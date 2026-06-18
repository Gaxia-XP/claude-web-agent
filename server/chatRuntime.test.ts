import { describe, it, expect } from 'vitest'
import type { ServerMsg } from '../shared/protocol'
import type { Provider, ProviderContext, TurnParams, TurnResult } from './providers/types'
import type { PermissionDecision } from './permission'
import { openDb, createChat, listMessages, getChatSdkSession, setChatSdkSession, deleteChat, DEFAULT_CONNECTION_ID } from './store'
import { FakeProvider } from './providers/fake'
import { ChatRuntime, type RuntimeDeps } from './chatRuntime'

// Sleep for `ms` real milliseconds (gives event loop time to fire timers).
async function tick(ms = 5): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, ms))
}

// Find the requestId of the most recent permission_request in `sent`.
function lastPermissionRequestId(sent: ServerMsg[]): string | undefined {
  for (let i = sent.length - 1; i >= 0; i--) {
    const m = sent[i]
    if (m.type === 'permission_request') return m.requestId
  }
  return undefined
}

// Count broadcast messages of a given type.
function countType(sent: ServerMsg[], type: ServerMsg['type']): number {
  return sent.filter((m) => m.type === type).length
}

function makeDeps(overrides: Partial<RuntimeDeps> = {}): { deps: RuntimeDeps; sent: ServerMsg[] } {
  const db = openDb(':memory:')
  createChat(db, {
    id: 'c1',
    title: 'Test chat',
    connectionId: DEFAULT_CONNECTION_ID,
    model: 'sonnet',
    cwd: '/work',
    now: 1000,
  })
  const sent: ServerMsg[] = []
  let idN = 0
  let nowN = 2000
  const deps: RuntimeDeps = {
    db,
    provider: new FakeProvider(),
    broadcast: (m) => sent.push(m),
    genId: () => `id${++idN}`,
    now: () => ++nowN,
    ...overrides,
  }
  return { deps, sent }
}

describe('ChatRuntime', () => {
  it('(a) persists user + assistant messages, usage, and sdk session after one turn', async () => {
    const { deps, sent } = makeDeps()
    const rt = new ChatRuntime('c1', deps)

    rt.enqueue('hi')
    await tick()
    // FakeProvider parked on a Write permission request -> answer it.
    const reqId = lastPermissionRequestId(sent)
    expect(reqId).toBeDefined()
    rt.handlePermissionResponse(reqId!, 'allow')
    await tick()

    const msgs = listMessages(deps.db, 'c1')
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant'])

    const user = msgs[0]
    expect(user.content).toEqual([{ type: 'text', text: 'hi' }])

    const asst = msgs[1]
    // ONE assistant row: text block (accumulated from onDelta deltas) + tool_use + tool_result blocks
    expect(asst.content).toEqual([
      { type: 'text', text: 'Hello hi' },
      { type: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/tmp/x' } },
      { type: 'tool_result', id: 't1', result: 'written' },
    ])
    expect(asst.usage).toEqual({ outputTokens: 3 })

    expect(getChatSdkSession(deps.db, 'c1')).toBe('sess-1')
    expect(rt.isIdle).toBe(true)
  })

  it('(b) serializes two enqueued turns one at a time, persisting both in order', async () => {
    const { deps, sent } = makeDeps()
    const rt = new ChatRuntime('c1', deps)

    rt.enqueue('first')
    rt.enqueue('second')
    await tick()

    // First turn parks; only one turn may be running at a time -> exactly one open request.
    expect(countType(sent, 'permission_request')).toBe(1)
    rt.handlePermissionResponse(lastPermissionRequestId(sent)!, 'allow')
    await tick()

    // Now the second turn runs and parks on its own request.
    expect(countType(sent, 'permission_request')).toBe(2)
    rt.handlePermissionResponse(lastPermissionRequestId(sent)!, 'allow')
    await tick(20)

    const msgs = listMessages(deps.db, 'c1')
    // Both user messages are eagerly persisted at enqueue time (before turns run),
    // so ordering by created_at gives: user(first), user(second), assistant(first), assistant(second).
    expect(msgs.map((m) => m.role)).toEqual(['user', 'user', 'assistant', 'assistant'])
    expect(msgs[0].content).toEqual([{ type: 'text', text: 'first' }])
    expect(msgs[1].content).toEqual([{ type: 'text', text: 'second' }])
    expect(msgs[2].content[0]).toEqual({ type: 'text', text: 'Hello first' })
    expect(msgs[3].content[0]).toEqual({ type: 'text', text: 'Hello second' })
    expect(rt.isIdle).toBe(true)
  })

  it('(c) carries sdkSessionId from the first turn into the second turn', async () => {
    // Recording provider: captures params.sdkSessionId per call; returns "s1" the first time.
    const seen: Array<string | undefined> = []
    let call = 0
    const recProvider: Provider = {
      type: 'rec',
      async send(params: TurnParams, ctx: ProviderContext): Promise<TurnResult> {
        seen.push(params.sdkSessionId)
        call++
        ctx.onDelta('ok')
        return { text: 'ok', sdkSessionId: call === 1 ? 's1' : 's2' }
      },
    }
    const { deps } = makeDeps({ provider: recProvider })
    const rt = new ChatRuntime('c1', deps)

    rt.enqueue('one')
    await tick()
    rt.enqueue('two')
    await tick()

    expect(seen).toEqual([undefined, 's1'])
    expect(getChatSdkSession(deps.db, 'c1')).toBe('s2')
    expect(rt.isIdle).toBe(true)
  })

  it('(d) #6b interrupt while parked: parked turn finishes (turn_done); queued user row is durable but its turn never runs', async () => {
    const { deps, sent } = makeDeps()
    const rt = new ChatRuntime('c1', deps)

    rt.enqueue('first')
    rt.enqueue('second')
    await tick()

    // First turn parked on permission; exactly one request so far.
    expect(countType(sent, 'permission_request')).toBe(1)

    rt.interrupt()
    await tick()

    // Parked turn unblocks (permission denied via cancelAll) and emits turn_done.
    expect(countType(sent, 'turn_done')).toBe(1)
    // The queued 'second' was cleared (#6b): no new permission_request was ever emitted.
    expect(countType(sent, 'permission_request')).toBe(1)

    // enqueue() persists the user message to the DB IMMEDIATELY (before queueing), so BOTH
    // user rows are durably persisted: 'first' (whose turn ran -> assistant) AND 'second'
    // (whose turn was cancelled by interrupt and never ran -> no assistant row for it).
    // interrupt() only clears the IN-MEMORY queue; it does NOT delete persisted rows.
    const msgs = listMessages(deps.db, 'c1')
    expect(msgs.map((m) => m.role)).toEqual(['user', 'user', 'assistant'])
    expect(msgs[0].content).toEqual([{ type: 'text', text: 'first' }])
    expect(msgs[1].content).toEqual([{ type: 'text', text: 'second' }])
    expect(msgs[2].role).toBe('assistant')
    expect(rt.isIdle).toBe(true)
  })

  it('(e) dispose() while parked unblocks the turn with turn_done', async () => {
    const { deps, sent } = makeDeps()
    const rt = new ChatRuntime('c1', deps)

    rt.enqueue('hi')
    await tick()
    expect(countType(sent, 'permission_request')).toBe(1)

    rt.dispose()
    await tick()

    expect(countType(sent, 'turn_done')).toBe(1)
  })

  // ── regression: fix #1 ────────────────────────────────────────────────────
  it('(f) #1: dispose() mid-turn skips persist (no FK error; no assistant row)', async () => {
    // Use a provider that deliberately delays resolution until we dispose() first.
    // We achieve this by capturing the resolve callback via a holder object.
    const holder: { release: (() => void) | undefined } = { release: undefined }
    const delayedProvider: Provider = {
      type: 'delayed',
      async send(_params: TurnParams, ctx: ProviderContext): Promise<TurnResult> {
        ctx.onDelta('answer')
        // Park until the test releases us
        await new Promise<void>((resolve) => { holder.release = resolve })
        return { text: 'answer', sdkSessionId: 'sess-x' }
      },
    }

    const { deps } = makeDeps({ provider: delayedProvider })
    const rt = new ChatRuntime('c1', deps)

    rt.enqueue('hi')
    // Let the turn start (it is now parked inside delayedProvider.send)
    await tick()

    // Delete the chat from the DB then dispose the runtime (mirrors hub delete_chat)
    deleteChat(deps.db, 'c1')
    rt.dispose()

    // Now unblock the provider so runTurn resolves
    holder.release?.()
    await tick(20)

    // The disposed guard must have fired — appendMessage was skipped, so no
    // assistant row. (The chat row is gone, so attempting INSERT would have
    // thrown a FK constraint error otherwise.)
    const msgs = listMessages(deps.db, 'c1')
    // user message was persisted eagerly at enqueue, but no assistant row
    expect(msgs.filter((m) => m.role === 'assistant')).toHaveLength(0)
  })

  // ── regression: fix #5 ────────────────────────────────────────────────────
  it('(g) #5: onActivity is called after a completed turn (not when disposed)', async () => {
    let activityCount = 0
    const immediateProvider: Provider = {
      type: 'immediate',
      async send(params: TurnParams, ctx: ProviderContext): Promise<TurnResult> {
        ctx.onDelta('hi')
        return { text: 'hi', sdkSessionId: 'sess-z' }
      },
    }
    const { deps } = makeDeps({
      provider: immediateProvider,
      onActivity: () => { activityCount++ },
    })
    const rt = new ChatRuntime('c1', deps)

    rt.enqueue('hello')
    await tick(20)

    expect(activityCount).toBe(1)
  })

  // ── M3 MAJOR#1 fixes ──────────────────────────────────────────────────────
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
      async send(_p: TurnParams, ctx: ProviderContext): Promise<TurnResult> {
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
      async send(_p: TurnParams, _ctx: ProviderContext): Promise<TurnResult> {
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

  it('(k-scrut-m2) a turn that streams partial text THEN throws persists both text and error blocks', async () => {
    const errMsg = 'mid-stream failure'
    const partialThenThrow: Provider = {
      type: 'partial-then-throw',
      async send(_p: TurnParams, ctx: ProviderContext): Promise<TurnResult> {
        ctx.onDelta('partial')
        throw new Error(errMsg)
      },
    }
    const { deps, sent } = makeDeps({ provider: partialThenThrow })
    const rt = new ChatRuntime('c1', deps)
    rt.enqueue('hi')
    await tick(20)
    // error + turn_done emitted to live view
    expect(countType(sent, 'error')).toBe(1)
    expect(countType(sent, 'turn_done')).toBe(1)
    // persisted assistant row must have BOTH the partial text AND the error block
    const msgs = listMessages(deps.db, 'c1')
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(msgs[1].content).toEqual([
      { type: 'text', text: 'partial' },
      { type: 'error', message: errMsg },
    ])
  })

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
})
