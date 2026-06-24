# Turn UX (typing indicator, token usage, transient auto-retry) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a typing indicator while awaiting the first token, per-turn input/output token counts under each assistant message, a total-usage summary in Settings, and transient-only auto-retry (3×, before the first token) in `runTurn`.

**Architecture:** Token data already flows end-to-end (`turn_done.usage`, the `messages.usage` column, `StoredMessage.usage`) so the token features only surface/aggregate it. The typing indicator is derived purely from existing `ChatView` state. The retry wraps the existing `provider.send()` call in `runTurn`, reusing its `emitted` flag as the "before the first token" signal; providers are made to throw errors carrying a numeric `.status` so transient classification is uniform.

**Tech Stack:** TypeScript ESM, React 18 + Tailwind 3 (front), Fastify + better-sqlite3 (server), Vitest (env node), `@anthropic-ai/sdk`.

## Global Constraints

- Style: single quotes, no semicolons, 2-space indent — **except `server/store.ts` which uses double quotes**. Comments in English.
- Frontend custom animations go in `web/src/index.css` (`tailwind.config.js` `theme.extend` is empty). DESIGN.md rules: text ≥ 12px (`text-xs`); muted-text floor is `gray-500` (#6b7280, AA); every animation needs a `@media (prefers-reduced-motion: reduce)` alternative.
- No schema or protocol change: `turn_done` already carries `usage?: Usage` (`shared/protocol.ts:73`), the `messages` table already has a `usage TEXT` column, `StoredMessage.usage` round-trips (`store.ts:268-314`).
- Gates that must pass before any merge: `npx vitest run`, `npx tsc --noEmit`, `npx tsc --noEmit -p web/tsconfig.json`, `npm run build:web`.
- Commit trailer on every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Branch: `feat/turn-ux` (already created off master `5b462a2`).

---

### Task 1: appState — `awaitingFirstToken` helper (typing-indicator state)

**Files:**
- Modify: `web/src/appState.ts` (add an exported helper near the bottom, beside `activePrompt`)
- Test: `web/src/appState.test.ts`

**Interfaces:**
- Produces: `awaitingFirstToken(view: ChatView): boolean` — true when a turn is in flight but the assistant has produced no output yet.

- [ ] **Step 1: Write the failing test** — append to `web/src/appState.test.ts` (add `awaitingFirstToken` to the existing import from `./appState`):

```ts
describe('awaitingFirstToken', () => {
  it('true while streaming with no assistant output yet (last message is the user)', () => {
    expect(awaitingFirstToken({ messages: [{ role: 'user', text: 'hi' }], streaming: true })).toBe(true)
  })
  it('true while streaming with an empty view', () => {
    expect(awaitingFirstToken({ messages: [], streaming: true })).toBe(true)
  })
  it('false once the assistant has started (last message is the assistant)', () => {
    expect(
      awaitingFirstToken({
        messages: [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'H', tools: [] }],
        streaming: true,
      }),
    ).toBe(false)
  })
  it('false when not streaming', () => {
    expect(awaitingFirstToken({ messages: [{ role: 'user', text: 'hi' }], streaming: false })).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run web/src/appState.test.ts`
Expected: FAIL — `awaitingFirstToken is not a function`.

- [ ] **Step 3: Write minimal implementation** — add to `web/src/appState.ts`:

```ts
// True while a turn is in flight (streaming) but the assistant has produced no output yet:
// the assistant bubble is created lazily on the first delta/tool, so until then the last
// message is the user's (or the view is empty). Drives the typing indicator.
export function awaitingFirstToken(view: ChatView): boolean {
  if (!view.streaming) return false
  const last = view.messages[view.messages.length - 1]
  return last === undefined || last.role === 'user'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run web/src/appState.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/appState.ts web/src/appState.test.ts
git commit -m "feat(web): awaitingFirstToken selector for the typing indicator

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: appState — per-turn token usage (data)

**Files:**
- Modify: `web/src/appState.ts` (import `Usage`; extend the assistant `UiMessage`; `reduceView` `turn_done`; `historyToView`)
- Test: `web/src/appState.test.ts`

**Interfaces:**
- Consumes: `Usage` from `@shared/protocol`.
- Produces: the assistant `UiMessage` variant gains `usage?: Usage`.

- [ ] **Step 1: Write the failing tests** — append to `web/src/appState.test.ts`:

```ts
describe('per-turn usage', () => {
  it('turn_done attaches usage to the last assistant message and clears streaming', () => {
    let s = appendUser(initialAppState, 'c1', 'hi')
    s = applyServer(s, { type: 'assistant_delta', chatId: 'c1', text: 'Hello' })
    s = applyServer(s, { type: 'turn_done', chatId: 'c1', usage: { inputTokens: 10, outputTokens: 2 } })
    expect(s.views['c1'].messages.at(-1)).toMatchObject({
      role: 'assistant',
      text: 'Hello',
      usage: { inputTokens: 10, outputTokens: 2 },
    })
    expect(s.views['c1'].streaming).toBe(false)
  })
  it('turn_done without usage just clears streaming (no usage field added)', () => {
    let s = appendUser(initialAppState, 'c1', 'hi')
    s = applyServer(s, { type: 'assistant_delta', chatId: 'c1', text: 'Hi' })
    s = applyServer(s, { type: 'turn_done', chatId: 'c1' })
    const last = s.views['c1'].messages.at(-1) as { usage?: unknown }
    expect(last.usage).toBeUndefined()
    expect(s.views['c1'].streaming).toBe(false)
  })
  it('chat_history surfaces a stored assistant message usage', () => {
    const s = applyServer(initialAppState, {
      type: 'chat_history',
      chatId: 'c1',
      messages: [
        { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }], createdAt: 0 },
        {
          id: 'a1',
          role: 'assistant',
          content: [{ type: 'text', text: 'yo' }],
          usage: { inputTokens: 5, outputTokens: 1 },
          createdAt: 1,
        },
      ],
    })
    expect(s.views['c1'].messages.at(-1)).toMatchObject({
      role: 'assistant',
      text: 'yo',
      usage: { inputTokens: 5, outputTokens: 1 },
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run web/src/appState.test.ts`
Expected: FAIL — `turn_done` does not attach usage; `chat_history` drops it.

- [ ] **Step 3: Write minimal implementation** in `web/src/appState.ts`:

(a) add `Usage` to the protocol import:
```ts
import type {
  ServerMsg,
  ToolCall,
  ChatMeta,
  StoredMessage,
  DirEntry,
  ConnectionMeta,
  Usage,
} from '@shared/protocol'
```

(b) extend the assistant `UiMessage`:
```ts
export type UiMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; tools: ToolCall[]; usage?: Usage }
  | { role: 'error'; text: string }
```

(c) replace the `turn_done` case in `reduceView`:
```ts
    case 'turn_done': {
      if (!msg.usage) return { ...view, streaming: false }
      const idx = view.messages.length - 1
      const last = view.messages[idx]
      if (!last || last.role !== 'assistant') return { ...view, streaming: false }
      const messages = [...view.messages]
      messages[idx] = { ...last, usage: msg.usage }
      return { ...view, streaming: false, messages }
    }
```

(d) in `historyToView`, carry usage onto the assistant message:
```ts
      if (text !== '' || tools.length > 0) ui.push({ role: 'assistant', text, tools, ...(m.usage ? { usage: m.usage } : {}) })
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run web/src/appState.test.ts`
Expected: PASS (all appState tests, including Task 1's).

- [ ] **Step 5: Commit**

```bash
git add web/src/appState.ts web/src/appState.test.ts
git commit -m "feat(web): carry per-turn usage onto assistant messages (live + history)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Frontend render — typing indicator + per-turn usage line

**Files:**
- Create: `web/src/components/TypingIndicator.tsx`
- Modify: `web/src/index.css` (keyframes + reduced-motion)
- Modify: `web/src/App.tsx` (render the indicator)
- Modify: `web/src/components/Message.tsx` (usage line)

**Interfaces:**
- Consumes: `awaitingFirstToken` (Task 1), the assistant `UiMessage.usage` (Task 2).

No unit test (the suite has no component-render harness); verified by `tsc` + `build:web` and the live run later.

- [ ] **Step 1: Create `web/src/components/TypingIndicator.tsx`**

```tsx
// Assistant-style bubble shown while a turn is in flight before the first token.
export function TypingIndicator() {
  return (
    <div className="flex justify-start px-3 py-2 sm:px-4">
      <div className="rounded-2xl bg-gray-100 px-4 py-3" role="status" aria-label="กำลังตอบกลับ">
        <span className="flex gap-1">
          <span className="typing-dot h-2 w-2 rounded-full bg-gray-500" />
          <span className="typing-dot h-2 w-2 rounded-full bg-gray-500" />
          <span className="typing-dot h-2 w-2 rounded-full bg-gray-500" />
        </span>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Add the animation to `web/src/index.css`** (append after the existing rules):

```css
@keyframes typing-dot {
  0%, 60%, 100% { opacity: 0.25; }
  30% { opacity: 1; }
}
.typing-dot { animation: typing-dot 1.2s infinite ease-in-out; }
.typing-dot:nth-child(2) { animation-delay: 0.15s; }
.typing-dot:nth-child(3) { animation-delay: 0.3s; }
@media (prefers-reduced-motion: reduce) {
  .typing-dot { animation: none; opacity: 0.5; }
}
```

- [ ] **Step 3: Render it in `web/src/App.tsx`**

Add the imports (beside the other component imports + the appState import):
```ts
import { TypingIndicator } from './components/TypingIndicator'
```
Add `awaitingFirstToken` to the existing `./appState` import list.

Then in the chat scroll area, render it after the messages map:
```tsx
            <div ref={scrollRef} className="flex-1 overflow-y-auto bg-gray-50">
              {view.messages.map((m, i) => (
                <Message key={i} msg={m} />
              ))}
              {awaitingFirstToken(view) && <TypingIndicator />}
            </div>
```

- [ ] **Step 4: Add the usage line in `web/src/components/Message.tsx`**

Inside the assistant bubble, after the `<div className="prose ...">…</div>`, add:
```tsx
        {!isUser && msg.role === 'assistant' && msg.usage && (msg.usage.inputTokens !== undefined || msg.usage.outputTokens !== undefined) && (
          <div className="mt-1 text-xs text-gray-500">
            ↑ {msg.usage.inputTokens ?? '–'} &nbsp; ↓ {msg.usage.outputTokens ?? '–'}
          </div>
        )}
```

- [ ] **Step 5: Verify types + build**

Run: `npx tsc --noEmit -p web/tsconfig.json && npm run build:web`
Expected: tsc exit 0; build succeeds.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/TypingIndicator.tsx web/src/index.css web/src/App.tsx web/src/components/Message.tsx
git commit -m "feat(web): typing indicator + per-turn token line under assistant messages

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: store — `totalUsage`

**Files:**
- Modify: `server/store.ts` (double-quote style)
- Test: `server/store.test.ts`

**Interfaces:**
- Produces: `totalUsage(db: DB): { inputTokens: number; outputTokens: number }`.

- [ ] **Step 1: Write the failing test** — append to `server/store.test.ts` (reuse that file's existing chat-seeding helper so the message FK is satisfied — search it for how it creates a chat, e.g. `createChat`/`createChatFromApi` + a seeded `local` connection):

```ts
it("totalUsage sums input/output across all messages, ignoring null and unparseable usage", () => {
  const db = openDb(":memory:")
  const chat = createChat(db, { connectionId: "local", model: "sonnet" }) // match this file's existing seeding
  appendMessage(db, { id: "u1", chatId: chat.id, role: "user", content: [{ type: "text", text: "hi" }], createdAt: 0 })
  appendMessage(db, { id: "a1", chatId: chat.id, role: "assistant", content: [{ type: "text", text: "x" }], usage: { inputTokens: 10, outputTokens: 2 }, createdAt: 1 })
  appendMessage(db, { id: "a2", chatId: chat.id, role: "assistant", content: [{ type: "text", text: "y" }], usage: { inputTokens: 5, outputTokens: 3 }, createdAt: 2 })
  expect(totalUsage(db)).toEqual({ inputTokens: 15, outputTokens: 5 })
})
```

(If `createChat`/`appendMessage`/`openDb` aren't already imported in the test, add them to the existing import from `./store`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/store.test.ts`
Expected: FAIL — `totalUsage is not a function`.

- [ ] **Step 3: Write minimal implementation** in `server/store.ts` (double quotes, beside `listMessages`):

```ts
export function totalUsage(db: DB): { inputTokens: number; outputTokens: number } {
  const rows = db.prepare("SELECT usage FROM messages WHERE usage IS NOT NULL").all() as { usage: string }[]
  let inputTokens = 0
  let outputTokens = 0
  for (const r of rows) {
    try {
      const u = JSON.parse(r.usage) as Usage
      inputTokens += u.inputTokens ?? 0
      outputTokens += u.outputTokens ?? 0
    } catch {
      // ignore unparseable usage rows (same tolerance as listMessages)
    }
  }
  return { inputTokens, outputTokens }
}
```

(`Usage` and `DB` are already imported in `store.ts`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/store.ts server/store.test.ts
git commit -m "feat(server): totalUsage(db) aggregate over the messages usage column

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: `GET /api/usage` endpoint

**Files:**
- Modify: `server/http-api.ts`
- Test: `server/http-api.test.ts`

**Interfaces:**
- Consumes: `totalUsage` (Task 4).
- Produces: `GET /api/usage` → `{ inputTokens: number; outputTokens: number }` (token-guarded by the existing global `onRequest` hook).

- [ ] **Step 1: Write the failing test** — append to `server/http-api.test.ts` (use that file's existing `makeApp()` helper + chat/message seeding pattern):

```ts
it("GET /api/usage returns the summed token usage across messages", async () => {
  const { app, db } = makeApp() // match this file's helper; it must expose db (or seed via the hub)
  const chat = createChat(db, { connectionId: "local", model: "sonnet" })
  appendMessage(db, { id: "a1", chatId: chat.id, role: "assistant", content: [{ type: "text", text: "x" }], usage: { inputTokens: 7, outputTokens: 1 }, createdAt: 1 })
  const res = await app.inject({ method: "GET", url: "/api/usage" })
  expect(res.statusCode).toBe(200)
  expect(res.json()).toEqual({ inputTokens: 7, outputTokens: 1 })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/http-api.test.ts`
Expected: FAIL — 404 (route not registered).

- [ ] **Step 3: Write minimal implementation** in `server/http-api.ts`:

Add `totalUsage` to the existing import from `./store`, then register the route inside `registerHttpApi` next to the other `app.get('/api/...')` routes:
```ts
  app.get('/api/usage', async () => totalUsage(db))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/http-api.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/http-api.ts server/http-api.test.ts
git commit -m "feat(server): GET /api/usage returns total token usage

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Settings — total-usage card

**Files:**
- Modify: `web/src/components/Settings.tsx`

No unit test; verified by `tsc` + `build:web`.

- [ ] **Step 1: Add fetch + state + render** in `web/src/components/Settings.tsx`

Add state beside the other harness-panel state (e.g. near `modelIds`):
```ts
  const [usage, setUsage] = useState<{ inputTokens: number; outputTokens: number } | null>(null)
```
Add a fetch effect (mirrors the existing `/v1/models` effect):
```ts
  useEffect(() => {
    let alive = true
    apiFetch('/api/usage', token)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error('http ' + res.status))))
      .then((body: { inputTokens?: number; outputTokens?: number }) => {
        if (alive) setUsage({ inputTokens: body.inputTokens ?? 0, outputTokens: body.outputTokens ?? 0 })
      })
      .catch(() => {
        if (alive) setUsage(null)
      })
    return () => {
      alive = false
    }
  }, [token])
```
Render a card inside the harness `<section>` (e.g. above the Logout button):
```tsx
          <div className="rounded-lg border bg-gray-50 p-3">
            <div className="text-xs font-medium text-gray-500">การใช้ token รวมทั้งหมด</div>
            {usage ? (
              <div className="mt-1 font-mono text-sm text-gray-700">
                ↑ {usage.inputTokens.toLocaleString()} &nbsp; ↓ {usage.outputTokens.toLocaleString()} &nbsp;·&nbsp; รวม{' '}
                {(usage.inputTokens + usage.outputTokens).toLocaleString()}
              </div>
            ) : (
              <div className="mt-1 text-sm text-gray-500">—</div>
            )}
          </div>
```

- [ ] **Step 2: Verify types + build**

Run: `npx tsc --noEmit -p web/tsconfig.json && npm run build:web`
Expected: tsc exit 0; build succeeds.

- [ ] **Step 3: Commit**

```bash
git add web/src/components/Settings.tsx
git commit -m "feat(web): show total token usage in Settings

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Provider error `status` uniformity

**Files:**
- Modify: `server/providers/types.ts` (add `ProviderHttpError`)
- Modify: `server/providers/openaiCompat.ts` (throw it)
- Modify: `server/providers/anthropicApi.ts` (`maxRetries: 0`)
- Modify: `server/providers/localAgent.ts` (attach `api_error_status` as `.status`)
- Test: `server/providers/openaiCompat.test.ts`, `server/providers/anthropicApi.test.ts`, `server/providers/localAgent.test.ts`

**Interfaces:**
- Produces: `class ProviderHttpError extends Error { readonly status: number }` (in `providers/types.ts`).

- [ ] **Step 1: Add `ProviderHttpError`** to `server/providers/types.ts`:

```ts
// Thrown by HTTP-based providers so the retry layer can classify transient (5xx/429) failures
// by status without parsing message strings.
export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ProviderHttpError'
  }
}
```

- [ ] **Step 2: openaiCompat — failing test** in `server/providers/openaiCompat.test.ts`:

```ts
import { OpenAICompatibleProvider, parseSseData } from './openaiCompat'
import { ProviderHttpError } from './types'

it('throws a ProviderHttpError carrying the upstream status on a non-ok response', async () => {
  const provider = new OpenAICompatibleProvider({
    baseUrl: 'https://x/v1',
    defaultModel: 'm',
    fetchFn: async () => ({ ok: false, status: 503, body: null }),
  })
  const ctx = {
    onDelta: () => {},
    onToolCall: () => {},
    onToolResult: () => {},
    permission: { resolve: async () => ({ behavior: 'allow' as const }) },
    signal: new AbortController().signal,
  }
  await expect(provider.send({ userText: 'hi', history: [] } as never, ctx as never)).rejects.toMatchObject({
    status: 503,
  })
})
```
(Match the existing import style of `openaiCompat.test.ts`; it already constructs the provider with an injected `fetchFn`.)

- [ ] **Step 3: openaiCompat — implement.** In `server/providers/openaiCompat.ts`, import `ProviderHttpError` from `./types` and replace the throw at the `!res.ok` check:
```ts
      if (!res.ok) throw new ProviderHttpError(res.status, `OpenAI-compatible request failed: HTTP ${res.status}`)
```

- [ ] **Step 4: anthropic — failing test** in `server/providers/anthropicApi.test.ts` (in the `makeAnthropicClient` describe):
```ts
  it('disables the SDK built-in retries so the turn-level retry is the single authority', () => {
    expect(makeAnthropicClient({ apiKey: 'sk' }).maxRetries).toBe(0)
  })
```

- [ ] **Step 5: anthropic — implement.** In `makeAnthropicClient` (`server/providers/anthropicApi.ts`) pass `maxRetries: 0`:
```ts
  return new Anthropic({ apiKey: opts.apiKey, maxRetries: 0, ...(baseURL ? { baseURL } : {}) })
```

- [ ] **Step 6: localAgent — failing test** in `server/providers/localAgent.test.ts` (match the file's existing fake-`queryFn` pattern that yields a `result` message). Yield `{ type: 'result', subtype: 'success', is_error: true, api_error_status: 529, result: 'API Error: 529 Overloaded' }` and assert:
```ts
  it('attaches api_error_status as .status when the agent result is an API error', async () => {
    // ...build the provider with a queryFn yielding the is_error result above, then:
    await expect(provider.send(params, ctx)).rejects.toMatchObject({ status: 529 })
  })
```

- [ ] **Step 7: localAgent — implement.** In `server/providers/localAgent.ts`, replace the `else` throw in the `result` case (currently `throw new Error(...)`) with:
```ts
            } else {
              const detail = msg.is_error && typeof msg.result === 'string' ? msg.result : msg.subtype
              const e = new Error(`local-agent turn failed: ${detail}`)
              if (typeof msg.api_error_status === 'number') (e as { status?: number }).status = msg.api_error_status
              throw e
            }
```

- [ ] **Step 8: Run the provider tests**

Run: `npx vitest run server/providers/`
Expected: PASS (the 3 new tests + all existing provider tests).

- [ ] **Step 9: Commit**

```bash
git add server/providers/types.ts server/providers/openaiCompat.ts server/providers/openaiCompat.test.ts server/providers/anthropicApi.ts server/providers/anthropicApi.test.ts server/providers/localAgent.ts server/providers/localAgent.test.ts
git commit -m "feat(providers): give provider errors a numeric .status for retry classification

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: `server/retry.ts` — `isTransientError` + `sendWithRetry`

**Files:**
- Create: `server/retry.ts`
- Test: `server/retry.test.ts`

**Interfaces:**
- Consumes: `Provider`, `ProviderContext`, `TurnParams`, `TurnResult` from `./providers/types`.
- Produces: `isTransientError(err: unknown): boolean`; `sendWithRetry(provider, params, ctx, opts): Promise<TurnResult>` where `opts: { getEmitted: () => boolean; signal: AbortSignal; maxRetries?: number; sleep?: (ms: number, signal: AbortSignal) => Promise<void> }`.

- [ ] **Step 1: Write the failing tests** — `server/retry.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { isTransientError, sendWithRetry } from './retry'
import { ProviderHttpError } from './providers/types'
import type { Provider, ProviderContext, TurnResult } from './providers/types'

const ctx = (): ProviderContext => ({
  onDelta: () => {},
  onToolCall: () => {},
  onToolResult: () => {},
  permission: { resolve: async () => ({ behavior: 'allow' }) },
  signal: new AbortController().signal,
})
const noDelay = async () => {}

describe('isTransientError', () => {
  it('treats 429 and 5xx as transient', () => {
    for (const s of [429, 500, 502, 503, 504]) expect(isTransientError(new ProviderHttpError(s, 'x'))).toBe(true)
  })
  it('treats 4xx (except 429) as permanent', () => {
    for (const s of [400, 401, 403, 404, 409]) expect(isTransientError(new ProviderHttpError(s, 'x'))).toBe(false)
  })
  it('treats a network/connection error as transient', () => {
    expect(isTransientError(new TypeError('fetch failed'))).toBe(true)
    expect(isTransientError(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(true)
  })
  it('treats an unknown error as permanent', () => {
    expect(isTransientError(new Error('boom'))).toBe(false)
  })
})

describe('sendWithRetry', () => {
  function provider(send: Provider['send']): Provider {
    return { type: 'openai-compatible', send } as Provider
  }
  it('retries a transient error (no delta yet) then succeeds', async () => {
    let calls = 0
    const p = provider(async () => {
      calls++
      if (calls < 3) throw new ProviderHttpError(503, 'down')
      return { text: 'ok' } as TurnResult
    })
    const result = await sendWithRetry(p, {} as never, ctx(), { getEmitted: () => false, signal: new AbortController().signal, sleep: noDelay })
    expect(result.text).toBe('ok')
    expect(calls).toBe(3)
  })
  it('does NOT retry once a delta has streamed', async () => {
    let calls = 0
    const p = provider(async () => {
      calls++
      throw new ProviderHttpError(503, 'down')
    })
    await expect(
      sendWithRetry(p, {} as never, ctx(), { getEmitted: () => true, signal: new AbortController().signal, sleep: noDelay }),
    ).rejects.toMatchObject({ status: 503 })
    expect(calls).toBe(1)
  })
  it('does NOT retry a permanent error', async () => {
    let calls = 0
    const p = provider(async () => {
      calls++
      throw new ProviderHttpError(409, 'conflict')
    })
    await expect(
      sendWithRetry(p, {} as never, ctx(), { getEmitted: () => false, signal: new AbortController().signal, sleep: noDelay }),
    ).rejects.toMatchObject({ status: 409 })
    expect(calls).toBe(1)
  })
  it('gives up after maxRetries and rethrows the last error', async () => {
    let calls = 0
    const p = provider(async () => {
      calls++
      throw new ProviderHttpError(503, 'down')
    })
    await expect(
      sendWithRetry(p, {} as never, ctx(), { getEmitted: () => false, signal: new AbortController().signal, maxRetries: 3, sleep: noDelay }),
    ).rejects.toMatchObject({ status: 503 })
    expect(calls).toBe(4) // 1 initial + 3 retries
  })
  it('stops retrying when the signal aborts during backoff', async () => {
    const ac = new AbortController()
    let calls = 0
    const p = provider(async () => {
      calls++
      throw new ProviderHttpError(503, 'down')
    })
    const sleep = async () => {
      ac.abort()
    }
    await expect(
      sendWithRetry(p, {} as never, ctx(), { getEmitted: () => false, signal: ac.signal, sleep }),
    ).rejects.toMatchObject({ status: 503 })
    expect(calls).toBe(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/retry.test.ts`
Expected: FAIL — module `./retry` not found.

- [ ] **Step 3: Write the implementation** — `server/retry.ts`:

```ts
import type { Provider, ProviderContext, TurnParams, TurnResult } from './providers/types'

const NETWORK_ERROR_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'])

function errorStatus(err: unknown): number | undefined {
  const s = (err as { status?: unknown } | null)?.status
  return typeof s === 'number' ? s : undefined
}

function isNetworkError(err: unknown): boolean {
  if (err instanceof TypeError) return true // fetch() network failure
  const name = (err as { name?: unknown } | null)?.name
  if (typeof name === 'string' && /Connection|Timeout/i.test(name)) return true
  const code = (err as { code?: unknown } | null)?.code ?? (err as { cause?: { code?: unknown } } | null)?.cause?.code
  return typeof code === 'string' && NETWORK_ERROR_CODES.has(code)
}

// Transient = worth retrying: HTTP 429 / 5xx, or a network/connection failure. Everything else
// (4xx config errors, parse/unknown errors) is permanent and surfaces immediately.
export function isTransientError(err: unknown): boolean {
  const status = errorStatus(err)
  if (status !== undefined) return status === 429 || (status >= 500 && status <= 599)
  return isNetworkError(err)
}

export type RetryOpts = {
  getEmitted: () => boolean
  signal: AbortSignal
  maxRetries?: number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const done = () => {
      signal.removeEventListener('abort', done)
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })

// Re-run provider.send up to maxRetries times, but ONLY for a transient error that occurred before
// any output streamed (getEmitted() === false) and while the turn is not aborted. Backoff is
// exponential (1s, 2s, 4s). Retrying after partial output would duplicate text, so it is excluded.
export async function sendWithRetry(
  provider: Provider,
  params: TurnParams,
  ctx: ProviderContext,
  opts: RetryOpts,
): Promise<TurnResult> {
  const maxRetries = opts.maxRetries ?? 3
  const sleep = opts.sleep ?? defaultSleep
  for (let attempt = 0; ; attempt++) {
    try {
      return await provider.send(params, ctx)
    } catch (err) {
      const canRetry = attempt < maxRetries && !opts.getEmitted() && !opts.signal.aborted && isTransientError(err)
      if (!canRetry) throw err
      await sleep(1000 * 2 ** attempt, opts.signal)
      if (opts.signal.aborted) throw err
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/retry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/retry.ts server/retry.test.ts
git commit -m "feat(server): sendWithRetry — transient, before-first-token turn retry

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: Wire `sendWithRetry` into `runTurn`

**Files:**
- Modify: `server/agent.ts`
- Test: the full server suite must stay green (the happy path + error→`turn_done` path are unchanged in shape).

**Interfaces:**
- Consumes: `sendWithRetry` (Task 8). `runTurn`'s local `emitted` flag (set in `ctx.onDelta`) is the `getEmitted` source.

- [ ] **Step 1: Modify `server/agent.ts`**

Add the import:
```ts
import { sendWithRetry } from './retry'
```
Replace the `provider.send(params, ctx)` argument inside the `Promise.race` with the retry wrapper:
```ts
    const raced = await Promise.race([
      sendWithRetry(provider, params, ctx, { getEmitted: () => emitted, signal: deps.signal }),
      timeoutPromise,
    ])
```
Everything else in `runTurn` is unchanged (the `!emitted && result.text` fallback, the `turn_done` with `result.usage`, the `catch` → `error` + `turn_done`).

- [ ] **Step 2: Run the full suite to verify nothing regressed**

Run: `npx vitest run`
Expected: PASS — all tests green (the existing agent/chatRuntime/provider tests pass unchanged; a non-failing provider runs exactly once, so the happy path is identical).

- [ ] **Step 3: Typecheck + build**

Run: `npx tsc --noEmit && npx tsc --noEmit -p web/tsconfig.json && npm run build:web`
Expected: both tsc exit 0; build succeeds.

- [ ] **Step 4: Commit**

```bash
git add server/agent.ts
git commit -m "feat(server): retry transient turn failures before the first token in runTurn

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification (after Task 9)

- [ ] `npx vitest run` — all green (≈ 357 + the new tests).
- [ ] `npx tsc --noEmit` — exit 0.
- [ ] `npx tsc --noEmit -p web/tsconfig.json` — exit 0.
- [ ] `npm run build:web` — succeeds.
- [ ] Live smoke (optional, follows the project's run pattern): start the server, send a turn — typing indicator shows before the first token, the per-turn token line appears under the answer, Settings shows the running total; an `anthropic-api`/`openai-compatible` connection pointed at a momentarily-down gateway recovers within the 3 retries instead of erroring on the first 503.

Then run the close-out ceremony: gates → `9arm:scrutinize` → opus whole-branch review → `--no-ff` merge to master (branch retained).
