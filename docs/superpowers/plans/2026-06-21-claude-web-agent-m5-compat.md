# M5 — Compatibility API (`/v1/*`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the existing provider engine as standard LLM-gateway endpoints — `GET /v1/models`, `POST /v1/chat/completions` (OpenAI), `POST /v1/messages` (Anthropic) — so external harnesses (open-webui, claude-cli) can plug into this server, with the connection + permission policy encoded in the model id.

**Architecture:** Stateless. The harness sends the full `messages[]` every call; there is **no** `ChatRuntime`, no DB persistence of compat turns, no live-sync. Each request resolves a connection+policy from the model id, builds a `Provider` via the existing `makeProvider`, converts `messages[]` → `TurnParams`, runs the existing `runTurn` with a `PolicyPermissionResolver` and an event sink, and maps the result onto the requested wire format (OpenAI or Anthropic). New code lives under `server/compat/`; `server/agent.ts`, `server/providers/*`, `server/store.ts`, `server/permission.ts` are reused **unchanged**.

**Tech Stack:** Node 20+, TypeScript ESM, Fastify (REST + SSE via `reply.hijack`), better-sqlite3 (read-only here), Vitest. Frontend untouched in M5.

## Global Constraints

- **Style:** single quotes, no semicolons, 2-space indent (everywhere except `server/store.ts` which uses double quotes — not touched here). Comments in English. Respond to the user in Thai.
- **Tests:** `npx vitest run <file>` from the repo ROOT. Whole suite via `npm test`. Baseline before M5: **213** passing. Server typecheck: `npm run typecheck`. Web typecheck: `npx tsc -p web/tsconfig.json --noEmit`. Web build: `npm run build:web`.
- **Provider/SDK:** `@anthropic-ai/claude-agent-sdk ^0.3.179` (local-agent), `@anthropic-ai/sdk ^0.104.2`. For ANY Anthropic/OpenAI wire-format question consult the `claude-api` skill — do not guess.
- **Security invariant (carry from M3/M4):** api_key lives server-side only. `ConnectionMeta` (browser type) omits `apiKey`; only `getConnectionWithSecret` reads it. **Compat responses MUST NOT echo api_key.** Compat turns resolve the secret server-side via `resolveConnectionByName` → `getConnectionWithSecret` and never put it on the wire.
- **Auth + `0.0.0.0` bind are M6, NOT M5.** M5 binds `127.0.0.1` (unchanged `server/index.ts`) and enforces no token. Same posture the native HTTP API (M4) already documents.

## Design Decisions (locked — these resolve the spec §9 nuances)

1. **Model-id grammar** (spec §9.3): `"<connName>/<model>"` (policy `readonly`) and `"<connName>-auto/<model>"` (policy `auto`). Split on the **first** `/`: left = connSpec, right = model (the model may itself contain `/`, e.g. `openrouter/anthropic/claude-3.5-sonnet` → conn `openrouter`, model `anthropic/claude-3.5-sonnet`). A connSpec ending in `-auto` selects `auto`. Connection is resolved by **name** (compat uses names, not ids); first match wins on duplicate names.
2. **Policy semantics:** `auto` → `PolicyPermissionResolver('auto')` (allows all tools — intended for local-agent autonomous tool use); `readonly` → `PolicyPermissionResolver('readonly')` (read-only tools allowed, writes/commands denied). For provider-API connections (anthropic-api / openai-compatible) the policy is harmless — those providers expose no tools — but `-auto` is still accepted for them.
3. **`messages[]` → `TurnParams`:** the **last** user-role message → `userText` (local-agent uses this); the full user/assistant transcript → `history` as `StoredMessage[]` (anthropic-api / openai-compatible replay it via `historyToChatMessages`). **`system` messages and the Anthropic top-level `system` field are dropped** in M5 (local-agent uses the `claude_code` preset; the provider-API providers currently have no system channel). Documented limitation; revisit if a harness needs it. Non-text content is out of scope (text-only).
4. **local-agent on the wire** (spec §9.4): runs the agent loop autonomously (tools execute server-side under the policy); **only the final assistant text** is surfaced. Intermediate `tool_call` / `tool_result` events are dropped in the sink — NOT mapped to OpenAI `tool_calls` / Anthropic `tool_use`. Non-stream returns `TurnResult.text` (the SDK's final `result` string — clean). Streaming forwards `assistant_delta` text live (for a tool-using local-agent turn this may include the agent's interim narration; that is legitimate assistant text, and the tool JSON noise is still dropped — this satisfies §9.4).
5. **cwd for local-agent compat turns:** undefined → the SDK default (the server process cwd). A per-request or default-cwd knob is future work.
6. **`GET /v1/models` enumeration:** for each connection, `"<name>/<defaultModel>"`; for `local-agent` connections additionally `"<name>-auto/<defaultModel>"`. The model after the slash is passed through to the provider, so a harness MAY request `"<name>/<any-model>"` and it works — `/v1/models` only advertises each connection's `defaultModel`. Served in the OpenAI list shape (open-webui consumes this); the same list serves both APIs (spec §9.1).
7. **Errors:** `runTurn` never throws (it emits an `error` event and returns `{ text:'' }`). The sink captures that into `error`. Non-stream → HTTP 500 with the API-appropriate error body. A `CompatError` (bad/unknown model id, un-buildable provider) is mapped to its `status` (404/400) **before** any stream is hijacked. Streaming provider errors are surfaced as a terminal `error` SSE event then the stream's normal terminator.
8. **SSE crash-guard:** reuse the M4 pattern verbatim — `reply.hijack()`, `raw.on('error', () => {})` (load-bearing), `canWrite() = !raw.writableEnded && !raw.destroyed`, and an `AbortController` aborted on `raw.on('close')` so a client disconnect interrupts a running local-agent turn.

## File Structure

- `server/compat/models.ts` — model-id parse, connection-by-name resolve, provider-config build, `/v1/models` enumeration. Pure functions over the DB. **(Task 1)**
- `server/compat/turn.ts` — `CompatMessage`, `CompatError`, `compatMessagesToTurnParams`, `resolveCompatTurn`, `executeCompatTurn`. The stateless engine bridge. **(Task 2)**
- `server/compat/openai.ts` — `registerOpenAiCompat(app, deps)`: `GET /v1/models` + `POST /v1/chat/completions` (non-stream JSON + stream SSE + `[DONE]`). **(Task 3)**
- `server/compat/anthropic.ts` — `registerAnthropicCompat(app, deps)`: `POST /v1/messages` (non-stream JSON + stream SSE: `message_start`…`message_stop`). **(Task 4)**
- `server/compat/index.ts` — `registerCompatApi(app, deps)` wires both; `server/index.ts` calls it. **(Task 5)**
- `scripts/e2e-compat.mjs` — credential-free end-to-end (fake provider in-process): `/v1/models`, both chat endpoints (stream + non-stream), and a `-auto` policy assertion. **(Task 6)**
- `README.md` + `.git/sdd/progress.md` — document the compat API + open-webui/claude-cli setup. **(Task 7)**

Reused unchanged: `server/agent.ts` (`runTurn`), `server/providers/index.ts` (`makeProvider`, `ProviderConfig`), `server/providers/types.ts` (`Provider`, `TurnParams`, `TurnResult`, `Usage`), `server/providers/messages.ts` (`historyToChatMessages`), `server/providers/fake.ts` (`FakeProvider`, tests), `server/permission.ts` (`PolicyPermissionResolver`, `PermissionPolicy`), `server/store.ts` (`listConnections`, `getConnectionWithSecret`, `ConnectionWithSecret`, `DB`, `DEFAULT_CONNECTION_ID`, `createConnection`), `shared/protocol.ts` (`ServerMsg`, `StoredMessage`, `Usage`).

---

### Task 1: `server/compat/models.ts` — model-id + connection + enumeration

**Files:**
- Create: `server/compat/models.ts`
- Test: `server/compat/models.test.ts`

**Interfaces:**
- Consumes: `listConnections(db)`, `getConnectionWithSecret(db, id)`, `ConnectionWithSecret`, `DB` (from `../store`); `ProviderConfig` (from `../providers/index`); `PermissionPolicy` (from `../permission`).
- Produces:
  - `type ParsedModelId = { connName: string; policy: PermissionPolicy; model: string }`
  - `parseModelId(id: string): ParsedModelId | null`
  - `resolveConnectionByName(db: DB, name: string): ConnectionWithSecret | undefined`
  - `connectionToProviderConfig(conn: ConnectionWithSecret, model: string): ProviderConfig`
  - `listCompatModels(db: DB): string[]`

- [ ] **Step 1: Write the failing test**

```ts
// server/compat/models.test.ts
import { describe, it, expect } from 'vitest'
import { openDb, createConnection, DEFAULT_CONNECTION_ID } from '../store'
import { parseModelId, resolveConnectionByName, connectionToProviderConfig, listCompatModels } from './models'

describe('compat/models parseModelId', () => {
  it('parses "<conn>/<model>" as readonly', () => {
    expect(parseModelId('local/sonnet')).toEqual({ connName: 'local', policy: 'readonly', model: 'sonnet' })
  })
  it('parses "<conn>-auto/<model>" as auto', () => {
    expect(parseModelId('local-auto/sonnet')).toEqual({ connName: 'local', policy: 'auto', model: 'sonnet' })
  })
  it('keeps slashes inside the model segment (split on the FIRST slash only)', () => {
    expect(parseModelId('openrouter/anthropic/claude-3.5-sonnet')).toEqual({
      connName: 'openrouter', policy: 'readonly', model: 'anthropic/claude-3.5-sonnet',
    })
  })
  it('returns null for malformed ids', () => {
    expect(parseModelId('nomodel')).toBeNull()      // no slash
    expect(parseModelId('/sonnet')).toBeNull()       // empty conn
    expect(parseModelId('local/')).toBeNull()        // empty model
    expect(parseModelId('-auto/sonnet')).toBeNull()  // empty conn before -auto
  })
})

describe('compat/models resolve + enumerate', () => {
  it('resolves a connection by NAME and exposes its secret', () => {
    const db = openDb(':memory:')
    createConnection(db, { id: 'c2', type: 'anthropic-api', name: 'claude', apiKey: 'sk-x', defaultModel: 'claude-opus-4-8', now: 1 })
    const conn = resolveConnectionByName(db, 'claude')
    expect(conn?.id).toBe('c2')
    expect(conn?.apiKey).toBe('sk-x')
    expect(resolveConnectionByName(db, 'missing')).toBeUndefined()
  })
  it('builds a ProviderConfig with the requested model + secret', () => {
    const conn = { id: 'c2', type: 'anthropic-api', name: 'claude', apiKey: 'sk-x', defaultModel: 'd', createdAt: 1, updatedAt: 1 }
    expect(connectionToProviderConfig(conn, 'claude-opus-4-8')).toEqual({ type: 'anthropic-api', defaultModel: 'claude-opus-4-8', apiKey: 'sk-x' })
  })
  it('lists "<name>/<model>" for all, plus "-auto" only for local-agent', () => {
    const db = openDb(':memory:') // seeds the local-agent connection name="local" defaultModel="sonnet"
    createConnection(db, { id: 'c2', type: 'anthropic-api', name: 'claude', apiKey: 'sk', defaultModel: 'claude-opus-4-8', now: 1 })
    const ids = listCompatModels(db)
    expect(ids).toContain('local/sonnet')
    expect(ids).toContain('local-auto/sonnet')
    expect(ids).toContain('claude/claude-opus-4-8')
    expect(ids).not.toContain('claude-auto/claude-opus-4-8') // provider-API connections get no -auto variant
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run server/compat/models.test.ts`
Expected: FAIL — `Cannot find module './models'`.

- [ ] **Step 3: Implement `server/compat/models.ts`**

```ts
import { listConnections, getConnectionWithSecret, type ConnectionWithSecret, type DB } from '../store'
import type { ProviderConfig } from '../providers/index'
import type { PermissionPolicy } from '../permission'

export type ParsedModelId = { connName: string; policy: PermissionPolicy; model: string }

const AUTO_SUFFIX = '-auto'

// "<conn>/<model>" -> readonly; "<conn>-auto/<model>" -> auto. Split on the FIRST '/' so the model
// segment may contain further slashes (e.g. "openrouter/anthropic/claude-3.5-sonnet"). Returns null
// when the id is malformed (no slash, empty conn, or empty model).
export function parseModelId(id: string): ParsedModelId | null {
  const slash = id.indexOf('/')
  if (slash <= 0 || slash === id.length - 1) return null
  const connSpec = id.slice(0, slash)
  const model = id.slice(slash + 1)
  if (model === '') return null
  if (connSpec.endsWith(AUTO_SUFFIX) && connSpec.length > AUTO_SUFFIX.length) {
    return { connName: connSpec.slice(0, -AUTO_SUFFIX.length), policy: 'auto', model }
  }
  return { connName: connSpec, policy: 'readonly', model }
}

// Compat model ids reference a connection by NAME (not its id). First match wins on duplicate names.
// Returns the row WITH its secret apiKey — server-side only; never put on the wire.
export function resolveConnectionByName(db: DB, name: string): ConnectionWithSecret | undefined {
  const meta = listConnections(db).find((c) => c.name === name)
  return meta ? getConnectionWithSecret(db, meta.id) : undefined
}

// makeProvider config from a resolved connection + the requested model (passed through as the default).
export function connectionToProviderConfig(conn: ConnectionWithSecret, model: string): ProviderConfig {
  const cfg: ProviderConfig = { type: conn.type, defaultModel: model }
  if (conn.baseUrl !== undefined) cfg.baseUrl = conn.baseUrl
  if (conn.apiKey !== undefined) cfg.apiKey = conn.apiKey
  return cfg
}

// Model ids advertised by GET /v1/models: "<name>/<defaultModel>" for every connection, plus
// "<name>-auto/<defaultModel>" for local-agent connections (the auto-permission variant).
export function listCompatModels(db: DB): string[] {
  const out: string[] = []
  for (const c of listConnections(db)) {
    out.push(`${c.name}/${c.defaultModel}`)
    if (c.type === 'local-agent') out.push(`${c.name}${AUTO_SUFFIX}/${c.defaultModel}`)
  }
  return out
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `npx vitest run server/compat/models.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add server/compat/models.ts server/compat/models.test.ts
git commit -m "feat(m5): compat model-id parsing + connection-by-name + model enumeration"
```

---

### Task 2: `server/compat/turn.ts` — stateless engine bridge

**Files:**
- Create: `server/compat/turn.ts`
- Test: `server/compat/turn.test.ts`

**Interfaces:**
- Consumes: `runTurn` (from `../agent`), `PolicyPermissionResolver` + `PermissionPolicy` (from `../permission`), `Provider` + `TurnParams` + `Usage` (types), `ProviderConfig`, `DB`, `StoredMessage` + `ServerMsg` (types), and Task 1's `parseModelId` / `resolveConnectionByName` / `connectionToProviderConfig`.
- Produces:
  - `type CompatMessage = { role: 'system' | 'user' | 'assistant'; content: string }`
  - `class CompatError extends Error { status: number }`
  - `type CompatDeps = { db: DB; makeProvider: (cfg: ProviderConfig) => Provider }`
  - `compatMessagesToTurnParams(messages: CompatMessage[], model: string): TurnParams`
  - `resolveCompatTurn(deps: CompatDeps, modelId: string): { provider: Provider; policy: PermissionPolicy; model: string }` (throws `CompatError`)
  - `executeCompatTurn(args: { provider; policy; model; messages; signal; onDelta? }): Promise<{ text: string; usage?: Usage; error?: string }>`

- [ ] **Step 1: Write the failing test** (drive the REAL `runTurn` via `FakeProvider`)

```ts
// server/compat/turn.test.ts
import { describe, it, expect } from 'vitest'
import { openDb, createConnection } from '../store'
import { FakeProvider } from '../providers/fake'
import { makeProvider } from '../providers/index'
import { compatMessagesToTurnParams, resolveCompatTurn, executeCompatTurn, CompatError } from './turn'

const ac = (): AbortSignal => new AbortController().signal

describe('compat/turn compatMessagesToTurnParams', () => {
  it('uses the LAST user message as userText and builds history from user/assistant only', () => {
    const p = compatMessagesToTurnParams(
      [{ role: 'system', content: 'sys' }, { role: 'user', content: 'Q1' }, { role: 'assistant', content: 'A1' }, { role: 'user', content: 'Q2' }],
      'sonnet',
    )
    expect(p.userText).toBe('Q2')
    expect(p.model).toBe('sonnet')
    expect(p.history?.map((m) => m.role)).toEqual(['user', 'assistant', 'user']) // system dropped
    expect(p.history?.[0].content).toEqual([{ type: 'text', text: 'Q1' }])
  })
})

describe('compat/turn resolveCompatTurn', () => {
  const deps = { db: openDb(':memory:'), makeProvider }
  it('throws CompatError 404 for a malformed model id', () => {
    expect(() => resolveCompatTurn(deps, 'nope')).toThrow(CompatError)
    try { resolveCompatTurn(deps, 'nope') } catch (e) { expect((e as CompatError).status).toBe(404) }
  })
  it('throws CompatError 404 for an unknown connection name', () => {
    try { resolveCompatTurn(deps, 'ghost/x') } catch (e) { expect((e as CompatError).status).toBe(404) }
  })
  it('throws CompatError 400 when the provider cannot be built (anthropic-api with no key)', () => {
    const db = openDb(':memory:')
    createConnection(db, { id: 'c2', type: 'anthropic-api', name: 'claude', defaultModel: 'd', now: 1 }) // no apiKey
    try { resolveCompatTurn({ db, makeProvider }, 'claude/claude-opus-4-8') } catch (e) {
      expect((e as CompatError).status).toBe(400)
    }
  })
  it('resolves provider + policy for a valid local-auto id', () => {
    const r = resolveCompatTurn(deps, 'local-auto/sonnet') // seeded local-agent connection
    expect(r.policy).toBe('auto')
    expect(r.model).toBe('sonnet')
    expect(r.provider.type).toBe('local-agent')
  })
})

describe('compat/turn executeCompatTurn', () => {
  it('runs the real runTurn via FakeProvider, returns final text + usage, streams deltas', async () => {
    const deltas: string[] = []
    const out = await executeCompatTurn({
      provider: new FakeProvider(), policy: 'auto', model: 'm',
      messages: [{ role: 'user', content: 'world' }], signal: ac(), onDelta: (t) => deltas.push(t),
    })
    expect(out.text).toBe('Hello world')         // FakeProvider returns 'Hello ' + userText
    expect(out.usage).toEqual({ outputTokens: 3 })
    expect(out.error).toBeUndefined()
    expect(deltas.join('')).toBe('Hello world')   // assistant_delta forwarded; tool events dropped
  })
  it('surfaces a provider error as { error } (runTurn never throws)', async () => {
    const boom = { type: 'boom', async send() { throw new Error('upstream down') } }
    const out = await executeCompatTurn({
      provider: boom as never, policy: 'readonly', model: 'm',
      messages: [{ role: 'user', content: 'x' }], signal: ac(),
    })
    expect(out.error).toMatch(/upstream down/)
    expect(out.text).toBe('')
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run server/compat/turn.test.ts`
Expected: FAIL — `Cannot find module './turn'`.

- [ ] **Step 3: Implement `server/compat/turn.ts`**

> NOTE: `StoredMessage` (verified `shared/protocol.ts:12-18`) = `{ id: string; role: 'user'|'assistant'; content: StoredContentBlock[]; usage?: Usage; createdAt: number }`. The mapper below builds exactly `{ id, role, content: [{ type:'text', text }], createdAt: 0 }` — required fields complete; `historyToChatMessages` reads only `role` + `content`. The `role` filter (user/assistant only) keeps the union type valid.

```ts
import type { ServerMsg, StoredMessage, Usage } from '../../shared/protocol'
import type { Provider, TurnParams } from '../providers/types'
import type { ProviderConfig } from '../providers/index'
import type { DB } from '../store'
import { PolicyPermissionResolver, type PermissionPolicy } from '../permission'
import { runTurn } from '../agent'
import { parseModelId, resolveConnectionByName, connectionToProviderConfig } from './models'

export type CompatMessage = { role: 'system' | 'user' | 'assistant'; content: string }
export type CompatDeps = { db: DB; makeProvider: (cfg: ProviderConfig) => Provider }

// Carries the HTTP status the compat endpoints return for resolution failures.
export class CompatError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'CompatError'
  }
}

// Convert incoming compat messages -> TurnParams. Last user message -> userText (local-agent);
// full user/assistant transcript -> history (anthropic-api / openai-compatible). System messages
// are dropped (documented M5 limitation).
export function compatMessagesToTurnParams(messages: CompatMessage[], model: string): TurnParams {
  const convo = messages.filter((m) => m.role === 'user' || m.role === 'assistant')
  const lastUser = [...convo].reverse().find((m) => m.role === 'user')
  const history: StoredMessage[] = convo.map((m, i) => ({
    id: `compat-${i}`,
    role: m.role,
    content: [{ type: 'text', text: m.content }],
    createdAt: 0,
  }))
  return { userText: lastUser?.content ?? '', history, model }
}

// Resolve provider + policy + model from a compat model id. Throws CompatError (404/400).
export function resolveCompatTurn(
  deps: CompatDeps,
  modelId: string,
): { provider: Provider; policy: PermissionPolicy; model: string } {
  const parsed = parseModelId(modelId)
  if (!parsed) throw new CompatError(404, `model not found: ${modelId}`)
  const conn = resolveConnectionByName(deps.db, parsed.connName)
  if (!conn) throw new CompatError(404, `unknown connection: ${parsed.connName}`)
  let provider: Provider
  try {
    provider = deps.makeProvider(connectionToProviderConfig(conn, parsed.model))
  } catch (err) {
    throw new CompatError(400, err instanceof Error ? err.message : String(err))
  }
  return { provider, policy: parsed.policy, model: parsed.model }
}

// Run one stateless turn through the shared runTurn. Streams assistant text via onDelta. Returns the
// final text (TurnResult.text), usage, and any provider error. Intermediate tool_call/tool_result/
// turn_done events are dropped — compat surfaces only the final answer.
export async function executeCompatTurn(args: {
  provider: Provider
  policy: PermissionPolicy
  model: string
  messages: CompatMessage[]
  signal: AbortSignal
  onDelta?: (text: string) => void
}): Promise<{ text: string; usage?: Usage; error?: string }> {
  const params = compatMessagesToTurnParams(args.messages, args.model)
  const resolver = new PolicyPermissionResolver(args.policy)
  let error: string | undefined
  const send = (m: ServerMsg): void => {
    if (m.type === 'assistant_delta') args.onDelta?.(m.text)
    else if (m.type === 'error') error = m.message
  }
  const result = await runTurn(args.provider, params, {
    chatId: 'compat',
    send,
    permission: resolver,
    signal: args.signal,
  })
  return { text: result.text, usage: result.usage, error }
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `npx vitest run server/compat/turn.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/compat/turn.ts server/compat/turn.test.ts
git commit -m "feat(m5): stateless compat turn bridge (messages->TurnParams, resolve, execute via runTurn)"
```

---

### Task 3: `server/compat/openai.ts` — `/v1/models` + `/v1/chat/completions`

**Files:**
- Create: `server/compat/openai.ts`
- Test: `server/compat/openai.test.ts`

**Interfaces:**
- Consumes: `FastifyInstance`, `FastifyReply`; Task 1 `listCompatModels`; Task 2 `CompatDeps`, `CompatError`, `resolveCompatTurn`, `executeCompatTurn`, `CompatMessage`.
- Produces: `registerOpenAiCompat(app: FastifyInstance, deps: CompatDeps): void`. Mounts:
  - `GET /v1/models` → `{ object: 'list', data: [{ id, object: 'model', created: 0, owned_by: 'claude-web-agent' }] }`
  - `POST /v1/chat/completions` `{ model, messages, stream? }`
    - non-stream → `{ id, object: 'chat.completion', created: 0, model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens, completion_tokens, total_tokens } }`
    - stream → `data: {chat.completion.chunk with choices[0].delta.content}` per delta, a final `delta:{}, finish_reason:'stop'` chunk, then `data: [DONE]`.
- Produces (internal, exported for the Anthropic task to reuse): `sseFrame(event, data)` is NOT shared; each module writes its own raw SSE (OpenAI has no `event:` line, Anthropic does) — keep them separate.

- [ ] **Step 1: Write the failing test**

```ts
// server/compat/openai.test.ts
import { describe, it, expect } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { openDb } from '../store'
import { makeProvider } from '../providers/index'
import { registerOpenAiCompat } from './openai'

function app(): FastifyInstance {
  const a = Fastify()
  registerOpenAiCompat(a, { db: openDb(':memory:'), makeProvider }) // seeded local-agent conn "local"
  return a
}

describe('compat openai /v1/models', () => {
  it('lists model ids in the OpenAI list shape incl the -auto local variant', async () => {
    const res = await app().inject({ method: 'GET', url: '/v1/models' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { object: string; data: Array<{ id: string; object: string }> }
    expect(body.object).toBe('list')
    const ids = body.data.map((m) => m.id)
    expect(ids).toContain('local/sonnet')
    expect(ids).toContain('local-auto/sonnet')
    expect(body.data.every((m) => m.object === 'model')).toBe(true)
  })
})

// A deterministic provider that emits two deltas then returns — lets us assert mapping without creds.
const echo = {
  type: 'echo',
  async send(params: { userText: string }, ctx: { onDelta: (t: string) => void }) {
    ctx.onDelta('Hi ')
    ctx.onDelta(params.userText)
    return { text: 'Hi ' + params.userText, usage: { inputTokens: 2, outputTokens: 3 } }
  },
}
function appEcho(): FastifyInstance {
  const a = Fastify()
  registerOpenAiCompat(a, { db: openDb(':memory:'), makeProvider: () => echo as never })
  return a
}

describe('compat openai /v1/chat/completions', () => {
  it('non-stream returns a chat.completion with the final text + usage', async () => {
    const res = await appEcho().inject({
      method: 'POST', url: '/v1/chat/completions',
      payload: { model: 'local-auto/sonnet', messages: [{ role: 'user', content: 'there' }], stream: false },
    })
    expect(res.statusCode).toBe(200)
    const b = res.json() as { object: string; choices: Array<{ message: { content: string }; finish_reason: string }>; usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }
    expect(b.object).toBe('chat.completion')
    expect(b.choices[0].message.content).toBe('Hi there')
    expect(b.choices[0].finish_reason).toBe('stop')
    expect(b.usage).toEqual({ prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 })
  })

  it('stream emits chat.completion.chunk frames then [DONE]', async () => {
    const res = await appEcho().inject({
      method: 'POST', url: '/v1/chat/completions',
      payload: { model: 'local-auto/sonnet', messages: [{ role: 'user', content: 'there' }], stream: true },
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('"object":"chat.completion.chunk"')
    expect(res.body).toContain('"content":"Hi "')
    expect(res.body).toContain('"finish_reason":"stop"')
    expect(res.body.trimEnd().endsWith('data: [DONE]')).toBe(true)
  })

  it('unknown model id -> 404 with an OpenAI-style error body', async () => {
    const res = await app().inject({
      method: 'POST', url: '/v1/chat/completions',
      payload: { model: 'ghost/x', messages: [{ role: 'user', content: 'x' }] },
    })
    expect(res.statusCode).toBe(404)
    expect((res.json() as { error: { message: string } }).error.message).toMatch(/connection|model/i)
  })

  it('missing messages -> 400', async () => {
    const res = await app().inject({ method: 'POST', url: '/v1/chat/completions', payload: { model: 'local/sonnet' } })
    expect(res.statusCode).toBe(400)
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run server/compat/openai.test.ts`
Expected: FAIL — `Cannot find module './openai'`.

- [ ] **Step 3: Implement `server/compat/openai.ts`**

```ts
import type { FastifyInstance, FastifyReply } from 'fastify'
import { listCompatModels } from './models'
import { CompatError, resolveCompatTurn, executeCompatTurn, type CompatDeps, type CompatMessage } from './turn'

type ChatBody = { model?: unknown; messages?: unknown; stream?: unknown }

// Validate + normalize the request body into { model, messages, stream }. Returns null on bad input.
function parseChatBody(body: ChatBody): { model: string; messages: CompatMessage[]; stream: boolean } | null {
  if (typeof body.model !== 'string' || body.model === '') return null
  if (!Array.isArray(body.messages) || body.messages.length === 0) return null
  const messages: CompatMessage[] = []
  for (const m of body.messages) {
    const role = (m as { role?: unknown }).role
    const content = (m as { content?: unknown }).content
    if ((role === 'system' || role === 'user' || role === 'assistant') && typeof content === 'string') {
      messages.push({ role, content })
    } else return null
  }
  return { model: body.model, messages, stream: (body as { stream?: unknown }).stream === true }
}

function openaiError(reply: FastifyReply, status: number, message: string): { error: { message: string; type: string } } {
  reply.code(status)
  return { error: { message, type: status === 404 ? 'not_found_error' : status === 400 ? 'invalid_request_error' : 'api_error' } }
}

export function registerOpenAiCompat(app: FastifyInstance, deps: CompatDeps): void {
  app.get('/v1/models', async () => ({
    object: 'list',
    data: listCompatModels(deps.db).map((id) => ({ id, object: 'model', created: 0, owned_by: 'claude-web-agent' })),
  }))

  app.post('/v1/chat/completions', async (req, reply) => {
    const parsed = parseChatBody((req.body ?? {}) as ChatBody)
    if (!parsed) return openaiError(reply, 400, 'model and a non-empty messages[] are required')

    let resolved
    try {
      resolved = resolveCompatTurn(deps, parsed.model)
    } catch (err) {
      if (err instanceof CompatError) return openaiError(reply, err.status, err.message)
      throw err
    }

    const ac = new AbortController()

    if (parsed.stream) {
      reply.hijack()
      const raw = reply.raw
      raw.on('error', () => {}) // load-bearing crash-guard (M4): absorbs post-canWrite EPIPE races
      raw.on('close', () => ac.abort())
      const canWrite = (): boolean => !raw.writableEnded && !raw.destroyed
      raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      const write = (obj: unknown): void => { if (canWrite()) raw.write(`data: ${JSON.stringify(obj)}\n\n`) }
      const chunk = (delta: Record<string, unknown>, finish: string | null): unknown => ({
        id: 'chatcmpl-compat', object: 'chat.completion.chunk', created: 0, model: parsed.model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })
      write(chunk({ role: 'assistant' }, null)) // OpenAI's first chunk announces the role
      const out = await executeCompatTurn({
        ...resolved, messages: parsed.messages, signal: ac.signal, onDelta: (t) => write(chunk({ content: t }, null)),
      })
      if (out.error && canWrite()) write(chunk({ content: `\n[error] ${out.error}` }, null))
      write(chunk({}, 'stop'))
      if (canWrite()) raw.write('data: [DONE]\n\n')
      if (canWrite()) raw.end()
      return reply
    }

    const out = await executeCompatTurn({ ...resolved, messages: parsed.messages, signal: ac.signal })
    if (out.error !== undefined) return openaiError(reply, 500, out.error)
    const inT = out.usage?.inputTokens ?? 0
    const outT = out.usage?.outputTokens ?? 0
    reply.code(200)
    return {
      id: 'chatcmpl-compat', object: 'chat.completion', created: 0, model: parsed.model,
      choices: [{ index: 0, message: { role: 'assistant', content: out.text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: inT, completion_tokens: outT, total_tokens: inT + outT },
    }
  })
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `npx vitest run server/compat/openai.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/compat/openai.ts server/compat/openai.test.ts
git commit -m "feat(m5): OpenAI-compatible /v1/models + /v1/chat/completions (stream + non-stream)"
```

---

### Task 4: `server/compat/anthropic.ts` — `/v1/messages`

**Files:**
- Create: `server/compat/anthropic.ts`
- Test: `server/compat/anthropic.test.ts`

**Interfaces:**
- Consumes: same as Task 3 minus `listCompatModels`. Reuses Task 2's bridge.
- Produces: `registerAnthropicCompat(app: FastifyInstance, deps: CompatDeps): void`. Mounts `POST /v1/messages` `{ model, messages, max_tokens?, system?, stream? }`:
  - non-stream → `{ id, type: 'message', role: 'assistant', model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens, output_tokens } }`
  - stream → SSE event sequence (per the `claude-api` skill's Raw SSE Format): `message_start` → `content_block_start` (index 0, empty text) → `content_block_delta` (`text_delta`) per delta → `content_block_stop` → `message_delta` (`stop_reason`, `usage`) → `message_stop`. Each frame is `event: <name>\ndata: <json>\n\n`.

- [ ] **Step 1: Write the failing test**

```ts
// server/compat/anthropic.test.ts
import { describe, it, expect } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { openDb } from '../store'
import { registerAnthropicCompat } from './anthropic'

const echo = {
  type: 'echo',
  async send(params: { userText: string }, ctx: { onDelta: (t: string) => void }) {
    ctx.onDelta('Hi ')
    ctx.onDelta(params.userText)
    return { text: 'Hi ' + params.userText, usage: { inputTokens: 2, outputTokens: 3 } }
  },
}
function appEcho(): FastifyInstance {
  const a = Fastify()
  registerAnthropicCompat(a, { db: openDb(':memory:'), makeProvider: () => echo as never })
  return a
}

describe('compat anthropic /v1/messages', () => {
  it('non-stream returns an Anthropic message object', async () => {
    const res = await appEcho().inject({
      method: 'POST', url: '/v1/messages',
      payload: { model: 'local-auto/sonnet', max_tokens: 64, messages: [{ role: 'user', content: 'there' }] },
    })
    expect(res.statusCode).toBe(200)
    const b = res.json() as { type: string; role: string; content: Array<{ type: string; text: string }>; stop_reason: string; usage: { input_tokens: number; output_tokens: number } }
    expect(b.type).toBe('message')
    expect(b.role).toBe('assistant')
    expect(b.content).toEqual([{ type: 'text', text: 'Hi there' }])
    expect(b.stop_reason).toBe('end_turn')
    expect(b.usage).toEqual({ input_tokens: 2, output_tokens: 3 })
  })

  it('stream emits the Anthropic SSE event sequence in order', async () => {
    const res = await appEcho().inject({
      method: 'POST', url: '/v1/messages',
      payload: { model: 'local-auto/sonnet', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'there' }] },
    })
    expect(res.statusCode).toBe(200)
    const body = res.body
    for (const ev of ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']) {
      expect(body).toContain(`event: ${ev}`)
    }
    expect(body).toContain('"type":"text_delta"')
    expect(body).toContain('"text":"Hi "')
    // ordering: start precedes a delta precedes stop
    expect(body.indexOf('event: message_start')).toBeLessThan(body.indexOf('event: content_block_delta'))
    expect(body.indexOf('event: content_block_delta')).toBeLessThan(body.indexOf('event: message_stop'))
  })

  it('unknown model -> 404 Anthropic-style error', async () => {
    const a = Fastify(); registerAnthropicCompat(a, { db: openDb(':memory:'), makeProvider: () => echo as never })
    const res = await a.inject({ method: 'POST', url: '/v1/messages', payload: { model: 'ghost/x', messages: [{ role: 'user', content: 'x' }] } })
    expect(res.statusCode).toBe(404)
    expect((res.json() as { type: string; error: { type: string } }).type).toBe('error')
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run server/compat/anthropic.test.ts`
Expected: FAIL — `Cannot find module './anthropic'`.

- [ ] **Step 3: Implement `server/compat/anthropic.ts`**

```ts
import type { FastifyInstance, FastifyReply } from 'fastify'
import { CompatError, resolveCompatTurn, executeCompatTurn, type CompatDeps, type CompatMessage } from './turn'

type MsgBody = { model?: unknown; messages?: unknown; stream?: unknown }

function parseBody(body: MsgBody): { model: string; messages: CompatMessage[]; stream: boolean } | null {
  if (typeof body.model !== 'string' || body.model === '') return null
  if (!Array.isArray(body.messages) || body.messages.length === 0) return null
  const messages: CompatMessage[] = []
  for (const m of body.messages) {
    const role = (m as { role?: unknown }).role
    const content = (m as { content?: unknown }).content
    // Anthropic content may be a string or an array of text blocks — flatten to text.
    let text: string | null = null
    if (typeof content === 'string') text = content
    else if (Array.isArray(content)) {
      text = content.filter((b) => (b as { type?: unknown }).type === 'text').map((b) => (b as { text: string }).text).join('')
    }
    if ((role === 'user' || role === 'assistant' || role === 'system') && text !== null) messages.push({ role, content: text })
    else return null
  }
  return { model: body.model, messages, stream: (body as { stream?: unknown }).stream === true }
}

function anthropicError(reply: FastifyReply, status: number, message: string): { type: string; error: { type: string; message: string } } {
  reply.code(status)
  return { type: 'error', error: { type: status === 404 ? 'not_found_error' : status === 400 ? 'invalid_request_error' : 'api_error', message } }
}

export function registerAnthropicCompat(app: FastifyInstance, deps: CompatDeps): void {
  app.post('/v1/messages', async (req, reply) => {
    const parsed = parseBody((req.body ?? {}) as MsgBody)
    if (!parsed) return anthropicError(reply, 400, 'model and a non-empty messages[] are required')

    let resolved
    try {
      resolved = resolveCompatTurn(deps, parsed.model)
    } catch (err) {
      if (err instanceof CompatError) return anthropicError(reply, err.status, err.message)
      throw err
    }

    const ac = new AbortController()

    if (parsed.stream) {
      reply.hijack()
      const raw = reply.raw
      raw.on('error', () => {}) // load-bearing crash-guard (M4)
      raw.on('close', () => ac.abort())
      const canWrite = (): boolean => !raw.writableEnded && !raw.destroyed
      raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      const frame = (event: string, data: unknown): void => { if (canWrite()) raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) }

      frame('message_start', { type: 'message_start', message: { id: 'msg_compat', type: 'message', role: 'assistant', model: parsed.model, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } })
      frame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      const out = await executeCompatTurn({
        ...resolved, messages: parsed.messages, signal: ac.signal,
        onDelta: (t) => frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } }),
      })
      if (out.error) frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `\n[error] ${out.error}` } })
      frame('content_block_stop', { type: 'content_block_stop', index: 0 })
      frame('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: out.usage?.outputTokens ?? 0 } })
      frame('message_stop', { type: 'message_stop' })
      if (canWrite()) raw.end()
      return reply
    }

    const out = await executeCompatTurn({ ...resolved, messages: parsed.messages, signal: ac.signal })
    if (out.error !== undefined) return anthropicError(reply, 500, out.error)
    reply.code(200)
    return {
      id: 'msg_compat', type: 'message', role: 'assistant', model: parsed.model,
      content: [{ type: 'text', text: out.text }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: out.usage?.inputTokens ?? 0, output_tokens: out.usage?.outputTokens ?? 0 },
    }
  })
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `npx vitest run server/compat/anthropic.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/compat/anthropic.ts server/compat/anthropic.test.ts
git commit -m "feat(m5): Anthropic-compatible /v1/messages (stream message_* events + non-stream)"
```

---

### Task 5: Wire-up — `server/compat/index.ts` + `server/index.ts`

**Files:**
- Create: `server/compat/index.ts`
- Modify: `server/index.ts` (add the registration call)
- Test: `server/compat/index.test.ts`

**Interfaces:**
- Consumes: `registerOpenAiCompat` (Task 3), `registerAnthropicCompat` (Task 4), `CompatDeps`.
- Produces: `registerCompatApi(app: FastifyInstance, deps: CompatDeps): void` (calls both).

- [ ] **Step 1: Write the failing test**

```ts
// server/compat/index.test.ts
import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import { openDb } from '../store'
import { makeProvider } from '../providers/index'
import { registerCompatApi } from './index'

describe('registerCompatApi', () => {
  it('mounts both /v1/models (OpenAI) and /v1/messages (Anthropic)', async () => {
    const app = Fastify()
    registerCompatApi(app, { db: openDb(':memory:'), makeProvider })
    expect((await app.inject({ method: 'GET', url: '/v1/models' })).statusCode).toBe(200)
    // /v1/messages with a bad body still proves the route is mounted (400, not 404)
    const res = await app.inject({ method: 'POST', url: '/v1/messages', payload: {} })
    expect(res.statusCode).toBe(400)
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run server/compat/index.test.ts`
Expected: FAIL — `Cannot find module './index'`.

- [ ] **Step 3: Implement `server/compat/index.ts`**

```ts
import type { FastifyInstance } from 'fastify'
import { registerOpenAiCompat } from './openai'
import { registerAnthropicCompat } from './anthropic'
import type { CompatDeps } from './turn'

// Compatibility API (M5): OpenAI (/v1/models, /v1/chat/completions) + Anthropic (/v1/messages).
// Stateless — does NOT touch ChatHub/ChatRuntime. Auth + 0.0.0.0 bind are M6.
export function registerCompatApi(app: FastifyInstance, deps: CompatDeps): void {
  registerOpenAiCompat(app, deps)
  registerAnthropicCompat(app, deps)
}

export type { CompatDeps } from './turn'
```

- [ ] **Step 4: Wire into `server/index.ts`**

Add the import alongside the others and register after `registerHttpApi`:

```ts
import { registerCompatApi } from './compat/index'
```

and, after the existing `registerHttpApi(app, { hub, db })` line:

```ts
registerCompatApi(app, { db, makeProvider })
```

- [ ] **Step 5: Run the test + full typecheck**

Run: `npx vitest run server/compat/index.test.ts` → PASS
Run: `npm run typecheck` → EXIT 0

- [ ] **Step 6: Commit**

```bash
git add server/compat/index.ts server/index.ts server/compat/index.test.ts
git commit -m "feat(m5): registerCompatApi wires OpenAI + Anthropic compat; mount in server/index.ts"
```

---

### Task 6: `scripts/e2e-compat.mjs` — credential-free end-to-end

**Files:**
- Create: `scripts/e2e-compat.mjs`

**Interfaces:**
- Consumes: the assembled Fastify app + `registerCompatApi`, with `makeProvider` overridden to a fake provider so no real Claude login is needed (mirrors `scripts/e2e-rest.mjs` / `scripts/e2e-openai.mjs`).
- Produces: a standalone script that boots an in-process server on a free port (use **8791** to avoid 8787/8788/8790), exercises `/v1/models`, `/v1/chat/completions` (stream + non-stream), `/v1/messages` (stream + non-stream), and a `-auto` policy assertion, prints `✅ ... PASS`, and `process.exit(1)` on any mismatch. Not part of `npm test`; run manually via `npx tsx scripts/e2e-compat.mjs`.

- [ ] **Step 1: Write the script** (model it on `scripts/e2e-rest.mjs`; build a Fastify app, register compat with a fake provider, drive it with `fetch`)

```js
// scripts/e2e-compat.mjs — credential-free e2e for the M5 Compatibility API.
// Boots the compat endpoints with a FAKE provider (no Claude login) and exercises every surface.
import Fastify from 'fastify'
import { openDb } from '../server/store.ts'
import { registerCompatApi } from '../server/compat/index.ts'

const PORT = 8791

// Fake provider: streams two deltas, "uses" a Write tool through the policy (so -auto vs readonly is
// observable), returns the final text + usage. No network, no creds.
class FakeProvider {
  type = 'fake'
  async send(params, ctx) {
    ctx.onDelta('Hello ')
    ctx.onDelta(params.userText)
    const decision = await ctx.permission.resolve('Write', { file_path: '/tmp/x' })
    if (decision.behavior === 'allow') ctx.onToolCall({ id: 't1', name: 'Write', input: {} })
    return { text: 'Hello ' + params.userText + (decision.behavior === 'allow' ? ' [wrote]' : ''), usage: { inputTokens: 2, outputTokens: 3 } }
  }
}

const db = openDb(':memory:')
const app = Fastify()
registerCompatApi(app, { db, makeProvider: () => new FakeProvider() })
await app.listen({ port: PORT, host: '127.0.0.1' })
const base = `http://127.0.0.1:${PORT}`

function assert(cond, msg) { if (!cond) { console.error('❌', msg); process.exit(1) } }

// 1) /v1/models lists the seeded local connection + its -auto variant
const models = await (await fetch(`${base}/v1/models`)).json()
const ids = models.data.map((m) => m.id)
assert(models.object === 'list' && ids.includes('local/sonnet') && ids.includes('local-auto/sonnet'), '/v1/models shape')

// 2) OpenAI non-stream
const oai = await (await fetch(`${base}/v1/chat/completions`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'local/sonnet', messages: [{ role: 'user', content: 'world' }], stream: false }),
})).json()
assert(oai.object === 'chat.completion' && oai.choices[0].message.content.startsWith('Hello world'), 'openai non-stream')

// 3) OpenAI stream
const oaiStream = await (await fetch(`${base}/v1/chat/completions`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'local/sonnet', messages: [{ role: 'user', content: 'world' }], stream: true }),
})).text()
assert(oaiStream.includes('chat.completion.chunk') && oaiStream.trimEnd().endsWith('data: [DONE]'), 'openai stream + [DONE]')

// 4) Anthropic non-stream
const ant = await (await fetch(`${base}/v1/messages`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'local/sonnet', max_tokens: 64, messages: [{ role: 'user', content: 'world' }] }),
})).json()
assert(ant.type === 'message' && ant.content[0].text.startsWith('Hello world'), 'anthropic non-stream')

// 5) Anthropic stream
const antStream = await (await fetch(`${base}/v1/messages`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'local/sonnet', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'world' }] }),
})).text()
assert(antStream.includes('event: message_start') && antStream.includes('event: message_stop'), 'anthropic stream events')

// 6) Policy: -auto allows Write (text gets "[wrote]"), readonly denies it
const autoRes = await (await fetch(`${base}/v1/chat/completions`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'local-auto/sonnet', messages: [{ role: 'user', content: 'go' }], stream: false }),
})).json()
const roRes = await (await fetch(`${base}/v1/chat/completions`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'local/sonnet', messages: [{ role: 'user', content: 'go' }], stream: false }),
})).json()
assert(autoRes.choices[0].message.content.includes('[wrote]'), '-auto policy allows Write')
assert(!roRes.choices[0].message.content.includes('[wrote]'), 'readonly policy denies Write')

await app.close()
console.log('✅ compat API e2e PASS — /v1/models + openai + anthropic (stream + non-stream) + policy')
process.exit(0)
```

- [ ] **Step 2: Run it**

Run: `npx tsx scripts/e2e-compat.mjs`
Expected: prints `✅ compat API e2e PASS ...`, exit 0.

- [ ] **Step 3: Commit**

```bash
git add scripts/e2e-compat.mjs
git commit -m "test(m5): credential-free compat e2e (models + openai + anthropic + policy)"
```

---

### Task 7: Docs — README + progress

**Files:**
- Modify: `README.md` (add a "Compatibility API (/v1)" section)
- Modify: `.git/sdd/progress.md` (record M5 shipped)

**Interfaces:** none (documentation).

- [ ] **Step 1: Add a README section** describing:
  - Base URL for harnesses: `http://127.0.0.1:8787/v1` (M5 is localhost-only; LAN + token is M6).
  - Model id grammar: `"<connName>/<model>"` (readonly) and `"<connName>-auto/<model>"` (local-agent auto).
  - `GET /v1/models`, `POST /v1/chat/completions` (OpenAI), `POST /v1/messages` (Anthropic) — stateless.
  - **open-webui**: set the OpenAI base URL to `http://<host>:8787/v1`, any token (M5 ignores it), pick a `local-auto/...` model to let the agent write/run.
  - **claude-cli / Claude Code**: `ANTHROPIC_BASE_URL=http://<host>:8787/v1`, `ANTHROPIC_API_KEY=<anything>`; `/v1/messages` serves the turn.
  - **Security warning** (mirror spec §11): `-auto` (local-agent) models run/write with no prompt — only expose to trusted harnesses.
  - Limitations: `system` messages dropped; non-text content unsupported; intermediate tool_use not surfaced; no auth/persistence (M5).

- [ ] **Step 2: Update `.git/sdd/progress.md`** with a `## M5 Compatibility API` entry summarizing the shipped surface + the design decisions above.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(m5): Compatibility API — endpoints, model-id grammar, open-webui/claude-cli setup, limits"
```

---

## Final gate (run before the M-convention close-out review)

- [ ] `npm run typecheck` → EXIT 0
- [ ] `npx tsc -p web/tsconfig.json --noEmit` → EXIT 0 (web untouched; must stay green)
- [ ] `npm test` → all green (**213 baseline + the new compat unit tests**; expect ~+20)
- [ ] `npm run build:web` → ok
- [ ] `npx tsx scripts/e2e-rest.mjs` → PASS (M4 regression — compat must not disturb it)
- [ ] `npx tsx scripts/e2e-openai.mjs` → PASS
- [ ] `npx tsx scripts/e2e-compat.mjs` → PASS (new)
- [ ] **opus whole-branch review** (M-convention close-out — caught a real bug at every prior milestone), then `--no-ff` merge to master (retain branch), then post-merge `9arm-skills:scrutinize`.

## Self-Review (against spec §9 / §15)

- §9.1 endpoints: `/v1/models` (T1+T3), `/v1/chat/completions` (T3), `/v1/messages` (T4) — covered.
- §9.2 Auth: **deferred to M6** (documented in T7 + this plan's constraints) — intentional gap, not a miss.
- §9.3 model-id mapping (`<conn>/<model>`, `<conn>-auto/<model>`): T1 `parseModelId` + `listCompatModels`.
- §9.4 local-agent → single final assistant message, no intermediate tool_use on the wire, stream final-answer deltas: T2 `executeCompatTurn` (drops tool events, returns `result.text`) + T3/T4 streaming.
- §15 success #7 (open-webui via OpenAI base URL → model list + chat via local-agent): T3 + T6 + T7.
- §15 success #8 (claude-cli `ANTHROPIC_BASE_URL` → `/v1/messages`): T4 + T7.
- §15 success #9 (`-auto` writes/runs without allow; normal = readonly): T2 policy + T6 policy assertion.
- Security invariant (no api_key on the wire): T1 resolves the secret server-side; no response shape includes it; preserved.
- No placeholders: every code step contains complete code; commands have expected output. All cross-task type dependencies verified against source (`StoredMessage`, `ConnectionWithSecret`, `ProviderConfig`, `Provider`, `Usage`, `runTurn`/`RunDeps`, `PolicyPermissionResolver`).
