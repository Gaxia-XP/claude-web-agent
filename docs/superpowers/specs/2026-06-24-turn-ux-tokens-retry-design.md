# Turn UX — typing indicator, per-turn + total token usage, transient auto-retry

**Date:** 2026-06-24 · **Branch:** `feat/turn-ux` (off master `5b462a2`)

Four small, mostly-independent additions to the chat turn experience. Token data already
flows end-to-end (no schema/protocol change); the typing indicator is pure frontend; only the
retry feature adds real server logic.

## Goals

1. **Typing indicator** — an animated "•••" while a turn is in flight before the assistant produces output.
2. **Per-turn token usage** — input/output token counts shown under each assistant message.
3. **Total token usage** — a cumulative summary in Settings.
4. **Transient auto-retry** — automatically retry a failing turn up to 3 times (transient errors only, before the first token) before surfacing an error.

## Non-goals

- USD cost display (providers populate only input/output tokens; `costUsd` stays unused).
- Per-model / per-connection token breakdown (grand total only).
- Retrying after partial output, or retrying permanent (4xx except 429) errors.
- Any persistence-schema change (usage is already stored per message).

## Existing data the token features build on (verified)

- `turn_done` ServerMsg already carries `usage?: Usage` where `Usage = { inputTokens?, outputTokens?, costUsd? }` — `shared/protocol.ts:73,2`. `runTurn` already emits it: `deps.send({ type: 'turn_done', chatId, usage: result.usage })` — `server/agent.ts:52`.
- The `messages` table already has a `usage TEXT` column; `StoredMessage.usage` round-trips (`store.ts:49,270,306`).

So per-turn and total usage **surface / aggregate existing data**; no new wire field, no migration.

---

## Feature 1 — Typing indicator (frontend only)

**Component:** new `web/src/components/TypingIndicator.tsx` — a left-aligned assistant-style bubble (`bg-gray-100`, `rounded-2xl`, same geometry as an assistant `Message`) containing three dots.

**Trigger (App.tsx render):** show it when the active view is `streaming === true` **and** the assistant has not produced output for this turn yet — i.e. the last message in `view.messages` is the user's (or the list is empty). Rationale: the assistant bubble is created lazily on the first `assistant_delta` / `tool_call` via `ensureAssistant` (`appState.ts:50`), so the gap between sending and the first token is exactly "streaming && last message is `user`". Once any delta/tool arrives, the real assistant bubble renders and the indicator is gone. The indicator also stays visible across auto-retries (Feature 4 keeps `streaming` true and emits no deltas while retrying).

Helper (pure, in `appState.ts` so it is unit-testable): `awaitingFirstToken(view): boolean` = `view.streaming && (last message is undefined or role === 'user')`.

**Motion:** three dots with a staggered opacity pulse via a CSS `@keyframes` added to `index.css` (the project's only stylesheet). Animation lives in the 150–250ms band feel. `@media (prefers-reduced-motion: reduce)` → no animation (static dots at a fixed opacity). Matches DESIGN.md's "Earned/honored reduced-motion" rule.

**Tests:** `awaitingFirstToken` unit tests in `appState.test.ts` (streaming+user → true; streaming+assistant-with-text → false; not-streaming → false; empty+streaming → true). The component itself is verified by build + live run (no component-test harness in the suite).

---

## Feature 2 — Per-turn token usage (frontend only)

**Data model:** extend the assistant `UiMessage` variant with `usage?: Usage` (`appState.ts:12`).

**Live path:** `reduceView`'s `turn_done` case (`appState.ts:82`) currently only sets `streaming:false`. Also attach `msg.usage` to the **last assistant message** when present (find last assistant message; if found, set its `usage`). If the turn produced no assistant message (e.g. tool-only then error), nothing to attach.

**History path:** `historyToView` (`appState.ts:99`) builds an assistant `UiMessage` from a `StoredMessage`; also copy `m.usage` onto it.

**Render:** `Message.tsx` — for an assistant message whose `usage` has any token field, render a small muted line beneath the markdown: `↑ {inputTokens ?? '–'}  ↓ {outputTokens ?? '–'}` at `text-xs text-gray-500` (AA-compliant, ≥12px per DESIGN.md's floor). Omit entirely when usage is absent or has no token fields.

**Tests:** `appState.test.ts` — `turn_done` with usage attaches it to the assistant message; `historyToView` carries `StoredMessage.usage` through. Render verified by build + live run.

---

## Feature 3 — Total token usage in Settings (server + frontend)

**Store helper:** `totalUsage(db): { inputTokens: number; outputTokens: number }` in `store.ts`. Implementation: select the non-null `usage` JSON rows (`SELECT usage FROM messages WHERE usage IS NOT NULL`), `JSON.parse` each (guarding unparseable rows exactly like `listMessages` does), and sum `inputTokens` / `outputTokens` (treat missing as 0). Summing in JS over the (small, single-user-local) message set is fine; if volume ever matters, promote to numeric columns later (YAGNI now).

**Endpoint:** `GET /api/usage` in `server/http-api.ts` → `{ inputTokens, outputTokens }`. Token-guarded by the existing global `onRequest` hook (only `GET /api/health` is exempt) — no per-route auth code needed.

**UI:** the Settings harness panel gains a small card "การใช้ token รวม" showing `↑ {in}  ↓ {out}  ·  รวม {in+out}` formatted with `toLocaleString()`. Fetched in a `useEffect` via `apiFetch('/api/usage', token)` (mirrors the existing `/api/lan-urls` and `/v1/models` fetches in `Settings.tsx`); on failure show a muted `gray-500` placeholder. Not auto-refreshing (fetched on Settings open) — acceptable for a usage summary.

**Tests:** `store.test.ts` — `totalUsage` sums across messages, ignores null/unparseable usage, missing token fields count as 0. `http-api.test.ts` — `GET /api/usage` returns the summed object and is token-guarded. UI verified by build + live run.

---

## Feature 4 — Transient auto-retry (server)

**Where:** `runTurn` (`server/agent.ts:18`). It already (a) tracks whether output streamed via the local `emitted` flag (set in `ctx.onDelta`, `:24`) and (b) calls `provider.send(params, ctx)` inside a `Promise.race` with the turn-timeout. The retry wraps that `provider.send` call; `emitted` is exactly the "before the first token" signal.

**Retry policy:**
- **maxRetries = 3** (up to 4 total attempts).
- **Backoff before each retry:** 1s, 2s, 4s (`1000 * 2^attemptIndex`). Worst-case added latency ≈ 7s, well under the 600s turn timeout.
- Retry fires **only when ALL hold:** the error is transient, `emitted === false` (no delta streamed yet), the turn is not aborted (`signal.aborted === false`), and attempts remain. Otherwise the error propagates to `runTurn`'s existing `catch` (→ `error` + `turn_done` ServerMsgs, unchanged).
- The whole retry loop stays **inside** the existing timeout race, so all attempts + backoffs are bounded by `turnTimeoutMs`. Backoff sleep is **abortable** via `signal` (an interrupt during a wait stops retrying immediately).
- During retries `streaming` stays true and no deltas are sent → the UI shows the Feature-1 typing indicator the whole time. On a retry success the turn streams normally; on exhaustion the last error surfaces.

**Transient classification** — `isTransientError(err): boolean` (pure, unit-tested), in a new `server/retry.ts`:
- If the error carries a numeric `status`: transient iff `status === 429 || (status >= 500 && status <= 599)`. (`400/401/403/404/409` → not transient — covers the maxplus Auto-list 409, a wrong key 401, an unknown model 404.)
- Else if it is a network/connection error (Anthropic `APIConnectionError` / `APIConnectionTimeoutError` by `name`; a `fetch` `TypeError`; a Node cause `code` in `{ECONNRESET, ECONNREFUSED, ETIMEDOUT, ENOTFOUND, EAI_AGAIN}`) → transient.
- Otherwise → **not** transient (unknown/bug errors are not retried).

**Uniform error `status` across providers** (so classification is not string-parsing):
- `anthropic-api`: the SDK throws `Anthropic.APIError` which already exposes `.status`. **Also set `maxRetries: 0`** in `makeAnthropicClient` so the SDK's built-in retries don't stack on top of ours (the wrapper becomes the single retry authority).
- `openai-compatible`: `openaiCompat.ts` currently throws `new Error('OpenAI-compatible request failed: HTTP <status>')` with no status property. Refactor to throw a `ProviderHttpError` (new tiny class in `server/providers/types.ts`: `class ProviderHttpError extends Error { constructor(readonly status: number, message: string) }`) carrying the numeric status. Message text is unchanged so the UI error string is stable.
- `local-agent`: best-effort — when the agent result is an API error with `api_error_status` (e.g. 529 overload), attach that as `.status` on the thrown error so overloads are retried; otherwise the error is treated as non-transient. (No agent-SDK retry knob is touched.)

**Retry helper** (testable): `sendWithRetry(provider, params, ctx, opts): Promise<TurnResult>` where `opts = { getEmitted: () => boolean; signal: AbortSignal; maxRetries?: number; sleep?: (ms: number, signal: AbortSignal) => Promise<void> }`. `runTurn` calls `Promise.race([sendWithRetry(provider, params, ctx, { getEmitted: () => emitted, signal: deps.signal }), timeoutPromise])`. `sleep` defaults to a real abortable timer but is injectable so tests run with zero delay.

**Tests:**
- `isTransientError`: status 429/500/502/503/504 → true; 400/401/403/404/409 → false; `ProviderHttpError(503)` → true; an Anthropic-style `{status:503}` → true; a network/connection error → true; a bare `Error('boom')` → false.
- `sendWithRetry`: a fake provider that throws a transient error N times then resolves → retried and eventually succeeds (assert call count, injected zero-delay sleep); a fake that streams a delta (calls `ctx.onDelta`) then throws transient → **not** retried (emitted guard); a permanent error → not retried; exhausts `maxRetries` then rethrows the last error; aborting the signal during a backoff stops further attempts.
- Existing `agent`/`chatRuntime`/provider tests stay green (the happy path and the error→`turn_done` path are unchanged in shape).

---

## Error handling summary

| Situation | Behavior |
| --- | --- |
| Permanent error (4xx≠429, parse, unknown) | surfaced immediately (no retry), unchanged |
| Transient error, no delta yet, attempts remain | wait backoff, retry (typing indicator stays) |
| Transient error, attempts exhausted | last error surfaced via existing `error`+`turn_done` path |
| Error after a delta already streamed | surfaced immediately (no retry — avoids duplicate output) |
| Interrupt during a turn or backoff | stop immediately; existing interrupt/settle path |

## Build order

1. **Feature 1 + 2** (frontend, no server) — typing indicator + per-turn tokens.
2. **Feature 3** (server endpoint + Settings card) — total tokens.
3. **Feature 4** (server retry) — most logic; landed last.

Each lands TDD-first, then the project close-out ceremony (gates → `9arm:scrutinize` → opus whole-branch review → `--no-ff` merge).

## Open decisions (resolved with the user)

- Retry: **transient-only**, **before the first token only**, **3 retries**, backoff **1s/2s/4s**.
- Total tokens: **grand total** (input + output), across all chats.
- Typing indicator: **animated dots** with a `prefers-reduced-motion` static fallback.
