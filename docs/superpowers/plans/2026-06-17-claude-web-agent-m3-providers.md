# Claude Web Agent — M3 (Other Providers + Settings) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** เพิ่ม provider อีก 2 แบบ (Anthropic API ผ่าน `@anthropic-ai/sdk`, OpenAI-compatible ผ่าน SSE) + connections CRUD + หน้า Settings + ConnectionPicker/ModelPicker เพื่อให้ผู้ใช้สร้างห้องแชตที่ผูกกับ connection/model ใดก็ได้ — พร้อมแก้ M2 scrutinize MAJORs ที่ยังค้าง (provider-type routing ใน hub, error-in-history, permission-modal hijack, cross-tab create_chat blank pane, chat-loading state) และ NITs ที่เกี่ยวข้อง.

**Architecture:** หัวใจคือ **provider-type routing**: `server/hub.ts` `getOrCreateRuntime` ต้องเลิก hardcode `'local-agent'` แล้วเปลี่ยนเป็นอ่าน `connection.type` จริงจาก DB (พร้อม api_key ที่อยู่ server-side เท่านั้น) ส่งเข้า `makeProvider(cfg)` factory ตัวใหม่ที่ switch เป็น `LocalAgentProvider` / `AnthropicApiProvider` / `OpenAICompatibleProvider`. provider แบบ stateless (anthropic/openai) ไม่มี local tool และไม่มี `sdk_session_id` resume — มันประกอบ `messages[]` จากประวัติใน DB ทุกรอบ (เพิ่ม `TurnParams.history`). connections CRUD + connection list ไหลผ่าน WebSocket (M4 จะมี REST) โดย **ไม่เคยส่ง `api_key` กลับ browser**. Frontend เพิ่ม `connections[]` state, ConnectionPicker/ModelPicker/NewChatModal และหน้า Settings; เปลี่ยน permission จาก single slot เป็น FIFO queue ที่ scope กับห้อง active; แก้ chat-list ให้ seed view + มี loading state. Provider interface (`server/providers/types.ts`) ขยายแค่ field `history` — `agent.ts`/`runTurn` ยัง provider-agnostic.

**Tech Stack:** เพิ่ม `@anthropic-ai/sdk` (Anthropic Messages API, streaming). OpenAI-compatible ใช้ global `fetch` (Node 20+) + SSE parser เขียนเอง. ที่เหลือเหมือน M1/M2 — Node 20+, TypeScript (ESM, moduleResolution Bundler), Fastify, `ws`, `@anthropic-ai/claude-agent-sdk`, `better-sqlite3`, React 18, Vite, Tailwind, react-markdown, Vitest.

## Global Constraints

- Node 20+, package `"type": "module"` ทั้งโปรเจกต์; TypeScript strict; `module: ESNext`, `moduleResolution: Bundler` (import ไม่ต้องมีนามสกุล `.js`).
- Shared types อยู่ที่ `shared/protocol.ts` — server import แบบ relative (`../shared/protocol` หรือ `../../shared/protocol`), web import ผ่าน alias `@shared/*`.
- Port: backend = `8787`, Vite dev = `5173`; Vite proxy `/ws` และ `/api` → backend. ฝั่ง client ใช้ `location.host` (ห้าม hardcode พอร์ต).
- Read-only tools ที่ auto-allow (local-agent เท่านั้น): `Read, Glob, Grep, NotebookRead, WebSearch, WebFetch, TodoWrite`.
- **API key ของ provider เก็บใน `connections.api_key` ฝั่ง server เท่านั้น** — `listConnections`/`getConnection`/`mapConnection`/`connection_list`/ทุก path ที่ส่งไป browser **ต้องไม่มี `api_key`**. มีเฉพาะ `getConnectionWithSecret` (server-internal, ใช้โดย `makeProvider` เท่านั้น) ที่อ่าน api_key. ห้าม log api_key.
- **Model IDs (อ้างจาก `claude-api` skill — อย่าเดา):** local-agent alias = `sonnet`/`opus`/`haiku` (default `sonnet`). anthropic-api default = `claude-opus-4-8`; suggestions = `claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5` (ใช้ string ตรงตามนี้ ห้ามต่อ date suffix). openai-compatible = free text (ผู้ใช้กรอกเอง).
- **Anthropic provider:** ใช้ `client.messages.stream({ model, max_tokens, messages })` — `max_tokens` บังคับ, ใช้ค่าคงที่ `DEFAULT_MAX_TOKENS = 16000`. **ไม่ส่ง `thinking`** (แชตล้วนตาม spec §2.3; omit ใช้ได้กับทุก model) และ **ไม่ส่ง `temperature`/`top_p`/`top_k`** (จะ 400 บน Opus 4.7+). ไม่ส่ง assistant prefill.
- Provider แบบ stateless ประกอบ `messages[]` จาก `TurnParams.history` (ประวัติเต็มจาก DB รวม user message รอบปัจจุบันที่ persist eagerly แล้ว) — ไม่ใช้ `sdk_session_id` resume, ไม่ใช้ permission resolver.
- Persistence: `better-sqlite3` `^11.0.0`. ตาราง `connections` **มีอยู่แล้วครบคอลัมน์ (รวม `api_key`) ตั้งแต่ M2 — M3 ไม่ต้อง migrate schema** เพิ่ม. DB ที่ `data/chats.db` (override ด้วย env `DB_PATH`).
- Per-turn watchdog timeout default = `600000` ms (ไม่เปลี่ยน).
- Test framework: Vitest (`environment: node`); ทุก pure logic ต้องมี unit test ก่อน implement (TDD). UI components ไม่มี DOM test (env เป็น node) → gate ด้วย `tsc`. **รัน Vitest จาก repo ROOT เสมอ** (เช่น `npx vitest run server/providers/anthropicApi.test.ts`).
- `npm run build:web` (vite build) ออกที่ repo-root `dist/`. root `tsconfig.json` include `["server","shared"]`; web ใช้ `web/tsconfig.json`.
- โค้ดสไตล์: ไฟล์ใหม่และไฟล์ server ส่วนใหญ่ใช้ **single quotes, ไม่มี semicolon, 2-space indent**. **ยกเว้น `server/store.ts` ที่ใช้ double quotes + ไม่มี semicolon** — แก้ไฟล์นั้นให้คงสไตล์เดิม (double quotes).
- commit บ่อย ทีละ task. branch: สร้าง `feat/m3-providers` จาก `master` (HEAD `2d35b20`) — ทำ task บน branch นี้ (ไม่เปิด PR ต่อ task); merge `--no-ff` เข้า `master` ตอนจบ (M-convention).

## Migration Typecheck Policy (สำคัญ — อ่านก่อนเริ่ม)

M3 มี protocol migration เล็ก ๆ: **Task 2** ขยาย `ServerMsg` (เพิ่ม `connection_list`), `ClientMsg` (เพิ่ม connection CRUD + `create_chat.connectionId`), และ `StoredContentBlock` (เพิ่ม variant `error`). การเพิ่ม variant ใน union ทำให้ไฟล์ที่ `switch` แบบ exhaustive (เช่น `web/src/appState.ts` `applyServer`) **พัง** ภายใต้ `tsc` ทั้งโปรเจกต์ จนกว่า task เจ้าของจะ handle case ใหม่. กฎระหว่างทาง:

1. **Gate ต่อ task = Vitest ของไฟล์ตัวเอง** ผ่าน — Vitest transpile รายไฟล์ด้วย esbuild (ไม่ cross-file typecheck) จึงเขียวได้แม้ไฟล์อื่นยังมี type error.
2. **ห้ามเคลม whole-project `tsc --noEmit` clean ระหว่างทาง.** ถ้า task มี tsc step ให้ตรวจเฉพาะไฟล์ของ task นั้น.
3. **typecheck ที่เป็นทางการ:** server+shared เขียวครบที่ **Task 9** (`npx tsc --noEmit`, root tsconfig); web เขียวครบที่ **Task 12** (`npx tsc -p web/tsconfig.json`); **Task 14** รันทั้งสอง + full suite + build + e2e เป็น gate สุดท้าย.

## M3 Design Decisions (locked — อย่า re-derive)

- **connections CRUD ไหลผ่าน WebSocket** (ไม่ใช่ REST) — REST/native API เป็น M4. เพิ่ม client msg `create_connection`/`update_connection`/`delete_connection` + server msg `connection_list` (broadcast ทุก socket เหมือน `chat_list`).
- **`makeProvider` รับ `ProviderConfig` (มี api_key) ไม่ใช่แค่ type string** — hub resolve connection พร้อม secret ผ่าน `getConnectionWithSecret` แล้วส่งเข้า factory. api_key อยู่ใน config object server-side เท่านั้น.
- **stateless provider ประกอบ `messages[]` จาก `TurnParams.history`** (เพิ่ม field นี้) — ไม่แตะ `agent.ts`/`runTurn` (ยังส่ง `userText` ตามเดิมเพื่อ local-agent). mapper รวม consecutive same-role + ข้าม block ที่ไม่ใช่ text (tool_use/tool_result/error).
- **error/timeout turn เก็บลง history** เป็น `StoredContentBlock` variant ใหม่ `{ type:'error', message }` — ไม่ persist assistant row ว่าง ๆ อีกต่อไป (M2 MAJOR#1). reload เห็น error bubble แดง.
- **permission เป็น FIFO queue ที่ scope กับ activeChatId** (M2 MAJOR#2) — background chat ไม่ hijack modal; หลายคำขอไม่ทับกัน; `chat_deleted` ล้างคำขอของห้องนั้นออกจาก queue; server cancel pending เมื่อ turn จบผิดปกติ.
- **deferred (ไม่ทำใน M3):** native HTTP API (M4), compat API + model-id mapping (M5), auth/token/0.0.0.0/QR/mobile (M6), permission `scope:'chat'`, advanced reconnect, `list_dirs` path bounding (M6 — README มี Security note แล้ว), ChatRuntime idle-eviction, auto-unsubscribe on chat switch.

## File Structure

**สร้างใหม่:**
- `server/providers/messages.ts` (+test) — `historyToChatMessages(history)`: แปลง `StoredMessage[]` → `{ role:'user'|'assistant'; content:string }[]` (ข้าม block ที่ไม่ใช่ text, รวม consecutive same-role) ใช้ร่วมโดย 2 provider stateless.
- `server/providers/anthropicApi.ts` (+test) — `AnthropicApiProvider` (`@anthropic-ai/sdk` streaming, inject `streamFn` เพื่อ test).
- `server/providers/openaiCompat.ts` (+test) — `OpenAICompatibleProvider` (fetch + SSE) + `parseSseData` (pure async generator, test แยก).
- `server/providers/index.ts` (+test) — `ProviderConfig` type + `makeProvider(cfg)` factory (switch 3 type).
- `web/src/components/ConnectionPicker.tsx`, `web/src/components/ModelPicker.tsx`, `web/src/components/NewChatModal.tsx`, `web/src/components/Settings.tsx`.

**แก้ไข:**
- `shared/protocol.ts` (+test) — `ConnectionMeta`, `StoredContentBlock` += `error`, `ClientMsg` += connection CRUD + `create_chat.connectionId`, `ServerMsg` += `connection_list`, `parseClientMsg`.
- `server/store.ts` (+test) — `getConnectionWithSecret`, `createConnection`, `updateConnection`, `deleteConnection`, `countChatsForConnection`; import `ConnectionMeta`.
- `server/providers/types.ts` — `TurnParams` += `history?: StoredMessage[]`.
- `server/providers/localAgent.ts` (+test) — เอา dual `session_id` ออกจาก input (ใช้ `options.resume` อย่างเดียว — NIT).
- `server/chatRuntime.ts` (+test) — ส่ง `history` (จาก `listMessages`) เข้า provider; capture error → persist error block / skip empty (MAJOR#1); cancel pending permission เมื่อ turn จบ.
- `server/hub.ts` (+test) — `getOrCreateRuntime` resolve `getConnectionWithSecret(...).type` → `makeProvider(cfg)`; `create_chat` ใช้ `connectionId`; route connection CRUD + broadcast `connection_list` + ส่ง connection_list ตอน addConnection.
- `server/index.ts` — wire `makeProvider` จาก `providers/index`; ย้าย `attachWebSocketServer` ก่อน `app.listen` (NIT).
- `web/src/appState.ts` (+test) — `connections`, `pendingQueue` (scope active), seed views ใน `chat_list`, error block ใน `historyToView`, `chat_deleted` ล้าง queue, helper สำหรับ Settings/new-chat.
- `web/src/App.tsx`, `web/src/components/FolderPicker.tsx` — routing Chat/Settings, NewChatModal flow, FolderPicker เป็น browser ของฟอร์ม, connection CRUD sends, permission modal จาก queue, loading placeholder.
- `package.json` — เพิ่ม `@anthropic-ai/sdk` (Task 1).
- `README.md` (Task 14).

ลำดับ task เรียงตาม dependency: deps → protocol → store → provider abstraction/providers → factory+hub routing → error-in-history → connection CRUD → frontend state → frontend components → App wiring → hardening → README+verify.

---

### Task 1: Dependency — `@anthropic-ai/sdk`

Goal: เพิ่ม `@anthropic-ai/sdk` (Anthropic Messages API SDK) เป็น runtime dependency สำหรับ `AnthropicApiProvider` ใน Task 5. เป็น config-only change; suite เดิมคือ gate.

**Files:**
- Modify: `P:\AI_PROJECT\Claude\WebPage\package.json`, `package-lock.json` (regenerated โดย npm)
- Test: (none — config-only)

**Interfaces:**
- Consumes: nothing.
- Produces: `@anthropic-ai/sdk` resolvable (default export `Anthropic`; ใช้ `new Anthropic({ apiKey }).messages.stream(...)` + `Anthropic.MessageParam`).

Notes:
- เราพึ่งเฉพาะ API ที่เสถียร: `client.messages.stream(body, options)` (body: `model`, `max_tokens`, `messages`; options: `{ signal }`) และ stream event shapes (`message_start.message.usage.input_tokens`, `content_block_delta.delta.text_delta`, `message_delta.usage.output_tokens`). อย่า pin เวอร์ชันแบบเดา — ติดตั้ง latest แล้วให้ npm เขียน pin ลง package.json.

- [ ] **Step 1: ติดตั้ง `@anthropic-ai/sdk`.**
  Run:
  ```bash
  cd /p/AI_PROJECT/Claude/WebPage && npm install @anthropic-ai/sdk
  ```
  Expected: `package.json` `dependencies` มี `@anthropic-ai/sdk` เพิ่มเข้ามา (เวอร์ชันที่ npm resolve, เช่น `^0.x.y`); `package-lock.json` อัปเดต; ไม่มี error.

- [ ] **Step 2: ยืนยัน dependency block.**
  เปิด `package.json` ตรวจว่า `"@anthropic-ai/sdk"` อยู่ใน `dependencies` (ไม่ใช่ devDependencies) เรียงตามตัวอักษร (ก่อน `@anthropic-ai/claude-agent-sdk`? — npm จัดให้, ปล่อยตามที่ npm เขียน).

- [ ] **Step 3: รัน suite เดิมเป็น sanity gate.**
  Run:
  ```bash
  cd /p/AI_PROJECT/Claude/WebPage && npx vitest run
  ```
  Expected: PASS ทั้งหมด (จำนวนเท่ากับ baseline M2 = 106). การเพิ่ม dependency ไม่ควรทำให้เทสต์พัง.

- [ ] **Step 4: Commit.**
  ```bash
  git checkout -b feat/m3-providers
  git add package.json package-lock.json
  git commit -m "build(m3): add @anthropic-ai/sdk for AnthropicApiProvider"
  ```

---

### Task 2: Protocol v3 — connections, error block, connection CRUD messages

Goal: ขยาย `shared/protocol.ts` ให้รองรับ connection metadata, error content block, การเลือก connection ตอนสร้างห้อง, และ connection CRUD messages. เพิ่ม parser cases. นี่คือสัญญา (contract) ที่ task ถัด ๆ ไปอ้างอิง.

**Files:**
- Modify: `P:\AI_PROJECT\Claude\WebPage\shared\protocol.ts`
- Test: `P:\AI_PROJECT\Claude\WebPage\shared\protocol.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `ConnectionMeta = { id, type, name, baseUrl?, defaultModel, createdAt, updatedAt }` (ไม่มี `apiKey`).
  - `StoredContentBlock` += `{ type:'error'; message:string }`.
  - `ClientMsg` += `{ type:'create_chat'; title?; model?; cwd?; connectionId? }` (เพิ่ม `connectionId?`), `{ type:'create_connection'; name; providerType; baseUrl?; apiKey?; defaultModel }`, `{ type:'update_connection'; id; name?; baseUrl?; apiKey?; defaultModel? }`, `{ type:'delete_connection'; id }`.
  - `ServerMsg` += `{ type:'connection_list'; connections: ConnectionMeta[] }`.
  - `parseClientMsg` handle 3 connection msgs ใหม่ + `create_chat.connectionId`.

- [ ] **Step 1: เขียน failing tests** ใน `shared/protocol.test.ts` (เพิ่มต่อท้ายไฟล์เดิม).
  ```ts
  import { describe, it, expect } from 'vitest'
  import { parseClientMsg } from './protocol'

  describe('protocol v3 — connections', () => {
    it('parses create_chat with connectionId + model + cwd', () => {
      const m = parseClientMsg(
        JSON.stringify({ type: 'create_chat', connectionId: 'c1', model: 'claude-opus-4-8', cwd: 'C:/x' }),
      )
      expect(m).toEqual({ type: 'create_chat', connectionId: 'c1', model: 'claude-opus-4-8', cwd: 'C:/x' })
    })

    it('parses create_chat without connectionId (omitted, not null)', () => {
      const m = parseClientMsg(JSON.stringify({ type: 'create_chat' }))
      expect(m).toEqual({ type: 'create_chat' })
    })

    it('parses create_connection', () => {
      const m = parseClientMsg(
        JSON.stringify({
          type: 'create_connection',
          name: 'My Anthropic',
          providerType: 'anthropic-api',
          apiKey: 'sk-x',
          defaultModel: 'claude-opus-4-8',
        }),
      )
      expect(m).toEqual({
        type: 'create_connection',
        name: 'My Anthropic',
        providerType: 'anthropic-api',
        apiKey: 'sk-x',
        defaultModel: 'claude-opus-4-8',
      })
    })

    it('rejects create_connection missing required fields', () => {
      expect(parseClientMsg(JSON.stringify({ type: 'create_connection', name: 'x' }))).toBeNull()
    })

    it('parses update_connection with only id + apiKey', () => {
      const m = parseClientMsg(JSON.stringify({ type: 'update_connection', id: 'c1', apiKey: 'sk-new' }))
      expect(m).toEqual({ type: 'update_connection', id: 'c1', apiKey: 'sk-new' })
    })

    it('parses delete_connection', () => {
      expect(parseClientMsg(JSON.stringify({ type: 'delete_connection', id: 'c1' }))).toEqual({
        type: 'delete_connection',
        id: 'c1',
      })
    })
  })
  ```

- [ ] **Step 2: รัน เพื่อยืนยัน fail.**
  Run: `npx vitest run shared/protocol.test.ts`
  Expected: FAIL (`create_connection` ฯลฯ ยังไม่ถูก parse → คืน null/ผิด).

- [ ] **Step 3: แก้ `shared/protocol.ts`.**
  3a. เพิ่ม `ConnectionMeta` (วางใต้ `ChatMeta`):
  ```ts
  export type ConnectionMeta = {
    id: string
    type: string
    name: string
    baseUrl?: string
    defaultModel: string
    createdAt: number
    updatedAt: number
  }
  ```
  3b. เพิ่ม variant `error` ใน `StoredContentBlock`:
  ```ts
  export type StoredContentBlock =
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: unknown }
    | { type: 'tool_result'; id: string; result: unknown }
    | { type: 'error'; message: string }
  ```
  3c. แก้ `create_chat` ใน `ClientMsg` + เพิ่ม 3 connection msgs:
  ```ts
  export type ClientMsg =
    | { type: 'create_chat'; title?: string; model?: string; cwd?: string; connectionId?: string }
    | { type: 'subscribe'; chatId: string }
    | { type: 'unsubscribe'; chatId: string }
    | { type: 'user_message'; chatId: string; text: string }
    | { type: 'permission_response'; requestId: string; decision: 'allow' | 'deny' }
    | { type: 'interrupt'; chatId: string }
    | { type: 'rename_chat'; chatId: string; title: string }
    | { type: 'delete_chat'; chatId: string }
    | { type: 'list_dirs'; path?: string }
    | {
        type: 'create_connection'
        name: string
        providerType: string
        baseUrl?: string
        apiKey?: string
        defaultModel: string
      }
    | { type: 'update_connection'; id: string; name?: string; baseUrl?: string; apiKey?: string; defaultModel?: string }
    | { type: 'delete_connection'; id: string }
  ```
  3d. เพิ่ม `connection_list` ใน `ServerMsg`:
  ```ts
    | { type: 'connection_list'; connections: ConnectionMeta[] }
  ```
  (วางถัดจาก `chat_list`.)
  3e. แก้ `parseClientMsg`: ใน case `create_chat` เพิ่มบรรทัด `if (typeof o.connectionId === 'string') m.connectionId = o.connectionId` (และเปลี่ยน type annotation ของ `m` ให้มี `connectionId?`). เพิ่ม cases ใหม่ก่อน `default`:
  ```ts
      case 'create_connection': {
        if (
          typeof o.name === 'string' &&
          typeof o.providerType === 'string' &&
          typeof o.defaultModel === 'string'
        ) {
          const m: Extract<ClientMsg, { type: 'create_connection' }> = {
            type: 'create_connection',
            name: o.name,
            providerType: o.providerType,
            defaultModel: o.defaultModel,
          }
          if (typeof o.baseUrl === 'string') m.baseUrl = o.baseUrl
          if (typeof o.apiKey === 'string') m.apiKey = o.apiKey
          return m
        }
        return null
      }
      case 'update_connection': {
        if (typeof o.id !== 'string') return null
        const m: Extract<ClientMsg, { type: 'update_connection' }> = { type: 'update_connection', id: o.id }
        if (typeof o.name === 'string') m.name = o.name
        if (typeof o.baseUrl === 'string') m.baseUrl = o.baseUrl
        if (typeof o.apiKey === 'string') m.apiKey = o.apiKey
        if (typeof o.defaultModel === 'string') m.defaultModel = o.defaultModel
        return m
      }
      case 'delete_connection':
        return typeof o.id === 'string' ? { type: 'delete_connection', id: o.id } : null
  ```
  สำหรับ `create_chat` case ปรับเป็น:
  ```ts
      case 'create_chat': {
        const m: Extract<ClientMsg, { type: 'create_chat' }> = { type: 'create_chat' }
        if (typeof o.title === 'string') m.title = o.title
        if (typeof o.model === 'string') m.model = o.model
        if (typeof o.cwd === 'string') m.cwd = o.cwd
        if (typeof o.connectionId === 'string') m.connectionId = o.connectionId
        return m
      }
  ```

- [ ] **Step 4: รัน เพื่อยืนยัน pass.**
  Run: `npx vitest run shared/protocol.test.ts`
  Expected: PASS ทั้งหมด (เดิม + ใหม่).

- [ ] **Step 5: Commit.**
  ```bash
  git add shared/protocol.ts shared/protocol.test.ts
  git commit -m "feat(m3): protocol v3 — ConnectionMeta, error block, connection CRUD msgs, create_chat.connectionId"
  ```

---

### Task 3: Store — connections CRUD + secret getter + delete guard

Goal: เพิ่มฟังก์ชัน store สำหรับ connections CRUD, `getConnectionWithSecret` (server-internal, มี api_key) และ `countChatsForConnection` (ใช้ guard การลบ). คงคอลัมน์ schema เดิม (ไม่ migrate). คง invariant: ฟังก์ชันสาธารณะ (`listConnections`/`getConnection`) ไม่คืน api_key.

**Files:**
- Modify: `P:\AI_PROJECT\Claude\WebPage\server\store.ts` (double-quote style)
- Test: `P:\AI_PROJECT\Claude\WebPage\server\store.test.ts`

**Interfaces:**
- Consumes: `ConnectionMeta` (Task 2) — เปลี่ยน `ConnectionRow` ให้ alias `ConnectionMeta`.
- Produces:
  - `getConnectionWithSecret(db, id): (ConnectionRow & { apiKey?: string }) | undefined`
  - `createConnection(db, c: { id; type; name; baseUrl?; apiKey?; defaultModel; now }): ConnectionRow`
  - `updateConnection(db, id, patch: { name?; baseUrl?; apiKey?; defaultModel? }, now): void`
  - `deleteConnection(db, id): void`
  - `countChatsForConnection(db, id): number`

- [ ] **Step 1: เขียน failing tests** (เพิ่มใน `server/store.test.ts`).
  ```ts
  import { describe, it, expect } from "vitest"
  import Database from "better-sqlite3"
  import {
    migrate,
    ensureDefaultLocalConnection,
    createConnection,
    updateConnection,
    deleteConnection,
    getConnection,
    getConnectionWithSecret,
    listConnections,
    countChatsForConnection,
    createChat,
  } from "./store"

  function freshDb() {
    const db = new Database(":memory:")
    db.pragma("foreign_keys = ON")
    migrate(db)
    ensureDefaultLocalConnection(db)
    return db
  }

  describe("connections CRUD", () => {
    it("creates a connection and stores api_key server-side only", () => {
      const db = freshDb()
      createConnection(db, {
        id: "c1",
        type: "anthropic-api",
        name: "My Anthropic",
        apiKey: "sk-secret",
        defaultModel: "claude-opus-4-8",
        now: 1000,
      })
      // public getters never expose api_key
      const pub = getConnection(db, "c1")
      expect(pub).toMatchObject({ id: "c1", type: "anthropic-api", name: "My Anthropic", defaultModel: "claude-opus-4-8" })
      expect((pub as Record<string, unknown>).apiKey).toBeUndefined()
      expect(listConnections(db).every((c) => (c as Record<string, unknown>).apiKey === undefined)).toBe(true)
      // secret getter exposes it (server-internal)
      expect(getConnectionWithSecret(db, "c1")?.apiKey).toBe("sk-secret")
    })

    it("updates only provided fields; api_key untouched when omitted", () => {
      const db = freshDb()
      createConnection(db, { id: "c1", type: "openai-compatible", name: "OR", baseUrl: "https://a", apiKey: "k1", defaultModel: "m1", now: 1 })
      updateConnection(db, "c1", { name: "OpenRouter", defaultModel: "m2" }, 2)
      const c = getConnectionWithSecret(db, "c1")!
      expect(c.name).toBe("OpenRouter")
      expect(c.defaultModel).toBe("m2")
      expect(c.baseUrl).toBe("https://a")
      expect(c.apiKey).toBe("k1") // unchanged
      updateConnection(db, "c1", { apiKey: "k2" }, 3)
      expect(getConnectionWithSecret(db, "c1")!.apiKey).toBe("k2")
    })

    it("counts chats referencing a connection (delete guard)", () => {
      const db = freshDb()
      createConnection(db, { id: "c1", type: "anthropic-api", name: "A", apiKey: "k", defaultModel: "m", now: 1 })
      expect(countChatsForConnection(db, "c1")).toBe(0)
      createChat(db, { id: "chat1", title: "t", connectionId: "c1", model: "m", now: 1 })
      expect(countChatsForConnection(db, "c1")).toBe(1)
    })

    it("deletes a connection with no chats", () => {
      const db = freshDb()
      createConnection(db, { id: "c1", type: "anthropic-api", name: "A", apiKey: "k", defaultModel: "m", now: 1 })
      deleteConnection(db, "c1")
      expect(getConnection(db, "c1")).toBeUndefined()
    })
  })
  ```

- [ ] **Step 2: รัน เพื่อยืนยัน fail.**
  Run: `npx vitest run server/store.test.ts`
  Expected: FAIL (ฟังก์ชันใหม่ยังไม่มี).

- [ ] **Step 3: แก้ `server/store.ts`** (double-quote style).
  3a. แก้ import บรรทัดบนให้ดึง `ConnectionMeta`:
  ```ts
  import type { ChatMeta, StoredMessage, StoredContentBlock, Usage, ConnectionMeta } from "../shared/protocol"
  ```
  3b. เปลี่ยน `ConnectionRow` เป็น alias (ลบ type literal เดิม แล้วใช้):
  ```ts
  export type ConnectionRow = ConnectionMeta
  ```
  3c. เพิ่ม type สำหรับ secret getter:
  ```ts
  export type ConnectionWithSecret = ConnectionRow & { apiKey?: string }
  ```
  3d. แก้ `ConnectionDbRow` ให้รวม `api_key`:
  ```ts
  type ConnectionDbRow = {
    id: string
    type: string
    name: string
    base_url: string | null
    api_key: string | null
    default_model: string
    created_at: number
    updated_at: number
  }
  ```
  3e. แก้ SQL ใน `listConnections` และ `getConnection` ให้ดึง `api_key` ด้วย (เพื่อ map type ตรง) **แต่ `mapConnection` ยังไม่ใส่ api_key** (คง invariant). เปลี่ยน 2 SELECT เป็น:
  ```sql
  SELECT id, type, name, base_url, api_key, default_model, created_at, updated_at FROM connections ...
  ```
  (`mapConnection` รับ row ที่มี `api_key` แต่ไม่ map field นี้ — ปล่อยเดิม.)
  3f. เพิ่มฟังก์ชันใหม่ (ต่อจาก `getConnection`):
  ```ts
  export function getConnectionWithSecret(db: DB, id: string): ConnectionWithSecret | undefined {
    const row = db
      .prepare(
        `SELECT id, type, name, base_url, api_key, default_model, created_at, updated_at
           FROM connections WHERE id = ?`,
      )
      .get(id) as ConnectionDbRow | undefined
    if (!row) return undefined
    const out: ConnectionWithSecret = mapConnection(row)
    if (row.api_key !== null) out.apiKey = row.api_key
    return out
  }

  export function createConnection(
    db: DB,
    c: { id: string; type: string; name: string; baseUrl?: string; apiKey?: string; defaultModel: string; now: number },
  ): ConnectionRow {
    db.prepare(
      `INSERT INTO connections (id, type, name, base_url, api_key, default_model, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(c.id, c.type, c.name, c.baseUrl ?? null, c.apiKey ?? null, c.defaultModel, c.now, c.now)
    const meta: ConnectionRow = {
      id: c.id,
      type: c.type,
      name: c.name,
      defaultModel: c.defaultModel,
      createdAt: c.now,
      updatedAt: c.now,
    }
    if (c.baseUrl !== undefined) meta.baseUrl = c.baseUrl
    return meta
  }

  export function updateConnection(
    db: DB,
    id: string,
    patch: { name?: string; baseUrl?: string; apiKey?: string; defaultModel?: string },
    now: number,
  ): void {
    const sets: string[] = []
    const vals: unknown[] = []
    if (patch.name !== undefined) {
      sets.push("name = ?")
      vals.push(patch.name)
    }
    if (patch.baseUrl !== undefined) {
      sets.push("base_url = ?")
      vals.push(patch.baseUrl)
    }
    if (patch.apiKey !== undefined) {
      sets.push("api_key = ?")
      vals.push(patch.apiKey)
    }
    if (patch.defaultModel !== undefined) {
      sets.push("default_model = ?")
      vals.push(patch.defaultModel)
    }
    sets.push("updated_at = ?")
    vals.push(now)
    vals.push(id)
    db.prepare(`UPDATE connections SET ${sets.join(", ")} WHERE id = ?`).run(...(vals as never[]))
  }

  export function deleteConnection(db: DB, id: string): void {
    db.prepare(`DELETE FROM connections WHERE id = ?`).run(id)
  }

  export function countChatsForConnection(db: DB, id: string): number {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM chats WHERE connection_id = ?`).get(id) as { n: number }
    return row.n
  }
  ```

- [ ] **Step 4: รัน เพื่อยืนยัน pass.**
  Run: `npx vitest run server/store.test.ts`
  Expected: PASS ทั้งหมด (เดิม + ใหม่).

- [ ] **Step 5: Commit.**
  ```bash
  git add server/store.ts server/store.test.ts
  git commit -m "feat(m3): store connections CRUD + getConnectionWithSecret + delete guard (api_key server-only)"
  ```

---

### Task 4: Provider abstraction — `TurnParams.history` + shared history→messages mapper

Goal: เพิ่ม field `history` ใน `TurnParams` (provider stateless ใช้ประกอบ `messages[]`) และเขียน `historyToChatMessages` (pure) ที่แปลง `StoredMessage[]` → `{ role; content }[]`: ดึงเฉพาะ text จากแต่ละ message, ข้าม message ที่ไม่มี text (เช่น error-only / tool-only), และรวม consecutive same-role เป็นก้อนเดียว (กัน non-alternating ที่ provider บางตัวปฏิเสธ).

**Files:**
- Modify: `P:\AI_PROJECT\Claude\WebPage\server\providers\types.ts`
- Create: `P:\AI_PROJECT\Claude\WebPage\server\providers\messages.ts`
- Test: `P:\AI_PROJECT\Claude\WebPage\server\providers\messages.test.ts`

**Interfaces:**
- Consumes: `StoredMessage`, `StoredContentBlock` (shared/protocol).
- Produces:
  - `TurnParams` += `history?: StoredMessage[]`.
  - `export type ChatMessage = { role: 'user' | 'assistant'; content: string }`
  - `export function historyToChatMessages(history: StoredMessage[]): ChatMessage[]`

- [ ] **Step 1: เขียน failing tests** `server/providers/messages.test.ts`.
  ```ts
  import { describe, it, expect } from 'vitest'
  import { historyToChatMessages } from './messages'
  import type { StoredMessage } from '../../shared/protocol'

  const msg = (role: 'user' | 'assistant', blocks: StoredMessage['content'], id: string = role): StoredMessage => ({
    id,
    role,
    content: blocks,
    createdAt: 0,
  })

  describe('historyToChatMessages', () => {
    it('maps user/assistant text blocks', () => {
      const out = historyToChatMessages([
        msg('user', [{ type: 'text', text: 'hi' }], 'u1'),
        msg('assistant', [{ type: 'text', text: 'hello' }], 'a1'),
      ])
      expect(out).toEqual([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ])
    })

    it('concatenates multiple text blocks within one message', () => {
      const out = historyToChatMessages([msg('assistant', [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], 'a1')])
      expect(out).toEqual([{ role: 'assistant', content: 'ab' }])
    })

    it('skips non-text blocks (tool_use/tool_result/error) and drops empty messages', () => {
      const out = historyToChatMessages([
        msg('user', [{ type: 'text', text: 'q' }], 'u1'),
        msg('assistant', [{ type: 'error', message: 'boom' }], 'a1'),
        msg('user', [{ type: 'text', text: 'again' }], 'u2'),
      ])
      // error-only assistant dropped → two consecutive users merged
      expect(out).toEqual([{ role: 'user', content: 'q\nagain' }])
    })

    it('merges consecutive same-role messages with newline', () => {
      const out = historyToChatMessages([
        msg('user', [{ type: 'text', text: 'one' }], 'u1'),
        msg('user', [{ type: 'text', text: 'two' }], 'u2'),
      ])
      expect(out).toEqual([{ role: 'user', content: 'one\ntwo' }])
    })

    it('returns [] for empty history', () => {
      expect(historyToChatMessages([])).toEqual([])
    })
  })
  ```

- [ ] **Step 2: รัน เพื่อยืนยัน fail.**
  Run: `npx vitest run server/providers/messages.test.ts`
  Expected: FAIL (`./messages` ยังไม่มี).

- [ ] **Step 3: สร้าง `server/providers/messages.ts`.**
  ```ts
  import type { StoredMessage } from '../../shared/protocol'

  export type ChatMessage = { role: 'user' | 'assistant'; content: string }

  function extractText(m: StoredMessage): string {
    let text = ''
    for (const b of m.content) {
      if (b.type === 'text') text += b.text
    }
    return text
  }

  // Build a clean, alternating-friendly message list from persisted history.
  // - keep only text content (tool_use/tool_result/error blocks are dropped — stateless
  //   providers have no tools, and error rows must not be replayed as assistant turns)
  // - drop messages that have no text after extraction
  // - merge consecutive same-role messages (some OpenAI-compatible servers reject
  //   non-alternating roles; Anthropic tolerates it but merging is harmless)
  export function historyToChatMessages(history: StoredMessage[]): ChatMessage[] {
    const out: ChatMessage[] = []
    for (const m of history) {
      const text = extractText(m)
      if (text === '') continue
      const last = out[out.length - 1]
      if (last && last.role === m.role) {
        last.content += '\n' + text
      } else {
        out.push({ role: m.role, content: text })
      }
    }
    return out
  }
  ```

- [ ] **Step 4: แก้ `server/providers/types.ts`** — เพิ่ม `history` ใน `TurnParams` + import `StoredMessage`.
  ```ts
  import type { ToolCall, Usage, StoredMessage } from '../../shared/protocol'
  ```
  ```ts
  export interface TurnParams {
    userText: string
    cwd?: string
    model?: string
    sdkSessionId?: string
    history?: StoredMessage[]
  }
  ```

- [ ] **Step 5: รัน เพื่อยืนยัน pass.**
  Run: `npx vitest run server/providers/messages.test.ts`
  Expected: PASS.

- [ ] **Step 6: Commit.**
  ```bash
  git add server/providers/types.ts server/providers/messages.ts server/providers/messages.test.ts
  git commit -m "feat(m3): TurnParams.history + historyToChatMessages mapper (shared by stateless providers)"
  ```

---

### Task 5: AnthropicApiProvider

Goal: provider แบบ stateless ที่คุย Anthropic Messages API ผ่าน `@anthropic-ai/sdk` streaming — stream text deltas → `ctx.onDelta`, เก็บ usage, รองรับ interrupt ผ่าน `ctx.signal` (คืน partial text ไม่โยน error). inject `streamFn` เพื่อ unit-test แบบไม่ต่อเน็ต.

**Files:**
- Create: `P:\AI_PROJECT\Claude\WebPage\server\providers\anthropicApi.ts`
- Test: `P:\AI_PROJECT\Claude\WebPage\server\providers\anthropicApi.test.ts`

**Interfaces:**
- Consumes: `Provider`, `ProviderContext`, `TurnParams`, `TurnResult` (types.ts); `Usage` (protocol); `historyToChatMessages` (Task 4); `Anthropic` (`@anthropic-ai/sdk`).
- Produces:
  - `export type AnthropicStreamEvent` (minimal structural type ของ event ที่เราอ่าน).
  - `export type AnthropicStreamFn = (body, opts: { signal: AbortSignal }) => AsyncIterable<AnthropicStreamEvent>`
  - `export class AnthropicApiProvider implements Provider` — `type = 'anthropic-api'`, constructor `{ apiKey: string; defaultModel: string; streamFn?: AnthropicStreamFn }`.

- [ ] **Step 1: เขียน failing tests** `server/providers/anthropicApi.test.ts`.
  ```ts
  import { describe, it, expect } from 'vitest'
  import { AnthropicApiProvider, type AnthropicStreamEvent } from './anthropicApi'
  import type { ProviderContext } from './types'
  import type { StoredMessage } from '../../shared/protocol'

  function ctx(overrides: Partial<ProviderContext> = {}): { ctx: ProviderContext; deltas: string[] } {
    const deltas: string[] = []
    const controller = new AbortController()
    const c: ProviderContext = {
      onDelta: (t) => deltas.push(t),
      onToolCall: () => {},
      onToolResult: () => {},
      permission: { resolve: async () => ({ behavior: 'allow' }) },
      signal: controller.signal,
      ...overrides,
    }
    return { ctx: c, deltas }
  }

  const userHistory: StoredMessage[] = [{ id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }], createdAt: 0 }]

  describe('AnthropicApiProvider', () => {
    it('streams text deltas, accumulates text + usage', async () => {
      async function* fake(): AsyncIterable<AnthropicStreamEvent> {
        yield { type: 'message_start', message: { usage: { input_tokens: 5 } } }
        yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } }
        yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } }
        yield { type: 'message_delta', usage: { output_tokens: 2 } }
        yield { type: 'message_stop' }
      }
      const p = new AnthropicApiProvider({ apiKey: 'sk', defaultModel: 'claude-opus-4-8', streamFn: () => fake() })
      const { ctx: c, deltas } = ctx()
      const result = await p.send({ userText: 'hi', history: userHistory }, c)
      expect(deltas).toEqual(['Hel', 'lo'])
      expect(result.text).toBe('Hello')
      expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 2 })
      expect(result.sdkSessionId).toBeUndefined()
    })

    it('passes model + built messages + signal to streamFn', async () => {
      let captured: { body: unknown; signal: AbortSignal } | undefined
      async function* fake(): AsyncIterable<AnthropicStreamEvent> {
        yield { type: 'message_stop' }
      }
      const p = new AnthropicApiProvider({
        apiKey: 'sk',
        defaultModel: 'claude-opus-4-8',
        streamFn: (body, opts) => {
          captured = { body, signal: opts.signal }
          return fake()
        },
      })
      const { ctx: c } = ctx()
      await p.send({ userText: 'hi', model: 'claude-sonnet-4-6', history: userHistory }, c)
      expect(captured?.body).toMatchObject({
        model: 'claude-sonnet-4-6',
        max_tokens: 16000,
        messages: [{ role: 'user', content: 'hi' }],
      })
      expect(captured?.signal).toBeDefined()
    })

    it('returns partial text without throwing when aborted mid-stream', async () => {
      const controller = new AbortController()
      async function* fake(): AsyncIterable<AnthropicStreamEvent> {
        yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } }
        controller.abort()
        throw new Error('aborted') // SDK throws on abort
      }
      const p = new AnthropicApiProvider({ apiKey: 'sk', defaultModel: 'm', streamFn: () => fake() })
      const { ctx: c, deltas } = ctx({ signal: controller.signal })
      const result = await p.send({ userText: 'hi', history: userHistory }, c)
      expect(deltas).toEqual(['partial'])
      expect(result.text).toBe('partial')
    })

    it('falls back to userText when history is empty', async () => {
      let captured: unknown
      async function* fake(): AsyncIterable<AnthropicStreamEvent> {
        yield { type: 'message_stop' }
      }
      const p = new AnthropicApiProvider({
        apiKey: 'sk',
        defaultModel: 'm',
        streamFn: (body) => {
          captured = body
          return fake()
        },
      })
      const { ctx: c } = ctx()
      await p.send({ userText: 'solo', history: [] }, c)
      expect(captured).toMatchObject({ messages: [{ role: 'user', content: 'solo' }] })
    })
  })
  ```

- [ ] **Step 2: รัน เพื่อยืนยัน fail.**
  Run: `npx vitest run server/providers/anthropicApi.test.ts`
  Expected: FAIL (`./anthropicApi` ยังไม่มี).

- [ ] **Step 3: สร้าง `server/providers/anthropicApi.ts`.**
  ```ts
  import Anthropic from '@anthropic-ai/sdk'
  import type { Usage } from '../../shared/protocol'
  import type { Provider, ProviderContext, TurnParams, TurnResult } from './types'
  import { historyToChatMessages, type ChatMessage } from './messages'

  const DEFAULT_MAX_TOKENS = 16000

  // Minimal structural view of the Anthropic stream events we read. Decouples this
  // provider (and its tests) from the exact SDK event types.
  export type AnthropicStreamEvent =
    | { type: 'message_start'; message: { usage?: { input_tokens?: number } } }
    | { type: 'content_block_delta'; delta: { type: string; text?: string } }
    | { type: 'message_delta'; usage?: { output_tokens?: number } }
    | { type: string }

  export type AnthropicStreamBody = {
    model: string
    max_tokens: number
    messages: ChatMessage[]
  }

  export type AnthropicStreamFn = (
    body: AnthropicStreamBody,
    opts: { signal: AbortSignal },
  ) => AsyncIterable<AnthropicStreamEvent>

  export class AnthropicApiProvider implements Provider {
    readonly type = 'anthropic-api'
    private defaultModel: string
    private streamFn: AnthropicStreamFn

    constructor(opts: { apiKey: string; defaultModel: string; streamFn?: AnthropicStreamFn }) {
      this.defaultModel = opts.defaultModel
      if (opts.streamFn) {
        this.streamFn = opts.streamFn
      } else {
        const client = new Anthropic({ apiKey: opts.apiKey })
        // The SDK's MessageStream is AsyncIterable over raw stream events.
        this.streamFn = (body, o) =>
          client.messages.stream(body as never, { signal: o.signal }) as unknown as AsyncIterable<AnthropicStreamEvent>
      }
    }

    async send(params: TurnParams, ctx: ProviderContext): Promise<TurnResult> {
      const mapped = historyToChatMessages(params.history ?? [])
      const messages: ChatMessage[] = mapped.length > 0 ? mapped : [{ role: 'user', content: params.userText }]
      const model = params.model ?? this.defaultModel

      let text = ''
      let inputTokens: number | undefined
      let outputTokens: number | undefined

      try {
        const stream = this.streamFn({ model, max_tokens: DEFAULT_MAX_TOKENS, messages }, { signal: ctx.signal })
        for await (const ev of stream) {
          if (ctx.signal.aborted) break
          if (ev.type === 'content_block_delta') {
            const d = (ev as { delta: { type: string; text?: string } }).delta
            if (d.type === 'text_delta' && typeof d.text === 'string') {
              text += d.text
              ctx.onDelta(d.text)
            }
          } else if (ev.type === 'message_start') {
            inputTokens = (ev as { message: { usage?: { input_tokens?: number } } }).message.usage?.input_tokens
          } else if (ev.type === 'message_delta') {
            outputTokens = (ev as { usage?: { output_tokens?: number } }).usage?.output_tokens
          }
        }
      } catch (err) {
        // On user interrupt the SDK aborts the stream and throws — return partial
        // text instead of surfacing an error bubble. Re-throw genuine failures.
        if (!ctx.signal.aborted) throw err
      }

      const usage: Usage | undefined =
        inputTokens !== undefined || outputTokens !== undefined ? { inputTokens, outputTokens } : undefined
      return { text, usage }
    }
  }
  ```

- [ ] **Step 4: รัน เพื่อยืนยัน pass.**
  Run: `npx vitest run server/providers/anthropicApi.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit.**
  ```bash
  git add server/providers/anthropicApi.ts server/providers/anthropicApi.test.ts
  git commit -m "feat(m3): AnthropicApiProvider (streaming via @anthropic-ai/sdk, interrupt-safe)"
  ```

---

### Task 6: OpenAICompatibleProvider + SSE parser

Goal: provider แบบ stateless ที่ POST `${baseUrl}/chat/completions` ด้วย `stream:true`, อ่าน SSE `data:` chunks → `choices[0].delta.content` → `ctx.onDelta`. แยก `parseSseData` เป็น pure async generator (test ง่าย). inject `fetchFn` เพื่อ test แบบไม่ต่อเน็ต. interrupt-safe (คืน partial).

**Files:**
- Create: `P:\AI_PROJECT\Claude\WebPage\server\providers\openaiCompat.ts`
- Test: `P:\AI_PROJECT\Claude\WebPage\server\providers\openaiCompat.test.ts`

**Interfaces:**
- Consumes: `Provider`/`ProviderContext`/`TurnParams`/`TurnResult` (types.ts); `Usage` (protocol); `historyToChatMessages`/`ChatMessage` (Task 4).
- Produces:
  - `export async function* parseSseData(chunks: AsyncIterable<Uint8Array | string>): AsyncGenerator<string>` — yield payload หลัง `data:` ของแต่ละ event.
  - `export type FetchLike = (url: string, init: { method: string; headers: Record<string,string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; body: AsyncIterable<Uint8Array | string> | null }>`
  - `export class OpenAICompatibleProvider implements Provider` — `type = 'openai-compatible'`, constructor `{ baseUrl: string; apiKey?: string; defaultModel: string; fetchFn?: FetchLike }`.

- [ ] **Step 1: เขียน failing tests** `server/providers/openaiCompat.test.ts`.
  ```ts
  import { describe, it, expect } from 'vitest'
  import { OpenAICompatibleProvider, parseSseData, type FetchLike } from './openaiCompat'
  import type { ProviderContext } from './types'
  import type { StoredMessage } from '../../shared/protocol'

  async function* chunks(...parts: string[]) {
    for (const p of parts) yield p
  }

  function ctx() {
    const deltas: string[] = []
    const controller = new AbortController()
    const c: ProviderContext = {
      onDelta: (t) => deltas.push(t),
      onToolCall: () => {},
      onToolResult: () => {},
      permission: { resolve: async () => ({ behavior: 'allow' }) },
      signal: controller.signal,
    }
    return { ctx: c, deltas, controller }
  }

  const userHistory: StoredMessage[] = [{ id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }], createdAt: 0 }]

  describe('parseSseData', () => {
    it('extracts data payloads across chunk boundaries', async () => {
      const out: string[] = []
      for await (const d of parseSseData(chunks('data: a\n', '\ndata: b\n\n', 'data: [DONE]\n\n'))) out.push(d)
      expect(out).toEqual(['a', 'b', '[DONE]'])
    })

    it('handles CRLF line endings', async () => {
      const out: string[] = []
      for await (const d of parseSseData(chunks('data: x\r\n\r\n'))) out.push(d)
      expect(out).toEqual(['x'])
    })
  })

  describe('OpenAICompatibleProvider', () => {
    it('streams delta content + parses usage, stops at [DONE]', async () => {
      const body =
        'data: {"choices":[{"delta":{"content":"He"}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n' +
        'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n' +
        'data: [DONE]\n\n'
      const fetchFn: FetchLike = async () => ({ ok: true, status: 200, body: chunks(body) })
      const p = new OpenAICompatibleProvider({ baseUrl: 'https://api.x/v1', apiKey: 'k', defaultModel: 'm', fetchFn })
      const { ctx: c, deltas } = ctx()
      const result = await p.send({ userText: 'hi', history: userHistory }, c)
      expect(deltas).toEqual(['He', 'llo'])
      expect(result.text).toBe('Hello')
      expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2 })
    })

    it('sends POST to {baseUrl}/chat/completions with bearer + model + messages + stream', async () => {
      let captured: { url: string; init: Record<string, unknown> } | undefined
      const fetchFn: FetchLike = async (url, init) => {
        captured = { url, init: init as unknown as Record<string, unknown> }
        return { ok: true, status: 200, body: chunks('data: [DONE]\n\n') }
      }
      const p = new OpenAICompatibleProvider({ baseUrl: 'https://api.x/v1/', apiKey: 'sk', defaultModel: 'gpt-x', fetchFn })
      const { ctx: c } = ctx()
      await p.send({ userText: 'hi', model: 'llama', history: userHistory }, c)
      expect(captured?.url).toBe('https://api.x/v1/chat/completions')
      const headers = (captured?.init.headers as Record<string, string>) ?? {}
      expect(headers.authorization).toBe('Bearer sk')
      const parsed = JSON.parse(captured?.init.body as string)
      expect(parsed).toMatchObject({ model: 'llama', stream: true, messages: [{ role: 'user', content: 'hi' }] })
    })

    it('throws on non-ok response', async () => {
      const fetchFn: FetchLike = async () => ({ ok: false, status: 401, body: null })
      const p = new OpenAICompatibleProvider({ baseUrl: 'https://api.x/v1', defaultModel: 'm', fetchFn })
      const { ctx: c } = ctx()
      await expect(p.send({ userText: 'hi', history: userHistory }, c)).rejects.toThrow(/401/)
    })

    it('returns partial text without throwing when aborted', async () => {
      const { ctx: c, deltas, controller } = ctx()
      async function* aborting() {
        yield 'data: {"choices":[{"delta":{"content":"part"}}]}\n\n'
        controller.abort()
        throw new Error('aborted')
      }
      const fetchFn: FetchLike = async () => ({ ok: true, status: 200, body: aborting() })
      const p = new OpenAICompatibleProvider({ baseUrl: 'https://api.x/v1', defaultModel: 'm', fetchFn })
      const result = await p.send({ userText: 'hi', history: userHistory }, c)
      expect(deltas).toEqual(['part'])
      expect(result.text).toBe('part')
    })

    it('omits authorization header when no apiKey', async () => {
      let headers: Record<string, string> = {}
      const fetchFn: FetchLike = async (_url, init) => {
        headers = init.headers
        return { ok: true, status: 200, body: chunks('data: [DONE]\n\n') }
      }
      const p = new OpenAICompatibleProvider({ baseUrl: 'https://api.x/v1', defaultModel: 'm', fetchFn })
      const { ctx: c } = ctx()
      await p.send({ userText: 'hi', history: userHistory }, c)
      expect(headers.authorization).toBeUndefined()
    })
  })
  ```

- [ ] **Step 2: รัน เพื่อยืนยัน fail.**
  Run: `npx vitest run server/providers/openaiCompat.test.ts`
  Expected: FAIL.

- [ ] **Step 3: สร้าง `server/providers/openaiCompat.ts`.**
  ```ts
  import type { Usage } from '../../shared/protocol'
  import type { Provider, ProviderContext, TurnParams, TurnResult } from './types'
  import { historyToChatMessages, type ChatMessage } from './messages'

  export type FetchLike = (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
  ) => Promise<{ ok: boolean; status: number; body: AsyncIterable<Uint8Array | string> | null }>

  // Parse an SSE byte/string stream into the payload after each `data:` line.
  // Buffers across chunk boundaries; tolerates CRLF.
  export async function* parseSseData(chunks: AsyncIterable<Uint8Array | string>): AsyncGenerator<string> {
    const decoder = new TextDecoder()
    let buffer = ''
    const drain = function* (block: string): Generator<string> {
      for (const line of block.split('\n')) {
        if (line.startsWith('data:')) yield line.slice(5).trimStart()
      }
    }
    for await (const chunk of chunks) {
      buffer += (typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })).replace(/\r/g, '')
      let idx: number
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        yield* drain(block)
      }
    }
    if (buffer.length > 0) yield* drain(buffer)
  }

  const defaultFetch: FetchLike = async (url, init) => {
    const res = await fetch(url, init)
    return { ok: res.ok, status: res.status, body: res.body as AsyncIterable<Uint8Array> | null }
  }

  export class OpenAICompatibleProvider implements Provider {
    readonly type = 'openai-compatible'
    private baseUrl: string
    private apiKey?: string
    private defaultModel: string
    private fetchFn: FetchLike

    constructor(opts: { baseUrl: string; apiKey?: string; defaultModel: string; fetchFn?: FetchLike }) {
      this.baseUrl = opts.baseUrl.replace(/\/$/, '')
      this.apiKey = opts.apiKey
      this.defaultModel = opts.defaultModel
      this.fetchFn = opts.fetchFn ?? defaultFetch
    }

    async send(params: TurnParams, ctx: ProviderContext): Promise<TurnResult> {
      const mapped = historyToChatMessages(params.history ?? [])
      const messages: ChatMessage[] = mapped.length > 0 ? mapped : [{ role: 'user', content: params.userText }]
      const model = params.model ?? this.defaultModel

      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`

      let text = ''
      let usage: Usage | undefined
      try {
        const res = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ model, messages, stream: true }),
          signal: ctx.signal,
        })
        if (!res.ok) throw new Error(`OpenAI-compatible request failed: HTTP ${res.status}`)
        if (!res.body) throw new Error('OpenAI-compatible response had no body')
        for await (const data of parseSseData(res.body)) {
          if (data === '[DONE]') break
          let json: unknown
          try {
            json = JSON.parse(data)
          } catch {
            continue
          }
          const obj = json as {
            choices?: { delta?: { content?: unknown } }[]
            usage?: { prompt_tokens?: number; completion_tokens?: number }
          }
          const delta = obj.choices?.[0]?.delta?.content
          if (typeof delta === 'string' && delta) {
            text += delta
            ctx.onDelta(delta)
          }
          if (obj.usage) usage = { inputTokens: obj.usage.prompt_tokens, outputTokens: obj.usage.completion_tokens }
        }
      } catch (err) {
        if (!ctx.signal.aborted) throw err
      }
      return { text, usage }
    }
  }
  ```

- [ ] **Step 4: รัน เพื่อยืนยัน pass.**
  Run: `npx vitest run server/providers/openaiCompat.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit.**
  ```bash
  git add server/providers/openaiCompat.ts server/providers/openaiCompat.test.ts
  git commit -m "feat(m3): OpenAICompatibleProvider + SSE parser (interrupt-safe)"
  ```

---

### Task 7: Provider factory + hub provider-type routing (the seam) + ChatRuntime history + boot

Goal: นี่คือ task ที่ทั้ง milestone แขวนอยู่ (M2 carry-over). สร้าง `makeProvider(cfg)` factory ที่ switch 3 provider type; เปลี่ยน `server/hub.ts` `getOrCreateRuntime` ให้เลิก hardcode `'local-agent'` แล้ว resolve `connection.type` + secret จริงจาก DB; ให้ `create_chat` ใช้ `connectionId`; ให้ `ChatRuntime` ส่ง `history` (จาก `listMessages`) เข้า provider; wire factory จริงใน `server/index.ts`.

**Files:**
- Create: `P:\AI_PROJECT\Claude\WebPage\server\providers\index.ts`
- Test: `P:\AI_PROJECT\Claude\WebPage\server\providers\index.test.ts`
- Modify: `P:\AI_PROJECT\Claude\WebPage\server\hub.ts` (+ `server\hub.test.ts`), `server\chatRuntime.ts`, `server\index.ts`

**Interfaces:**
- Consumes: `LocalAgentProvider`, `AnthropicApiProvider`, `OpenAICompatibleProvider`, `Provider`; `getConnectionWithSecret`, `getConnection` (store); `listMessages` (store); `TurnParams.history`.
- Produces:
  - `export type ProviderConfig = { type: string; baseUrl?: string; apiKey?: string; defaultModel: string }`
  - `export function makeProvider(cfg: ProviderConfig): Provider`
  - `HubDeps.makeProvider` signature → `(cfg: ProviderConfig) => Provider`.

- [ ] **Step 1: เขียน failing test** `server/providers/index.test.ts`.
  ```ts
  import { describe, it, expect } from 'vitest'
  import { makeProvider } from './index'
  import { LocalAgentProvider } from './localAgent'
  import { AnthropicApiProvider } from './anthropicApi'
  import { OpenAICompatibleProvider } from './openaiCompat'

  describe('makeProvider', () => {
    it('returns LocalAgentProvider for local-agent', () => {
      const p = makeProvider({ type: 'local-agent', defaultModel: 'sonnet' })
      expect(p).toBeInstanceOf(LocalAgentProvider)
      expect(p.type).toBe('local-agent')
    })
    it('returns AnthropicApiProvider for anthropic-api', () => {
      const p = makeProvider({ type: 'anthropic-api', apiKey: 'sk', defaultModel: 'claude-opus-4-8' })
      expect(p).toBeInstanceOf(AnthropicApiProvider)
      expect(p.type).toBe('anthropic-api')
    })
    it('returns OpenAICompatibleProvider for openai-compatible', () => {
      const p = makeProvider({ type: 'openai-compatible', baseUrl: 'https://x/v1', apiKey: 'k', defaultModel: 'm' })
      expect(p).toBeInstanceOf(OpenAICompatibleProvider)
      expect(p.type).toBe('openai-compatible')
    })
    it('throws when anthropic-api has no apiKey', () => {
      expect(() => makeProvider({ type: 'anthropic-api', defaultModel: 'm' })).toThrow(/api key/i)
    })
    it('throws when openai-compatible has no baseUrl', () => {
      expect(() => makeProvider({ type: 'openai-compatible', apiKey: 'k', defaultModel: 'm' })).toThrow(/base url/i)
    })
    it('throws for unknown type', () => {
      expect(() => makeProvider({ type: 'nope', defaultModel: 'm' })).toThrow(/unknown provider type/i)
    })
  })
  ```

- [ ] **Step 2: รัน เพื่อยืนยัน fail.** Run: `npx vitest run server/providers/index.test.ts` → FAIL.

- [ ] **Step 3: สร้าง `server/providers/index.ts`.**
  ```ts
  import type { Provider } from './types'
  import { LocalAgentProvider } from './localAgent'
  import { AnthropicApiProvider } from './anthropicApi'
  import { OpenAICompatibleProvider } from './openaiCompat'

  export type ProviderConfig = {
    type: string
    baseUrl?: string
    apiKey?: string
    defaultModel: string
  }

  export function makeProvider(cfg: ProviderConfig): Provider {
    switch (cfg.type) {
      case 'local-agent':
        return new LocalAgentProvider()
      case 'anthropic-api':
        if (!cfg.apiKey) throw new Error('anthropic-api connection requires an api key')
        return new AnthropicApiProvider({ apiKey: cfg.apiKey, defaultModel: cfg.defaultModel })
      case 'openai-compatible':
        if (!cfg.baseUrl) throw new Error('openai-compatible connection requires a base url')
        return new OpenAICompatibleProvider({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, defaultModel: cfg.defaultModel })
      default:
        throw new Error(`unknown provider type: ${cfg.type}`)
    }
  }
  ```

- [ ] **Step 4: รัน เพื่อยืนยัน pass.** Run: `npx vitest run server/providers/index.test.ts` → PASS.

- [ ] **Step 5: แก้ `server/chatRuntime.ts` — ส่ง history เข้า provider.**
  5a. เพิ่ม `listMessages` ใน import จาก `./store`:
  ```ts
  import { type DB, getChat, getChatSdkSession, setChatSdkSession, appendMessage, listMessages } from './store'
  ```
  5b. ใน `runOne`, หลังบรรทัด `const sdkSessionId = getChatSdkSession(this.deps.db, this.chatId)` เพิ่ม:
  ```ts
      const history = listMessages(this.deps.db, this.chatId)
  ```
  5c. ใน object params ที่ส่งเข้า `runTurn` เพิ่ม `history`:
  ```ts
        {
          userText,
          cwd: chat?.cwd,
          model: chat?.model ?? 'sonnet',
          sdkSessionId,
          history,
        },
  ```

- [ ] **Step 6: รัน chatRuntime tests (ยังเขียวเพราะ FakeProvider/recording provider ไม่อ่าน history).** Run: `npx vitest run server/chatRuntime.test.ts` → PASS (เท่าเดิม).

- [ ] **Step 7: แก้ `server/hub.ts` — provider-type routing + create_chat connectionId.**
  7a. แก้ import จาก `./store` ให้รวม `getConnection` + `getConnectionWithSecret`:
  ```ts
  import {
    DEFAULT_CONNECTION_ID,
    getChat,
    getConnection,
    getConnectionWithSecret,
    createChat,
    listChats,
    listMessages,
    renameChat,
    deleteChat,
    type DB,
  } from './store'
  ```
  7b. import `ProviderConfig`:
  ```ts
  import type { Provider } from './providers/types'
  import type { ProviderConfig } from './providers/index'
  ```
  7c. เปลี่ยน `HubDeps.makeProvider` signature:
  ```ts
  export type HubDeps = {
    db: DB
    makeProvider: (cfg: ProviderConfig) => Provider
    genId: () => string
    now: () => number
    turnTimeoutMs?: number
  }
  ```
  7d. แทน `getOrCreateRuntime` ทั้งฟังก์ชัน:
  ```ts
    private getOrCreateRuntime(chatId: string): ChatRuntime {
      let rt = this.runtimes.get(chatId)
      if (rt) return rt
      const chat = getChat(this.deps.db, chatId)
      const conn = chat ? getConnectionWithSecret(this.deps.db, chat.connectionId) : undefined
      if (!conn) throw new Error(`no connection resolved for chat ${chatId}`)
      const cfg: ProviderConfig = { type: conn.type, defaultModel: conn.defaultModel }
      if (conn.baseUrl !== undefined) cfg.baseUrl = conn.baseUrl
      if (conn.apiKey !== undefined) cfg.apiKey = conn.apiKey
      rt = new ChatRuntime(chatId, {
        db: this.deps.db,
        provider: this.deps.makeProvider(cfg),
        broadcast: (m) => this.broadcast(m),
        genId: this.deps.genId,
        now: this.deps.now,
        turnTimeoutMs: this.deps.turnTimeoutMs,
        onActivity: () => this.broadcastAll({ type: 'chat_list', chats: listChats(this.deps.db) }),
      })
      this.runtimes.set(chatId, rt)
      return rt
    }
  ```
  7e. แทน `create_chat` case ใน `route`:
  ```ts
        case 'create_chat': {
          const id = this.deps.genId()
          const now = this.deps.now()
          const connectionId = msg.connectionId ?? DEFAULT_CONNECTION_ID
          const conn = getConnection(this.deps.db, connectionId)
          if (!conn) {
            send({ type: 'error', message: 'connection not found' })
            break
          }
          const chat = createChat(this.deps.db, {
            id,
            title: msg.title ?? 'New chat',
            connectionId,
            model: msg.model ?? conn.defaultModel,
            cwd: msg.cwd,
            now,
          })
          send({ type: 'chat_created', chat })
          this.subscribe(chat.id, send)
          this.broadcastAll({ type: 'chat_list', chats: listChats(this.deps.db) })
          break
        }
  ```

- [ ] **Step 8: เพิ่ม regression test ใน `server/hub.test.ts`** — chat ที่ผูก connection แบบ anthropic-api ทำให้ `makeProvider` ถูกเรียกด้วย cfg.type ที่ถูกต้อง (api_key ไม่รั่วผ่าน provider list).
  เพิ่ม import:
  ```ts
  import { openDb, listChats, listMessages, getChat, createConnection } from './store'
  import type { Provider, ProviderConfig } from './providers/types'
  ```
  (หมายเหตุ: `ProviderConfig` export จาก `./providers/index` — ปรับ import ให้ตรง: `import type { ProviderConfig } from './providers/index'`.)
  เพิ่มเทสต์ใหม่ก่อนปิด `describe`:
  ```ts
    it('(10) routes provider by the chat\'s connection.type via makeProvider(cfg)', async () => {
      const db = openDb(':memory:')
      createConnection(db, {
        id: 'anth',
        type: 'anthropic-api',
        name: 'Anthropic',
        apiKey: 'sk-secret',
        defaultModel: 'claude-opus-4-8',
        now: 500,
      })
      const cfgs: ProviderConfig[] = []
      let idN = 0
      let nowN = 1000
      const stubProvider: Provider = {
        type: 'stub',
        async send(_p, ctx) {
          ctx.onDelta('ok')
          return { text: 'ok' }
        },
      }
      const hub = new ChatHub({
        db,
        makeProvider: (cfg) => {
          cfgs.push(cfg)
          return stubProvider
        },
        genId: () => `id-${++idN}`,
        now: () => ++nowN,
      })
      const sent: ServerMsg[] = []
      const handle = hub.addConnection((m) => sent.push(m))
      handle.handle(JSON.stringify({ type: 'create_chat', title: 'A', connectionId: 'anth' }))
      const chatId = (sent.find((m) => m.type === 'chat_created') as Extract<ServerMsg, { type: 'chat_created' }>).chat.id
      handle.handle(JSON.stringify({ type: 'user_message', chatId, text: 'hi' }))
      await waitFor(() => sent.some((m) => m.type === 'turn_done'))
      // makeProvider received the REAL connection type + secret server-side
      expect(cfgs[0]).toMatchObject({ type: 'anthropic-api', defaultModel: 'claude-opus-4-8', apiKey: 'sk-secret' })
    })
  ```

- [ ] **Step 9: แก้ `server/index.ts` — wire factory.**
  9a. เปลี่ยน import:
  ```ts
  import { makeProvider } from './providers/index'
  ```
  (ลบ `import { LocalAgentProvider } from './providers/localAgent'`.)
  9b. เปลี่ยน hub ctor:
  ```ts
  const hub = new ChatHub({
    db,
    makeProvider,
    genId: randomUUID,
    now: Date.now,
  })
  ```

- [ ] **Step 10: รัน hub + chatRuntime suites.** Run: `npx vitest run server/hub.test.ts server/chatRuntime.test.ts` → PASS (เดิม + (10) ใหม่).

- [ ] **Step 11: Commit.**
  ```bash
  git add server/providers/index.ts server/providers/index.test.ts server/hub.ts server/hub.test.ts server/chatRuntime.ts server/index.ts
  git commit -m "feat(m3): provider-type routing — makeProvider(cfg) factory + hub resolves connection.type; ChatRuntime passes history"
  ```

---

### Task 8: MAJOR#1 — persist error/timeout into history (no empty assistant row) + cancel pending on turn end

Goal: เมื่อ turn จบด้วย error/timeout, `ChatRuntime` ต้อง **ไม่** persist assistant row ว่าง อีกต่อไป — แต่เก็บข้อความ error เป็น `StoredContentBlock` variant `error` (reload เห็น error bubble) และถ้า turn ไม่มีทั้ง content และ error (เช่น interrupt ก่อนมี output) ให้ข้ามการ persist. เพิ่ม cancel pending permission ตอน turn จบ (กัน pending รั่วเมื่อ timeout — server-side ส่วนของ MAJOR#2).

**Files:**
- Modify: `P:\AI_PROJECT\Claude\WebPage\server\chatRuntime.ts`
- Test: `P:\AI_PROJECT\Claude\WebPage\server\chatRuntime.test.ts`

**Interfaces:**
- Consumes: `StoredContentBlock` `error` variant (Task 2); `InteractivePermissionResolver.cancelAll` (existing).
- Produces: (behavioral) failed turn → assistant row with `[{type:'error', message}]`; empty turn → no row; pending cancelled at turn end.

- [ ] **Step 1: เขียน failing tests** (เพิ่มใน `server/chatRuntime.test.ts`).
  ```ts
  import type { PermissionDecision } from './permission'

  it('(h) #M1: a turn that throws persists an error block (not an empty assistant row)', async () => {
    const throwing: Provider = {
      type: 'throwing',
      async send(): Promise<TurnResult> {
        throw new Error('boom from provider')
      },
    }
    const { deps, sent } = makeDeps({ provider: throwing })
    const rt = new ChatRuntime('c1', deps)
    rt.enqueue('hi')
    await tick(20)
    // error + turn_done emitted
    expect(countType(sent, 'error')).toBe(1)
    expect(countType(sent, 'turn_done')).toBe(1)
    // persisted: user row + ONE assistant row whose content is an error block
    const msgs = listMessages(deps.db, 'c1')
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(msgs[1].content).toEqual([{ type: 'error', message: 'boom from provider' }])
  })

  it('(i) #M1: timeout persists error block + cancels the parked permission', async () => {
    let decision: PermissionDecision | undefined
    const parking: Provider = {
      type: 'parking',
      async send(_p, ctx): Promise<TurnResult> {
        decision = await ctx.permission.resolve('Write', {})
        return { text: '' }
      },
    }
    const { deps, sent } = makeDeps({ provider: parking, turnTimeoutMs: 20 })
    const rt = new ChatRuntime('c1', deps)
    rt.enqueue('hi')
    await tick(40)
    expect(sent.some((m) => m.type === 'error' && m.message === 'turn timed out')).toBe(true)
    // pending permission was cancelled at turn end (denied), not left hanging
    expect(decision).toEqual({ behavior: 'deny', message: 'turn ended' })
    // error block persisted
    const asst = listMessages(deps.db, 'c1').find((m) => m.role === 'assistant')
    expect(asst?.content).toEqual([{ type: 'error', message: 'turn timed out' }])
  })

  it('(j) #M1: an interrupted turn with no output and no error persists no assistant row', async () => {
    const holder: { release: (() => void) | undefined } = { release: undefined }
    const silent: Provider = {
      type: 'silent',
      async send(_p, ctx): Promise<TurnResult> {
        await new Promise<void>((r) => { holder.release = r })
        return { text: '' }
      },
    }
    const { deps } = makeDeps({ provider: silent })
    const rt = new ChatRuntime('c1', deps)
    rt.enqueue('hi')
    await tick()
    rt.interrupt() // aborts; provider returns {text:''} with no deltas/errors
    holder.release?.()
    await tick(20)
    const msgs = listMessages(deps.db, 'c1')
    expect(msgs.filter((m) => m.role === 'assistant')).toHaveLength(0)
  })
  ```
  (เพิ่ม import `type { PermissionDecision } from './permission'` ที่หัวไฟล์ถ้ายังไม่มี.)

- [ ] **Step 2: รัน เพื่อยืนยัน fail.** Run: `npx vitest run server/chatRuntime.test.ts` → FAIL (tests h/i/j).

- [ ] **Step 3: แก้ `server/chatRuntime.ts` `runOne`.**
  3a. เพิ่มตัวสะสม error ข้างบนคู่กับ `toolUseBlocks`/`toolResultBlocks`:
  ```ts
      const errorMessages: string[] = []
  ```
  3b. ใน `accumulatingSend` เพิ่ม branch สำหรับ error:
  ```ts
      const accumulatingSend = (m: ServerMsg): void => {
        this.deps.broadcast(m)
        if (m.type === 'assistant_delta') {
          accumulatedText += m.text
        } else if (m.type === 'tool_call') {
          toolUseBlocks.push({ type: 'tool_use', id: m.id, name: m.name, input: m.input })
        } else if (m.type === 'tool_result') {
          toolResultBlocks.push({ type: 'tool_result', id: m.id, result: m.result })
        } else if (m.type === 'error') {
          errorMessages.push(m.message)
        }
      }
  ```
  3c. แทนบล็อกประกอบ + persist assistant (ส่วนหลัง `if (this.disposed) return`):
  ```ts
        if (this.disposed) return

        // Build ONE assistant row. On a failed/timed-out turn (no content) persist an
        // error block so the failure survives reload; on a truly empty turn (e.g.
        // interrupted before any output) persist nothing.
        const content: StoredContentBlock[] = []
        const text = accumulatedText !== '' ? accumulatedText : result.text
        if (text !== '') content.push({ type: 'text', text })
        content.push(...toolUseBlocks)
        content.push(...toolResultBlocks)
        if (content.length === 0 && errorMessages.length > 0) {
          content.push({ type: 'error', message: errorMessages.join('\n') })
        }

        if (content.length > 0) {
          const usage: Usage | undefined = result.usage
          const asstMsg: StoredMessage & { chatId: string } = {
            chatId: this.chatId,
            id: this.deps.genId(),
            role: 'assistant',
            content,
            usage,
            createdAt: this.deps.now(),
          }
          appendMessage(this.deps.db, asstMsg)
        }

        if (result.sdkSessionId) {
          setChatSdkSession(this.deps.db, this.chatId, result.sdkSessionId, this.deps.now())
          if (!this.disposed) this.deps.onActivity?.()
        }
  ```
  3d. ใน `finally` ของ `runOne` เพิ่ม cancel pending (หลัง `abort.abort()`):
  ```ts
      } finally {
        abort.abort()
        // Deny any permission left parked by a timed-out/errored turn so the provider's
        // canUseTool promise never hangs across turns (server side of MAJOR#2).
        this.permission.cancelAll('turn ended')
        if (this.currentAbort === abort) this.currentAbort = null
      }
  ```

- [ ] **Step 4: รัน เพื่อยืนยัน pass.** Run: `npx vitest run server/chatRuntime.test.ts` → PASS (เดิม + h/i/j).
  หมายเหตุ: ตรวจว่า test เดิม (a)/(d) ยังเขียว — (a) content ไม่ว่าง → persist ปกติ; (d) parked turn ถูก deny แล้วยังมี output → persist ปกติ.

- [ ] **Step 5: Commit.**
  ```bash
  git add server/chatRuntime.ts server/chatRuntime.test.ts
  git commit -m "fix(m3): persist error/timeout turns as error block (no empty assistant row) + cancel parked permission at turn end (M2 MAJOR#1)"
  ```

---

### Task 9: Connection CRUD over WebSocket + connection_list broadcast (server tsc gate)

Goal: ให้ hub route `create_connection`/`update_connection`/`delete_connection`, broadcast `connection_list` (ทุก socket) และส่ง connection_list ตอน addConnection (คู่กับ chat_list). delete guard: ห้ามลบ `local` หรือ connection ที่มีห้องอ้างอยู่. นี่คือจุดที่ **server+shared tsc เขียวครบ**.

**Files:**
- Modify: `P:\AI_PROJECT\Claude\WebPage\server\hub.ts`
- Test: `P:\AI_PROJECT\Claude\WebPage\server\hub.test.ts`

**Interfaces:**
- Consumes: `listConnections`, `createConnection`, `updateConnection`, `deleteConnection`, `countChatsForConnection`, `DEFAULT_CONNECTION_ID` (store).
- Produces: WS handling ของ connection CRUD; `connection_list` broadcast; invariant api_key ไม่ออก wire (ใช้ `listConnections` ที่ omit api_key อยู่แล้ว).

- [ ] **Step 1: เขียน failing tests** (เพิ่มใน `server/hub.test.ts`).
  ```ts
  it('(11) addConnection sends connection_list immediately (with seeded local, no api_key)', () => {
    const { hub } = makeHub()
    const sent: ServerMsg[] = []
    hub.addConnection((m) => sent.push(m))
    const cl = sent.find((m) => m.type === 'connection_list') as Extract<ServerMsg, { type: 'connection_list' }>
    expect(cl).toBeTruthy()
    expect(cl.connections.some((c) => c.id === 'local')).toBe(true)
    expect(cl.connections.every((c) => (c as Record<string, unknown>).apiKey === undefined)).toBe(true)
  })

  it('(12) create_connection -> broadcastAll connection_list including the new one (no api_key)', () => {
    const { hub } = makeHub()
    const sent: ServerMsg[] = []
    const handle = hub.addConnection((m) => sent.push(m))
    handle.handle(
      JSON.stringify({
        type: 'create_connection',
        name: 'My Anthropic',
        providerType: 'anthropic-api',
        apiKey: 'sk-secret',
        defaultModel: 'claude-opus-4-8',
      }),
    )
    const lists = sent.filter((m) => m.type === 'connection_list') as Extract<ServerMsg, { type: 'connection_list' }>[]
    const last = lists[lists.length - 1]
    const added = last.connections.find((c) => c.name === 'My Anthropic')
    expect(added).toMatchObject({ type: 'anthropic-api', defaultModel: 'claude-opus-4-8' })
    expect((added as Record<string, unknown>).apiKey).toBeUndefined()
  })

  it('(13) update_connection changes name/model in next connection_list', () => {
    const { hub } = makeHub()
    const sent: ServerMsg[] = []
    const handle = hub.addConnection((m) => sent.push(m))
    handle.handle(
      JSON.stringify({ type: 'create_connection', name: 'A', providerType: 'openai-compatible', baseUrl: 'https://x/v1', defaultModel: 'm1' }),
    )
    const created = (sent.filter((m) => m.type === 'connection_list').pop() as Extract<ServerMsg, { type: 'connection_list' }>).connections.find((c) => c.name === 'A')!
    handle.handle(JSON.stringify({ type: 'update_connection', id: created.id, name: 'B', defaultModel: 'm2' }))
    const last = (sent.filter((m) => m.type === 'connection_list').pop() as Extract<ServerMsg, { type: 'connection_list' }>).connections.find((c) => c.id === created.id)!
    expect(last.name).toBe('B')
    expect(last.defaultModel).toBe('m2')
  })

  it('(14) delete_connection refuses to delete local (error, still present)', () => {
    const { hub } = makeHub()
    const sent: ServerMsg[] = []
    const handle = hub.addConnection((m) => sent.push(m))
    handle.handle(JSON.stringify({ type: 'delete_connection', id: 'local' }))
    expect(sent.some((m) => m.type === 'error')).toBe(true)
    const last = sent.filter((m) => m.type === 'connection_list').pop() as Extract<ServerMsg, { type: 'connection_list' }>
    expect(last.connections.some((c) => c.id === 'local')).toBe(true)
  })

  it('(15) delete_connection refuses when chats reference it', () => {
    const { hub } = makeHub()
    const sent: ServerMsg[] = []
    const handle = hub.addConnection((m) => sent.push(m))
    handle.handle(JSON.stringify({ type: 'create_connection', name: 'A', providerType: 'anthropic-api', apiKey: 'k', defaultModel: 'm' }))
    const conn = (sent.filter((m) => m.type === 'connection_list').pop() as Extract<ServerMsg, { type: 'connection_list' }>).connections.find((c) => c.name === 'A')!
    handle.handle(JSON.stringify({ type: 'create_chat', title: 'bound', connectionId: conn.id }))
    sent.length = 0
    handle.handle(JSON.stringify({ type: 'delete_connection', id: conn.id }))
    expect(sent.some((m) => m.type === 'error')).toBe(true)
  })

  it('(16) delete_connection removes an unused connection', () => {
    const { hub } = makeHub()
    const sent: ServerMsg[] = []
    const handle = hub.addConnection((m) => sent.push(m))
    handle.handle(JSON.stringify({ type: 'create_connection', name: 'A', providerType: 'anthropic-api', apiKey: 'k', defaultModel: 'm' }))
    const conn = (sent.filter((m) => m.type === 'connection_list').pop() as Extract<ServerMsg, { type: 'connection_list' }>).connections.find((c) => c.name === 'A')!
    handle.handle(JSON.stringify({ type: 'delete_connection', id: conn.id }))
    const last = sent.filter((m) => m.type === 'connection_list').pop() as Extract<ServerMsg, { type: 'connection_list' }>
    expect(last.connections.some((c) => c.id === conn.id)).toBe(false)
  })
  ```

- [ ] **Step 2: รัน เพื่อยืนยัน fail.** Run: `npx vitest run server/hub.test.ts` → FAIL (11–16).

- [ ] **Step 3: แก้ `server/hub.ts`.**
  3a. เพิ่มใน import จาก `./store`: `listConnections, createConnection, updateConnection, deleteConnection, countChatsForConnection`.
  3b. ใน `addConnection` หลัง `send({ type: 'chat_list', ... })` เพิ่ม:
  ```ts
      send({ type: 'connection_list', connections: listConnections(this.deps.db) })
  ```
  3c. เพิ่ม helper:
  ```ts
    private broadcastConnections(): void {
      this.broadcastAll({ type: 'connection_list', connections: listConnections(this.deps.db) })
    }
  ```
  3d. เพิ่ม cases ใน `route` (ก่อน `list_dirs` หรือหลัง — ที่ใดก็ได้ใน switch):
  ```ts
        case 'create_connection': {
          const id = this.deps.genId()
          const now = this.deps.now()
          createConnection(this.deps.db, {
            id,
            type: msg.providerType,
            name: msg.name,
            baseUrl: msg.baseUrl,
            apiKey: msg.apiKey,
            defaultModel: msg.defaultModel,
            now,
          })
          this.broadcastConnections()
          break
        }
        case 'update_connection': {
          updateConnection(
            this.deps.db,
            msg.id,
            { name: msg.name, baseUrl: msg.baseUrl, apiKey: msg.apiKey, defaultModel: msg.defaultModel },
            this.deps.now(),
          )
          this.broadcastConnections()
          break
        }
        case 'delete_connection': {
          if (msg.id === DEFAULT_CONNECTION_ID) {
            send({ type: 'error', message: 'cannot delete the default local connection' })
            break
          }
          if (countChatsForConnection(this.deps.db, msg.id) > 0) {
            send({ type: 'error', message: 'cannot delete a connection that has chats' })
            break
          }
          deleteConnection(this.deps.db, msg.id)
          this.broadcastConnections()
          break
        }
  ```
  หมายเหตุ: `createConnection`/`updateConnection` รับ `baseUrl?`/`apiKey?` แบบ `undefined`-able — ส่ง `msg.baseUrl`/`msg.apiKey` ตรง ๆ (undefined = ไม่ตั้ง/ไม่แก้). store `updateConnection` แก้เฉพาะ field ที่ `!== undefined` แล้ว.

- [ ] **Step 4: รัน เพื่อยืนยัน pass.** Run: `npx vitest run server/hub.test.ts` → PASS (เดิม + 11–16).

- [ ] **Step 5: server+shared tsc gate (authoritative).**
  Run: `npx tsc --noEmit`
  Expected: **clean** (0 errors). ถ้ามี error ในไฟล์ server/shared ให้แก้ก่อน commit. (web ยังไม่ถูก include ใน root tsconfig — ไม่เกี่ยว.)

- [ ] **Step 6: รัน server suite ทั้งหมด.** Run: `npx vitest run server shared` → PASS.

- [ ] **Step 7: Commit.**
  ```bash
  git add server/hub.ts server/hub.test.ts
  git commit -m "feat(m3): connection CRUD over WS + connection_list broadcast + delete guards (server tsc green)"
  ```

---

### Task 10: Frontend state — connections, permission FIFO queue (scoped to active), seed views, error-in-history

Goal: ขยาย `web/src/appState.ts`: เก็บ `connections[]`; เปลี่ยน permission จาก single `pending` → `pendingQueue` (FIFO) + selector `activePrompt` ที่ scope กับ activeChatId (MAJOR#2); seed views ใน `chat_list` (MAJOR#3); render error block ใน `historyToView` (MAJOR#1 ฝั่ง reload); `chat_deleted` ล้างคำขอ permission ของห้องนั้นออกจาก queue (NIT). อัปเดต test เดิมที่อ้าง `pending`/`clearPending`.

**Files:**
- Modify: `P:\AI_PROJECT\Claude\WebPage\web\src\appState.ts`
- Test: `P:\AI_PROJECT\Claude\WebPage\web\src\appState.test.ts`

**Interfaces:**
- Consumes: `ConnectionMeta`, `StoredContentBlock` `error` (protocol).
- Produces:
  - `AppState` += `connections: ConnectionMeta[]`; `pending?` → `pendingQueue: PermissionPrompt[]`.
  - `export function activePrompt(state): PermissionPrompt | undefined`
  - `export function dequeuePending(state, requestId): AppState` (แทน `clearPending`)
  - `chat_list` seed views; `connection_list` reducer; `historyToView` error rendering; `chat_deleted` queue cleanup.

- [ ] **Step 1: อัปเดต/เขียน failing tests** ใน `web/src/appState.test.ts`.
  1a. แก้ import ด้านบน: เปลี่ยน `clearPending` → `dequeuePending` + เพิ่ม `activePrompt`, และ import `ConnectionMeta`:
  ```ts
  import {
    initialAppState,
    applyServer,
    appendUser,
    setActiveChat,
    dequeuePending,
    activePrompt,
    closeFolder,
    type AppState,
  } from './appState'
  import type { ChatMeta, StoredMessage, ConnectionMeta } from '@shared/protocol'
  ```
  1b. แทนเทสต์ `permission_request sets state.pending with chatId` ด้วย:
  ```ts
  it('permission_request enqueues into pendingQueue; activePrompt scopes to activeChatId', () => {
    let s: AppState = applyServer(initialAppState, { type: 'chat_created', chat: meta('c1') }) // c1 active
    s = applyServer(s, { type: 'permission_request', chatId: 'c1', requestId: 'r1', name: 'Write', input: {} })
    expect(s.pendingQueue).toEqual([{ chatId: 'c1', requestId: 'r1', name: 'Write', input: {} }])
    expect(activePrompt(s)).toEqual({ chatId: 'c1', requestId: 'r1', name: 'Write', input: {} })
  })

  it('a permission_request for a non-active chat is queued but NOT shown (no hijack)', () => {
    let s: AppState = applyServer(initialAppState, { type: 'chat_created', chat: meta('c1') }) // c1 active
    s = applyServer(s, { type: 'chat_created', chat: meta('c2') }) // now c2 active
    s = applyServer(s, { type: 'permission_request', chatId: 'c1', requestId: 'r1', name: 'Write', input: {} })
    expect(s.pendingQueue).toHaveLength(1)
    expect(activePrompt(s)).toBeUndefined() // c1's prompt not shown while c2 active
    s = setActiveChat(s, 'c1')
    expect(activePrompt(s)?.requestId).toBe('r1') // appears after switching to c1
  })

  it('two concurrent requests for the active chat both survive (FIFO, no overwrite)', () => {
    let s: AppState = applyServer(initialAppState, { type: 'chat_created', chat: meta('c1') })
    s = applyServer(s, { type: 'permission_request', chatId: 'c1', requestId: 'r1', name: 'Write', input: {} })
    s = applyServer(s, { type: 'permission_request', chatId: 'c1', requestId: 'r2', name: 'Bash', input: {} })
    expect(s.pendingQueue.map((p) => p.requestId)).toEqual(['r1', 'r2'])
    expect(activePrompt(s)?.requestId).toBe('r1') // head shown first
    s = dequeuePending(s, 'r1')
    expect(activePrompt(s)?.requestId).toBe('r2') // next surfaces
  })
  ```
  1c. แทนเทสต์ `clearPending removes the pending prompt` ด้วย:
  ```ts
  it('dequeuePending removes the answered prompt by requestId', () => {
    let s: AppState = applyServer(initialAppState, { type: 'chat_created', chat: meta('c1') })
    s = applyServer(s, { type: 'permission_request', chatId: 'c1', requestId: 'r1', name: 'Write', input: {} })
    s = dequeuePending(s, 'r1')
    expect(s.pendingQueue).toEqual([])
    expect(activePrompt(s)).toBeUndefined()
  })
  ```
  1d. แก้เทสต์ `chat_deleted removes chat + view ...` ให้รวมการล้าง queue — เพิ่มเทสต์ใหม่:
  ```ts
  it('chat_deleted clears that chat\'s pending permission prompts from the queue', () => {
    let s: AppState = applyServer(initialAppState, { type: 'chat_created', chat: meta('c1') })
    s = applyServer(s, { type: 'permission_request', chatId: 'c1', requestId: 'r1', name: 'Write', input: {} })
    expect(s.pendingQueue).toHaveLength(1)
    s = applyServer(s, { type: 'chat_deleted', chatId: 'c1' })
    expect(s.pendingQueue).toEqual([])
  })
  ```
  1e. เพิ่มเทสต์ connections + seed views + error-history:
  ```ts
  const conn = (id: string, over: Partial<ConnectionMeta> = {}): ConnectionMeta => ({
    id,
    type: 'anthropic-api',
    name: 'A',
    defaultModel: 'claude-opus-4-8',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  })

  it('connection_list sets connections', () => {
    const s = applyServer(initialAppState, { type: 'connection_list', connections: [conn('local', { type: 'local-agent', name: 'local', defaultModel: 'sonnet' }), conn('a1')] })
    expect(s.connections.map((c) => c.id)).toEqual(['local', 'a1'])
  })

  it('chat_list seeds an empty view for unknown chat ids (no blank pane on select)', () => {
    const s = applyServer(initialAppState, { type: 'chat_list', chats: [meta('c1'), meta('c2')] })
    expect(s.views.c1).toEqual({ messages: [], streaming: false })
    expect(s.views.c2).toEqual({ messages: [], streaming: false })
  })

  it('chat_list does NOT clobber an existing (e.g. streaming) view', () => {
    let s: AppState = appendUser(initialAppState, 'c1', 'hi') // streaming view
    s = applyServer(s, { type: 'chat_list', chats: [meta('c1')] })
    expect(s.views.c1.streaming).toBe(true)
    expect(s.views.c1.messages).toEqual([{ role: 'user', text: 'hi' }])
  })

  it('chat_history renders a persisted error block as a role:error message', () => {
    const messages: StoredMessage[] = [
      { id: 'u1', role: 'user', content: [{ type: 'text', text: 'do it' }], createdAt: 1 },
      { id: 'a1', role: 'assistant', content: [{ type: 'error', message: 'turn timed out' }], createdAt: 2 },
    ]
    const s = applyServer(initialAppState, { type: 'chat_history', chatId: 'c1', messages })
    expect(s.views.c1.messages).toEqual([
      { role: 'user', text: 'do it' },
      { role: 'error', text: 'turn timed out' },
    ])
  })
  ```

- [ ] **Step 2: รัน เพื่อยืนยัน fail.** Run: `npx vitest run web/src/appState.test.ts` → FAIL.

- [ ] **Step 3: แก้ `web/src/appState.ts`.**
  3a. import เพิ่ม `ConnectionMeta`:
  ```ts
  import type { ServerMsg, ToolCall, ChatMeta, StoredMessage, DirEntry, ConnectionMeta } from '@shared/protocol'
  ```
  3b. แก้ `AppState` + `initialAppState`:
  ```ts
  export type AppState = {
    chats: ChatMeta[]
    connections: ConnectionMeta[]
    activeChatId?: string
    views: Record<string, ChatView>
    pendingQueue: PermissionPrompt[]
    folder?: FolderPickerState
  }

  export const initialAppState: AppState = { chats: [], connections: [], views: {}, pendingQueue: [] }
  ```
  3c. แก้ `historyToView` ให้ render error block (แทนฟังก์ชันเดิม):
  ```ts
  function historyToView(messages: StoredMessage[]): ChatView {
    const ui: UiMessage[] = []
    for (const m of messages) {
      if (m.role === 'user') {
        const first = m.content.find((b) => b.type === 'text')
        ui.push({ role: 'user', text: first && first.type === 'text' ? first.text : '' })
      } else {
        let text = ''
        const tools: ToolCall[] = []
        const errors: string[] = []
        for (const b of m.content) {
          if (b.type === 'text') text += b.text
          else if (b.type === 'tool_use') tools.push({ id: b.id, name: b.name, input: b.input })
          else if (b.type === 'error') errors.push(b.message)
          // tool_result blocks are ignored for render
        }
        if (text !== '' || tools.length > 0) ui.push({ role: 'assistant', text, tools })
        for (const e of errors) ui.push({ role: 'error', text: e })
      }
    }
    return { messages: ui, streaming: false }
  }
  ```
  3d. แก้ `applyServer` cases:
  - `chat_list` → seed views:
    ```ts
      case 'chat_list': {
        const views = { ...state.views }
        for (const c of msg.chats) if (!views[c.id]) views[c.id] = { messages: [], streaming: false }
        return { ...state, chats: msg.chats, views }
      }
    ```
  - เพิ่ม `connection_list`:
    ```ts
      case 'connection_list':
        return { ...state, connections: msg.connections }
    ```
  - `permission_request` → enqueue:
    ```ts
      case 'permission_request':
        return {
          ...state,
          pendingQueue: [
            ...state.pendingQueue,
            { chatId: msg.chatId, requestId: msg.requestId, name: msg.name, input: msg.input },
          ],
        }
    ```
  - `chat_deleted` → ล้าง queue:
    ```ts
      case 'chat_deleted': {
        const views = { ...state.views }
        delete views[msg.chatId]
        return {
          ...state,
          chats: state.chats.filter((c) => c.id !== msg.chatId),
          views,
          activeChatId: state.activeChatId === msg.chatId ? undefined : state.activeChatId,
          pendingQueue: state.pendingQueue.filter((p) => p.chatId !== msg.chatId),
        }
      }
    ```
  3e. แทน `clearPending` ด้วย `activePrompt` + `dequeuePending` (ท้ายไฟล์):
  ```ts
  export function activePrompt(state: AppState): PermissionPrompt | undefined {
    if (state.activeChatId === undefined) return undefined
    return state.pendingQueue.find((p) => p.chatId === state.activeChatId)
  }

  export function dequeuePending(state: AppState, requestId: string): AppState {
    return { ...state, pendingQueue: state.pendingQueue.filter((p) => p.requestId !== requestId) }
  }
  ```
  (ลบ `export function clearPending` เดิม.)

- [ ] **Step 4: รัน เพื่อยืนยัน pass.** Run: `npx vitest run web/src/appState.test.ts` → PASS (เดิมที่แก้ + ใหม่).
  หมายเหตุ: `web tsc` ทั้งโปรเจกต์ยัง RED เพราะ `App.tsx` ยังอ้าง `clearPending`/`state.pending` (จะแก้ Task 12) — ตาม Migration Policy ปล่อยได้.

- [ ] **Step 5: Commit.**
  ```bash
  git add web/src/appState.ts web/src/appState.test.ts
  git commit -m "feat(m3): appState — connections + permission FIFO queue (scope active) + seed views + error-in-history (M2 MAJOR#1/#2/#3)"
  ```

---

### Task 11: Frontend components — ConnectionPicker, ModelPicker, NewChatModal, Settings

Goal: สร้าง 4 component (presentational, controlled). ไม่มี DOM test (env=node) → gate = สร้างไฟล์ + review; whole-project web `tsc` เขียวที่ Task 12 (App.tsx ที่ wire ทั้งหมดยังไม่เสร็จ). เขียนให้ typecheck ถูกต้องและตรง props ที่ Task 12 จะใช้.

**Files:**
- Create: `web/src/components/ConnectionPicker.tsx`, `web/src/components/ModelPicker.tsx`, `web/src/components/NewChatModal.tsx`, `web/src/components/Settings.tsx`
- Test: (none — UI; gate = tsc ที่ Task 12)

**Interfaces:**
- `ConnectionPicker({ connections, value, onChange })`
- `ModelPicker({ providerType, value, onChange, id })` + export `MODEL_SUGGESTIONS`
- `NewChatModal({ draft, connections, onChange, onBrowse, onSubmit, onClose })` + export `type NewChatDraft = { connectionId: string; model: string; cwd?: string }`
- `Settings({ connections, onCreate, onUpdate, onDelete, onClose })` + export `type ConnectionFormPayload`

- [ ] **Step 1: สร้าง `web/src/components/ModelPicker.tsx`.**
  ```tsx
  export const MODEL_SUGGESTIONS: Record<string, string[]> = {
    'local-agent': ['sonnet', 'opus', 'haiku'],
    'anthropic-api': ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
    'openai-compatible': [],
  }

  export function ModelPicker({
    providerType,
    value,
    onChange,
    id,
  }: {
    providerType: string
    value: string
    onChange: (v: string) => void
    id: string
  }) {
    const listId = `models-${id}`
    const suggestions = MODEL_SUGGESTIONS[providerType] ?? []
    return (
      <>
        <input
          list={listId}
          className="w-full rounded-lg border px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-blue-400"
          placeholder="model id"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <datalist id={listId}>
          {suggestions.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </>
    )
  }
  ```

- [ ] **Step 2: สร้าง `web/src/components/ConnectionPicker.tsx`.**
  ```tsx
  import type { ConnectionMeta } from '@shared/protocol'

  export function ConnectionPicker({
    connections,
    value,
    onChange,
  }: {
    connections: ConnectionMeta[]
    value: string
    onChange: (id: string) => void
  }) {
    return (
      <select
        className="w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-400"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {connections.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name} ({c.type})
          </option>
        ))}
      </select>
    )
  }
  ```

- [ ] **Step 3: สร้าง `web/src/components/NewChatModal.tsx`.**
  ```tsx
  import type { ConnectionMeta } from '@shared/protocol'
  import { ConnectionPicker } from './ConnectionPicker'
  import { ModelPicker } from './ModelPicker'

  export type NewChatDraft = { connectionId: string; model: string; cwd?: string }

  export function NewChatModal({
    draft,
    connections,
    onChange,
    onBrowse,
    onSubmit,
    onClose,
  }: {
    draft: NewChatDraft
    connections: ConnectionMeta[]
    onChange: (d: NewChatDraft) => void
    onBrowse: () => void
    onSubmit: () => void
    onClose: () => void
  }) {
    const selected = connections.find((c) => c.id === draft.connectionId)
    const providerType = selected?.type ?? 'local-agent'
    const isLocal = providerType === 'local-agent'

    const selectConnection = (id: string) => {
      const conn = connections.find((c) => c.id === id)
      onChange({ ...draft, connectionId: id, model: conn?.defaultModel ?? draft.model })
    }

    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
        <div className="flex w-[90%] max-w-md flex-col gap-3 rounded-xl bg-white p-5 shadow-xl">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">แชทใหม่</h2>
            <button className="text-gray-400 hover:text-gray-700" title="ปิด" onClick={onClose}>
              ✕
            </button>
          </div>

          <label className="text-sm font-medium text-gray-700">Connection</label>
          <ConnectionPicker connections={connections} value={draft.connectionId} onChange={selectConnection} />

          <label className="text-sm font-medium text-gray-700">Model</label>
          <ModelPicker
            providerType={providerType}
            value={draft.model}
            onChange={(model) => onChange({ ...draft, model })}
            id="newchat"
          />

          {isLocal && (
            <>
              <label className="text-sm font-medium text-gray-700">Working directory</label>
              <div className="flex items-center gap-2">
                <input
                  className="min-w-0 flex-1 rounded-lg border px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-blue-400"
                  placeholder="(ไม่ระบุ = โฟลเดอร์เริ่มต้นของ server)"
                  value={draft.cwd ?? ''}
                  onChange={(e) => onChange({ ...draft, cwd: e.target.value || undefined })}
                />
                <button className="shrink-0 rounded-lg border px-3 py-2 text-sm" onClick={onBrowse}>
                  เลือก…
                </button>
              </div>
            </>
          )}

          <div className="mt-2 flex justify-end gap-2">
            <button className="rounded-lg border px-4 py-2 text-sm" onClick={onClose}>
              ยกเลิก
            </button>
            <button
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-40"
              disabled={!draft.connectionId || !draft.model.trim()}
              onClick={onSubmit}
            >
              สร้าง
            </button>
          </div>
        </div>
      </div>
    )
  }
  ```

- [ ] **Step 4: สร้าง `web/src/components/Settings.tsx`.**
  ```tsx
  import { useState } from 'react'
  import type { ConnectionMeta } from '@shared/protocol'
  import { ModelPicker } from './ModelPicker'

  export type ConnectionFormPayload = {
    name: string
    providerType: string
    baseUrl?: string
    apiKey?: string
    defaultModel: string
  }

  const NEW_TYPES = ['anthropic-api', 'openai-compatible']

  function emptyForm(): ConnectionFormPayload {
    return { name: '', providerType: 'anthropic-api', defaultModel: 'claude-opus-4-8' }
  }

  export function Settings({
    connections,
    onCreate,
    onUpdate,
    onDelete,
    onClose,
  }: {
    connections: ConnectionMeta[]
    onCreate: (p: ConnectionFormPayload) => void
    onUpdate: (id: string, patch: { name?: string; baseUrl?: string; apiKey?: string; defaultModel?: string }) => void
    onDelete: (id: string) => void
    onClose: () => void
  }) {
    // editId: undefined = not editing; '' = creating new; otherwise editing that id
    const [editId, setEditId] = useState<string | undefined>(undefined)
    const [form, setForm] = useState<ConnectionFormPayload>(emptyForm())

    const startCreate = () => {
      setEditId('')
      setForm(emptyForm())
    }
    const startEdit = (c: ConnectionMeta) => {
      setEditId(c.id)
      setForm({ name: c.name, providerType: c.type, baseUrl: c.baseUrl, defaultModel: c.defaultModel })
    }
    const cancel = () => setEditId(undefined)
    const submit = () => {
      if (editId === '') {
        onCreate(form)
      } else if (editId) {
        onUpdate(editId, {
          name: form.name,
          baseUrl: form.baseUrl,
          defaultModel: form.defaultModel,
          ...(form.apiKey ? { apiKey: form.apiKey } : {}),
        })
      }
      setEditId(undefined)
    }

    const isOpenai = form.providerType === 'openai-compatible'

    return (
      <div className="flex h-full flex-1 flex-col bg-gray-50">
        <header className="flex items-center justify-between border-b bg-white px-4 py-3">
          <span className="text-lg font-semibold">Settings — Connections</span>
          <button className="rounded-lg border px-3 py-1.5 text-sm" onClick={onClose}>
            ← กลับไปแชท
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-4">
          <ul className="space-y-2">
            {connections.map((c) => (
              <li key={c.id} className="flex items-center gap-2 rounded-lg border bg-white px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{c.name}</div>
                  <div className="truncate text-xs text-gray-500">
                    {c.type} · {c.defaultModel}
                    {c.baseUrl ? ` · ${c.baseUrl}` : ''}
                  </div>
                </div>
                <button className="rounded px-2 py-1 text-sm text-gray-600 hover:bg-gray-100" onClick={() => startEdit(c)}>
                  แก้ไข
                </button>
                <button
                  className="rounded px-2 py-1 text-sm text-red-600 hover:bg-red-50 disabled:opacity-40"
                  disabled={c.id === 'local'}
                  title={c.id === 'local' ? 'ลบ connection เริ่มต้นไม่ได้' : 'ลบ'}
                  onClick={() => {
                    if (window.confirm(`ลบ connection "${c.name}" ?`)) onDelete(c.id)
                  }}
                >
                  ลบ
                </button>
              </li>
            ))}
          </ul>

          {editId === undefined ? (
            <button className="mt-4 rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700" onClick={startCreate}>
              + เพิ่ม connection
            </button>
          ) : (
            <div className="mt-4 flex flex-col gap-3 rounded-xl border bg-white p-4">
              <h3 className="text-base font-semibold">{editId === '' ? 'เพิ่ม connection' : 'แก้ไข connection'}</h3>

              {editId === '' && (
                <>
                  <label className="text-sm font-medium text-gray-700">ประเภท</label>
                  <select
                    className="w-full rounded-lg border px-3 py-2 text-sm"
                    value={form.providerType}
                    onChange={(e) => {
                      const providerType = e.target.value
                      setForm((f) => ({
                        ...f,
                        providerType,
                        defaultModel: providerType === 'anthropic-api' ? 'claude-opus-4-8' : f.defaultModel,
                      }))
                    }}
                  >
                    {NEW_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </>
              )}

              <label className="text-sm font-medium text-gray-700">ชื่อ</label>
              <input
                className="w-full rounded-lg border px-3 py-2 text-sm"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />

              {isOpenai && (
                <>
                  <label className="text-sm font-medium text-gray-700">Base URL</label>
                  <input
                    className="w-full rounded-lg border px-3 py-2 font-mono text-sm"
                    placeholder="https://openrouter.ai/api/v1"
                    value={form.baseUrl ?? ''}
                    onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value || undefined }))}
                  />
                </>
              )}

              <label className="text-sm font-medium text-gray-700">
                API key{editId !== '' ? ' (เว้นว่าง = คงค่าเดิม)' : ''}
              </label>
              <input
                type="password"
                className="w-full rounded-lg border px-3 py-2 font-mono text-sm"
                placeholder={editId === '' ? 'sk-…' : '••••••••'}
                value={form.apiKey ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value || undefined }))}
              />

              <label className="text-sm font-medium text-gray-700">Default model</label>
              <ModelPicker
                providerType={form.providerType}
                value={form.defaultModel}
                onChange={(defaultModel) => setForm((f) => ({ ...f, defaultModel }))}
                id="settings"
              />

              <div className="mt-1 flex justify-end gap-2">
                <button className="rounded-lg border px-4 py-2 text-sm" onClick={cancel}>
                  ยกเลิก
                </button>
                <button
                  className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-40"
                  disabled={!form.name.trim() || !form.defaultModel.trim() || (isOpenai && !form.baseUrl)}
                  onClick={submit}
                >
                  บันทึก
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    )
  }
  ```

- [ ] **Step 5: review การ import** — ตรวจว่าทุก component import `ConnectionMeta`/sub-component ถูก path (`@shared/protocol`, `./ConnectionPicker`, `./ModelPicker`). ยังไม่รัน whole-project tsc (จะ RED จาก App.tsx — Task 12).

- [ ] **Step 6: Commit.**
  ```bash
  git add web/src/components/ConnectionPicker.tsx web/src/components/ModelPicker.tsx web/src/components/NewChatModal.tsx web/src/components/Settings.tsx
  git commit -m "feat(m3): frontend components — ConnectionPicker, ModelPicker, NewChatModal, Settings"
  ```

---

### Task 12: App.tsx wiring — Settings page, NewChatModal flow, permission queue, loading state (web tsc green)

Goal: ต่อสายทุกอย่างใน `web/src/App.tsx`: routing Chat/Settings, สร้างห้องผ่าน NewChatModal (เลือก connection+model, browse cwd เฉพาะ local-agent ผ่าน FolderPicker), connection CRUD sends, permission modal จาก `activePrompt` (queue + scope active, MAJOR#2), loading placeholder เมื่อเลือกห้องที่ view ยังไม่มา (MAJOR#4), และ guard ไม่ให้ stale `dir_list` เปิด FolderPicker ที่ถูกยกเลิก (NIT). **web tsc เขียวครบ** ที่ task นี้.

**Files:**
- Modify: `P:\AI_PROJECT\Claude\WebPage\web\src\App.tsx`
- Test: (none — gate = `tsc -p web/tsconfig.json`)

**Interfaces:**
- Consumes: `activePrompt`, `dequeuePending` (appState); `NewChatModal`/`NewChatDraft`, `Settings`/`ConnectionFormPayload` (components).
- Produces: full UI wiring; ws client sends `create_chat`/`create_connection`/`update_connection`/`delete_connection`.

- [ ] **Step 1: แทน `web/src/App.tsx` ทั้งไฟล์.**
  ```tsx
  import { useEffect, useReducer, useRef, useState } from 'react'
  import type { ServerMsg } from '@shared/protocol'
  import {
    applyServer,
    appendUser,
    dequeuePending,
    activePrompt,
    closeFolder,
    setActiveChat,
    initialAppState,
    type AppState,
  } from './appState'
  import { createWsClient, type WsStatus } from './ws'
  import { Sidebar } from './components/Sidebar'
  import { FolderPicker } from './components/FolderPicker'
  import { Message } from './components/Message'
  import { Composer } from './components/Composer'
  import { PermissionModal } from './components/PermissionModal'
  import { NewChatModal, type NewChatDraft } from './components/NewChatModal'
  import { Settings, type ConnectionFormPayload } from './components/Settings'

  type Action =
    | { kind: 'server'; msg: ServerMsg }
    | { kind: 'user'; chatId: string; text: string }
    | { kind: 'setActive'; chatId: string }
    | { kind: 'dequeuePending'; requestId: string }
    | { kind: 'closeFolder' }

  function reducer(state: AppState, action: Action): AppState {
    switch (action.kind) {
      case 'server':
        return applyServer(state, action.msg)
      case 'user':
        return appendUser(state, action.chatId, action.text)
      case 'setActive':
        return setActiveChat(state, action.chatId)
      case 'dequeuePending':
        return dequeuePending(state, action.requestId)
      case 'closeFolder':
        return closeFolder(state)
    }
  }

  export function App() {
    const [state, dispatch] = useReducer(reducer, initialAppState)
    const [status, setStatus] = useState<WsStatus>('connecting')
    const [page, setPage] = useState<'chat' | 'settings'>('chat')
    const [newChat, setNewChat] = useState<NewChatDraft | null>(null)
    const clientRef = useRef<ReturnType<typeof createWsClient> | null>(null)
    const scrollRef = useRef<HTMLDivElement>(null)

    const activeChatRef = useRef<string | undefined>(undefined)
    activeChatRef.current = state.activeChatId

    useEffect(() => {
      const client = createWsClient({
        onMessage: (msg) => dispatch({ kind: 'server', msg }),
        onStatus: (s) => {
          setStatus(s)
          if (s === 'open' && activeChatRef.current) {
            client.send({ type: 'subscribe', chatId: activeChatRef.current })
          }
        },
      })
      clientRef.current = client
      return () => client.close()
    }, [])

    const activeId = state.activeChatId
    const view = activeId ? state.views[activeId] : undefined

    useEffect(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
    }, [view?.messages])

    const selectChat = (id: string) => {
      dispatch({ kind: 'setActive', chatId: id })
      clientRef.current?.send({ type: 'subscribe', chatId: id })
    }

    const defaultDraft = (): NewChatDraft => {
      const first = state.connections[0]
      return { connectionId: first?.id ?? 'local', model: first?.defaultModel ?? 'sonnet' }
    }
    const openNewChat = () => setNewChat(defaultDraft())
    const submitNewChat = () => {
      if (!newChat) return
      const conn = state.connections.find((c) => c.id === newChat.connectionId)
      const isLocal = (conn?.type ?? 'local-agent') === 'local-agent'
      clientRef.current?.send({
        type: 'create_chat',
        connectionId: newChat.connectionId,
        model: newChat.model,
        ...(isLocal && newChat.cwd ? { cwd: newChat.cwd } : {}),
      })
      setNewChat(null)
      dispatch({ kind: 'closeFolder' })
    }

    const renameChat = (id: string, title: string) => clientRef.current?.send({ type: 'rename_chat', chatId: id, title })
    const deleteChat = (id: string) => clientRef.current?.send({ type: 'delete_chat', chatId: id })

    const send = (text: string) => {
      if (!activeId) return
      dispatch({ kind: 'user', chatId: activeId, text })
      clientRef.current?.send({ type: 'user_message', chatId: activeId, text })
    }
    const stop = () => {
      if (!activeId) return
      clientRef.current?.send({ type: 'interrupt', chatId: activeId })
    }

    // FolderPicker is only used to browse a cwd for the NewChatModal draft.
    const browseFolder = (path: string) => clientRef.current?.send({ type: 'list_dirs', path })
    const openBrowse = () => clientRef.current?.send({ type: 'list_dirs', path: newChat?.cwd })
    const chooseFolder = (path: string) => {
      setNewChat((d) => (d ? { ...d, cwd: path } : d))
      dispatch({ kind: 'closeFolder' })
    }
    const cancelFolder = () => dispatch({ kind: 'closeFolder' })

    const prompt = activePrompt(state)
    const decide = (decision: 'allow' | 'deny') => {
      if (!prompt) return
      clientRef.current?.send({ type: 'permission_response', requestId: prompt.requestId, decision })
      dispatch({ kind: 'dequeuePending', requestId: prompt.requestId })
    }

    const createConnection = (p: ConnectionFormPayload) =>
      clientRef.current?.send({
        type: 'create_connection',
        name: p.name,
        providerType: p.providerType,
        defaultModel: p.defaultModel,
        ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
        ...(p.apiKey ? { apiKey: p.apiKey } : {}),
      })
    const updateConnection = (
      id: string,
      patch: { name?: string; baseUrl?: string; apiKey?: string; defaultModel?: string },
    ) => clientRef.current?.send({ type: 'update_connection', id, ...patch })
    const deleteConnection = (id: string) => clientRef.current?.send({ type: 'delete_connection', id })

    if (page === 'settings') {
      return (
        <div className="flex h-full">
          <Settings
            connections={state.connections}
            onCreate={createConnection}
            onUpdate={updateConnection}
            onDelete={deleteConnection}
            onClose={() => setPage('chat')}
          />
        </div>
      )
    }

    return (
      <div className="flex h-full">
        <Sidebar
          chats={state.chats}
          activeChatId={activeId}
          onSelect={selectChat}
          onNew={openNewChat}
          onRename={renameChat}
          onDelete={deleteChat}
        />
        <div className="flex h-full flex-1 flex-col">
          <header className="flex items-center justify-between border-b bg-white px-4 py-3">
            <span className="text-lg font-semibold">Claude Web Agent</span>
            <div className="flex items-center gap-2">
              {status === 'closed' && (
                <span className="rounded bg-yellow-100 px-2 py-1 text-xs text-yellow-800">
                  การเชื่อมต่อหลุด กำลังเชื่อมต่อใหม่…
                </span>
              )}
              <button className="rounded-lg border px-3 py-1.5 text-sm" onClick={() => setPage('settings')}>
                ⚙ Settings
              </button>
            </div>
          </header>
          {activeId && view ? (
            <>
              <div ref={scrollRef} className="flex-1 overflow-y-auto bg-gray-50">
                {view.messages.map((m, i) => (
                  <Message key={i} msg={m} />
                ))}
              </div>
              <Composer disabled={view.streaming} onSend={send} onStop={stop} />
            </>
          ) : activeId ? (
            <div className="flex flex-1 items-center justify-center bg-gray-50 text-gray-400">กำลังโหลด…</div>
          ) : (
            <div className="flex flex-1 items-center justify-center bg-gray-50 text-gray-500">
              <div className="text-center">
                <p className="text-base">ยังไม่มีแชทที่เลือก</p>
                <button className="mt-3 rounded-lg bg-blue-600 px-4 py-2 text-white" onClick={openNewChat}>
                  + สร้างแชทใหม่
                </button>
              </div>
            </div>
          )}
        </div>
        {newChat && (
          <NewChatModal
            draft={newChat}
            connections={state.connections}
            onChange={setNewChat}
            onBrowse={openBrowse}
            onSubmit={submitNewChat}
            onClose={() => {
              setNewChat(null)
              dispatch({ kind: 'closeFolder' })
            }}
          />
        )}
        {/* FolderPicker only renders while a new-chat draft is open → a stale dir_list
            after cancel cannot resurrect the picker (NIT). */}
        {newChat && state.folder?.open && (
          <FolderPicker state={state.folder} onBrowse={browseFolder} onChoose={chooseFolder} onClose={cancelFolder} />
        )}
        {prompt && <PermissionModal prompt={prompt} onDecide={decide} />}
      </div>
    )
  }
  ```

- [ ] **Step 2: web tsc gate (authoritative).**
  Run: `npx tsc -p web/tsconfig.json`
  Expected: **clean** (0 errors). แก้ type error ที่เหลือ (เช่น import ที่ค้าง) จนเขียว.

- [ ] **Step 3: build:web gate.**
  Run: `npm run build:web`
  Expected: build สำเร็จ (ออกที่ `dist/`).

- [ ] **Step 4: รัน full suite (sanity).** Run: `npx vitest run` → PASS ทั้งหมด.

- [ ] **Step 5: Commit.**
  ```bash
  git add web/src/App.tsx
  git commit -m "feat(m3): App wiring — Settings page, NewChatModal flow, permission queue, loading state (web tsc green)"
  ```

---

### Task 13: Hardening — M2 NITs (localAgent dual session_id, resume preservation, guarded JSON.parse, WSS before listen)

Goal: ปิด NIT จาก M2 scrutinize ที่เหลือ (ไม่รวม stale dir_list ที่จัดการแล้วใน Task 12): (a) เอา dual `session_id` ออกจาก input ของ localAgent (ใช้ `options.resume` อย่างเดียว); (b) regression test ว่า turn ที่ error ไม่ล้าง `sdk_session_id` เดิม; (c) guard `JSON.parse` ใน `listMessages` (1 row พังต้องไม่ทำทั้งห้องเปิดไม่ได้); (d) ย้าย `attachWebSocketServer` มาก่อน `app.listen` ใน index.ts.

**Files:**
- Modify: `server/providers/localAgent.ts` (+test), `server/chatRuntime.test.ts`, `server/store.ts` (+test), `server/index.ts`

- [ ] **Step 1: localAgent — เขียน failing test** (เพิ่มใน `server/providers/localAgent.test.ts`).
  ```ts
  it('does not embed session_id inside the streamed input message (resume option only)', async () => {
    let capturedPrompt: AsyncIterable<unknown> | undefined
    function recordingQuery(opts: { prompt: AsyncIterable<unknown> }) {
      capturedPrompt = opts.prompt
      async function* gen() {
        yield { type: 'result', subtype: 'success', result: 'ok' }
      }
      return Object.assign(gen(), { interrupt: async () => {} })
    }
    const provider = new LocalAgentProvider(recordingQuery as never)
    await provider.send({ userText: 'hi', sdkSessionId: 'sess-1' }, makeCtx().ctx)

    const iter = (capturedPrompt as AsyncIterable<{ message: unknown; session_id?: unknown }>)[Symbol.asyncIterator]()
    const { value } = await iter.next()
    expect(value.session_id).toBeUndefined()
    expect(value.message).toEqual({ role: 'user', content: 'hi' })
  })
  ```

- [ ] **Step 2: รัน เพื่อยืนยัน fail.** Run: `npx vitest run server/providers/localAgent.test.ts` → FAIL (ปัจจุบันยัง yield `session_id`).

- [ ] **Step 3: แก้ `server/providers/localAgent.ts`** — ลบ session_id ออกจาก input yield.
  เปลี่ยน:
  ```ts
      async function* input() {
        yield {
          type: 'user' as const,
          message: { role: 'user' as const, content: params.userText },
          parent_tool_use_id: null,
          ...(sessionId ? { session_id: sessionId } : {}),
        }
      }
  ```
  เป็น:
  ```ts
      async function* input() {
        yield {
          type: 'user' as const,
          message: { role: 'user' as const, content: params.userText },
          parent_tool_use_id: null,
        }
      }
  ```
  (resume ยังทำงานผ่าน `options.resume` ตามเดิม — test ข้อ 'threads resume' ยังเขียว.)

- [ ] **Step 4: รัน เพื่อยืนยัน pass.** Run: `npx vitest run server/providers/localAgent.test.ts` → PASS.

- [ ] **Step 5: chatRuntime — resume preservation test** (เพิ่มใน `server/chatRuntime.test.ts`; import `setChatSdkSession` จาก `./store`).
  ```ts
  it('(k) an errored turn does NOT clear a previously saved sdk_session_id', async () => {
    const throwing: Provider = {
      type: 'throwing',
      async send(): Promise<TurnResult> {
        throw new Error('nope')
      },
    }
    const { deps } = makeDeps({ provider: throwing })
    setChatSdkSession(deps.db, 'c1', 'sess-keep', 9999)
    const rt = new ChatRuntime('c1', deps)
    rt.enqueue('hi')
    await tick(20)
    expect(getChatSdkSession(deps.db, 'c1')).toBe('sess-keep')
  })
  ```
  (แก้ import ด้านบนของไฟล์ให้รวม `setChatSdkSession`.)

- [ ] **Step 6: รัน.** Run: `npx vitest run server/chatRuntime.test.ts` → PASS (k ใหม่). ไม่ต้องแก้โค้ด — `runOne` เรียก `setChatSdkSession` เฉพาะเมื่อ `result.sdkSessionId` truthy; error turn คืน `{text:''}` (ไม่มี sdkSessionId) → ค่าเดิมคงอยู่.

- [ ] **Step 7: store — guarded JSON.parse — เขียน failing test** (เพิ่มใน `server/store.test.ts`).
  ```ts
  import { appendMessage } from "./store"

  it("listMessages skips a row with corrupt JSON content instead of throwing", () => {
    const db = freshDb()
    createChat(db, { id: "c1", title: "t", connectionId: "local", model: "sonnet", now: 1 })
    appendMessage(db, { chatId: "c1", id: "m1", role: "user", content: [{ type: "text", text: "ok" }], createdAt: 1 })
    // inject a corrupt row directly
    db.prepare(`INSERT INTO messages (id, chat_id, role, content, usage, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
      "bad",
      "c1",
      "assistant",
      "{not json",
      null,
      2,
    )
    expect(() => listMessages(db, "c1")).not.toThrow()
    const msgs = listMessages(db, "c1")
    expect(msgs.map((m) => m.id)).toEqual(["m1"]) // corrupt row skipped
  })
  ```
  (เพิ่ม `listMessages`/`appendMessage` ใน import ของไฟล์ test ถ้ายังไม่มี.)

- [ ] **Step 8: รัน เพื่อยืนยัน fail.** Run: `npx vitest run server/store.test.ts` → FAIL (โยน SyntaxError).

- [ ] **Step 9: แก้ `server/store.ts` `listMessages`** — guard parse, ข้าม row เสีย.
  เปลี่ยนส่วน `.map(...)` เป็น `flatMap` ที่ข้าม row พัง:
  ```ts
    return rows.flatMap((r) => {
      let content: StoredContentBlock[]
      try {
        content = JSON.parse(r.content) as StoredContentBlock[]
      } catch {
        // A single corrupt row must not make the whole chat unopenable.
        return []
      }
      const msg: StoredMessage = {
        id: r.id,
        role: r.role,
        content,
        createdAt: r.created_at,
      }
      if (r.usage !== null) {
        try {
          msg.usage = JSON.parse(r.usage) as Usage
        } catch {
          // ignore unparseable usage; keep the message
        }
      }
      return [msg]
    })
  ```

- [ ] **Step 10: รัน เพื่อยืนยัน pass.** Run: `npx vitest run server/store.test.ts` → PASS.

- [ ] **Step 11: แก้ `server/index.ts`** — attach WS ก่อน listen (ปิด race window).
  เปลี่ยนลำดับท้ายไฟล์จาก:
  ```ts
  await app.listen({ port: PORT, host: '127.0.0.1' })
  attachWebSocketServer(app.server, hub)
  app.log.info(`WebSocket listening on ws://127.0.0.1:${PORT}/ws`)
  ```
  เป็น:
  ```ts
  attachWebSocketServer(app.server, hub)
  await app.listen({ port: PORT, host: '127.0.0.1' })
  app.log.info(`WebSocket listening on ws://127.0.0.1:${PORT}/ws`)
  ```

- [ ] **Step 12: tsc + suite gate.** Run: `npx tsc --noEmit && npx vitest run server shared` → clean + PASS.

- [ ] **Step 13: Commit.**
  ```bash
  git add server/providers/localAgent.ts server/providers/localAgent.test.ts server/chatRuntime.test.ts server/store.ts server/store.test.ts server/index.ts
  git commit -m "fix(m3): M2 NITs — drop dual session_id, resume-preserve-on-error test, guarded listMessages parse, WSS before listen"
  ```

---

### Task 14: README + e2e (openai-compatible, no creds) + final verification

Goal: อัปเดต README (providers + Settings + security note สำหรับ api_key); เพิ่ม e2e อัตโนมัติของ openai-compatible provider (fake SSE server in-process, ไม่ต้องใช้ key จริง); รัน gate สุดท้ายทั้งหมด; เตรียม merge.

**Files:**
- Modify: `P:\AI_PROJECT\Claude\WebPage\README.md`
- Create: `P:\AI_PROJECT\Claude\WebPage\scripts\e2e-openai.mjs`

- [ ] **Step 1: สร้าง `scripts/e2e-openai.mjs`** — boot backend in-process (temp DB) + fake OpenAI-compatible SSE server, ขับผ่าน ws จริง.
  ```js
  // Live e2e for the OpenAI-compatible provider — NO external credentials.
  // Boots a fake OpenAI-compatible SSE server + the real Fastify/WS/hub stack
  // against a temp DB, then drives it over a real WebSocket: create connection ->
  // create chat -> user_message -> assert streamed reply + persisted history.
  // Run: npx tsx scripts/e2e-openai.mjs
  import http from 'node:http'
  import { mkdtempSync } from 'node:fs'
  import { tmpdir } from 'node:os'
  import { join } from 'node:path'
  import { randomUUID } from 'node:crypto'
  import Fastify from 'fastify'
  import { WebSocket } from 'ws'
  import { attachWebSocketServer } from '../server/ws'
  import { ChatHub } from '../server/hub'
  import { openDb, listMessages } from '../server/store'
  import { makeProvider } from '../server/providers/index'

  function fail(msg) {
    console.error('❌', msg)
    process.exit(1)
  }

  // 1) Fake OpenAI-compatible server: streams "Hello e2e" then [DONE].
  const fake = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url.endsWith('/chat/completions')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const pieces = ['Hello', ' ', 'e2e']
      for (const p of pieces) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 3, completion_tokens: 3 } })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    res.writeHead(404).end()
  })
  await new Promise((r) => fake.listen(0, r))
  const fakePort = fake.address().port
  const baseUrl = `http://127.0.0.1:${fakePort}/v1`

  // 2) Backend with a temp DB.
  const dbPath = join(mkdtempSync(join(tmpdir(), 'cwa-e2e-')), 'chats.db')
  const db = openDb(dbPath)
  const app = Fastify()
  const hub = new ChatHub({ db, makeProvider, genId: randomUUID, now: Date.now })
  attachWebSocketServer(app.server, hub)
  await app.listen({ port: 0, host: '127.0.0.1' })
  const port = app.server.address().port

  // 3) Drive over a real WebSocket.
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  const sent = []
  let connId
  let chatId
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString())
    sent.push(m)
    if (m.type === 'connection_list') {
      const c = m.connections.find((x) => x.name === 'e2e-openai')
      if (c && !connId) {
        connId = c.id
        ws.send(JSON.stringify({ type: 'create_chat', title: 'e2e', connectionId: connId, model: 'fake-model' }))
      }
    }
    if (m.type === 'chat_created') {
      chatId = m.chat.id
      ws.send(JSON.stringify({ type: 'user_message', chatId, text: 'hi there' }))
    }
  })

  await new Promise((resolve) => ws.on('open', resolve))
  ws.send(JSON.stringify({ type: 'create_connection', name: 'e2e-openai', providerType: 'openai-compatible', baseUrl, apiKey: 'unused', defaultModel: 'fake-model' }))

  // 4) Wait for turn_done, then assert.
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waiting for turn_done')), 10000)
    const iv = setInterval(() => {
      if (sent.some((m) => m.type === 'turn_done' && m.chatId === chatId)) {
        clearTimeout(t)
        clearInterval(iv)
        resolve()
      }
    }, 20)
  }).catch((e) => fail(e.message))

  const text = sent
    .filter((m) => m.type === 'assistant_delta' && m.chatId === chatId)
    .map((m) => m.text)
    .join('')
  if (text !== 'Hello e2e') fail(`expected streamed "Hello e2e", got "${text}"`)

  const msgs = listMessages(db, chatId)
  const roles = msgs.map((m) => m.role).join(',')
  if (roles !== 'user,assistant') fail(`expected persisted user,assistant; got ${roles}`)
  const asstText = msgs[1].content.find((b) => b.type === 'text')
  if (!asstText || asstText.text !== 'Hello e2e') fail('assistant text not persisted correctly')

  console.log('✅ openai-compatible e2e PASS — streamed + persisted "Hello e2e"')
  ws.close()
  await app.close()
  fake.close()
  process.exit(0)
  ```

- [ ] **Step 2: รัน e2e-openai.** Run: `npx tsx scripts/e2e-openai.mjs`
  Expected: `✅ openai-compatible e2e PASS`. (ไม่ต้องใช้ key จริง.)

- [ ] **Step 3: อัปเดต `README.md`** — เพิ่มหัวข้อ M3:
  - **Providers:** อธิบาย 3 ชนิด: `local-agent` (full agent, ใช้ machine login, มี cwd + permission), `anthropic-api` (`@anthropic-ai/sdk`, ต้องมี API key, แชตล้วน), `openai-compatible` (base URL + key, SSE, แชตล้วน เช่น OpenRouter/Ollama).
  - **Settings:** หน้า Settings สำหรับเพิ่ม/แก้/ลบ connection; ใส่ API key (เก็บฝั่ง server เท่านั้น); ลบ `local` ไม่ได้ และลบ connection ที่มีห้องอ้างอยู่ไม่ได้.
  - **New chat:** เลือก connection + model; cwd เลือกได้เฉพาะ local-agent.
  - **Security note (อัปเดต):** api_key ของ provider เก็บใน `data/chats.db` (gitignored) ฝั่ง server เท่านั้น — ไม่ถูกส่งกลับ browser, ไม่ log. (คง Security note เดิมเรื่อง `list_dirs` path bounding + localhost-only ไว้ — LAN/auth เป็น M6.)
  - **Model IDs:** anthropic ใช้ `claude-opus-4-8`/`claude-sonnet-4-6`/`claude-haiku-4-5`; openai-compatible กรอก model id ของ endpoint นั้นเอง.
  - **Test commands:** เพิ่ม `npx tsx scripts/e2e-openai.mjs` (no creds) ข้าง `e2e-multichat.mjs`.

- [ ] **Step 4: Final verification gate (รันทั้งหมด).**
  ```bash
  npx tsc --noEmit                      # server+shared clean
  npx tsc -p web/tsconfig.json          # web clean
  npx vitest run                        # full suite PASS
  npm run build:web                     # build ok
  npx tsx scripts/e2e-openai.mjs        # openai-compatible e2e PASS (no creds)
  npx tsx scripts/e2e-multichat.mjs     # local-agent multi-chat e2e (needs Claude login)
  ```
  Expected: ทุกคำสั่งผ่าน. บันทึกจำนวนเทสต์รวม (baseline 106 + เทสต์ใหม่ของ M3).

- [ ] **Step 5: Manual verification — Anthropic API (ต้องมี key จริง, ทำเองนอก CI).**
  - `npm run dev` → เปิด UI → Settings → เพิ่ม connection ชนิด `anthropic-api`, ใส่ API key จริง, default model `claude-opus-4-8` → บันทึก.
  - แชทใหม่ เลือก connection นั้น → ส่งข้อความ → เห็นคำตอบ stream ทีละ token, ไม่มี permission modal (stateless), reload แล้วประวัติอยู่ คุยต่อได้ (ส่ง messages[] จาก DB).
  - ยืนยันว่า `GET`/connection list ไม่มี api_key (เปิด DevTools → WS frames → connection_list ไม่มี field apiKey).

- [ ] **Step 6: Commit.**
  ```bash
  git add README.md scripts/e2e-openai.mjs
  git commit -m "docs(m3): README providers/Settings/security + add credential-free openai-compatible e2e"
  ```

- [ ] **Step 7: Pre-merge review (แนะนำตาม handoff).** รัน `9arm-skills:scrutinize` (หรือ opus whole-branch review) บน diff ทั้ง branch — มันจับ cross-cutting bug ที่ per-task review พลาดทั้งใน M1 และ M2. แก้ Critical/Important ก่อน merge.

- [ ] **Step 8: Merge** ด้วย `superpowers:finishing-a-development-branch` — `feat/m3-providers` → `--no-ff` merge เข้า `master` (M-convention). อัปเดต `.git/sdd/progress.md` + memory `claude-web-agent-project.md` (M3 done) + handoff.

---

## Self-Review (ผู้เขียนแผนตรวจเองเทียบ spec)

**Spec coverage (§16 M3 + carry-overs):**
- connections CRUD → Task 3 (store) + Task 9 (WS routing) + Task 11/12 (Settings UI). ✓
- AnthropicApiProvider → Task 5; OpenAICompatibleProvider → Task 6 (spec §4.2/§4.3). ✓
- ConnectionPicker / ModelPicker → Task 11; ใช้ใน NewChatModal/Settings → Task 12. ✓
- หน้า Settings (เพิ่ม/แก้ connection, ใส่ key, ตั้ง model) → Task 11/12 (spec §10). ✓
- api_key server-side เท่านั้น (§2 non-functional, §4.4, §11) → Global Constraint + Task 3 invariant + tests (store + hub + manual). ✓
- provider-type routing (hub) → Task 7 (carry-over "do early"). ✓
- stateless ประกอบ messages[] จาก DB (§4.2/§4.3) → Task 4 mapper + Task 7 history wiring. ✓
- M2 MAJOR#1 error-in-history → Task 8 (server) + Task 10 (historyToView). ✓
- M2 MAJOR#2 permission hijack/overwrite → Task 8 (server cancel) + Task 10 (FIFO queue scope active) + Task 12 (modal from activePrompt). ✓
- M2 MAJOR#3 cross-tab create_chat blank pane → Task 10 (seed views on chat_list). ✓
- M2 MAJOR#4 chat-loading state → Task 12 (loading placeholder). ✓
- NITs: dual session_id, resume-preserve test, stale dir_list, subscribers leak, chat_deleted clears pending, guarded JSON.parse, WSS before listen → Task 12 (stale dir_list, chat_deleted clears pending via Task 10) + Task 13 (rest). **subscribers Map leak** = ปล่อยตามเดิม (harmless; deferred — entries ว่างคงอยู่แต่ไม่โต per chat). ✓ (documented deferral)

**Out of scope ที่ยืนยันไม่ทำใน M3:** native HTTP API (M4), compat API + model-id mapping (M5), auth/0.0.0.0/QR (M6), permission `scope:'chat'`, `list_dirs` path bounding (M6), idle-eviction, auto-unsubscribe.

**Placeholder scan:** ไม่มี TBD/TODO/"add error handling"; ทุก step ที่แก้โค้ดมีโค้ดจริง. ✓

**Type consistency:** `ProviderConfig` (Task 7) ใช้สม่ำเสมอใน hub/index; `ConnectionMeta` (Task 2) ใช้ใน store/appState/components; `NewChatDraft`/`ConnectionFormPayload` ตรงกันระหว่าง component (Task 11) กับ App (Task 12); `activePrompt`/`dequeuePending` (Task 10) ตรงกับ App (Task 12); `TurnParams.history` (Task 4) ตรงกับ ChatRuntime (Task 7) + providers (Task 5/6). ✓

## Appendix A — Traceability (carry-over → task)

| Carry-over / MAJOR / NIT (จาก handoff/memory) | Task |
|---|---|
| hub hardcodes `connectionType='local-agent'` → resolve real type + `makeProvider(type)` switch | 7 |
| api_key never returned to browser | 3 (invariant) + 9 + 2 (ConnectionMeta omits) |
| create_chat must pass connectionId/model | 2 + 7 + 12 |
| stateless providers reconstruct messages[] from listMessages | 4 + 7 |
| MAJOR#1 empty assistant row + dropped error | 8 + 10 |
| MAJOR#2 permission single global slot (hijack + overwrite + hang) | 8 (server cancel) + 10 (queue) + 12 (modal) |
| MAJOR#3 cross-tab create_chat → row but no view | 10 |
| MAJOR#4 never-opened chat shows empty/create until history | 12 |
| NIT dual session_id + resume | 13 |
| NIT missing resume-preservation test | 13 |
| NIT stale dir_list reopens cancelled FolderPicker | 12 |
| NIT chat_deleted doesn't clear pending modal | 10 |
| NIT unguarded JSON.parse in listMessages | 13 |
| NIT WSS attached after listen | 13 |
| (deferred) subscribers Map leak; idle-eviction; auto-unsubscribe; scope:'chat'; list_dirs bounding | — (documented) |

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-17-claude-web-agent-m3-providers.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, two-stage review between tasks, fast iteration. ตรงกับวิธีที่ใช้สำเร็จใน M2 (controller pattern + `scripts/task-brief`/`review-package` + explicit model ต่อ dispatch: haiku=transcription, sonnet=integration/multi-file, opus=final whole-branch review). **REQUIRED SUB-SKILL:** `superpowers:subagent-driven-development`.

**2. Inline Execution** — รัน task ในเซสชันนี้แบบ batch + checkpoint. **REQUIRED SUB-SKILL:** `superpowers:executing-plans`.

**Which approach?**
