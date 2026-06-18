# Claude Web Agent — M4 (Native HTTP API: REST + SSE) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** เพิ่ม native HTTP API surface (REST + SSE) ที่ขับ engine เดียวกับ UI — `GET /api/connections`, `GET/POST /api/chats`, `GET/POST /api/chats/:id/messages` (stream + non-stream), `POST /api/query` — โดยใช้ `ChatHub`/`ChatRuntime` ตัวเดิม เพื่อให้ turn ที่เข้าทาง REST **broadcast ไป WebSocket subscriber ของห้องนั้นอัตโนมัติ (live-sync)**; พร้อมเพิ่ม `PolicyPermissionResolver` (`readonly` default / `auto`) และทำให้ `ChatRuntime` เลือก permission resolver **ต่อ-turn** (interactive สำหรับ WS, policy สำหรับ API).

**Architecture:** หัวใจคือ **per-turn resolver selection** + **single shared hub**. วันนี้ `ChatRuntime` hardcode `InteractivePermissionResolver` หนึ่งตัวต่อห้องและ `enqueue(text)` คืน `void`. M4 ขยาย `enqueue(text, { resolver?, onEvent? })` ให้คืน `Promise<TurnResult>`: queue element เปลี่ยนจาก `string` เป็น object ที่พก resolver + per-turn event sink + settle-callback; `runOne` ส่ง `item.resolver ?? this.permission` เข้า `runTurn` (ซึ่ง type permission เป็น `PermissionResolver` interface อยู่แล้ว → `agent.ts` ไม่ต้องแก้) และเรียก `item.onEvent(m)` คู่กับ `deps.broadcast(m)` (broadcast ยังต่ออยู่ → WS subscribers live-sync ฟรี) แล้ว settle promise ใน `finally`. `ChatHub` เพิ่ม **public methods** 2 ตัว (`createChatFromApi`, `enqueueApiTurn`) เพราะ surface เดิมเป็น private ทั้งหมด — REST handler เรียกผ่าน method พวกนี้เพื่อใช้ runtime ตัวเดียวกัน (ไม่สร้าง hub/runtime คู่ขนาน). ไฟล์ใหม่ `server/http-api.ts` export `registerHttpApi(app, { hub, db })` (เรียกได้ทั้งจาก `index.ts` และ e2e harness) ลงทะเบียน route บน Fastify instance เดิม; SSE ใช้ `reply.hijack()` + `reply.raw` เขียน frame `event: delta|tool_call|tool_result|done|error`. **ไม่แตะ `shared/protocol.ts`** (ไม่มี union ใหม่ → tsc เขียวตลอดทาง ไม่มี migration-red).

**Tech Stack:** ไม่เพิ่ม dependency ใหม่ — Fastify 4 (route + SSE ผ่าน `reply.raw`), Node 20 global `fetch` (ใช้ใน e2e), `ws` (WS subscriber ใน e2e), `better-sqlite3`, Vitest 2, tsx 4. เหมือน M1-M3 ทุกอย่าง (TypeScript ESM, `moduleResolution: Bundler`).

## Global Constraints

- Node 20+, package `"type": "module"` ทั้งโปรเจกต์; TypeScript strict; `module: ESNext`, `moduleResolution: Bundler` (import ไม่ต้องมีนามสกุล `.js`/`.ts`).
- Shared types อยู่ที่ `shared/protocol.ts` — server import แบบ relative (`../shared/protocol` หรือ `../../shared/protocol`).
- Port: backend = `8787` bind `127.0.0.1` (M4 **ยังคง localhost**; bind `0.0.0.0` + auth เป็น **M6**). Vite proxy `/api` → `http://127.0.0.1:8787` มีอยู่แล้ว (vite.config.ts:14) — REST ทุก endpoint ต้องอยู่ใต้ prefix `/api` ถึงจะ reachable จาก SPA ใน dev.
- **Auth = M6 (deferred).** spec §8 ระบุ `Authorization: Bearer <token>` แต่ M4 **ไม่บังคับ token** (localhost). ใส่ comment `// TODO(M6): bearer-token auth` ที่หัว `registerHttpApi` + บันทึกใน README. อย่าใส่ middleware auth จริงในเฟสนี้.
- **api_key ห้ามออกจาก server.** REST response ทุก path ใช้ `listConnections`/`getConnection` (ไม่มี `apiKey`) เท่านั้น — **ห้าม** `getConnectionWithSecret` บน response path. (มันถูกใช้ใน `getOrCreateRuntime` ฝั่ง server เท่านั้น.) `ConnectionMeta` เป็น superset ของ `ConnectionWithSecret` → tsc จับ leak **ไม่ได้**, ต้องมี test ยืนยันว่า body ไม่มี `apiKey`.
- **Read-only tools (auto-allow):** `Read, Glob, Grep, NotebookRead, WebSearch, WebFetch, TodoWrite` — มีอยู่ใน `server/permission.ts` เป็น `READ_ONLY_TOOLS`/`isReadOnlyTool`. `PolicyPermissionResolver` **ต้อง reuse** `isReadOnlyTool` ไม่ประกาศ set ใหม่.
- **Permission policy:** REST รับ field `permission?: 'readonly' | 'auto'`, **default `'readonly'`** (spec §5). ค่าอื่น/ขาด → `'readonly'`. `'readonly'` = allow read set / deny ที่เหลือ; `'auto'` = allow ทั้งหมด.
- **PermissionResolver contract (อย่าเดา):** `resolve(toolName: string, input: unknown): Promise<PermissionDecision>` โดย `PermissionDecision = { behavior: 'allow'; updatedInput?: unknown } | { behavior: 'deny'; message: string }` (deny **ต้อง** มี `message`). `handleResponse`/`cancelAll` มีเฉพาะบน `InteractivePermissionResolver` ไม่ใช่บน interface — `PolicyPermissionResolver` **ไม่ต้องมี** (มันถูกส่งเป็น per-turn resolver เข้า `runTurn` เท่านั้น ไม่เคยเก็บใน `this.permission`).
- **`runTurn` ไม่เคย throw** — provider error/timeout → emit `error` + `turn_done` ServerMsg แล้ว `return { text: '' }`. REST จึง **ตรวจ error จาก event** (`onEvent` เก็บ `error` message) ไม่ใช่จาก rejected promise. `turn_done` ออกเสมอ 1 ครั้งต่อ turn (= ตัวปิด SSE stream).
- Per-turn watchdog timeout default = `600000` ms (ไม่เปลี่ยน).
- Test framework: Vitest (`environment: node`); pure logic ต้องมี unit test ก่อน implement (TDD). **รัน Vitest จาก repo ROOT เสมอ** (เช่น `npx vitest run server/http-api.test.ts`). e2e `.mjs` รันด้วยมือ `npx tsx scripts/e2e-rest.mjs` (ไม่ผูกกับ `npm test`, ไม่ถูก typecheck โดย tsc).
- `npm run build:web` (vite build) ออกที่ repo-root `dist/`. root `tsconfig.json` include `["server","shared"]` → tsc ครอบ server/shared (รวมไฟล์ M4 ใหม่ทั้งหมด); ไม่ครอบ `scripts/*.mjs` และ `web/`.
- โค้ดสไตล์: **single quotes, ไม่มี semicolon, 2-space indent** ทุกไฟล์ที่ M4 แตะ. **`server/store.ts` ใช้ double quotes** (M4 ไม่แก้ store.ts — ไม่ต้องกังวล). คอมเมนต์โค้ดเป็นภาษาอังกฤษ (ตามไฟล์รอบข้าง).
- commit บ่อย ทีละ task. branch: สร้าง `feat/m4-http-api` จาก `master` (HEAD `3333cc6`) — ทำ task บน branch นี้ (ไม่เปิด PR ต่อ task); merge `--no-ff` เข้า `master` ตอนจบ (M-convention).

## tsc policy (อ่านก่อนเริ่ม — ต่างจาก M3)

M4 **ไม่มี protocol migration** (ไม่เพิ่ม/แก้ union ใน `shared/protocol.ts`). การเปลี่ยน `ChatRuntime.enqueue` จาก `void` เป็น `Promise<TurnResult>` เป็น backward-compatible ที่ call site (hub เรียก `...enqueue(msg.text)` แล้วทิ้ง promise — ไม่ error เพราะ promise ตัวนี้ **ไม่เคย reject**). ดังนั้น **whole-project `npx tsc --noEmit` ควรเขียวหลังจบทุก task** — ใช้เป็น gate เสริมได้ตลอด (ต่างจาก M3 ที่ red ระหว่างทาง). ถ้า task ไหน tsc แดง แปลว่าพลาด — แก้ก่อน commit.

## M4 Design Decisions (locked — อย่า re-derive)

- **Per-turn resolver ผ่าน `enqueue`** (ไม่ใช่ผ่าน constructor/HubDeps). queue เปลี่ยนเป็น `QueueItem[]`; `this.permission` (interactive) ยังเป็น default + ยังเป็น lifecycle anchor (`interrupt`/`dispose`/finally cancelAll, `handlePermissionResponse`). `PolicyPermissionResolver` ถูกส่งเป็น per-turn argument เข้า `runTurn` **เท่านั้น** ไม่เคยเก็บใน `this.permission` → ไม่ต้องมี no-op `cancelAll`/`handleResponse`, และ `this.permission.cancelAll('turn ended')` ใน finally ยังทำงานบน interactive resolver (ไม่มี pending สำหรับ policy turn → harmless).
- **`onEvent` คู่กับ `broadcast`** — `accumulatingSend` เรียก `this.deps.broadcast(m)` (→ WS subscribers, live-sync ฟรี) **และ** `item.onEvent?.(m)` (→ HTTP/SSE caller). ห้ามสลับ broadcast ออกต่อ-turn ไม่งั้น WS client ที่ดูห้องเดียวกันจะดับระหว่าง API turn.
- **`enqueue` คืน `Promise<TurnResult>`** ที่ settle ใน `runOne` finally (ครั้งเดียวเสมอ แม้ disposed/error). queued items ที่ยังไม่รัน → settle `{ text: '' }` ตอน `interrupt`/`dispose`.
- **REST ขับผ่าน hub public methods ใหม่** (`createChatFromApi`, `enqueueApiTurn`) ที่ใช้ `getOrCreateRuntime`/`broadcastAll` ตัวเดิม (ยัง private) → runtime/queue/broadcast ตัวเดียวกับ WS. **ไม่** driving ผ่าน synthetic `addConnection` (จะ echo `broadcastAll` รก + ไม่มี return value).
- **reads (`GET`) เรียก store ตรง** ด้วย `deps.db` (`listConnections`/`listChats`/`getChat`/`listMessages`) — ไม่ต้องผ่าน hub. **mutations/turn** ผ่าน hub (ต้อง broadcast/ใช้ runtime).
- **POST /api/chats คืน `{ chatId }`** (ตาม spec §8). **GET /api/chats คืน `{ chats: ChatMeta[] }`**, **GET /api/connections คืน `{ connections: ConnectionMeta[] }`**, **GET messages คืน `{ messages: StoredMessage[] }`** (envelope).
- **POST messages non-stream คืน `{ text, toolCalls, usage }`** (spec §8); **stream → SSE** event `delta`/`tool_call`/`tool_result`/`done`/`error`. **POST /api/query** สร้างห้อง (persist, reuse `createChatFromApi`) แล้วรัน turn เดียว — non-stream คืน `{ chatId, text, toolCalls, usage }`, stream → SSE (มี frame `event: chat` นำหน้าแจ้ง chatId).
- **deferred (ไม่ทำใน M4):** auth/token/`0.0.0.0`/QR/mobile (M6), compat API `/v1/*` + model-id mapping (M5), POST/PUT/DELETE `/api/connections` (connection CRUD ยังผ่าน WS เท่านั้น), SSE-through-Vite-proxy (UI ใช้ WS — ไม่ทดสอบ SSE ผ่าน Vite ใน M4), permission `scope:'chat'`, ChatRuntime idle-eviction, auto-unsubscribe.
- **M3 carry-over minors ที่ fold เข้า M4 (ทำใน Task ที่เกี่ยวข้อง):** (a) `listMessages` ORDER BY เพิ่ม rowid tiebreaker (Task 1, ในไฟล์ store.ts — double quotes) — stateless replay ordering เสถียร; (b) เพิ่ม anthropicApi in-loop-abort regression test (Task 1) — openai มีแล้ว anthropic ยังไม่มี. ทั้งสองเป็น minor อิสระ วางไว้ Task 1 (ไฟล์เล็ก) ให้จบในตัว.

## File Structure

**สร้างใหม่:**
- `server/http-api.ts` (+ `server/http-api.test.ts`) — `registerHttpApi(app, { hub, db })` (REST routes) + `serverMsgToSse(m)` (pure ServerMsg→SSE frame mapper) + `runApiTurn(...)` (stream/non-stream turn helper).
- `scripts/e2e-rest.mjs` — credential-free in-process e2e: REST create chat → non-stream message → SSE message → ยืนยัน WS live-sync + persistence + `/api/query` + ไม่มี apiKey leak.

**แก้ไข:**
- `server/permission.ts` (+ `server/permission.test.ts`) — เพิ่ม `PolicyPermissionResolver` + `PermissionPolicy` type (reuse `isReadOnlyTool`/`PermissionDecision`).
- `server/chatRuntime.ts` (+ `server/chatRuntime.test.ts`) — `EnqueueOptions`/`QueueItem`; `queue: QueueItem[]`; `enqueue(text, opts?): Promise<TurnResult>`; per-turn resolver + `onEvent` ใน `runOne`; settle promise; settle queued items ใน `interrupt`/`dispose`.
- `server/hub.ts` (+ `server/hub.test.ts`) — public `createChatFromApi(opts): ChatMeta` + `enqueueApiTurn(chatId, text, { resolver, onEvent? }): Promise<TurnResult>`.
- `server/index.ts` — `registerHttpApi(app, { hub, db })` ระหว่างสร้าง `hub` กับ `attachWebSocketServer`.
- `server/store.ts` (double quotes) — `listMessages` ORDER BY เพิ่ม `, rowid ASC` (M3 carry-over; Task 1).
- `server/providers/anthropicApi.test.ts` — เพิ่ม in-loop-abort regression test (M3 carry-over; Task 1).
- `README.md` (Task 6) — section "Native HTTP API" + auth-deferred note.

ลำดับ task เรียงตาม dependency: resolver+carry-overs → chatRuntime seam → hub public API → http-api reads+create+wiring → http-api turn endpoints → e2e+README+verify.

---

### Task 1: PolicyPermissionResolver + M3 carry-over minors

Goal: เพิ่ม `PolicyPermissionResolver` (non-interactive resolver สำหรับ native API) ใน `server/permission.ts` — เป็นรากฐานที่ Task 5 ใช้. แถมเก็บ M3 carry-over 2 ตัวที่อิสระและเล็ก: `listMessages` rowid tiebreaker (store.ts) + anthropicApi in-loop-abort regression test. ทั้งหมด pure/มี test ชัด.

**Files:**
- Modify: `P:\AI_PROJECT\Claude\WebPage\server\permission.ts`
- Test: `P:\AI_PROJECT\Claude\WebPage\server\permission.test.ts`
- Modify: `P:\AI_PROJECT\Claude\WebPage\server\store.ts` (double-quote style)
- Test: `P:\AI_PROJECT\Claude\WebPage\server\store.test.ts`
- Test: `P:\AI_PROJECT\Claude\WebPage\server\providers\anthropicApi.test.ts`

**Interfaces:**
- Consumes: `PermissionDecision`, `PermissionResolver`, `isReadOnlyTool` (ทั้งหมดมีใน `server/permission.ts` แล้ว).
- Produces:
  - `export type PermissionPolicy = 'readonly' | 'auto'`
  - `export class PolicyPermissionResolver implements PermissionResolver` — constructor `(mode: PermissionPolicy)`, method `resolve(toolName, input): Promise<PermissionDecision>`.

- [ ] **Step 1: เขียน failing tests สำหรับ `PolicyPermissionResolver`** (เพิ่มต่อท้าย `server/permission.test.ts`).
  ```ts
  import { PolicyPermissionResolver } from './permission'

  describe('PolicyPermissionResolver', () => {
    it("'auto' mode allows every tool", async () => {
      const r = new PolicyPermissionResolver('auto')
      expect(await r.resolve('Read', {})).toEqual({ behavior: 'allow' })
      expect(await r.resolve('Write', { file_path: '/tmp/x' })).toEqual({ behavior: 'allow' })
      expect(await r.resolve('Bash', { command: 'ls' })).toEqual({ behavior: 'allow' })
    })

    it("'readonly' mode allows the read-only tool set", async () => {
      const r = new PolicyPermissionResolver('readonly')
      for (const t of ['Read', 'Glob', 'Grep', 'NotebookRead', 'WebSearch', 'WebFetch', 'TodoWrite']) {
        expect(await r.resolve(t, {})).toEqual({ behavior: 'allow' })
      }
    })

    it("'readonly' mode denies write/run tools with a message", async () => {
      const r = new PolicyPermissionResolver('readonly')
      const write = await r.resolve('Write', { file_path: '/tmp/x' })
      expect(write.behavior).toBe('deny')
      if (write.behavior === 'deny') expect(write.message).toMatch(/readonly/i)
      const bash = await r.resolve('Bash', { command: 'ls' })
      expect(bash.behavior).toBe('deny')
    })
  })
  ```

- [ ] **Step 2: รัน เพื่อยืนยัน fail.**
  Run: `npx vitest run server/permission.test.ts`
  Expected: FAIL (`PolicyPermissionResolver` ยังไม่มี).

- [ ] **Step 3: เพิ่ม `PolicyPermissionResolver` ใน `server/permission.ts`** (ต่อท้ายไฟล์ หลัง `InteractivePermissionResolver`).
  ```ts
  // Non-interactive resolver for native/compat API turns: decides tool permission from a
  // fixed policy instead of prompting a human. 'auto' allows everything; 'readonly' allows
  // only the read-only tool set and denies writes/commands. It emits no ServerMsg and parks
  // no promise — so it needs none of the interactive resolver's chatId/send/genId deps, and
  // no cancelAll/handleResponse (it is passed only as a per-turn resolver into runTurn, never
  // stored as ChatRuntime's lifecycle resolver).
  export type PermissionPolicy = 'readonly' | 'auto'

  export class PolicyPermissionResolver implements PermissionResolver {
    constructor(private mode: PermissionPolicy) {}

    async resolve(toolName: string, _input: unknown): Promise<PermissionDecision> {
      if (this.mode === 'auto') return { behavior: 'allow' }
      if (isReadOnlyTool(toolName)) return { behavior: 'allow' }
      return { behavior: 'deny', message: `readonly policy denies tool ${toolName}` }
    }
  }
  ```

- [ ] **Step 4: รัน เพื่อยืนยัน pass.**
  Run: `npx vitest run server/permission.test.ts`
  Expected: PASS ทั้งหมด (เดิม + ใหม่).

- [ ] **Step 5: M3 carry-over (a) — เขียน failing test สำหรับ `listMessages` ordering tiebreaker** (เพิ่มใน `server/store.test.ts`, double-quote style).
  ```ts
  it("orders messages by created_at then rowid (stable for same-timestamp rows)", () => {
    const db = freshDb()
    createChat(db, { id: "c1", title: "t", connectionId: DEFAULT_CONNECTION_ID, model: "m", now: 1 })
    // three messages sharing the SAME created_at — insertion order must be preserved
    appendMessage(db, { chatId: "c1", id: "m1", role: "user", content: [{ type: "text", text: "1" }], createdAt: 100 })
    appendMessage(db, { chatId: "c1", id: "m2", role: "assistant", content: [{ type: "text", text: "2" }], createdAt: 100 })
    appendMessage(db, { chatId: "c1", id: "m3", role: "user", content: [{ type: "text", text: "3" }], createdAt: 100 })
    expect(listMessages(db, "c1").map((m) => m.id)).toEqual(["m1", "m2", "m3"])
  })
  ```
  หมายเหตุ: ใช้ helper `freshDb()` + imports (`createChat`, `appendMessage`, `listMessages`, `DEFAULT_CONNECTION_ID`) ที่มีอยู่ในไฟล์ test แล้ว — ถ้ายังไม่ได้ import ตัวไหน ให้เพิ่มในบรรทัด import เดิม.

- [ ] **Step 6: รัน — test ใหม่อาจ pass อยู่แล้ว** (SQLite มักคืนตาม rowid โดยบังเอิญเมื่อ `created_at` เท่ากัน) **แต่ต้องทำให้เป็น guarantee.**
  Run: `npx vitest run server/store.test.ts`
  ถ้า PASS อยู่แล้ว: ยังต้องทำ Step 7 เพื่อ lock ลง SQL (ปัจจุบันพึ่ง implicit ordering). ถ้า FAIL: Step 7 จะแก้.

- [ ] **Step 7: แก้ `listMessages` ใน `server/store.ts`** (double quotes) — เพิ่ม `, rowid ASC` ใน ORDER BY.
  หา query ของ `listMessages` (ปัจจุบันลงท้าย `ORDER BY created_at ASC`) แล้วเปลี่ยนเป็น:
  ```sql
  ORDER BY created_at ASC, rowid ASC
  ```
  (เปลี่ยนเฉพาะ ORDER BY clause; ไม่แตะคอลัมน์/ตรรกะอื่น. คงสไตล์ double-quote ของไฟล์.)

- [ ] **Step 8: M3 carry-over (b) — เพิ่ม in-loop-abort regression test ของ `AnthropicApiProvider`** (เพิ่มใน `server/providers/anthropicApi.test.ts`, ใน `describe('AnthropicApiProvider', ...)`).
  ```ts
  it('stops emitting deltas once ctx.signal is aborted mid-stream', async () => {
    const controller = new AbortController()
    async function* fake(): AsyncIterable<AnthropicStreamEvent> {
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'one' } }
      controller.abort() // abort BEFORE the next event is consumed
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'two' } }
    }
    const p = new AnthropicApiProvider({ apiKey: 'sk', defaultModel: 'm', streamFn: () => fake() })
    const deltas: string[] = []
    const ctx: ProviderContext = {
      onDelta: (t) => deltas.push(t),
      onToolCall: () => {},
      onToolResult: () => {},
      permission: { resolve: async () => ({ behavior: 'allow' }) },
      signal: controller.signal,
    }
    const result = await p.send({ userText: 'hi', history: userHistory }, ctx)
    // the in-loop `if (ctx.signal.aborted) break` must drop 'two'
    expect(deltas).toEqual(['one'])
    expect(result.text).toBe('one')
  })
  ```
  หมายเหตุ: ไฟล์นี้มี `AnthropicStreamEvent`, `ProviderContext`, และตัวแปร `userHistory` อยู่แล้ว (จาก M3) — ใช้ของเดิม ไม่ต้องประกาศซ้ำ. ถ้าชื่อ helper/ตัวแปรในไฟล์ต่างไป ให้ปรับให้ตรงไฟล์จริง.

- [ ] **Step 9: รัน เพื่อยืนยัน pass ทั้งหมด.**
  Run: `npx vitest run server/permission.test.ts server/store.test.ts server/providers/anthropicApi.test.ts`
  Expected: PASS ทั้งหมด. แล้วรัน `npx tsc --noEmit` Expected: clean.

- [ ] **Step 10: Commit.**
  ```bash
  git checkout -b feat/m4-http-api
  git add server/permission.ts server/permission.test.ts server/store.ts server/store.test.ts server/providers/anthropicApi.test.ts
  git commit -m "feat(m4): PolicyPermissionResolver + listMessages rowid tiebreaker + anthropicApi abort test"
  ```

---

### Task 2: ChatRuntime — per-turn resolver, per-turn onEvent, awaitable TurnResult

Goal: ขยาย `ChatRuntime.enqueue` ให้รับ `{ resolver?, onEvent? }` และคืน `Promise<TurnResult>` ที่ settle เมื่อ turn จบ; เปลี่ยน internal queue เป็น `QueueItem[]`; `runOne` ใช้ resolver ต่อ-turn (fallback `this.permission`) และ feed `onEvent` คู่กับ `broadcast`. คงพฤติกรรมเดิมทั้งหมด (eager user persist, single assistant row, error/timeout handling, dispose guard, sdk session). นี่คือ seam ที่ M4 แขวนอยู่.

**Files:**
- Modify: `P:\AI_PROJECT\Claude\WebPage\server\chatRuntime.ts`
- Test: `P:\AI_PROJECT\Claude\WebPage\server\chatRuntime.test.ts`

**Interfaces:**
- Consumes: `PermissionResolver` (`./permission`), `TurnResult` (`./providers/types`).
- Produces:
  - `export interface EnqueueOptions { resolver?: PermissionResolver; onEvent?: (m: ServerMsg) => void }`
  - `ChatRuntime.enqueue(text: string, opts?: EnqueueOptions): Promise<TurnResult>` (เดิม `(text: string): void`).

- [ ] **Step 1: เขียน failing tests** (เพิ่มต่อท้าย `describe('ChatRuntime', ...)` ใน `server/chatRuntime.test.ts`). ใช้ helper เดิม (`makeDeps`, `tick`, `lastPermissionRequestId`, `countType`).
  ```ts
  // ── M4: per-turn resolver + onEvent + awaitable result ────────────────────
  // An inline allow-all resolver (the structural interface — no class needed).
  const allowAll = { resolve: async () => ({ behavior: 'allow' as const }) }

  it('(m4-a) enqueue returns a promise resolving with the TurnResult', async () => {
    const { deps } = makeDeps()
    const rt = new ChatRuntime('c1', deps)
    // pass an allow-all per-turn resolver so FakeProvider does not park on its Write
    const result = await rt.enqueue('hi', { resolver: allowAll })
    expect(result.text).toBe('Hello hi')
    expect(result.usage).toEqual({ outputTokens: 3 })
    expect(result.sdkSessionId).toBe('sess-1')
    expect(rt.isIdle).toBe(true)
  })

  it('(m4-b) per-turn onEvent receives the same events as broadcast', async () => {
    const { deps, sent } = makeDeps()
    const rt = new ChatRuntime('c1', deps)
    const events: ServerMsg[] = []
    await rt.enqueue('x', { resolver: allowAll, onEvent: (m) => events.push(m) })
    // onEvent saw the deltas + turn_done
    expect(events.some((m) => m.type === 'assistant_delta')).toBe(true)
    expect(events.some((m) => m.type === 'turn_done')).toBe(true)
    // broadcast (sent) ALSO saw them — live-sync preserved
    expect(sent.some((m) => m.type === 'assistant_delta')).toBe(true)
    expect(sent.some((m) => m.type === 'turn_done')).toBe(true)
  })

  it('(m4-c) per-turn resolver is consulted instead of the interactive one', async () => {
    const { deps, sent } = makeDeps()
    const rt = new ChatRuntime('c1', deps)
    const seen: string[] = []
    const recording = {
      resolve: async (toolName: string) => {
        seen.push(toolName)
        return { behavior: 'allow' as const }
      },
    }
    await rt.enqueue('hi', { resolver: recording })
    // FakeProvider asks to Write; the per-turn resolver handled it (NOT the interactive one)
    expect(seen).toEqual(['Write'])
    // interactive path never emitted a permission_request
    expect(countType(sent, 'permission_request')).toBe(0)
  })

  it('(m4-d) queued (unrun) turns settle with empty text on interrupt', async () => {
    // a provider that parks until released, so the SECOND turn stays queued
    const holder: { release: (() => void) | undefined } = { release: undefined }
    const parking = {
      type: 'park',
      async send() {
        await new Promise<void>((r) => { holder.release = r })
        return { text: 'done' }
      },
    }
    const { deps } = makeDeps({ provider: parking })
    const rt = new ChatRuntime('c1', deps)
    const first = rt.enqueue('one', { resolver: allowAll })
    const second = rt.enqueue('two', { resolver: allowAll })
    await tick()
    rt.interrupt() // aborts the running turn + clears the queued 'two'
    holder.release?.()
    const r2 = await second // must NOT hang
    expect(r2).toEqual({ text: '' })
    await first // also settles (running turn aborted)
    expect(rt.isIdle).toBe(true)
  })
  ```

- [ ] **Step 2: รัน เพื่อยืนยัน fail.**
  Run: `npx vitest run server/chatRuntime.test.ts`
  Expected: FAIL (`enqueue` คืน void; ไม่มี resolver/onEvent param).

- [ ] **Step 3: แก้ imports ใน `server/chatRuntime.ts`** (บรรทัด 7-8).
  เปลี่ยน:
  ```ts
  import type { Provider } from './providers/types'
  import { InteractivePermissionResolver } from './permission'
  ```
  เป็น:
  ```ts
  import type { Provider, TurnResult } from './providers/types'
  import { InteractivePermissionResolver, type PermissionResolver } from './permission'
  ```

- [ ] **Step 4: เพิ่ม `EnqueueOptions` + `QueueItem` และเปลี่ยน field `queue`** ใน `server/chatRuntime.ts`.
  4a. เพิ่ม type หลัง `RuntimeDeps` interface (ก่อน `export class ChatRuntime`):
  ```ts
  export interface EnqueueOptions {
    // Per-turn permission resolver. Defaults to the chat's interactive (WS) resolver.
    // Native/compat API turns pass a PolicyPermissionResolver here.
    resolver?: PermissionResolver
    // Per-turn event sink, IN ADDITION to the hub broadcast (which stays wired so WS
    // subscribers still see the turn). Used by the native-API SSE/non-stream callers.
    onEvent?: (m: ServerMsg) => void
  }

  type QueueItem = {
    text: string
    resolver?: PermissionResolver
    onEvent?: (m: ServerMsg) => void
    settle: (result: TurnResult) => void
  }
  ```
  4b. เปลี่ยน field (บรรทัด 31) จาก `private queue: string[] = []` เป็น:
  ```ts
  private queue: QueueItem[] = []
  ```

- [ ] **Step 5: แทนที่ `enqueue`** (บรรทัด 47-60) ด้วย:
  ```ts
  enqueue(text: string, opts: EnqueueOptions = {}): Promise<TurnResult> {
    // Persist the user message IMMEDIATELY (eagerly) so it is durable even if the turn
    // later aborts or is interrupted before it runs. interrupt() clears only the queue.
    const userMsg: StoredMessage & { chatId: string } = {
      chatId: this.chatId,
      id: this.deps.genId(),
      role: 'user',
      content: [{ type: 'text', text }],
      createdAt: this.deps.now(),
    }
    appendMessage(this.deps.db, userMsg)
    let settle!: (result: TurnResult) => void
    const done = new Promise<TurnResult>((resolve) => {
      settle = resolve
    })
    this.queue.push({ text, resolver: opts.resolver, onEvent: opts.onEvent, settle })
    void this.drain()
    return done
  }
  ```

- [ ] **Step 6: แทนที่ `interrupt` และ `dispose`** (บรรทัด 62-77) ด้วย — settle queued items ก่อน clear:
  ```ts
  interrupt(): void {
    this.currentAbort?.abort()
    // #6b: clear pending (unrun) turns; settle their promises so API callers never hang.
    // The persisted user rows are untouched.
    for (const item of this.queue) item.settle({ text: '' })
    this.queue = []
    this.permission.cancelAll('interrupted by user')
  }

  handlePermissionResponse(requestId: string, decision: 'allow' | 'deny'): void {
    this.permission.handleResponse(requestId, decision)
  }

  dispose(): void {
    this.disposed = true
    this.currentAbort?.abort()
    this.permission.cancelAll('chat closed')
    for (const item of this.queue) item.settle({ text: '' })
    this.queue = []
  }
  ```
  (หมายเหตุ: `handlePermissionResponse` คงเดิม — แสดงไว้เพื่อบริบท ไม่ต้องแก้.)

- [ ] **Step 7: แทนที่ `drain`** (บรรทัด 83-94) — shift `QueueItem` แทน string:
  ```ts
  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.queue.length > 0 && !this.disposed) {
        const item = this.queue.shift()!
        await this.runOne(item)
      }
    } finally {
      this.running = false
    }
  }
  ```

- [ ] **Step 8: แทนที่ `runOne`** (บรรทัด 96-186) ทั้งเมธอด — เปลี่ยน signature เป็น `QueueItem`, feed `onEvent`, per-turn resolver, settle ใน finally:
  ```ts
  private async runOne(item: QueueItem): Promise<void> {
    const userText = item.text
    const chat = getChat(this.deps.db, this.chatId)
    const sdkSessionId = getChatSdkSession(this.deps.db, this.chatId)
    const history = listMessages(this.deps.db, this.chatId)

    const abort = new AbortController()
    this.currentAbort = abort

    // Accumulating send: forward to broadcast (WS live-sync) AND the per-turn onEvent sink
    // (HTTP/SSE caller) AND collect content blocks for the ONE assistant row.
    let accumulatedText = ''
    const toolUseBlocks: StoredContentBlock[] = []
    const toolResultBlocks: StoredContentBlock[] = []
    const errorMessages: string[] = []
    const accumulatingSend = (m: ServerMsg): void => {
      this.deps.broadcast(m)
      item.onEvent?.(m)
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

    let result: TurnResult = { text: '' }
    try {
      result = await runTurn(
        this.deps.provider,
        {
          userText,
          cwd: chat?.cwd,
          model: chat?.model ?? 'sonnet',
          sdkSessionId,
          history,
        },
        {
          chatId: this.chatId,
          send: accumulatingSend,
          // Per-turn resolver: native-API turns pass a PolicyPermissionResolver; WS turns
          // fall back to the chat's shared interactive resolver.
          permission: item.resolver ?? this.permission,
          signal: abort.signal,
          turnTimeoutMs: this.deps.turnTimeoutMs,
        },
      )

      // #1: if the chat was deleted (dispose()) during the turn, skip persisting
      // to avoid a FOREIGN KEY constraint error.
      if (this.disposed) return

      // Build ONE assistant row. On a failed/timed-out turn (no content) persist an
      // error block so the failure survives reload; on a truly empty turn (e.g.
      // interrupted before any output) persist nothing.
      const content: StoredContentBlock[] = []
      const text = accumulatedText !== '' ? accumulatedText : result.text
      if (text !== '') content.push({ type: 'text', text })
      content.push(...toolUseBlocks)
      content.push(...toolResultBlocks)
      if (errorMessages.length > 0) {
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
        // #5: notify hub so it can re-broadcast chat_list (sidebar recency order).
        if (!this.disposed) this.deps.onActivity?.()
      }
    } finally {
      // #2: always abort the provider's async iterator after every turn —
      // harmless on normal completion, critical on timeout to tear down the live query.
      abort.abort()
      // Deny any permission left parked by a timed-out/errored turn so the provider's
      // canUseTool promise never hangs across turns (server side of MAJOR#2).
      this.permission.cancelAll('turn ended')
      if (this.currentAbort === abort) this.currentAbort = null
      // Settle the per-turn promise exactly once with the (possibly empty) result so
      // native-API callers awaiting the turn always resolve — even on dispose/error.
      item.settle(result)
    }
  }
  ```

- [ ] **Step 9: รัน เพื่อยืนยัน pass (ทั้งเก่าและใหม่).**
  Run: `npx vitest run server/chatRuntime.test.ts`
  Expected: PASS ทั้งหมด — test (a)-(k) เดิม **ต้องยังเขียว** (regression: enqueue ยังคืน promise แต่ test เดิมเรียก `rt.enqueue('...')` แล้วทิ้ง return — ใช้ได้). ใหม่ (m4-a)-(m4-d) PASS.

- [ ] **Step 10: tsc + commit.**
  ```bash
  npx tsc --noEmit
  git add server/chatRuntime.ts server/chatRuntime.test.ts
  git commit -m "feat(m4): ChatRuntime per-turn resolver + onEvent sink + awaitable TurnResult from enqueue"
  ```
  Expected: tsc clean (hub's `enqueue(msg.text)` call ยัง compile — return ถูกทิ้ง).

---

### Task 3: ChatHub public API — createChatFromApi + enqueueApiTurn

Goal: เพิ่ม public method 2 ตัวบน `ChatHub` ให้ REST layer ขับ engine ตัวเดียวกับ WS โดยไม่แตะ private internals: `createChatFromApi` (สร้างห้อง + broadcast chat_list, คืน `ChatMeta`) และ `enqueueApiTurn` (resolve runtime ผ่าน `getOrCreateRuntime`, enqueue ด้วย per-turn resolver + onEvent, คืน `Promise<TurnResult>`; ถ้า build runtime ล้ม → broadcast chat-scoped error+turn_done แล้ว throw). live-sync ไป WS subscriber ได้ฟรีเพราะ runtime ใช้ `broadcast` ตัวเดิม.

**Files:**
- Modify: `P:\AI_PROJECT\Claude\WebPage\server\hub.ts`
- Test: `P:\AI_PROJECT\Claude\WebPage\server\hub.test.ts`

**Interfaces:**
- Consumes: `getOrCreateRuntime`/`broadcast`/`broadcastAll` (private, ภายใน hub); `getConnection`/`createChat`/`listChats` (`./store`); `PermissionResolver`/`PolicyPermissionResolver` (`./permission`); `ChatMeta` (`../shared/protocol`); `TurnResult` (`./providers/types`).
- Produces:
  - `createChatFromApi(opts: { connectionId?: string; model?: string; cwd?: string; title?: string }): ChatMeta`
  - `enqueueApiTurn(chatId: string, text: string, opts: { resolver: PermissionResolver; onEvent?: (m: ServerMsg) => void }): Promise<TurnResult>`

- [ ] **Step 1: เขียน failing tests** (เพิ่มต่อท้าย `describe('ChatHub', ...)` ใน `server/hub.test.ts`). เพิ่ม import `PolicyPermissionResolver` ที่หัวไฟล์: `import { PolicyPermissionResolver } from './permission'`.
  ```ts
  // ── M4: native HTTP API hub methods ───────────────────────────────────────
  it('(m4-1) createChatFromApi creates a chat, broadcasts chat_list, returns ChatMeta', () => {
    const { db, hub } = makeHub()
    const sent: ServerMsg[] = []
    hub.addConnection((m) => sent.push(m))
    sent.length = 0
    const chat = hub.createChatFromApi({ title: 'Via API' })
    expect(chat.title).toBe('Via API')
    expect(chat.connectionId).toBe('local')
    expect(chat.model).toBe('sonnet')
    expect(listChats(db).map((c) => c.id)).toContain(chat.id)
    expect(sent.some((m) => m.type === 'chat_list')).toBe(true)
  })

  it('(m4-2) createChatFromApi throws for an unknown connectionId', () => {
    const { hub } = makeHub()
    expect(() => hub.createChatFromApi({ connectionId: 'nope' })).toThrow(/connection not found/)
  })

  it('(m4-3) enqueueApiTurn runs an auto-policy turn and broadcasts to a WS subscriber', async () => {
    const { db, hub } = makeHub()
    const sub: ServerMsg[] = []
    const subHandle = hub.addConnection((m) => sub.push(m))
    const chat = hub.createChatFromApi({ title: 'API turn' })
    subHandle.handle(JSON.stringify({ type: 'subscribe', chatId: chat.id }))

    const apiEvents: ServerMsg[] = []
    const result = await hub.enqueueApiTurn(chat.id, 'hi', {
      resolver: new PolicyPermissionResolver('auto'),
      onEvent: (m) => apiEvents.push(m),
    })

    // FakeProvider: 'Hello ' + 'hi'; Write auto-allowed by 'auto'
    expect(result.text).toBe('Hello hi')
    expect(apiEvents.some((m) => m.type === 'assistant_delta')).toBe(true)
    expect(apiEvents.some((m) => m.type === 'turn_done')).toBe(true)
    // LIVE SYNC: the WS subscriber ALSO received the turn
    expect(sub.some((m) => m.type === 'assistant_delta' && m.chatId === chat.id)).toBe(true)
    expect(sub.some((m) => m.type === 'turn_done' && m.chatId === chat.id)).toBe(true)
    expect(listMessages(db, chat.id).map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  it('(m4-4) enqueueApiTurn under readonly policy denies the Write tool (no tool_call)', async () => {
    const { hub } = makeHub()
    hub.addConnection(() => {})
    const chat = hub.createChatFromApi({ title: 'ro' })
    const apiEvents: ServerMsg[] = []
    const result = await hub.enqueueApiTurn(chat.id, 'hi', {
      resolver: new PolicyPermissionResolver('readonly'),
      onEvent: (m) => apiEvents.push(m),
    })
    expect(result.text).toBe('Hello hi')
    expect(apiEvents.some((m) => m.type === 'tool_call')).toBe(false)
  })

  it('(m4-5) enqueueApiTurn on a build failure broadcasts error+turn_done and throws', () => {
    const db = openDb(':memory:')
    createConnection(db, { id: 'anth-no-key', type: 'anthropic-api', name: 'no key', defaultModel: 'm', now: 1 })
    let idN = 0
    let nowN = 1000
    const hub = new ChatHub({
      db,
      makeProvider: (cfg) => {
        if (cfg.type === 'anthropic-api' && !cfg.apiKey) throw new Error('anthropic-api connection requires an api key')
        return new FakeProvider()
      },
      genId: () => `id-${++idN}`,
      now: () => ++nowN,
    })
    const sub: ServerMsg[] = []
    const subHandle = hub.addConnection((m) => sub.push(m))
    const chat = hub.createChatFromApi({ connectionId: 'anth-no-key', title: 'bad' })
    subHandle.handle(JSON.stringify({ type: 'subscribe', chatId: chat.id }))
    sub.length = 0

    // getOrCreateRuntime throws synchronously inside enqueueApiTurn
    expect(() =>
      hub.enqueueApiTurn(chat.id, 'hi', { resolver: new PolicyPermissionResolver('auto'), onEvent: () => {} }),
    ).toThrow(/api key/i)
    // WS subscriber got chat-scoped error + turn_done so its spinner clears
    expect(sub.some((m) => m.type === 'error' && m.chatId === chat.id)).toBe(true)
    expect(sub.some((m) => m.type === 'turn_done' && m.chatId === chat.id)).toBe(true)
  })
  ```

- [ ] **Step 2: รัน เพื่อยืนยัน fail.**
  Run: `npx vitest run server/hub.test.ts`
  Expected: FAIL (method ใหม่ยังไม่มี).

- [ ] **Step 3: แก้ imports ใน `server/hub.ts`.**
  3a. เพิ่ม `ChatMeta` ใน protocol import (บรรทัด 1-5):
  ```ts
  import {
    parseClientMsg,
    type ClientMsg,
    type ServerMsg,
    type ChatMeta,
  } from '../shared/protocol'
  ```
  3b. เพิ่ม `PermissionResolver` import (ใต้ import `Provider`, ~บรรทัด 25):
  ```ts
  import type { Provider, TurnResult } from './providers/types'
  import type { PermissionResolver } from './permission'
  ```
  (เปลี่ยน `import type { Provider } from './providers/types'` เดิมให้รวม `TurnResult`.)

- [ ] **Step 4: เพิ่ม public methods ใน `ChatHub`** — วางหลัง `addConnection` (ก่อน `private broadcastConnections`):
  ```ts
  // ── Native HTTP API (M4) ───────────────────────────────────────────────────
  // Create a chat from the native API. Mirrors the WS 'create_chat' route MINUS the
  // per-connection subscribe (a REST caller has no persistent Send), and still broadcasts
  // chat_list so WS sidebars update. Throws if the connectionId is unknown.
  createChatFromApi(opts: { connectionId?: string; model?: string; cwd?: string; title?: string }): ChatMeta {
    const id = this.deps.genId()
    const now = this.deps.now()
    const connectionId = opts.connectionId ?? DEFAULT_CONNECTION_ID
    const conn = getConnection(this.deps.db, connectionId)
    if (!conn) throw new Error('connection not found')
    const chat = createChat(this.deps.db, {
      id,
      title: opts.title ?? 'New chat',
      connectionId,
      model: opts.model ?? conn.defaultModel,
      cwd: opts.cwd,
      now,
    })
    this.broadcastAll({ type: 'chat_list', chats: listChats(this.deps.db) })
    return chat
  }

  // Enqueue a native-API turn on the SAME runtime the WS path uses, so the turn broadcasts
  // to WS subscribers of this chat automatically. The caller supplies the per-turn permission
  // resolver (PolicyPermissionResolver) and an optional per-turn event sink (SSE/non-stream).
  // On a runtime-build failure (e.g. missing api key) it mirrors the WS user_message contract:
  // chat-scoped error + turn_done to WS subscribers, then re-throws for the REST caller.
  enqueueApiTurn(
    chatId: string,
    text: string,
    opts: { resolver: PermissionResolver; onEvent?: (m: ServerMsg) => void },
  ): Promise<TurnResult> {
    let rt: ChatRuntime
    try {
      rt = this.getOrCreateRuntime(chatId)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.broadcast({ type: 'error', chatId, message })
      this.broadcast({ type: 'turn_done', chatId })
      throw err
    }
    return rt.enqueue(text, { resolver: opts.resolver, onEvent: opts.onEvent })
  }
  ```

- [ ] **Step 5: รัน เพื่อยืนยัน pass (เก่า + ใหม่).**
  Run: `npx vitest run server/hub.test.ts`
  Expected: PASS ทั้งหมด — test (1)-(17),(M5),(9),(B1*) เดิมต้องยังเขียว.

- [ ] **Step 6: tsc + commit.**
  ```bash
  npx tsc --noEmit
  git add server/hub.ts server/hub.test.ts
  git commit -m "feat(m4): ChatHub.createChatFromApi + enqueueApiTurn (native API drives shared runtime, live-sync)"
  ```

---

### Task 4: http-api.ts — read endpoints, POST /api/chats, server wiring

Goal: สร้าง `server/http-api.ts` export `registerHttpApi(app, { hub, db })` ลงทะเบียน REST route ที่ "ปลอดภัย/ไม่ stream" บน Fastify instance เดิม: `GET /api/connections`, `GET /api/chats`, `GET /api/chats/:id/messages` (+404), `POST /api/chats` (ผ่าน `hub.createChatFromApi`, คืน `{ chatId }`). แล้ว wire เข้า `server/index.ts`. (turn endpoints อยู่ Task 5 — เพิ่มในไฟล์เดียวกัน.) ทดสอบด้วย Fastify `app.inject()` (ไม่ต้องมี socket จริง).

**Files:**
- Create: `P:\AI_PROJECT\Claude\WebPage\server\http-api.ts`
- Test: `P:\AI_PROJECT\Claude\WebPage\server\http-api.test.ts`
- Modify: `P:\AI_PROJECT\Claude\WebPage\server\index.ts`

**Interfaces:**
- Consumes: `FastifyInstance` (`fastify`); `ChatHub` (`./hub`); `listConnections`/`listChats`/`getChat`/`listMessages`/`DB` (`./store`).
- Produces:
  - `export interface HttpApiDeps { hub: ChatHub; db: DB }`
  - `export function registerHttpApi(app: FastifyInstance, deps: HttpApiDeps): void`

- [ ] **Step 1: เขียน failing tests** `server/http-api.test.ts`.
  ```ts
  import { describe, it, expect } from 'vitest'
  import Fastify, { type FastifyInstance } from 'fastify'
  import { openDb, listChats } from './store'
  import { FakeProvider } from './providers/fake'
  import { ChatHub } from './hub'
  import { registerHttpApi } from './http-api'

  function makeApp(): { app: FastifyInstance; hub: ChatHub; db: ReturnType<typeof openDb> } {
    const db = openDb(':memory:')
    let idN = 0
    let nowN = 1000
    const hub = new ChatHub({
      db,
      makeProvider: () => new FakeProvider(),
      genId: () => `id-${++idN}`,
      now: () => ++nowN,
    })
    const app = Fastify()
    registerHttpApi(app, { hub, db })
    return { app, hub, db }
  }

  describe('http-api read + create endpoints', () => {
    it('GET /api/connections returns the seeded local connection, never api_key', async () => {
      const { app } = makeApp()
      const res = await app.inject({ method: 'GET', url: '/api/connections' })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { connections: Array<Record<string, unknown>> }
      expect(body.connections.some((c) => c.id === 'local')).toBe(true)
      expect(body.connections.every((c) => c.apiKey === undefined)).toBe(true)
    })

    it('GET /api/chats is empty initially, then lists a created chat', async () => {
      const { app, hub } = makeApp()
      const empty = await app.inject({ method: 'GET', url: '/api/chats' })
      expect((empty.json() as { chats: unknown[] }).chats).toHaveLength(0)
      const chat = hub.createChatFromApi({ title: 'X' })
      const res = await app.inject({ method: 'GET', url: '/api/chats' })
      const ids = (res.json() as { chats: Array<{ id: string }> }).chats.map((c) => c.id)
      expect(ids).toContain(chat.id)
    })

    it('POST /api/chats creates a chat and returns { chatId } with 201', async () => {
      const { app, db } = makeApp()
      const res = await app.inject({ method: 'POST', url: '/api/chats', payload: { title: 'Created' } })
      expect(res.statusCode).toBe(201)
      const { chatId } = res.json() as { chatId: string }
      expect(chatId).toBeTruthy()
      expect(listChats(db).map((c) => c.id)).toContain(chatId)
    })

    it('POST /api/chats with an unknown connectionId returns 400', async () => {
      const { app } = makeApp()
      const res = await app.inject({ method: 'POST', url: '/api/chats', payload: { connectionId: 'nope' } })
      expect(res.statusCode).toBe(400)
      expect((res.json() as { error: string }).error).toMatch(/connection not found/)
    })

    it('GET /api/chats/:id/messages returns history; 404 for unknown chat', async () => {
      const { app, hub } = makeApp()
      const chat = hub.createChatFromApi({ title: 'M' })
      const ok = await app.inject({ method: 'GET', url: `/api/chats/${chat.id}/messages` })
      expect(ok.statusCode).toBe(200)
      expect((ok.json() as { messages: unknown[] }).messages).toEqual([])
      const missing = await app.inject({ method: 'GET', url: '/api/chats/ghost/messages' })
      expect(missing.statusCode).toBe(404)
    })
  })
  ```

- [ ] **Step 2: รัน เพื่อยืนยัน fail.**
  Run: `npx vitest run server/http-api.test.ts`
  Expected: FAIL (`./http-api` ยังไม่มี).

- [ ] **Step 3: สร้าง `server/http-api.ts`** (เฉพาะ read + create; turn endpoints เพิ่ม Task 5).
  ```ts
  import type { FastifyInstance } from 'fastify'
  import type { ChatHub } from './hub'
  import { listConnections, listChats, getChat, listMessages, type DB } from './store'

  export interface HttpApiDeps {
    hub: ChatHub
    db: DB
  }

  // Native HTTP API (REST + SSE). Shares the ChatHub/ChatRuntime engine with the WS UI so
  // turns originated here broadcast to WS subscribers for free (live-sync).
  // TODO(M6): bearer-token auth + 0.0.0.0 bind. M4 stays on the localhost listener and does
  // NOT enforce a token (see README "Native HTTP API").
  export function registerHttpApi(app: FastifyInstance, deps: HttpApiDeps): void {
    const { hub, db } = deps

    // GET /api/connections — public connection metadata (NEVER api_key)
    app.get('/api/connections', async () => ({ connections: listConnections(db) }))

    // GET /api/chats — list chats (updated_at DESC)
    app.get('/api/chats', async () => ({ chats: listChats(db) }))

    // POST /api/chats — create a chat -> { chatId }
    app.post('/api/chats', async (req, reply) => {
      const body = (req.body ?? {}) as { connectionId?: string; model?: string; cwd?: string; title?: string }
      try {
        const chat = hub.createChatFromApi({
          connectionId: body.connectionId,
          model: body.model,
          cwd: body.cwd,
          title: body.title,
        })
        reply.code(201)
        return { chatId: chat.id }
      } catch (err) {
        reply.code(400)
        return { error: err instanceof Error ? err.message : String(err) }
      }
    })

    // GET /api/chats/:id/messages — stored history
    app.get('/api/chats/:id/messages', async (req, reply) => {
      const { id } = req.params as { id: string }
      if (!getChat(db, id)) {
        reply.code(404)
        return { error: 'chat not found' }
      }
      return { messages: listMessages(db, id) }
    })
  }
  ```

- [ ] **Step 4: รัน เพื่อยืนยัน pass.**
  Run: `npx vitest run server/http-api.test.ts`
  Expected: PASS ทั้งหมด.

- [ ] **Step 5: Wire เข้า `server/index.ts`.**
  5a. เพิ่ม import (ใต้ `import { ChatHub } from './hub'`):
  ```ts
  import { registerHttpApi } from './http-api'
  ```
  5b. เพิ่มบรรทัดเรียก หลังสร้าง `hub` (หลังบล็อก `const hub = new ChatHub({...})`) และ **ก่อน** `attachWebSocketServer(app.server, hub)`:
  ```ts
  registerHttpApi(app, { hub, db })
  ```
  (โครงสุดท้ายของไฟล์: `app.get('/api/health', ...)` → `const hub = new ChatHub({...})` → `registerHttpApi(app, { hub, db })` → `attachWebSocketServer(app.server, hub)` → `await app.listen(...)`.)

- [ ] **Step 6: tsc + commit.**
  ```bash
  npx tsc --noEmit
  git add server/http-api.ts server/http-api.test.ts server/index.ts
  git commit -m "feat(m4): http-api read endpoints (connections/chats/messages) + POST /api/chats + server wiring"
  ```

---

### Task 5: http-api.ts — turn endpoints (POST messages + POST query, stream + non-stream) + SSE mapper

Goal: เพิ่ม `serverMsgToSse` (pure ServerMsg→SSE frame), `runApiTurn` (ตัวจัดการ turn ทั้ง stream/non-stream), และ route `POST /api/chats/:id/messages` + `POST /api/query` ใน `server/http-api.ts`. non-stream คืน `{ text, toolCalls, usage }` (และ `chatId` สำหรับ `/api/query`); stream → SSE event `delta`/`tool_call`/`tool_result`/`done`/`error`. ทดสอบ mapper (pure) + non-stream (inject); stream ครอบใน e2e (Task 6).

**Files:**
- Modify: `P:\AI_PROJECT\Claude\WebPage\server\http-api.ts`
- Test: `P:\AI_PROJECT\Claude\WebPage\server\http-api.test.ts`

**Interfaces:**
- Consumes: `FastifyReply` (`fastify`); `ServerMsg`/`ToolCall` (`../shared/protocol`); `PolicyPermissionResolver`/`PermissionPolicy` (`./permission`); `TurnResult` (`./providers/types`); `ChatHub.enqueueApiTurn`/`createChatFromApi`; `getChat` (`./store`).
- Produces:
  - `export function serverMsgToSse(m: ServerMsg): string | null`
  - route `POST /api/chats/:id/messages`, `POST /api/query`.

- [ ] **Step 1: เขียน failing tests** (เพิ่มใน `server/http-api.test.ts`). เพิ่ม import:
  ```ts
  import { serverMsgToSse } from './http-api'
  import type { ServerMsg } from '../shared/protocol'
  ```
  แล้วเพิ่ม describe-blocks:
  ```ts
  describe('serverMsgToSse', () => {
    it('maps assistant_delta -> delta frame', () => {
      expect(serverMsgToSse({ type: 'assistant_delta', chatId: 'c', text: 'hi' })).toBe(
        'event: delta\ndata: {"text":"hi"}\n\n',
      )
    })
    it('maps tool_call -> tool_call frame', () => {
      expect(serverMsgToSse({ type: 'tool_call', chatId: 'c', id: 't1', name: 'Write', input: { a: 1 } })).toBe(
        'event: tool_call\ndata: {"id":"t1","name":"Write","input":{"a":1}}\n\n',
      )
    })
    it('maps turn_done -> done frame', () => {
      expect(serverMsgToSse({ type: 'turn_done', chatId: 'c', usage: { outputTokens: 3 } })).toBe(
        'event: done\ndata: {"usage":{"outputTokens":3}}\n\n',
      )
    })
    it('maps error -> error frame', () => {
      expect(serverMsgToSse({ type: 'error', chatId: 'c', message: 'boom' })).toBe(
        'event: error\ndata: {"message":"boom"}\n\n',
      )
    })
    it('returns null for interactive/housekeeping messages', () => {
      expect(serverMsgToSse({ type: 'permission_request', chatId: 'c', requestId: 'r', name: 'Write', input: {} })).toBeNull()
      expect(serverMsgToSse({ type: 'chat_list', chats: [] })).toBeNull()
    })
  })

  describe('http-api turn endpoints (non-stream)', () => {
    it('POST /api/chats/:id/messages (stream:false) returns { text, toolCalls, usage }', async () => {
      const { app, hub, db } = makeApp()
      const chat = hub.createChatFromApi({ title: 'T' })
      // default policy = readonly -> FakeProvider's Write is denied -> no toolCalls
      const res = await app.inject({
        method: 'POST',
        url: `/api/chats/${chat.id}/messages`,
        payload: { text: 'hi', stream: false },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { text: string; toolCalls: unknown[]; usage: { outputTokens?: number } }
      expect(body.text).toBe('Hello hi')
      expect(body.toolCalls).toEqual([])
      expect(body.usage).toEqual({ outputTokens: 3 })
      // persisted
      const msgs = await app.inject({ method: 'GET', url: `/api/chats/${chat.id}/messages` })
      expect((msgs.json() as { messages: Array<{ role: string }> }).messages.map((m) => m.role)).toEqual(['user', 'assistant'])
      expect(db).toBeTruthy()
    })

    it('permission:auto allows the Write tool -> toolCalls populated', async () => {
      const { app, hub } = makeApp()
      const chat = hub.createChatFromApi({ title: 'T2' })
      const res = await app.inject({
        method: 'POST',
        url: `/api/chats/${chat.id}/messages`,
        payload: { text: 'hi', stream: false, permission: 'auto' },
      })
      const body = res.json() as { toolCalls: Array<{ name: string }> }
      expect(body.toolCalls.map((t) => t.name)).toEqual(['Write'])
    })

    it('POST messages requires non-empty text (400) and a real chat (404)', async () => {
      const { app, hub } = makeApp()
      const chat = hub.createChatFromApi({ title: 'T3' })
      const noText = await app.inject({ method: 'POST', url: `/api/chats/${chat.id}/messages`, payload: {} })
      expect(noText.statusCode).toBe(400)
      const ghost = await app.inject({ method: 'POST', url: '/api/chats/ghost/messages', payload: { text: 'hi' } })
      expect(ghost.statusCode).toBe(404)
    })

    it('POST /api/query creates a chat and returns { chatId, text, toolCalls, usage }', async () => {
      const { app } = makeApp()
      const res = await app.inject({ method: 'POST', url: '/api/query', payload: { text: 'once', stream: false } })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { chatId: string; text: string; toolCalls: unknown[] }
      expect(body.chatId).toBeTruthy()
      expect(body.text).toBe('Hello once')
    })
  })
  ```

- [ ] **Step 2: รัน เพื่อยืนยัน fail.**
  Run: `npx vitest run server/http-api.test.ts`
  Expected: FAIL (`serverMsgToSse` + turn routes ยังไม่มี).

- [ ] **Step 3: แก้ `server/http-api.ts`** — เพิ่ม imports, `serverMsgToSse`, `runApiTurn`, และ 2 route.
  3a. ขยาย import บนสุด:
  ```ts
  import type { FastifyInstance, FastifyReply } from 'fastify'
  import type { ServerMsg, ToolCall } from '../shared/protocol'
  import type { TurnResult } from './providers/types'
  import type { ChatHub } from './hub'
  import { PolicyPermissionResolver, type PermissionPolicy } from './permission'
  import { listConnections, listChats, getChat, listMessages, type DB } from './store'
  ```
  3b. เพิ่ม helper (วางใต้ `HttpApiDeps` interface, นอก `registerHttpApi`):
  ```ts
  // 'readonly' (default) unless explicitly 'auto'. Any other/absent value -> 'readonly'.
  function parsePolicy(v: unknown): PermissionPolicy {
    return v === 'auto' ? 'auto' : 'readonly'
  }

  function sseFrame(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  }

  // Map a broadcast ServerMsg to a native-API SSE frame, or null to skip messages irrelevant
  // to a non-interactive API caller (permission_*, chat/connection housekeeping). Event names
  // follow the native-API contract: delta / tool_call / tool_result / done / error.
  export function serverMsgToSse(m: ServerMsg): string | null {
    switch (m.type) {
      case 'assistant_delta':
        return sseFrame('delta', { text: m.text })
      case 'tool_call':
        return sseFrame('tool_call', { id: m.id, name: m.name, input: m.input })
      case 'tool_result':
        return sseFrame('tool_result', { id: m.id, result: m.result })
      case 'turn_done':
        return sseFrame('done', { usage: m.usage })
      case 'error':
        return sseFrame('error', { message: m.message })
      default:
        return null
    }
  }

  // Run a native-API turn through the shared hub runtime, returning either an SSE stream
  // (stream=true, via reply.hijack) or a JSON object { text, toolCalls, usage }. `replyChatId`,
  // when provided, is echoed back (used by /api/query so the caller learns the new chatId).
  async function runApiTurn(
    hub: ChatHub,
    reply: FastifyReply,
    chatId: string,
    text: string,
    policy: PermissionPolicy,
    stream: boolean,
    replyChatId?: string,
  ): Promise<unknown> {
    const resolver = new PolicyPermissionResolver(policy)

    if (stream) {
      reply.hijack()
      const raw = reply.raw
      raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      if (replyChatId) raw.write(sseFrame('chat', { chatId: replyChatId }))
      const onEvent = (m: ServerMsg): void => {
        if (raw.writableEnded) return
        const frame = serverMsgToSse(m)
        if (frame) raw.write(frame)
      }
      try {
        await hub.enqueueApiTurn(chatId, text, { resolver, onEvent })
      } catch (err) {
        if (!raw.writableEnded) raw.write(sseFrame('error', { message: err instanceof Error ? err.message : String(err) }))
      }
      if (!raw.writableEnded) raw.end()
      return reply
    }

    // Non-stream: collect tool calls + any error event, return JSON.
    const toolCalls: ToolCall[] = []
    let errorMessage: string | undefined
    const onEvent = (m: ServerMsg): void => {
      if (m.type === 'tool_call') toolCalls.push({ id: m.id, name: m.name, input: m.input })
      else if (m.type === 'error') errorMessage = m.message
    }
    let result: TurnResult
    try {
      result = await hub.enqueueApiTurn(chatId, text, { resolver, onEvent })
    } catch (err) {
      reply.code(500)
      return { error: err instanceof Error ? err.message : String(err) }
    }
    if (errorMessage !== undefined) {
      reply.code(500)
      return { ...(replyChatId ? { chatId: replyChatId } : {}), error: errorMessage }
    }
    reply.code(200)
    return {
      ...(replyChatId ? { chatId: replyChatId } : {}),
      text: result.text,
      toolCalls,
      usage: result.usage,
    }
  }
  ```
  3c. เพิ่ม 2 route ใน `registerHttpApi` (ต่อจาก `GET /api/chats/:id/messages`):
  ```ts
    // POST /api/chats/:id/messages — send a message; stream:false -> JSON, stream:true -> SSE
    app.post('/api/chats/:id/messages', async (req, reply) => {
      const { id } = req.params as { id: string }
      const body = (req.body ?? {}) as { text?: string; stream?: boolean; permission?: string }
      if (typeof body.text !== 'string' || body.text === '') {
        reply.code(400)
        return { error: 'text is required' }
      }
      if (!getChat(db, id)) {
        reply.code(404)
        return { error: 'chat not found' }
      }
      return runApiTurn(hub, reply, id, body.text, parsePolicy(body.permission), body.stream === true)
    })

    // POST /api/query — create a one-off chat then run a single turn (stream or non-stream)
    app.post('/api/query', async (req, reply) => {
      const body = (req.body ?? {}) as {
        text?: string
        connectionId?: string
        model?: string
        cwd?: string
        title?: string
        stream?: boolean
        permission?: string
      }
      if (typeof body.text !== 'string' || body.text === '') {
        reply.code(400)
        return { error: 'text is required' }
      }
      let chatId: string
      try {
        const chat = hub.createChatFromApi({
          connectionId: body.connectionId,
          model: body.model,
          cwd: body.cwd,
          title: body.title ?? 'API query',
        })
        chatId = chat.id
      } catch (err) {
        reply.code(400)
        return { error: err instanceof Error ? err.message : String(err) }
      }
      return runApiTurn(hub, reply, chatId, body.text, parsePolicy(body.permission), body.stream === true, chatId)
    })
  ```

- [ ] **Step 4: รัน เพื่อยืนยัน pass (เก่า + ใหม่).**
  Run: `npx vitest run server/http-api.test.ts`
  Expected: PASS ทั้งหมด.

- [ ] **Step 5: tsc + commit.**
  ```bash
  npx tsc --noEmit
  git add server/http-api.ts server/http-api.test.ts
  git commit -m "feat(m4): http-api turn endpoints — POST messages + POST query (SSE + non-stream) + serverMsgToSse"
  ```

---

### Task 6: e2e-rest harness + README + full verification

Goal: เขียน `scripts/e2e-rest.mjs` (credential-free, in-process) พิสูจน์ end-to-end: REST create chat → non-stream message → SSE message → WS subscriber ได้ turn เดียวกัน (live-sync) → persistence ครบ → `/api/query` → ไม่มี apiKey leak. อัปเดต README. รัน gate ทั้งหมดเป็น sign-off ของ M4.

**Files:**
- Create: `P:\AI_PROJECT\Claude\WebPage\scripts\e2e-rest.mjs`
- Modify: `P:\AI_PROJECT\Claude\WebPage\README.md`

**Interfaces:**
- Consumes: `attachWebSocketServer` (`../server/ws`), `registerHttpApi` (`../server/http-api`), `ChatHub` (`../server/hub`), `openDb`/`listMessages`/`createConnection` (`../server/store`), `makeProvider` (`../server/providers/index`); Node `http`/`fs`/`os`/`path`/`crypto`; `ws` `WebSocket`; global `fetch`.
- Produces: PASS/FAIL script (exit 0/1).

- [ ] **Step 1: สร้าง `scripts/e2e-rest.mjs`.** (สไตล์ single-quote/no-semicolon ตาม `e2e-openai.mjs`; ใช้ openai-compatible + fake SSE upstream เพื่อ credential-free — provider นี้ไม่มี tool จึงไม่แตะ permission, พิสูจน์ REST/SSE/live-sync plumbing ล้วน. policy path ครอบโดย unit/integration แล้ว.)
  ```js
  // Live e2e for the native HTTP API (REST + SSE) — NO external credentials.
  // Boots a fake OpenAI-compatible SSE upstream + the real Fastify/REST/WS/hub stack against
  // a temp DB, seeds an openai-compatible connection in the DB, then: creates a chat over REST,
  // sends a non-stream message, sends a streaming (SSE) message, and asserts a subscribed WS
  // ALSO received the turn (live-sync) + persistence + /api/query + no api_key leak.
  // Run: npx tsx scripts/e2e-rest.mjs
  import http from 'node:http'
  import { mkdtempSync } from 'node:fs'
  import { tmpdir } from 'node:os'
  import { join } from 'node:path'
  import { randomUUID } from 'node:crypto'
  import Fastify from 'fastify'
  import { WebSocket } from 'ws'
  import { attachWebSocketServer } from '../server/ws'
  import { registerHttpApi } from '../server/http-api'
  import { ChatHub } from '../server/hub'
  import { openDb, listMessages, createConnection } from '../server/store'
  import { makeProvider } from '../server/providers/index'

  function fail(msg) {
    console.error('❌', msg)
    process.exit(1)
  }

  // 1) Fake OpenAI-compatible upstream: streams "Hello rest" then [DONE].
  const fake = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url.endsWith('/chat/completions')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const p of ['Hello', ' ', 'rest']) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 3, completion_tokens: 3 } })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    res.writeHead(404).end()
  })
  await new Promise((r) => fake.listen(0, r))
  const baseUrl = `http://127.0.0.1:${fake.address().port}/v1`

  // 2) Backend: Fastify + REST API + WS, temp DB, seeded openai-compatible connection.
  const dbPath = join(mkdtempSync(join(tmpdir(), 'cwa-e2e-rest-')), 'chats.db')
  const db = openDb(dbPath)
  const app = Fastify()
  const hub = new ChatHub({ db, makeProvider, genId: randomUUID, now: Date.now })
  registerHttpApi(app, { hub, db })
  attachWebSocketServer(app.server, hub)
  await app.listen({ port: 0, host: '127.0.0.1' })
  const port = app.server.address().port
  const api = `http://127.0.0.1:${port}/api`

  const connId = randomUUID()
  createConnection(db, {
    id: connId,
    type: 'openai-compatible',
    name: 'e2e-rest',
    baseUrl,
    apiKey: 'unused',
    defaultModel: 'fake-model',
    now: Date.now(),
  })

  // 3) A WS subscriber to prove live-sync of REST-originated turns.
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  const wsMsgs = []
  ws.on('message', (raw) => wsMsgs.push(JSON.parse(raw.toString())))
  await new Promise((resolve) => ws.on('open', resolve))

  // 4) Create a chat over REST.
  const createRes = await fetch(`${api}/chats`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ connectionId: connId, model: 'fake-model', title: 'rest' }),
  })
  if (createRes.status !== 201) fail(`POST /api/chats -> ${createRes.status}`)
  const { chatId } = await createRes.json()
  if (!chatId) fail('POST /api/chats returned no chatId')

  // Subscribe the WS to the chat so it receives the turn broadcasts.
  ws.send(JSON.stringify({ type: 'subscribe', chatId }))
  await new Promise((r) => setTimeout(r, 50))

  // 5) Non-stream message.
  const nsRes = await fetch(`${api}/chats/${chatId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'hi', stream: false }),
  })
  const ns = await nsRes.json()
  if (ns.text !== 'Hello rest') fail(`non-stream text was ${JSON.stringify(ns)}`)

  // 6) Streaming (SSE) message.
  const sseRes = await fetch(`${api}/chats/${chatId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'again', stream: true }),
  })
  if (!sseRes.ok) fail(`SSE status ${sseRes.status}`)
  const sseBody = await sseRes.text()
  const sseDeltas = [...sseBody.matchAll(/event: delta\ndata: (.+)/g)].map((m) => JSON.parse(m[1]).text).join('')
  if (sseDeltas !== 'Hello rest') fail(`SSE deltas were "${sseDeltas}" (raw: ${sseBody})`)
  if (!/event: done/.test(sseBody)) fail('SSE stream missing "done" event')

  // 7) Live-sync: the WS subscriber received both turns' deltas + turn_done for this chat.
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waiting for WS turn_done')), 10000)
    const iv = setInterval(() => {
      const dones = wsMsgs.filter((m) => m.type === 'turn_done' && m.chatId === chatId).length
      if (dones >= 2) {
        clearTimeout(t)
        clearInterval(iv)
        resolve()
      }
    }, 20)
  }).catch((e) => fail(e.message))
  const wsText = wsMsgs.filter((m) => m.type === 'assistant_delta' && m.chatId === chatId).map((m) => m.text).join('')
  if (wsText !== 'Hello restHello rest') fail(`WS live-sync deltas were "${wsText}"`)

  // 8) Persistence: two turns -> user,assistant,user,assistant.
  const roles = listMessages(db, chatId).map((m) => m.role).join(',')
  if (roles !== 'user,assistant,user,assistant') fail(`persisted roles were ${roles}`)

  // 9) /api/query one-off.
  const qRes = await fetch(`${api}/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ connectionId: connId, model: 'fake-model', text: 'once', stream: false }),
  })
  const q = await qRes.json()
  if (!q.chatId || q.text !== 'Hello rest') fail(`/api/query returned ${JSON.stringify(q)}`)

  // 10) GET /api/connections never leaks api_key.
  const conns = await (await fetch(`${api}/connections`)).json()
  if (conns.connections.some((c) => 'apiKey' in c)) fail('apiKey leaked in GET /api/connections')

  console.log('✅ native HTTP API e2e PASS — REST + SSE + live-sync + persistence + /api/query')
  ws.close()
  await app.close()
  fake.close()
  process.exit(0)
  ```

- [ ] **Step 2: รัน e2e-rest.**
  Run: `npx tsx scripts/e2e-rest.mjs`
  Expected: พิมพ์ `✅ native HTTP API e2e PASS ...` แล้ว exit 0. ถ้าค้าง/FAIL: ตรวจว่า port เก่าค้างไหม (8787/8790) แล้ว debug ตาม message.

- [ ] **Step 3: อัปเดต `README.md`** — เพิ่ม section "Native HTTP API (M4)".
  เพิ่มหัวข้อ (วางหลัง section ที่อธิบาย WS/UI; ปรับถ้อยคำให้เข้ากับ README เดิม):
  ```markdown
  ## Native HTTP API (REST + SSE)

  The same chat engine is reachable over REST on the localhost listener (`http://127.0.0.1:8787`,
  proxied via Vite `/api` in dev). Turns sent here also broadcast to any WebSocket UI viewing the
  same chat (live-sync).

  | Method | Path | Body | Returns |
  | --- | --- | --- | --- |
  | GET | `/api/connections` | — | `{ connections }` (no api_key) |
  | GET | `/api/chats` | — | `{ chats }` |
  | POST | `/api/chats` | `{ connectionId?, model?, cwd?, title? }` | `201 { chatId }` |
  | GET | `/api/chats/:id/messages` | — | `{ messages }` (404 if unknown) |
  | POST | `/api/chats/:id/messages` | `{ text, stream?, permission? }` | non-stream `{ text, toolCalls, usage }`; stream → SSE |
  | POST | `/api/query` | `{ text, connectionId?, model?, cwd?, stream?, permission? }` | one-off chat + turn |

  - `permission`: `readonly` (default — read-only tools auto-allowed, writes/commands denied) or
    `auto` (all tools allowed). Applies to local-agent connections; chat-only providers ignore it.
  - SSE events: `delta` `{text}`, `tool_call` `{id,name,input}`, `tool_result` `{id,result}`,
    `done` `{usage}`, `error` `{message}` (and a leading `chat` `{chatId}` for `/api/query`).
  - **Auth:** M4 binds localhost only and does NOT enforce a bearer token yet. LAN bind
    (`0.0.0.0`) + `Authorization: Bearer <token>` arrive in M6 — do not expose this port to an
    untrusted network until then.

  Example:
  ```bash
  curl -s localhost:8787/api/connections
  CHAT=$(curl -s -XPOST localhost:8787/api/chats -H 'content-type: application/json' -d '{}' | jq -r .chatId)
  curl -s -XPOST localhost:8787/api/chats/$CHAT/messages -H 'content-type: application/json' -d '{"text":"hello"}'
  ```
  ```

- [ ] **Step 4: รัน gate ทั้งหมด (M4 sign-off).**
  Run ทีละคำสั่ง:
  ```bash
  npx tsc --noEmit
  npx tsc -p web/tsconfig.json
  npx vitest run
  npm run build:web
  npx tsx scripts/e2e-openai.mjs
  npx tsx scripts/e2e-rest.mjs
  ```
  Expected: tsc (server+shared) clean; web tsc clean (M4 ไม่แตะ web); Vitest **เขียวทั้งหมด** (176 baseline + tests ใหม่ของ Task 1/2/3/4/5); build:web ok; e2e-openai PASS (regression — WS path ไม่พัง); e2e-rest PASS.

- [ ] **Step 5: Commit.**
  ```bash
  git add scripts/e2e-rest.mjs README.md
  git commit -m "test(m4): credential-free REST+SSE+live-sync e2e (e2e-rest) + README native HTTP API"
  ```

- [ ] **Step 6: Opus whole-branch review + merge** (ตาม M-convention — ดู Execution Handoff ด้านล่าง).
  หลัง review ผ่าน:
  ```bash
  git checkout master
  git merge --no-ff feat/m4-http-api -m "merge: M4 native HTTP API (REST + SSE + per-turn permission policy)"
  ```

---

## Self-Review (ผู้เขียน plan ตรวจกับ spec แล้ว)

**Spec coverage (§8 endpoints):**
- `GET /api/connections` → Task 4 ✓ (no api_key — Global Constraint + test).
- `POST /api/chats` `{connectionId,model,cwd?}` → `{chatId}` → Task 4 ✓.
- `GET /api/chats` → Task 4 ✓.
- `GET /api/chats/:id/messages` → Task 4 ✓ (+404).
- `POST /api/chats/:id/messages` `{text,stream?,permission?}` (stream/non-stream) → Task 5 ✓.
- `POST /api/query` (one-off) → Task 5 ✓.
- "broadcast ไป WS subscriber (live-sync)" → Task 2 (onEvent + broadcast คู่กัน) + Task 3 (enqueueApiTurn ใช้ getOrCreateRuntime ตัวเดิม) + e2e ยืนยัน (Task 6) ✓.
- "serialize ต่อห้อง" → reuse `ChatRuntime` queue เดิม (REST + WS enqueue เข้า queue เดียวกัน) ✓.
- §5 `PolicyPermissionResolver` (readonly default / auto) + per-turn binding → Task 1 + Task 2 ✓.
- §16 M4 scope (REST+SSE, PolicyPermissionResolver, live sync, serialize) ครบ; auth/0.0.0.0 = M6 (deferred ตาม handoff) ✓.

**Placeholder scan:** ทุก step มี code/command จริง ไม่มี "TBD/implement later/add error handling"; ข้อยกเว้นเดียวคือ comment `// TODO(M6): bearer-token auth` ซึ่งเป็น marker เจตนา (auth = M6) ไม่ใช่ placeholder ของงาน M4.

**Type consistency:** `PermissionResolver`/`PermissionDecision`/`PermissionPolicy` (permission.ts), `TurnResult`/`Provider`/`ProviderContext` (providers/types.ts), `ServerMsg`/`ChatMeta`/`ToolCall` (shared/protocol.ts), `enqueue(text, opts?): Promise<TurnResult>` ใช้ชื่อ/ชนิดตรงกันทุก task (ตรวจกับ signature จริงจากโค้ดปัจจุบัน). `EnqueueOptions.onEvent` ↔ `runOne` ↔ `enqueueApiTurn.opts.onEvent` ↔ `runApiTurn.onEvent` ชนิด `(m: ServerMsg) => void` สม่ำเสมอ. `createChatFromApi` คืน `ChatMeta`; `POST /api/chats` คืน `{ chatId: chat.id }` (สอดคล้อง spec).

**ความเสี่ยงที่ฝัง guard ไว้แล้ว:** (1) `runTurn` ไม่ throw → REST อ่าน error จาก `onEvent` ไม่ใช่ rejected promise (Global Constraint + non-stream handler). (2) per-turn promise settle ใน `finally` เสมอ (รวม disposed) + queued items settle ตอน interrupt/dispose → ไม่ค้าง. (3) `broadcast` ยังต่ออยู่ → WS live-sync ไม่ดับ. (4) `getOrCreateRuntime` throw → broadcast chat-scoped error+turn_done + throw (mirror WS contract). (5) api_key ไม่หลุด (ใช้ secret-free getter + test). (6) tsc เขียวตลอด (ไม่มี protocol migration).

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-18-claude-web-agent-m4-http-api.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — controller pattern (ตาม handoff M1-M3): record BASE sha → dispatch ONE implementer ต่อ task (model: sonnet ทุก task; ไม่มี task trivial พอสำหรับ haiku) → `review-package BASE HEAD` → ONE sonnet task reviewer → fix loop → ledger line ใน `.git/sdd/progress.md` (section `## M4`). **จบด้วย opus whole-branch review** (Task 6 Step 6) — caught cross-cutting bugs ทุก milestone ที่ per-task review พลาด. ลบ stale `.git/sdd/task-*-report.md` จาก milestone ก่อนก่อนเริ่ม.

**2. Inline Execution** — executing-plans, batch + checkpoints.

**หลัง execute เสร็จ:** รัน `9arm-skills:scrutinize` (post-merge end-to-end) ก่อน/หลัง merge — เจอ bug จริงที่ review อื่นพลาดทุก milestone — แล้ว `superpowers:finishing-a-development-branch` merge `feat/m4-http-api` `--no-ff` → `master`.

**Which approach?**
