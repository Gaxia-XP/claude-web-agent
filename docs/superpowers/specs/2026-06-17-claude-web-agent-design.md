# Claude Web Agent — Design Spec

**วันที่:** 2026-06-17
**สถานะ:** Draft (รอ review)

## 1. เป้าหมาย (Goal)

สร้าง **local web app** สำหรับคุยกับ Claude (และ LLM provider อื่น) ที่:

- รันบนเครื่อง PC ของผู้ใช้ เข้าได้ทั้งจาก PC และมือถือ (responsive)
- รองรับ **agent เต็มรูปแบบ** (อ่าน/เขียนไฟล์, รันคำสั่ง) ผ่าน Claude Agent SDK บนเครื่องที่รัน backend
- เสียบสลับ **provider** ได้หลายแบบ: Local Agent SDK, Anthropic API, OpenAI-compatible
- เก็บประวัติหลายห้องแชตแบบถาวร
- เปิดใช้งานได้ทั้งผ่าน **UI**, **native HTTP API**, และ **compatibility API** (OpenAI/Anthropic) ให้ harness ภายนอกเสียบเข้ามาใช้ได้

## 2. Requirements

### Functional
1. แชตหลายห้อง (multi-conversation) มี sidebar รายชื่อแชต สร้าง/เปลี่ยนชื่อ/ลบได้ บันทึกถาวร
2. แต่ละห้องผูกกับ: provider (connection), model, และ working directory (cwd — เฉพาะ local-agent)
3. Provider เสียบสลับได้ 3 แบบ:
   - **Local Agent SDK** — `@anthropic-ai/claude-agent-sdk` บนเครื่อง → full agent (file/command tools)
   - **Anthropic API** — `@anthropic-ai/sdk` ด้วย API key → แชตธรรมดา
   - **OpenAI-compatible** — base URL + key (OpenRouter, Ollama, ฯลฯ) → แชตธรรมดา
4. Streaming ตอบทีละ token ทั้งใน UI และ API
5. Permission (เฉพาะ local-agent ที่มี tool):
   - อ่าน (Read/Glob/Grep/NotebookRead/WebSearch/WebFetch/TodoWrite) → auto-allow
   - เขียน/รัน (Write/Edit/MultiEdit/NotebookEdit/Bash/Task/...) → ถามก่อน
   - ใน UI: เด้ง modal Allow once / Allow ทั้งห้อง / Deny
   - ใน native API: ตั้ง policy ต่อ request — `readonly` (default) หรือ `auto`
   - ใน compat API: ฝัง policy ใน model id (ดูข้อ 9)
6. แสดง tool calls เป็น card (ชื่อ tool + argument) และผลลัพธ์
7. FolderPicker เลือก cwd ต่อห้อง (ช่องพิมพ์ path + browse subfolder + รายการล่าสุด)
8. หน้า Settings จัดการ connection (เพิ่ม/แก้ provider, ใส่ key, ตั้ง model)
9. **Native HTTP API**: REST + SSE ใช้ห้อง/provider เดียวกับ UI (stateful)
10. **Compatibility API**: `/v1/chat/completions` + `/v1/models` (OpenAI) และ `/v1/messages` (Anthropic) — ให้ harness เช่น open-webui, opencode, claude-cli เสียบใช้ (stateless)
11. Live sync: ห้องเดียวกันถูกขับจาก UI/native API พร้อมกัน → broadcast ข้อความใหม่ไป WebSocket ที่ subscribe ห้องนั้น
12. ปุ่ม Stop (interrupt) ระหว่าง Claude กำลังตอบ
13. Render markdown + code highlight; แสดง token/cost ท้ายแต่ละรอบ (ถ้า provider ให้ข้อมูล)

### Non-functional
- รันด้วย `npm run dev` (dev) / `npm start` (prod build)
- Backend bind `0.0.0.0` (เข้าจาก LAN ได้) ป้องกันด้วย bearer token
- API key ของ provider เก็บฝั่ง server เท่านั้น ไม่ส่งไป browser
- ทำงานบน Windows (เครื่องผู้ใช้) เป็นหลัก

## 3. สถาปัตยกรรมภาพรวม

```
  Browser (UI)        harness ภายนอก (open-webui/opencode/claude-cli)
      │ WS + native REST/SSE          │ OpenAI / Anthropic wire format
      ▼                               ▼
┌────────────────────────────────────────────────────────────────────┐
│  Node + Fastify (bind 0.0.0.0, bearer-token auth)                   │
│  ws.ts │ http-api.ts(native) │ compat/ (openai.ts, anthropic.ts)    │
│                    │  แปลงเข้า turn เดียวกัน                          │
│                    ▼                                                 │
│              agent.ts (turn orchestration, provider-agnostic)       │
│        │                 │                    │                      │
│  permission-resolver   providers/*        store.ts (SQLite)         │
│        │           ┌─────┼──────┐             │                      │
│  Interactive/     local anthropic openai   chats/messages/          │
│  Policy           Agent  API     compat    connections              │
└───────────────────┼─────────────────────────────────────────────────┘
                 Claude Agent SDK (login บนเครื่อง)
                 / api.anthropic.com / custom base URL
```

**ทำไม WebSocket (ไม่ใช่ SSE) สำหรับ UI:** agent ต้องสื่อสารสองทาง — server ส่ง token + tool call + permission request ลง, client ส่ง message + allow/deny + interrupt ขึ้น. SSE ทำได้ทางเดียว. (HTTP API ฝั่ง integration ใช้ SSE สำหรับ stream ก็พอ เพราะ permission ใช้ policy ไม่ต้อง round-trip)

## 4. Provider Abstraction

หัวใจของดีไซน์ — `agent.ts` ไม่รู้จัก provider โดยตรง คุยผ่าน interface เดียว ทั้ง 3 ทางเข้า (UI, native API, compat API) มา rendezvous ที่ turn เดียวกัน:

```ts
interface ProviderContext {
  onDelta(text: string): void           // token ทีละชิ้น
  onToolCall(call: ToolCall): void       // tool_use เริ่ม
  onToolResult(id: string, result: unknown): void
  permission: PermissionResolver         // ใช้เฉพาะ provider ที่มี tool
  signal: AbortSignal                    // สำหรับ interrupt
}

interface TurnResult {
  text: string
  toolCalls: ToolCall[]
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number }
  sdkSessionId?: string                  // เก็บไว้ resume (local-agent)
}

interface Provider {
  readonly type: 'local-agent' | 'anthropic-api' | 'openai-compatible'
  send(chat: ChatLike, history: Message[], userText: string, ctx: ProviderContext): Promise<TurnResult>
}
```

`ChatLike` = ข้อมูลพอสำหรับ 1 turn (model, cwd, sdkSessionId) — ใช้ได้ทั้งห้องจริง (stateful) และ ห้องชั่วคราว (compat stateless)

### 4.1 LocalAgentProvider
- ใช้ `query({ prompt, options })` จาก `@anthropic-ai/claude-agent-sdk`
- options: `cwd`, `model`, `includePartialMessages: true`,
  `systemPrompt: { type:'preset', preset:'claude_code' }`,
  `resume: sdkSessionId` (ถ้ามี), `canUseTool` → เรียก `ctx.permission.resolve(...)`
- ใช้ **streaming input mode** (ป้อน prompt เป็น async generator) เพราะ `canUseTool` ทำงานเฉพาะโหมดนี้ และทำให้แทรก interrupt ได้
- อ่าน message stream:
  - `type:'stream_event'` (partial) → `ctx.onDelta(textDelta)`
  - `type:'assistant'` block `tool_use` → `ctx.onToolCall(...)`
  - `type:'user'` (tool_result) → `ctx.onToolResult(...)`
  - `type:'system'` subtype `init` → เก็บ `session_id` → `TurnResult.sdkSessionId`
  - `type:'result'` → usage/cost

### 4.2 AnthropicApiProvider
- ใช้ `@anthropic-ai/sdk` → `client.messages.stream({ model, messages, max_tokens, system })`
- เก็บ history เอง (API stateless): ส่ง `messages[]` ที่ประกอบจาก DB/คำขอ ทุกรอบ
- stream `text` deltas → `ctx.onDelta`. ไม่มี local file tools → `permission` ไม่ถูกใช้

### 4.3 OpenAICompatibleProvider
- POST `${baseURL}/chat/completions` ด้วย `stream:true`, header `Authorization: Bearer <key>`
- อ่าน SSE `data:` chunk → `choices[].delta.content` → `ctx.onDelta`
- เก็บ history เอง เหมือน Anthropic API. ไม่มี tool.

### 4.4 Connections
- เก็บ provider config ใน SQLite (key อยู่ฝั่ง server) — frontend เห็นแค่ name/type/model list
```
connections: id, type, name, base_url(null ได้), api_key(null สำหรับ local-agent),
             default_model, created_at, updated_at
```
- local-agent ไม่ต้องมี key (ใช้ login บนเครื่อง)

## 5. Permission Model

```ts
type PermissionDecision =
  | { behavior: 'allow'; updatedInput?: unknown }
  | { behavior: 'deny'; message: string }

interface PermissionResolver {
  resolve(chatId: string, toolName: string, input: unknown): Promise<PermissionDecision>
}
```

- **InteractivePermissionResolver** (UI/WebSocket): auto-allow read set; tool อื่น → ส่ง `permission_request` ไป WS ที่ subscribe ห้องนั้น แล้ว await คำตอบ. จำตัวเลือก "Allow ทั้งห้อง" ใน in-memory map ต่อ session
- **PolicyPermissionResolver** (native API + compat): `readonly` → allow read set, deny ที่เหลือ; `auto` → allow ทั้งหมด
- ตัว resolver ผูก **ต่อ 1 รอบข้อความ** (ไม่ใช่ต่อห้อง) เพราะ turn เดียวมาได้จากหลายทางเข้า

Read set (auto-allow): `Read, Glob, Grep, NotebookRead, WebSearch, WebFetch, TodoWrite`

## 6. Data Model (SQLite ผ่าน better-sqlite3)

```sql
chats (
  id TEXT PRIMARY KEY,
  title TEXT,
  connection_id TEXT REFERENCES connections(id),
  model TEXT,
  cwd TEXT,                       -- เฉพาะ local-agent
  sdk_session_id TEXT,            -- สำหรับ resume (local-agent)
  created_at INTEGER, updated_at INTEGER
)

messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT REFERENCES chats(id),
  role TEXT,                      -- 'user' | 'assistant'
  content TEXT,                   -- JSON: [{type:'text'|'tool_use'|'tool_result', ...}]
  usage TEXT,                     -- JSON nullable
  created_at INTEGER
)

connections (
  id TEXT PRIMARY KEY,
  type TEXT,                      -- 'local-agent'|'anthropic-api'|'openai-compatible'
  name TEXT,                      -- ใช้เป็น prefix ของ model id ใน compat API ด้วย
  base_url TEXT, api_key TEXT,    -- nullable; เก็บ server-side เท่านั้น
  default_model TEXT,
  created_at INTEGER, updated_at INTEGER
)
```

- ทุก message + tool call เขียนลง DB ตอนเกิด → reload เห็นประวัติครบ
- ไฟล์ `data/chats.db` (gitignored)
- compat API เป็น stateless ไม่จำเป็นต้องเขียนลง DB (อาจ log เป็นห้องเพื่อโชว์ใน UI ได้ภายหลัง — nice-to-have)

## 7. Real-time Protocol (WebSocket — UI channel)

ทุกข้อความ JSON `{ type, ... }`. type ใน `shared/protocol.ts` (ใช้ร่วม 2 ฝั่ง)

**Client → Server**
- `auth` `{ token }`
- `subscribe` / `unsubscribe` `{ chatId }`
- `user_message` `{ chatId, text }`
- `permission_response` `{ requestId, decision:'allow'|'deny', scope?:'once'|'chat' }`
- `interrupt` `{ chatId }`
- `create_chat` `{ connectionId, model, cwd? }`
- `rename_chat` / `delete_chat` `{ chatId, ... }`
- `list_dirs` `{ path }`

**Server → Client**
- `auth_ok` / `auth_error`
- `chat_list` `{ chats[] }` / `chat_created` `{ chat }`
- `assistant_delta` `{ chatId, text }`
- `tool_call` `{ chatId, id, name, input }`
- `tool_result` `{ chatId, id, result }`
- `permission_request` `{ chatId, requestId, name, input }`
- `turn_done` `{ chatId, usage? }`
- `dir_list` `{ path, entries[] }`
- `error` `{ message, chatId? }`

## 8. Native HTTP API (REST + SSE)

ทุก endpoint ต้องมี header `Authorization: Bearer <token>`. ใช้ห้อง/provider เดียวกับ UI (stateful)

```
GET    /api/connections                  ลิสต์ connection (ไม่คืน api_key)
POST   /api/chats                        { connectionId, model, cwd? } → { chatId }
GET    /api/chats                        ลิสต์ห้อง
GET    /api/chats/:id/messages           ดึงประวัติ
POST   /api/chats/:id/messages           ส่งข้อความ
         body: { text, stream?:bool, permission?:'readonly'|'auto' }
         • stream:false → JSON { text, toolCalls, usage }
         • stream:true  → SSE: event delta / tool_call / tool_result / done
POST   /api/query                        one-off: สร้างห้องชั่วคราว+ส่งข้อความครั้งเดียว
```

- ข้อความที่เข้าทาง native API ถูก broadcast ไป WS subscriber ของห้องนั้น (live sync)
- 1 ห้องประมวลผลทีละรอบ (serialize); รอบใหม่เข้าคิวถ้ารอบเก่ายังไม่จบ

## 9. Compatibility API (LLM Gateway สำหรับ harness ภายนอก)

ทำให้ server เรากลายเป็น "model backend" รูปแบบมาตรฐาน ให้ harness เสียบเข้ามาใช้ ทุก provider ของเรา (รวม local-agent ที่เป็น full Claude Code agent) ถูก expose ผ่านหน้าตา API มาตรฐาน — **stateless** (client/harness ส่ง `messages[]` เต็มทุกครั้ง ไม่ผูกกับห้อง UI)

### 9.1 Endpoints
```
# OpenAI-compatible
GET    /v1/models                        ลิสต์ model id ที่เลือกได้ (ดู 9.3)
POST   /v1/chat/completions              { model, messages, stream? }
         • stream:false → { choices:[{message:{role,content}}], usage }
         • stream:true  → SSE chunk: { choices:[{delta:{content}}] } ... [DONE]

# Anthropic Messages
POST   /v1/messages                      { model, messages, max_tokens, system?, stream? }
         • stream:false → { content:[{type:'text',text}], usage }
         • stream:true  → SSE: message_start / content_block_delta / message_stop
GET    /v1/models                        (ใช้ร่วม รูปแบบ list เดียวกันพอใช้ได้ทั้งคู่)
```

### 9.2 Auth (map token เป็น API key)
- OpenAI format: `Authorization: Bearer <our-token>`
- Anthropic format: `x-api-key: <our-token>` (รับ `anthropic-version` header แต่ไม่บังคับ)
- ตั้งค่าใน harness: base URL ชี้มาที่ `http://<host>:<port>/v1`, API key = bearer token ของเรา

### 9.3 Model ID mapping (ฝัง connection + permission)
รูปแบบ model id ที่ `/v1/models` คืน และ harness ใช้เลือก:
```
"<connectionName>/<model>"            เลือก connection + model
"<connectionName>-auto/<model>"       (เฉพาะ local-agent) → permission policy = auto
```
- ตัวอย่าง: `local/claude-opus-4-8` (readonly default), `local-auto/claude-opus-4-8` (auto), `openrouter/anthropic/claude-3.5-sonnet`
- `/v1/models` จะ list ทั้ง readonly และ `-auto` variant ให้ connection แบบ local-agent
- harness ไม่ต้องส่ง field พิเศษ — policy อยู่ในชื่อ model

### 9.4 การ map local-agent → chat completion
- local-agent รัน agent loop จนจบแบบ autonomous (tool ทำงาน server-side ตาม policy ที่ฝังใน model id) แล้วคืน **ข้อความสุดท้าย** เป็น assistant message เดียว
- intermediate tool_use **ไม่** ถูก map เป็น OpenAI `tool_calls`/Anthropic `tool_use` บน wire (เพราะ harness ฝั่งนั้นจะพยายามไปรันเอง) — เรารัน tool เองภายในแล้วส่งแต่คำตอบ
- streaming: ไหล text deltas ของคำตอบสุดท้ายออกไป (ไม่ปล่อย noise ของ tool ระหว่างทาง; อาจมี comment/heartbeat กัน timeout)
- provider API (anthropic/openai-compat) → pass-through ตรงไปตรงมา

## 10. Frontend (React + Vite + Tailwind, responsive)

**Pages**
- `Login` — กรอก/วาง bearer token (เก็บ localStorage); Settings มี QR ของ URL+token ให้สแกนจากมือถือ
- `Chat` — sidebar + ChatView (เป็น drawer บนจอแคบ)
- `Settings` — จัดการ connections (เพิ่ม Anthropic key / custom endpoint), แสดง token + QR, **โชว์ base URL + model id list สำหรับเสียบ harness ภายนอก**

**Components**
`Sidebar` (รายชื่อแชต, ปุ่มแชตใหม่), `ChatView`, `Message` (markdown), `ToolCard`,
`PermissionModal`, `Composer` (พิมพ์/ส่ง/Stop), `FolderPicker`,
`ConnectionPicker`, `ModelPicker`

**State:** zustand store + `ws.ts` (WebSocket client + reconnect) + `api.ts` (REST helper)
**Responsive:** sidebar ยุบเป็น drawer (hamburger) บน mobile; composer/messages ปรับ layout; แตะง่าย

## 11. Security & Auth

- bind `0.0.0.0` (เข้าจาก LAN) — host/port ตั้งได้ผ่าน env
- **bearer token**: สุ่มตอนรันครั้งแรก เก็บ `data/.token`, พิมพ์โชว์ที่ console พร้อม URL + QR
- ทุก WS / native API / compat API ต้อง auth ด้วย token; ไม่ผ่าน → ปิด/401
- provider api_key เก็บใน SQLite ฝั่ง server เท่านั้น (frontend ไม่เห็น); ไม่ log key
- mobile/tunnel: แนะนำ cloudflared/ngrok; token ป้องกัน endpoint
- เตือนใน README: model id แบบ `-auto` (local-agent) รัน/เขียนได้หมด — ใช้กับ network/harness ที่ไว้ใจเท่านั้น

## 12. โครงสร้างโปรเจกต์ (root = working dir)

```
./
├── shared/protocol.ts
├── server/
│   ├── index.ts            # Fastify + WS + static, bind 0.0.0.0, auth
│   ├── auth.ts
│   ├── ws.ts
│   ├── http-api.ts         # native REST + SSE
│   ├── compat/
│   │   ├── openai.ts       # /v1/chat/completions + /v1/models
│   │   ├── anthropic.ts    # /v1/messages
│   │   └── models.ts       # model-id ↔ connection+policy mapping
│   ├── agent.ts            # turn orchestration (provider-agnostic)
│   ├── providers/
│   │   ├── index.ts        # Provider interface + registry
│   │   ├── localAgent.ts
│   │   ├── anthropicApi.ts
│   │   └── openaiCompat.ts
│   ├── permission-resolver.ts
│   ├── connections.ts
│   ├── store.ts            # SQLite CRUD
│   └── fsbrowse.ts
├── web/                    # React + Vite + Tailwind
│   ├── index.html  vite.config.ts
│   └── src/
│       ├── main.tsx  App.tsx  ws.ts  api.ts  store.ts  markdown.tsx
│       ├── pages/ Chat.tsx  Settings.tsx  Login.tsx
│       └── components/ Sidebar ChatView Message ToolCard
│            PermissionModal Composer FolderPicker
│            ConnectionPicker ModelPicker
├── data/ chats.db  .token   # gitignored
├── package.json  tsconfig.json  .gitignore  README.md
```

## 13. Tech Stack & Dependencies

- **Backend:** Node 20+, TypeScript, Fastify, `@fastify/websocket` (หรือ `ws`), `better-sqlite3`, `@anthropic-ai/claude-agent-sdk`, `@anthropic-ai/sdk`, `qrcode`
- **Frontend:** React 18, Vite, Tailwind, zustand, react-markdown + shiki/highlight.js
- **Dev:** tsx/nodemon, concurrently (รัน server + vite พร้อมกัน), Vite proxy `/api` + `/v1` + `/ws` → backend

## 14. Out of Scope (YAGNI — เฟสนี้ไม่ทำ)

- Multi-user / บัญชีผู้ใช้ (token เดียวพอ)
- เปิด Anthropic/OpenAI server-side tools ใน provider API (เฟสแรกแชตล้วน)
- compat API: ไม่ map intermediate tool_use ออก wire (รัน server-side), ไม่ผูก state กับห้อง UI
- Cloud hosting แบบ production
- แชร์/ส่งออกบทสนทนาเป็นไฟล์
- ปรับ system prompt ต่อห้องจาก UI (ใช้ preset claude_code เป็นค่า default)

## 15. Success Criteria

1. เปิดเว็บบน PC → สร้างห้อง provider local-agent เลือกโฟลเดอร์ → คุย, Claude อ่านไฟล์ได้เอง, ขออนุญาตตอนจะเขียน/รัน, ตอบ stream ทีละ token
2. reload แล้วประวัติยังอยู่ คุยต่อในห้องเดิมได้ (resume)
3. เพิ่ม connection Anthropic API (key) แล้วสร้างห้องคุยได้
4. เปิดจากมือถือผ่าน LAN IP + token → ใช้งานได้ responsive
5. `curl` POST `/api/chats/:id/messages` (stream + non-stream) ได้คำตอบ; ข้อความโผล่ใน UI ที่เปิดห้องเดียวกัน
6. provider OpenAI-compatible คุยกับ endpoint ภายนอกได้
7. **ตั้ง open-webui ให้ใช้ OpenAI base URL = เรา → เห็น model list, คุยผ่าน local-agent ได้**
8. **ตั้ง claude-cli/Claude Code `ANTHROPIC_BASE_URL` = เรา + key = token → `/v1/messages` ทำงาน**
9. **เลือก model id แบบ `-auto` ผ่าน harness → local-agent เขียน/รันได้โดยไม่ต้องกด allow; แบบปกติ → readonly**

## 16. ลำดับการ Implement (Phasing)

แบ่งเป็น milestone ให้ส่งมอบทีละชิ้นที่ใช้งานได้จริง:

- **M1 — แกน local-agent + UI:** Fastify+WS, LocalAgentProvider (stream + canUseTool + permission modal), ChatView พื้นฐาน, 1 ห้อง (ยังไม่ persist)
- **M2 — Persistence + หลายห้อง:** SQLite store, Sidebar, resume ด้วย sdk_session_id, FolderPicker
- **M3 — Providers อื่น + Settings:** connections CRUD, AnthropicApiProvider, OpenAICompatibleProvider, ConnectionPicker/ModelPicker
- **M4 — Native HTTP API:** REST + SSE, PolicyPermissionResolver, live sync ไป WS, serialize ต่อห้อง
- **M5 — Compatibility API:** `/v1/models`, `/v1/chat/completions` (OpenAI), `/v1/messages` (Anthropic), model-id mapping + policy, ทดสอบกับ open-webui/claude-cli
- **M6 — Auth + Mobile:** bearer token + Login page, bind 0.0.0.0, responsive/drawer, QR ใน Settings

แต่ละ M ทดสอบได้เอง (ตรงกับ Success Criteria ข้างบน)
