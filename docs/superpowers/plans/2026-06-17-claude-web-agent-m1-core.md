# Claude Web Agent — M1 (Core local-agent + UI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** เปิดหน้าเว็บ localhost คุยกับ Claude (local-agent ผ่าน Claude Agent SDK) แบบ streaming ในห้องเดียว โดย Claude อ่านไฟล์ได้เอง และเด้ง modal ขออนุญาตก่อนเขียนไฟล์/รันคำสั่ง

**Architecture:** Backend = Node + Fastify เสิร์ฟ + WebSocket (`ws`) ต่อ 1 connection = 1 chat session. ฝั่ง server มี `Provider` interface (M1 มี `LocalAgentProvider` ครอบ `@anthropic-ai/claude-agent-sdk` `query()` + `FakeProvider` สำหรับเทสต์), `runTurn()` orchestration ที่ส่ง event ผ่าน callback, และ `InteractivePermissionResolver` ที่ auto-allow read tools แต่ส่งคำขอ permission ไป client สำหรับ write/run. Frontend = React + Vite + Tailwind, แยก state logic เป็น pure reducer (`reduce(state, ServerMsg)`) ที่เทสต์ได้.

**Tech Stack:** Node 20+, TypeScript (ESM, moduleResolution Bundler), Fastify, `ws`, `@anthropic-ai/claude-agent-sdk`, React 18, Vite, Tailwind, react-markdown, Vitest.

## Global Constraints

- Node 20+, package `"type": "module"` ทั้งโปรเจกต์
- TypeScript strict; `module: ESNext`, `moduleResolution: Bundler` (import แบบไม่ต้องมีนามสกุล .js); dev รัน server ด้วย `tsx` (ไม่ build), web ด้วย Vite
- Shared types อยู่ที่ `shared/protocol.ts` — server import แบบ relative, web import ผ่าน alias `@shared/*`
- Port: backend = `8787`, Vite dev = `5173`; Vite proxy `/ws` และ `/api` → backend
- M1: ห้องเดียว, ไม่ persist, ไม่มี auth, localhost เท่านั้น (auth/LAN อยู่ M6)
- Read-only tools ที่ auto-allow: `Read, Glob, Grep, NotebookRead, WebSearch, WebFetch, TodoWrite`
- Test framework: Vitest (`environment: node`); ทุก pure logic ต้องมี unit test ก่อน implement (TDD)
- model alias ของ local-agent: ใช้ `'sonnet'` เป็น default ใน M1
- commit บ่อย ทีละ task

---

### Task 1: Project scaffold + toolchain

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore` (มีอยู่แล้ว — ตรวจ), `server/health.ts`, `server/health.test.ts`

**Interfaces:**
- Produces: `pingMessage(): string` ใน `server/health.ts` (ไว้พิสูจน์ว่า toolchain + test ทำงาน)

- [ ] **Step 1: สร้าง `package.json`**

```json
{
  "name": "claude-web-agent",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "concurrently -n server,web -c blue,green \"npm:dev:server\" \"npm:dev:web\"",
    "dev:server": "tsx watch server/index.ts",
    "dev:web": "vite",
    "build:web": "vite build",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^0.1.0",
    "fastify": "^4.28.0",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "@types/ws": "^8.5.10",
    "@types/react": "^18.3.3",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.1",
    "autoprefixer": "^10.4.19",
    "concurrently": "^8.2.2",
    "postcss": "^8.4.39",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-markdown": "^9.0.1",
    "tailwindcss": "^3.4.6",
    "tsx": "^4.16.0",
    "typescript": "^5.5.3",
    "vite": "^5.3.3",
    "vitest": "^2.0.0"
  }
}
```

> หมายเหตุ: ถ้า `@anthropic-ai/claude-agent-sdk` เวอร์ชันจริงต่างจาก `^0.1.0` ให้ใช้ `npm view @anthropic-ai/claude-agent-sdk version` แล้วใส่เวอร์ชันล่าสุด

- [ ] **Step 2: สร้าง `tsconfig.json`** (server + shared)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"],
    "baseUrl": ".",
    "paths": { "@shared/*": ["shared/*"] }
  },
  "include": ["server", "shared"]
}
```

- [ ] **Step 3: สร้าง `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['server/**/*.test.ts', 'web/src/**/*.test.ts'],
  },
})
```

- [ ] **Step 4: เขียน failing test `server/health.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { pingMessage } from './health'

describe('pingMessage', () => {
  it('returns a stable ping string', () => {
    expect(pingMessage()).toBe('claude-web-agent: ok')
  })
})
```

- [ ] **Step 5: ติดตั้ง deps แล้วรันเทสต์ให้ fail**

Run: `npm install && npx vitest run server/health.test.ts`
Expected: FAIL — `Cannot find module './health'` (ยังไม่ได้สร้าง)

- [ ] **Step 6: สร้าง `server/health.ts`**

```ts
export function pingMessage(): string {
  return 'claude-web-agent: ok'
}
```

- [ ] **Step 7: รันเทสต์ให้ผ่าน**

Run: `npx vitest run server/health.test.ts`
Expected: PASS (1 test)

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts server/health.ts server/health.test.ts
git commit -m "chore: scaffold project + toolchain (vitest passing)"
```

---

### Task 2: Shared protocol types

**Files:**
- Create: `shared/protocol.ts`, `shared/protocol.test.ts`

**Interfaces:**
- Produces:
  - `type ToolCall = { id: string; name: string; input: unknown }`
  - `type Usage = { inputTokens?: number; outputTokens?: number; costUsd?: number }`
  - `type ClientMsg` (union: `user_message`, `permission_response`, `interrupt`)
  - `type ServerMsg` (union: `assistant_delta`, `tool_call`, `tool_result`, `permission_request`, `turn_done`, `error`)
  - `parseClientMsg(raw: string): ClientMsg | null` — parse + validate ขั้นต่ำ

- [ ] **Step 1: เขียน failing test `shared/protocol.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { parseClientMsg } from './protocol'

describe('parseClientMsg', () => {
  it('parses a valid user_message', () => {
    const m = parseClientMsg(JSON.stringify({ type: 'user_message', text: 'hi' }))
    expect(m).toEqual({ type: 'user_message', text: 'hi' })
  })

  it('parses a permission_response', () => {
    const m = parseClientMsg(JSON.stringify({ type: 'permission_response', requestId: 'r1', decision: 'allow' }))
    expect(m).toEqual({ type: 'permission_response', requestId: 'r1', decision: 'allow' })
  })

  it('returns null for unknown type', () => {
    expect(parseClientMsg(JSON.stringify({ type: 'nope' }))).toBeNull()
  })

  it('returns null for invalid JSON', () => {
    expect(parseClientMsg('{not json')).toBeNull()
  })
})
```

- [ ] **Step 2: รันเทสต์ให้ fail**

Run: `npx vitest run shared/protocol.test.ts`
Expected: FAIL — `Cannot find module './protocol'`

- [ ] **Step 3: สร้าง `shared/protocol.ts`**

```ts
export type ToolCall = { id: string; name: string; input: unknown }
export type Usage = { inputTokens?: number; outputTokens?: number; costUsd?: number }

export type ClientMsg =
  | { type: 'user_message'; text: string }
  | { type: 'permission_response'; requestId: string; decision: 'allow' | 'deny' }
  | { type: 'interrupt' }

export type ServerMsg =
  | { type: 'assistant_delta'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; result: unknown }
  | { type: 'permission_request'; requestId: string; name: string; input: unknown }
  | { type: 'turn_done'; usage?: Usage }
  | { type: 'error'; message: string }

export function parseClientMsg(raw: string): ClientMsg | null {
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  switch (o.type) {
    case 'user_message':
      return typeof o.text === 'string' ? { type: 'user_message', text: o.text } : null
    case 'permission_response':
      return typeof o.requestId === 'string' && (o.decision === 'allow' || o.decision === 'deny')
        ? { type: 'permission_response', requestId: o.requestId, decision: o.decision }
        : null
    case 'interrupt':
      return { type: 'interrupt' }
    default:
      return null
  }
}
```

- [ ] **Step 4: รันเทสต์ให้ผ่าน**

Run: `npx vitest run shared/protocol.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add shared/protocol.ts shared/protocol.test.ts
git commit -m "feat: shared WS protocol types + parseClientMsg"
```

---

### Task 3: Permission resolver

**Files:**
- Create: `server/permission.ts`, `server/permission.test.ts`

**Interfaces:**
- Consumes: `ServerMsg` จาก `shared/protocol`
- Produces:
  - `READ_ONLY_TOOLS: Set<string>`, `isReadOnlyTool(name: string): boolean`
  - `type PermissionDecision = { behavior: 'allow'; updatedInput?: unknown } | { behavior: 'deny'; message: string }`
  - `interface PermissionResolver { resolve(toolName: string, input: unknown): Promise<PermissionDecision> }`
  - `class InteractivePermissionResolver implements PermissionResolver` — ctor `(send: (m: ServerMsg) => void, genId: () => string)`; method `handleResponse(requestId: string, decision: 'allow' | 'deny'): void`

- [ ] **Step 1: เขียน failing test `server/permission.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest'
import type { ServerMsg } from '../shared/protocol'
import { isReadOnlyTool, InteractivePermissionResolver } from './permission'

describe('isReadOnlyTool', () => {
  it('treats Read/Glob/Grep as read-only', () => {
    expect(isReadOnlyTool('Read')).toBe(true)
    expect(isReadOnlyTool('Grep')).toBe(true)
  })
  it('treats Write/Bash as NOT read-only', () => {
    expect(isReadOnlyTool('Write')).toBe(false)
    expect(isReadOnlyTool('Bash')).toBe(false)
  })
})

describe('InteractivePermissionResolver', () => {
  it('auto-allows read-only tools without sending a request', async () => {
    const sent: ServerMsg[] = []
    const r = new InteractivePermissionResolver((m) => sent.push(m), () => 'id1')
    const d = await r.resolve('Read', { file_path: '/a' })
    expect(d).toEqual({ behavior: 'allow' })
    expect(sent).toHaveLength(0)
  })

  it('sends a permission_request for write tools and resolves on allow', async () => {
    const sent: ServerMsg[] = []
    let id = 0
    const r = new InteractivePermissionResolver((m) => sent.push(m), () => `req${++id}`)
    const p = r.resolve('Write', { file_path: '/a' })
    expect(sent).toEqual([{ type: 'permission_request', requestId: 'req1', name: 'Write', input: { file_path: '/a' } }])
    r.handleResponse('req1', 'allow')
    await expect(p).resolves.toEqual({ behavior: 'allow' })
  })

  it('resolves deny with a message', async () => {
    const r = new InteractivePermissionResolver(() => {}, () => 'req1')
    const p = r.resolve('Bash', { command: 'rm -rf /' })
    r.handleResponse('req1', 'deny')
    await expect(p).resolves.toEqual({ behavior: 'deny', message: 'User denied' })
  })

  it('ignores responses for unknown requestId', () => {
    const r = new InteractivePermissionResolver(() => {}, () => 'x')
    expect(() => r.handleResponse('nonexistent', 'allow')).not.toThrow()
  })
})
```

- [ ] **Step 2: รันเทสต์ให้ fail**

Run: `npx vitest run server/permission.test.ts`
Expected: FAIL — `Cannot find module './permission'`

- [ ] **Step 3: สร้าง `server/permission.ts`**

```ts
import type { ServerMsg } from '../shared/protocol'

export const READ_ONLY_TOOLS = new Set<string>([
  'Read', 'Glob', 'Grep', 'NotebookRead', 'WebSearch', 'WebFetch', 'TodoWrite',
])

export function isReadOnlyTool(name: string): boolean {
  return READ_ONLY_TOOLS.has(name)
}

export type PermissionDecision =
  | { behavior: 'allow'; updatedInput?: unknown }
  | { behavior: 'deny'; message: string }

export interface PermissionResolver {
  resolve(toolName: string, input: unknown): Promise<PermissionDecision>
}

export class InteractivePermissionResolver implements PermissionResolver {
  private pending = new Map<string, (d: PermissionDecision) => void>()

  constructor(
    private send: (m: ServerMsg) => void,
    private genId: () => string,
  ) {}

  async resolve(toolName: string, input: unknown): Promise<PermissionDecision> {
    if (isReadOnlyTool(toolName)) return { behavior: 'allow' }
    const requestId = this.genId()
    this.send({ type: 'permission_request', requestId, name: toolName, input })
    return new Promise<PermissionDecision>((resolve) => {
      this.pending.set(requestId, resolve)
    })
  }

  handleResponse(requestId: string, decision: 'allow' | 'deny'): void {
    const fn = this.pending.get(requestId)
    if (!fn) return
    this.pending.delete(requestId)
    fn(decision === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: 'User denied' })
  }
}
```

- [ ] **Step 4: รันเทสต์ให้ผ่าน**

Run: `npx vitest run server/permission.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add server/permission.ts server/permission.test.ts
git commit -m "feat: permission resolver (auto-allow reads, ask for writes)"
```

---

### Task 4: Provider interface + FakeProvider + runTurn orchestration

**Files:**
- Create: `server/providers/types.ts`, `server/providers/fake.ts`, `server/agent.ts`, `server/agent.test.ts`

**Interfaces:**
- Consumes: `PermissionResolver` (Task 3), `ToolCall`, `Usage`, `ServerMsg` (Task 2)
- Produces:
  - `interface ProviderContext { onDelta(text): void; onToolCall(c: ToolCall): void; onToolResult(id: string, result: unknown): void; permission: PermissionResolver; signal: AbortSignal }`
  - `interface TurnParams { userText: string; cwd?: string; model?: string; sdkSessionId?: string }`
  - `interface TurnResult { text: string; usage?: Usage; sdkSessionId?: string }`
  - `interface Provider { readonly type: string; send(params: TurnParams, ctx: ProviderContext): Promise<TurnResult> }`
  - `class FakeProvider implements Provider` — ขับ ctx callbacks ตาม script เพื่อเทสต์
  - `runTurn(provider, params, deps): Promise<TurnResult>` where `deps = { send: (m: ServerMsg) => void; permission: PermissionResolver; signal: AbortSignal }`

- [ ] **Step 1: สร้าง `server/providers/types.ts`** (ยังไม่มีเทสต์ — เป็น type ล้วน)

```ts
import type { ToolCall, Usage } from '../../shared/protocol'
import type { PermissionResolver } from '../permission'

export interface ProviderContext {
  onDelta(text: string): void
  onToolCall(call: ToolCall): void
  onToolResult(id: string, result: unknown): void
  permission: PermissionResolver
  signal: AbortSignal
}

export interface TurnParams {
  userText: string
  cwd?: string
  model?: string
  sdkSessionId?: string
}

export interface TurnResult {
  text: string
  usage?: Usage
  sdkSessionId?: string
}

export interface Provider {
  readonly type: string
  send(params: TurnParams, ctx: ProviderContext): Promise<TurnResult>
}
```

- [ ] **Step 2: สร้าง `server/providers/fake.ts`**

```ts
import type { Provider, ProviderContext, TurnParams, TurnResult } from './types'

/** Provider ปลอมสำหรับเทสต์ orchestration: ส่ง delta สองชิ้น, เรียก tool หนึ่งตัว (ผ่าน permission), แล้วจบ */
export class FakeProvider implements Provider {
  readonly type = 'fake'

  async send(params: TurnParams, ctx: ProviderContext): Promise<TurnResult> {
    ctx.onDelta('Hello ')
    ctx.onDelta(params.userText)
    const decision = await ctx.permission.resolve('Write', { file_path: '/tmp/x' })
    if (decision.behavior === 'allow') {
      ctx.onToolCall({ id: 't1', name: 'Write', input: { file_path: '/tmp/x' } })
      ctx.onToolResult('t1', 'written')
    }
    return { text: 'Hello ' + params.userText, usage: { outputTokens: 3 }, sdkSessionId: 'sess-1' }
  }
}
```

- [ ] **Step 3: เขียน failing test `server/agent.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import type { ServerMsg } from '../shared/protocol'
import { InteractivePermissionResolver } from './permission'
import { FakeProvider } from './providers/fake'
import { runTurn } from './agent'

describe('runTurn', () => {
  it('wires provider callbacks into ServerMsg stream and emits turn_done', async () => {
    const sent: ServerMsg[] = []
    let id = 0
    const permission = new InteractivePermissionResolver((m) => sent.push(m), () => `req${++id}`)
    const ac = new AbortController()

    const p = runTurn(new FakeProvider(), { userText: 'world' }, { send: (m) => sent.push(m), permission, signal: ac.signal })

    // FakeProvider asks permission for Write -> auto answer allow
    // wait a microtask for the request to be emitted
    await Promise.resolve()
    const req = sent.find((m) => m.type === 'permission_request') as Extract<ServerMsg, { type: 'permission_request' }>
    expect(req).toBeTruthy()
    permission.handleResponse(req.requestId, 'allow')

    const result = await p
    expect(result.text).toBe('Hello world')
    expect(result.sdkSessionId).toBe('sess-1')

    const types = sent.map((m) => m.type)
    expect(types).toContain('assistant_delta')
    expect(types).toContain('tool_call')
    expect(types).toContain('tool_result')
    expect(types[types.length - 1]).toBe('turn_done')
  })
})
```

- [ ] **Step 4: รันเทสต์ให้ fail**

Run: `npx vitest run server/agent.test.ts`
Expected: FAIL — `Cannot find module './agent'`

- [ ] **Step 5: สร้าง `server/agent.ts`**

```ts
import type { ServerMsg } from '../shared/protocol'
import type { PermissionResolver } from './permission'
import type { Provider, ProviderContext, TurnParams, TurnResult } from './providers/types'

export interface RunDeps {
  send: (m: ServerMsg) => void
  permission: PermissionResolver
  signal: AbortSignal
}

export async function runTurn(provider: Provider, params: TurnParams, deps: RunDeps): Promise<TurnResult> {
  const ctx: ProviderContext = {
    onDelta: (text) => deps.send({ type: 'assistant_delta', text }),
    onToolCall: (c) => deps.send({ type: 'tool_call', id: c.id, name: c.name, input: c.input }),
    onToolResult: (id, result) => deps.send({ type: 'tool_result', id, result }),
    permission: deps.permission,
    signal: deps.signal,
  }
  try {
    const result = await provider.send(params, ctx)
    deps.send({ type: 'turn_done', usage: result.usage })
    return result
  } catch (err) {
    deps.send({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    deps.send({ type: 'turn_done' })
    return { text: '' }
  }
}
```

- [ ] **Step 6: รันเทสต์ให้ผ่าน**

Run: `npx vitest run server/agent.test.ts`
Expected: PASS (1 test)

- [ ] **Step 7: Commit**

```bash
git add server/providers/types.ts server/providers/fake.ts server/agent.ts server/agent.test.ts
git commit -m "feat: provider interface + FakeProvider + runTurn orchestration"
```

---

### Task 5: LocalAgentProvider (Claude Agent SDK)

**Files:**
- Create: `server/providers/localAgent.ts`, `server/providers/localAgent.test.ts`

**Interfaces:**
- Consumes: `Provider`, `ProviderContext`, `TurnParams`, `TurnResult` (Task 4)
- Produces: `class LocalAgentProvider implements Provider` — ctor `(queryFn = query)` (inject ได้เพื่อเทสต์); แปลง SDK message stream → ctx callbacks; ใช้ `canUseTool` → `ctx.permission.resolve`; คืน `sdkSessionId` จาก system/init

> หมายเหตุ SDK boundary: รูปแบบ message ของ `@anthropic-ai/claude-agent-sdk` ถูก map ใน `mapSdkMessage`. เทสต์ใช้ `queryFn` ปลอม (async generator) จึงไม่ผูกกับ runtime จริง. การยืนยันรูปแบบจริง (เช่น input message shape, partial event) อยู่ใน Task 11 (e2e กับ Claude จริง) — ปรับ map ตรงนั้นถ้าจำเป็น

- [ ] **Step 1: เขียน failing test `server/providers/localAgent.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import type { ToolCall } from '../../shared/protocol'
import type { ProviderContext } from './types'
import { LocalAgentProvider } from './localAgent'

// async generator ปลอมเลียนแบบ SDK query()
function fakeQuery(_opts: unknown) {
  async function* gen() {
    yield { type: 'system', subtype: 'init', session_id: 'sess-xyz' }
    yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } } }
    yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/a' } }] } }
    yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'file body' }] } }
    yield { type: 'result', subtype: 'success', result: 'Hi done', usage: { input_tokens: 5, output_tokens: 2 } }
  }
  const it = gen()
  return Object.assign(it, { interrupt: async () => {} })
}

function makeCtx() {
  const deltas: string[] = []
  const tools: ToolCall[] = []
  const results: Array<[string, unknown]> = []
  const ctx: ProviderContext = {
    onDelta: (t) => deltas.push(t),
    onToolCall: (c) => tools.push(c),
    onToolResult: (id, r) => results.push([id, r]),
    permission: { resolve: async () => ({ behavior: 'allow' }) },
    signal: new AbortController().signal,
  }
  return { ctx, deltas, tools, results }
}

describe('LocalAgentProvider', () => {
  it('maps SDK messages into provider callbacks and returns session id + text', async () => {
    const { ctx, deltas, tools, results } = makeCtx()
    const provider = new LocalAgentProvider(fakeQuery as never)
    const res = await provider.send({ userText: 'hello' }, ctx)

    expect(deltas).toEqual(['Hi'])
    expect(tools).toEqual([{ id: 'tu1', name: 'Read', input: { file_path: '/a' } }])
    expect(results).toEqual([['tu1', 'file body']])
    expect(res.sdkSessionId).toBe('sess-xyz')
    expect(res.text).toBe('Hi done')
    expect(res.usage).toEqual({ inputTokens: 5, outputTokens: 2 })
  })
})
```

- [ ] **Step 2: รันเทสต์ให้ fail**

Run: `npx vitest run server/providers/localAgent.test.ts`
Expected: FAIL — `Cannot find module './localAgent'`

- [ ] **Step 3: สร้าง `server/providers/localAgent.ts`**

```ts
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { Usage } from '../../shared/protocol'
import type { Provider, ProviderContext, TurnParams, TurnResult } from './types'

type QueryFn = typeof query

export class LocalAgentProvider implements Provider {
  readonly type = 'local-agent'

  constructor(private queryFn: QueryFn = query) {}

  async send(params: TurnParams, ctx: ProviderContext): Promise<TurnResult> {
    const self = this
    let sessionId = params.sdkSessionId
    let finalText = ''
    let usage: Usage | undefined

    async function* input() {
      yield {
        type: 'user' as const,
        message: { role: 'user' as const, content: params.userText },
        parent_tool_use_id: null,
        session_id: sessionId ?? '',
      }
    }

    const q = self.queryFn({
      // streaming input mode (จำเป็นสำหรับ canUseTool)
      prompt: input() as never,
      options: {
        cwd: params.cwd,
        model: params.model,
        includePartialMessages: true,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        ...(sessionId ? { resume: sessionId } : {}),
        canUseTool: async (toolName: string, toolInput: unknown) => {
          return ctx.permission.resolve(toolName, toolInput)
        },
      } as never,
    })

    for await (const msg of q as AsyncIterable<any>) {
      if (ctx.signal.aborted) {
        await (q as any).interrupt?.()
        break
      }
      switch (msg.type) {
        case 'system':
          if (msg.subtype === 'init' && typeof msg.session_id === 'string') sessionId = msg.session_id
          break
        case 'stream_event': {
          const ev = msg.event
          if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
            ctx.onDelta(ev.delta.text)
          }
          break
        }
        case 'assistant': {
          const content = msg.message?.content
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block?.type === 'tool_use') {
                ctx.onToolCall({ id: block.id, name: block.name, input: block.input })
              }
            }
          }
          break
        }
        case 'user': {
          const content = msg.message?.content
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block?.type === 'tool_result') {
                ctx.onToolResult(block.tool_use_id, block.content)
              }
            }
          }
          break
        }
        case 'result': {
          if (msg.subtype === 'success' && typeof msg.result === 'string') finalText = msg.result
          if (msg.usage) {
            usage = { inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens }
          }
          break
        }
      }
    }

    return { text: finalText, usage, sdkSessionId: sessionId }
  }
}
```

- [ ] **Step 4: รันเทสต์ให้ผ่าน**

Run: `npx vitest run server/providers/localAgent.test.ts`
Expected: PASS (1 test)

- [ ] **Step 5: Commit**

```bash
git add server/providers/localAgent.ts server/providers/localAgent.test.ts
git commit -m "feat: LocalAgentProvider wrapping Claude Agent SDK query()"
```

---

### Task 6: Fastify + WebSocket server (ใช้ FakeProvider ก่อน)

**Files:**
- Create: `server/ws.ts`, `server/ws.test.ts`, `server/index.ts`

**Interfaces:**
- Consumes: `parseClientMsg` (Task 2), `runTurn` (Task 4), `InteractivePermissionResolver` (Task 3), `Provider` (Task 4)
- Produces:
  - `class ChatSession` — ctor `(send: (m: ServerMsg) => void, provider: Provider, opts?: { cwd?: string; model?: string })`; method `handle(raw: string): void`; เก็บ `sdkSessionId` ในตัว, serialize ทีละ turn, รองรับ interrupt
  - `attachWebSocketServer(httpServer, makeProvider: () => Provider): WebSocketServer`
  - `server/index.ts` รัน Fastify + attach WS (default provider = LocalAgentProvider)

- [ ] **Step 1: เขียน failing test `server/ws.test.ts`** (เทสต์ `ChatSession` ตรงๆ ไม่ต้องเปิด socket จริง)

```ts
import { describe, it, expect } from 'vitest'
import type { ServerMsg } from '../shared/protocol'
import { FakeProvider } from './providers/fake'
import { ChatSession } from './ws'

describe('ChatSession', () => {
  it('runs a turn on user_message and answers an auto-emitted permission request', async () => {
    const sent: ServerMsg[] = []
    const session = new ChatSession((m) => sent.push(m), new FakeProvider())

    session.handle(JSON.stringify({ type: 'user_message', text: 'world' }))

    // รอ permission_request โผล่ แล้วตอบ allow ผ่าน handle()
    await waitFor(() => sent.some((m) => m.type === 'permission_request'))
    const req = sent.find((m) => m.type === 'permission_request') as Extract<ServerMsg, { type: 'permission_request' }>
    session.handle(JSON.stringify({ type: 'permission_response', requestId: req.requestId, decision: 'allow' }))

    await waitFor(() => sent.some((m) => m.type === 'turn_done'))
    const types = sent.map((m) => m.type)
    expect(types).toContain('assistant_delta')
    expect(types).toContain('tool_call')
    expect(types[types.length - 1]).toBe('turn_done')
  })

  it('ignores malformed messages', () => {
    const sent: ServerMsg[] = []
    const session = new ChatSession((m) => sent.push(m), new FakeProvider())
    expect(() => session.handle('{not json')).not.toThrow()
    expect(sent).toHaveLength(0)
  })
})

function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = () => {
      if (cond()) return resolve()
      if (Date.now() - start > timeoutMs) return reject(new Error('timeout'))
      setTimeout(tick, 5)
    }
    tick()
  })
}
```

- [ ] **Step 2: รันเทสต์ให้ fail**

Run: `npx vitest run server/ws.test.ts`
Expected: FAIL — `Cannot find module './ws'`

- [ ] **Step 3: สร้าง `server/ws.ts`**

```ts
import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { parseClientMsg, type ServerMsg } from '../shared/protocol'
import { InteractivePermissionResolver } from './permission'
import { runTurn } from './agent'
import type { Provider } from './providers/types'

export class ChatSession {
  private permission: InteractivePermissionResolver
  private sdkSessionId?: string
  private currentAbort?: AbortController
  private queue: string[] = []
  private running = false

  constructor(
    private send: (m: ServerMsg) => void,
    private provider: Provider,
    private opts: { cwd?: string; model?: string } = {},
  ) {
    this.permission = new InteractivePermissionResolver(send, () => randomUUID())
  }

  handle(raw: string): void {
    const msg = parseClientMsg(raw)
    if (!msg) return
    switch (msg.type) {
      case 'user_message':
        this.queue.push(msg.text)
        void this.drain()
        break
      case 'permission_response':
        this.permission.handleResponse(msg.requestId, msg.decision)
        break
      case 'interrupt':
        this.currentAbort?.abort()
        break
    }
  }

  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.queue.length > 0) {
        const userText = this.queue.shift() as string
        const ac = new AbortController()
        this.currentAbort = ac
        const result = await runTurn(
          this.provider,
          { userText, cwd: this.opts.cwd, model: this.opts.model ?? 'sonnet', sdkSessionId: this.sdkSessionId },
          { send: this.send, permission: this.permission, signal: ac.signal },
        )
        if (result.sdkSessionId) this.sdkSessionId = result.sdkSessionId
      }
    } finally {
      this.running = false
    }
  }
}

export function attachWebSocketServer(httpServer: Server, makeProvider: () => Provider): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' })
  wss.on('connection', (socket: WebSocket) => {
    const send = (m: ServerMsg) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(m))
    }
    const session = new ChatSession(send, makeProvider(), { cwd: process.cwd() })
    socket.on('message', (data) => session.handle(data.toString()))
    socket.on('error', () => {})
  })
  return wss
}
```

- [ ] **Step 4: รันเทสต์ให้ผ่าน**

Run: `npx vitest run server/ws.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: สร้าง `server/index.ts`**

```ts
import Fastify from 'fastify'
import { attachWebSocketServer } from './ws'
import { LocalAgentProvider } from './providers/localAgent'
import { pingMessage } from './health'

const PORT = Number(process.env.PORT ?? 8787)

const app = Fastify({ logger: true })
app.get('/api/health', async () => ({ status: pingMessage() }))

await app.listen({ port: PORT, host: '127.0.0.1' })
attachWebSocketServer(app.server, () => new LocalAgentProvider())
app.log.info(`WebSocket listening on ws://127.0.0.1:${PORT}/ws`)
```

- [ ] **Step 6: ยืนยัน server บูตได้ (manual)**

Run (terminal แยก): `npm run dev:server`
แล้วอีก terminal: `curl http://127.0.0.1:8787/api/health`
Expected: `{"status":"claude-web-agent: ok"}` — จากนั้นกด Ctrl+C ปิด

- [ ] **Step 7: Commit**

```bash
git add server/ws.ts server/ws.test.ts server/index.ts
git commit -m "feat: Fastify + WebSocket server with per-connection ChatSession"
```

---

### Task 7: Frontend scaffold + chat state reducer (tested)

**Files:**
- Create: `index.html`, `vite.config.ts`, `web/tsconfig.json`, `postcss.config.js`, `tailwind.config.js`, `web/src/index.css`, `web/src/main.tsx`, `web/src/chatState.ts`, `web/src/chatState.test.ts`

**Interfaces:**
- Consumes: `ServerMsg`, `ToolCall` (Task 2) ผ่าน alias `@shared/protocol`
- Produces:
  - `type UiMessage = { role: 'user'; text: string } | { role: 'assistant'; text: string; tools: ToolCall[] }`
  - `type PermissionPrompt = { requestId: string; name: string; input: unknown }`
  - `type ChatState = { messages: UiMessage[]; pending?: PermissionPrompt; streaming: boolean }`
  - `initialState: ChatState`
  - `applyServer(state: ChatState, msg: ServerMsg): ChatState`
  - `appendUser(state: ChatState, text: string): ChatState`

- [ ] **Step 1: เขียน failing test `web/src/chatState.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { initialState, applyServer, appendUser, type ChatState } from './chatState'

describe('chatState', () => {
  it('appendUser adds a user message and starts streaming', () => {
    const s = appendUser(initialState, 'hi')
    expect(s.messages).toEqual([{ role: 'user', text: 'hi' }])
    expect(s.streaming).toBe(true)
  })

  it('assistant_delta accumulates into a single assistant message', () => {
    let s: ChatState = appendUser(initialState, 'hi')
    s = applyServer(s, { type: 'assistant_delta', text: 'Hel' })
    s = applyServer(s, { type: 'assistant_delta', text: 'lo' })
    expect(s.messages[1]).toEqual({ role: 'assistant', text: 'Hello', tools: [] })
  })

  it('tool_call attaches to the current assistant message', () => {
    let s: ChatState = appendUser(initialState, 'hi')
    s = applyServer(s, { type: 'assistant_delta', text: 'x' })
    s = applyServer(s, { type: 'tool_call', id: 't1', name: 'Read', input: { file_path: '/a' } })
    const last = s.messages[1]
    expect(last.role).toBe('assistant')
    if (last.role === 'assistant') expect(last.tools).toEqual([{ id: 't1', name: 'Read', input: { file_path: '/a' } }])
  })

  it('permission_request sets pending; response is cleared by caller via clearPending path', () => {
    let s: ChatState = appendUser(initialState, 'hi')
    s = applyServer(s, { type: 'permission_request', requestId: 'r1', name: 'Write', input: {} })
    expect(s.pending).toEqual({ requestId: 'r1', name: 'Write', input: {} })
  })

  it('turn_done stops streaming', () => {
    let s: ChatState = appendUser(initialState, 'hi')
    s = applyServer(s, { type: 'turn_done' })
    expect(s.streaming).toBe(false)
  })
})
```

- [ ] **Step 2: รันเทสต์ให้ fail**

Run: `npx vitest run web/src/chatState.test.ts`
Expected: FAIL — `Cannot find module './chatState'`

- [ ] **Step 3: สร้าง `web/src/chatState.ts`**

```ts
import type { ServerMsg, ToolCall } from '@shared/protocol'

export type UiMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; tools: ToolCall[] }

export type PermissionPrompt = { requestId: string; name: string; input: unknown }

export type ChatState = {
  messages: UiMessage[]
  pending?: PermissionPrompt
  streaming: boolean
}

export const initialState: ChatState = { messages: [], streaming: false }

export function appendUser(state: ChatState, text: string): ChatState {
  return { ...state, messages: [...state.messages, { role: 'user', text }], streaming: true }
}

function lastAssistant(messages: UiMessage[]): { idx: number; msg: Extract<UiMessage, { role: 'assistant' }> } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'assistant') return { idx: i, msg: m }
  }
  return null
}

function ensureAssistant(state: ChatState): { messages: UiMessage[]; idx: number } {
  const last = state.messages[state.messages.length - 1]
  if (last && last.role === 'assistant') return { messages: state.messages, idx: state.messages.length - 1 }
  const messages = [...state.messages, { role: 'assistant' as const, text: '', tools: [] }]
  return { messages, idx: messages.length - 1 }
}

export function applyServer(state: ChatState, msg: ServerMsg): ChatState {
  switch (msg.type) {
    case 'assistant_delta': {
      const { messages, idx } = ensureAssistant(state)
      const cur = messages[idx] as Extract<UiMessage, { role: 'assistant' }>
      messages[idx] = { ...cur, text: cur.text + msg.text }
      return { ...state, messages }
    }
    case 'tool_call': {
      const { messages, idx } = ensureAssistant(state)
      const cur = messages[idx] as Extract<UiMessage, { role: 'assistant' }>
      messages[idx] = { ...cur, tools: [...cur.tools, { id: msg.id, name: msg.name, input: msg.input }] }
      return { ...state, messages }
    }
    case 'tool_result':
      return state // M1: ผลลัพธ์ tool ไม่ render รายละเอียด (โชว์แค่ card)
    case 'permission_request':
      return { ...state, pending: { requestId: msg.requestId, name: msg.name, input: msg.input } }
    case 'turn_done':
      return { ...state, streaming: false }
    case 'error': {
      const last = lastAssistant(state.messages)
      const note = `\n\n[error] ${msg.message}`
      if (!last) return state
      const messages = [...state.messages]
      messages[last.idx] = { ...last.msg, text: last.msg.text + note }
      return { ...state, messages }
    }
  }
}

export function clearPending(state: ChatState): ChatState {
  return { ...state, pending: undefined }
}
```

- [ ] **Step 4: รันเทสต์ให้ผ่าน**

Run: `npx vitest run web/src/chatState.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: สร้างไฟล์ Vite/Tailwind config + entry**

`index.html` (repo root):
```html
<!doctype html>
<html lang="th">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Claude Web Agent</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/web/src/main.tsx"></script>
  </body>
</html>
```

`vite.config.ts` (repo root):
```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@shared': fileURLToPath(new URL('./shared', import.meta.url)) },
  },
  server: {
    port: 5173,
    fs: { allow: ['.'] },
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
    },
  },
})
```

`web/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "baseUrl": ".",
    "paths": { "@shared/*": ["../shared/*"] }
  },
  "include": ["src", "../shared"]
}
```

`postcss.config.js`:
```js
export default { plugins: { tailwindcss: {}, autoprefixer: {} } }
```

`tailwind.config.js`:
```js
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './web/src/**/*.{ts,tsx}'],
  theme: { extend: {} },
  plugins: [],
}
```

`web/src/index.css`:
```css
@tailwind base;
@tailwind components;
@tailwind utilities;

html, body, #root { height: 100%; margin: 0; }
body { font-family: ui-sans-serif, system-ui, sans-serif; }
```

`web/src/main.tsx`:
```tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'
import { App } from './App'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
```

- [ ] **Step 6: Commit** (App.tsx มาใน Task 8 — ตอนนี้ commit state + config; ยังไม่รัน Vite)

```bash
git add index.html vite.config.ts web/tsconfig.json postcss.config.js tailwind.config.js web/src/index.css web/src/main.tsx web/src/chatState.ts web/src/chatState.test.ts
git commit -m "feat: frontend scaffold + tested chat state reducer"
```

---

### Task 8: WS client + Chat UI components

**Files:**
- Create: `web/src/ws.ts`, `web/src/App.tsx`, `web/src/components/Message.tsx`, `web/src/components/ToolCard.tsx`, `web/src/components/Composer.tsx`, `web/src/components/PermissionModal.tsx`

**Interfaces:**
- Consumes: `ChatState`, `applyServer`, `appendUser`, `clearPending`, `initialState` (Task 7); `ClientMsg`, `ServerMsg` (Task 2)
- Produces:
  - `createWsClient(onMessage: (m: ServerMsg) => void): { send: (m: ClientMsg) => void; close: () => void }`
  - React component tree rooted at `App`

- [ ] **Step 1: สร้าง `web/src/ws.ts`**

```ts
import type { ClientMsg, ServerMsg } from '@shared/protocol'

export function createWsClient(onMessage: (m: ServerMsg) => void) {
  const url = `ws://${location.hostname}:5173/ws` // ผ่าน Vite proxy
  const ws = new WebSocket(url)
  const queue: string[] = []

  ws.onopen = () => {
    for (const q of queue) ws.send(q)
    queue.length = 0
  }
  ws.onmessage = (ev) => {
    try {
      onMessage(JSON.parse(ev.data) as ServerMsg)
    } catch {
      /* ignore */
    }
  }

  return {
    send(m: ClientMsg) {
      const raw = JSON.stringify(m)
      if (ws.readyState === WebSocket.OPEN) ws.send(raw)
      else queue.push(raw)
    },
    close() {
      ws.close()
    },
  }
}
```

- [ ] **Step 2: สร้าง `web/src/components/ToolCard.tsx`**

```tsx
import type { ToolCall } from '@shared/protocol'

export function ToolCard({ call }: { call: ToolCall }) {
  return (
    <div className="my-1 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs">
      <span className="font-semibold text-amber-800">⚙ {call.name}</span>
      <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-amber-900">
        {JSON.stringify(call.input, null, 2)}
      </pre>
    </div>
  )
}
```

- [ ] **Step 3: สร้าง `web/src/components/Message.tsx`**

```tsx
import ReactMarkdown from 'react-markdown'
import type { UiMessage } from '../chatState'
import { ToolCard } from './ToolCard'

export function Message({ msg }: { msg: UiMessage }) {
  const isUser = msg.role === 'user'
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} px-3 py-2`}>
      <div
        className={`max-w-[80%] rounded-2xl px-4 py-2 ${
          isUser ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-900'
        }`}
      >
        {!isUser && msg.role === 'assistant' && msg.tools.map((t) => <ToolCard key={t.id} call={t} />)}
        <div className="prose prose-sm max-w-none break-words">
          <ReactMarkdown>{msg.text}</ReactMarkdown>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: สร้าง `web/src/components/Composer.tsx`**

```tsx
import { useState } from 'react'

export function Composer({ disabled, onSend, onStop }: { disabled: boolean; onSend: (t: string) => void; onStop: () => void }) {
  const [text, setText] = useState('')
  const submit = () => {
    const t = text.trim()
    if (!t) return
    onSend(t)
    setText('')
  }
  return (
    <div className="flex items-end gap-2 border-t bg-white p-3">
      <textarea
        className="flex-1 resize-none rounded-lg border px-3 py-2 outline-none focus:ring-2 focus:ring-blue-400"
        rows={2}
        placeholder="พิมพ์ข้อความ… (Enter ส่ง, Shift+Enter ขึ้นบรรทัด)"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submit()
          }
        }}
      />
      {disabled ? (
        <button className="rounded-lg bg-red-500 px-4 py-2 text-white" onClick={onStop}>
          Stop
        </button>
      ) : (
        <button className="rounded-lg bg-blue-600 px-4 py-2 text-white" onClick={submit}>
          ส่ง
        </button>
      )}
    </div>
  )
}
```

- [ ] **Step 5: สร้าง `web/src/components/PermissionModal.tsx`**

```tsx
import type { PermissionPrompt } from '../chatState'

export function PermissionModal({
  prompt,
  onDecide,
}: {
  prompt: PermissionPrompt
  onDecide: (decision: 'allow' | 'deny') => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-[90%] max-w-md rounded-xl bg-white p-5 shadow-xl">
        <h2 className="text-lg font-semibold">ขออนุญาตใช้เครื่องมือ</h2>
        <p className="mt-1 text-sm text-gray-600">
          Claude ต้องการใช้ <span className="font-mono font-semibold">{prompt.name}</span>
        </p>
        <pre className="mt-2 max-h-48 overflow-auto rounded bg-gray-100 p-2 text-xs">
          {JSON.stringify(prompt.input, null, 2)}
        </pre>
        <div className="mt-4 flex justify-end gap-2">
          <button className="rounded-lg border px-4 py-2" onClick={() => onDecide('deny')}>
            ปฏิเสธ
          </button>
          <button className="rounded-lg bg-blue-600 px-4 py-2 text-white" onClick={() => onDecide('allow')}>
            อนุญาต
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 6: สร้าง `web/src/App.tsx`**

```tsx
import { useEffect, useMemo, useReducer, useRef } from 'react'
import type { ServerMsg } from '@shared/protocol'
import { applyServer, appendUser, clearPending, initialState, type ChatState } from './chatState'
import { createWsClient } from './ws'
import { Message } from './components/Message'
import { Composer } from './components/Composer'
import { PermissionModal } from './components/PermissionModal'

type Action = { kind: 'server'; msg: ServerMsg } | { kind: 'user'; text: string } | { kind: 'clearPending' }

function reducer(state: ChatState, action: Action): ChatState {
  switch (action.kind) {
    case 'server':
      return applyServer(state, action.msg)
    case 'user':
      return appendUser(state, action.text)
    case 'clearPending':
      return clearPending(state)
  }
}

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState)
  const clientRef = useRef<ReturnType<typeof createWsClient> | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const client = createWsClient((msg) => dispatch({ kind: 'server', msg }))
    clientRef.current = client
    return () => client.close()
  }, [])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [state.messages])

  const send = (text: string) => {
    dispatch({ kind: 'user', text })
    clientRef.current?.send({ type: 'user_message', text })
  }
  const stop = () => clientRef.current?.send({ type: 'interrupt' })
  const decide = (decision: 'allow' | 'deny') => {
    if (!state.pending) return
    clientRef.current?.send({ type: 'permission_response', requestId: state.pending.requestId, decision })
    dispatch({ kind: 'clearPending' })
  }

  const header = useMemo(() => 'Claude Web Agent', [])

  return (
    <div className="flex h-full flex-col">
      <header className="border-b bg-white px-4 py-3 text-lg font-semibold">{header}</header>
      <div ref={scrollRef} className="flex-1 overflow-y-auto bg-gray-50">
        {state.messages.map((m, i) => (
          <Message key={i} msg={m} />
        ))}
      </div>
      <Composer disabled={state.streaming} onSend={send} onStop={stop} />
      {state.pending && <PermissionModal prompt={state.pending} onDecide={decide} />}
    </div>
  )
}
```

- [ ] **Step 7: ยืนยัน build ฝั่ง web ผ่าน + typecheck**

Run: `npx tsc -p web/tsconfig.json && npm run build:web`
Expected: typecheck ผ่าน, Vite build สำเร็จ (มี `dist/`)

- [ ] **Step 8: Commit**

```bash
git add web/src/ws.ts web/src/App.tsx web/src/components
git commit -m "feat: chat UI (messages, composer, tool cards, permission modal)"
```

---

### Task 9: End-to-end verification กับ Claude จริง

**Files:**
- Modify: ปรับ `server/providers/localAgent.ts` ถ้ารูปแบบ SDK message จริงต่างจากที่ map ไว้
- Create: `README.md` (วิธีรัน)

**Interfaces:**
- ไม่มี interface ใหม่ — เป็นการยืนยันทั้งระบบ และจุดที่ map SDK boundary จริง

- [ ] **Step 1: ยืนยันว่า login ของ Claude Agent SDK พร้อมบนเครื่อง**

Run: `npx tsx -e "import {query} from '@anthropic-ai/claude-agent-sdk'; const q=query({prompt:'say hi in 3 words', options:{}}); for await (const m of q){ if(m.type==='result') console.log(m.result) }"`
Expected: ได้ข้อความตอบกลับสั้นๆ (พิสูจน์ว่า SDK ใช้ login บนเครื่องได้). ถ้า error เรื่อง auth → ผู้ใช้ต้อง login Claude Code/SDK ก่อน

- [ ] **Step 2: เปิดทั้งระบบ**

Run: `npm run dev`
Expected: server ขึ้น `WebSocket listening on ws://127.0.0.1:8787/ws` และ Vite ขึ้น `http://localhost:5173`

- [ ] **Step 3: ทดสอบแชตธรรมดา (manual ในเบราว์เซอร์)**

เปิด `http://localhost:5173` → พิมพ์ "สวัสดี ตอบสั้นๆ" → กดส่ง
Expected: เห็นข้อความ user ทางขวา, คำตอบ assistant ไหลทีละ token ทางซ้าย, ปุ่มเปลี่ยนเป็น Stop ระหว่างตอบ แล้วกลับเป็น "ส่ง" เมื่อจบ
ถ้า token ไม่ไหล (ไม่มี assistant_delta) → ตรวจ map `stream_event` ใน `localAgent.ts` กับ event จริง (log `msg` ดิบดู) แล้วแก้เงื่อนไข `content_block_delta`/`text_delta` ให้ตรง

- [ ] **Step 4: ทดสอบ read tool (auto-allow)**

พิมพ์ "อ่านไฟล์ package.json แล้วบอกชื่อ project" 
Expected: เห็น ToolCard `Read` (ไม่มี modal เด้ง เพราะ auto-allow) แล้ว Claude ตอบชื่อ project ได้

- [ ] **Step 5: ทดสอบ write/run tool (ขออนุญาต)**

พิมพ์ "สร้างไฟล์ hello.txt เขียนคำว่า hi"
Expected: modal เด้งโชว์ `Write` + path → กด "อนุญาต" → ไฟล์ถูกสร้าง; ลองอีกครั้งกับ "รัน echo test" → modal `Bash` เด้ง → กด "ปฏิเสธ" → Claude รายงานว่าถูกปฏิเสธ ไม่รันคำสั่ง

- [ ] **Step 6: ทดสอบ multi-turn (resume)**

พิมพ์ต่อ "เมื่อกี้ฉันให้เธอทำอะไร" 
Expected: Claude จำบริบทห้องเดิมได้ (เพราะ resume ด้วย sdkSessionId)

- [ ] **Step 7: เขียน `README.md`**

```markdown
# Claude Web Agent

Local web app คุยกับ Claude (local-agent ผ่าน Claude Agent SDK) แบบ agent เต็มรูปแบบ

## ต้องมี
- Node 20+
- Login ของ Claude Agent SDK บนเครื่อง (เหมือน Claude Code)

## รัน (dev)
```
npm install
npm run dev
```
เปิด http://localhost:5173

- read tools (Read/Glob/Grep/…) อนุญาตอัตโนมัติ
- write/run tools (Write/Edit/Bash/…) เด้ง modal ขออนุญาตก่อน

## สถานะ
M1: ห้องเดียว ไม่ persist ไม่มี auth (localhost). ดู `docs/superpowers/specs/` สำหรับแผนเต็ม (M2–M6)
```

- [ ] **Step 8: รันชุดเทสต์ทั้งหมดให้เขียว**

Run: `npm test`
Expected: PASS ทุกไฟล์ (health, protocol, permission, agent, localAgent, ws, chatState)

- [ ] **Step 9: Commit**

```bash
git add README.md server/providers/localAgent.ts
git commit -m "docs: README + verified e2e local-agent chat (M1 done)"
```

---

## Self-Review

**1. Spec coverage (เทียบ spec M1):**
- Fastify + WS ✅ (Task 6) · LocalAgentProvider stream + canUseTool ✅ (Task 5) · permission modal ✅ (Task 3 + 8) · ChatView พื้นฐาน ✅ (Task 7–8) · ห้องเดียวไม่ persist ✅ · resume ใน session เดียว ✅ (Task 6 ChatSession เก็บ sdkSessionId; Task 9 Step 6 ยืนยัน)
- Read auto-allow / write-run ask ✅ (Task 3, ยืนยัน Task 9) · streaming token ✅ (Task 5/7, ยืนยัน Task 9) · tool cards ✅ (Task 8) · markdown ✅ (Message.tsx) · Stop/interrupt ✅ (Composer + ChatSession.abort)
- เลื่อนไป M2+: persistence, multi-chat sidebar, FolderPicker, providers อื่น, native/compat API, auth/LAN, responsive drawer — ตรงกับ phasing ใน spec

**2. Placeholder scan:** ไม่มี TBD/TODO; ทุก step ที่แตะโค้ดมีโค้ดเต็ม; จุด SDK boundary มี step ยืนยัน+ปรับจริง (Task 9 Step 3) ไม่ใช่ placeholder

**3. Type consistency:** `ServerMsg`/`ClientMsg`/`ToolCall`/`Usage` นิยามครั้งเดียวใน `shared/protocol.ts` ใช้ตรงกันทุก task · `PermissionDecision`/`PermissionResolver` (Task 3) ใช้ใน `ProviderContext` (Task 4) และ `localAgent.ts` (Task 5) ตรงกัน · `TurnParams`/`TurnResult`/`Provider` (Task 4) ใช้ใน FakeProvider, LocalAgentProvider, runTurn, ChatSession ตรงกัน · `ChatState`/`applyServer`/`appendUser`/`clearPending` (Task 7) ใช้ใน App.tsx (Task 8) ตรงกัน
```
