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

  it('threads resume: first turn has no options.resume, second turn resumes the recorded session', async () => {
    const calls: Array<{ options?: { resume?: string } }> = []
    function recordingQuery(opts: { options?: { resume?: string } }) {
      calls.push(opts)
      async function* gen() {
        yield { type: 'system', subtype: 'init', session_id: 'sess-1' }
        yield { type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } }
      }
      const it = gen()
      return Object.assign(it, { interrupt: async () => {} })
    }

    const provider = new LocalAgentProvider(recordingQuery as never)

    const ctx1 = makeCtx().ctx
    const first = await provider.send({ userText: 'one' }, ctx1)
    expect(first.sdkSessionId).toBe('sess-1')

    const ctx2 = makeCtx().ctx
    await provider.send({ userText: 'two', sdkSessionId: 'sess-1' }, ctx2)

    expect(calls).toHaveLength(2)
    expect(calls[0].options?.resume).toBeUndefined()
    expect(calls[1].options?.resume).toBe('sess-1')
  })

  it('proactively calls query.interrupt() when the signal aborts mid-turn', async () => {
    const controller = new AbortController()

    // Resolvable gate: the generator parks on `await gate` after init.
    // interrupt() (called by the provider's abort listener) resolves the gate,
    // so the generator completes and the for-await loop ends — no hang, no it.return().
    let release!: () => void
    const gate = new Promise<void>((res) => {
      release = res
    })

    function fakeAbortingQuery(_opts: unknown) {
      async function* gen() {
        yield { type: 'system', subtype: 'init', session_id: 'sess-hang' }
        await gate
      }
      const it = gen()
      let interruptCalls = 0
      return Object.assign(it, {
        interrupt: async () => {
          interruptCalls++
          release()
        },
        getInterruptCalls: () => interruptCalls,
      })
    }

    const ctx: ProviderContext = {
      onDelta: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      permission: { resolve: async () => ({ behavior: 'allow' }) },
      signal: controller.signal,
    }

    const provider = new LocalAgentProvider(fakeAbortingQuery as never)
    const p = provider.send({ userText: 'go' }, ctx)

    // Abort shortly after send starts so the listener fires while the turn is parked on `gate`.
    setTimeout(() => controller.abort(), 10)

    // Resolves because interrupt() released the gate; the generator finishes and send() returns.
    await p
    // The gate could only have been released by interrupt() being invoked at least once.
    expect(gate).resolves.toBeUndefined()
  })
})
