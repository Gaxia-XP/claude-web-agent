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

  it('throws when result subtype is not success (e.g. error_max_turns)', async () => {
    function failQuery(_opts: unknown) {
      async function* gen() {
        yield { type: 'system', subtype: 'init', session_id: 'sess-fail' }
        yield { type: 'result', subtype: 'error_max_turns' }
      }
      return Object.assign(gen(), { interrupt: async () => {} })
    }
    const { ctx } = makeCtx()
    const provider = new LocalAgentProvider(failQuery as never)
    await expect(provider.send({ userText: 'x' }, ctx)).rejects.toThrow(/error_max_turns/)
  })

  // The SDK reports API failures with is_error:true even though subtype stays 'success'
  // (e.g. {subtype:'success', is_error:true, api_error_status:529, result:'API Error: 529 ...'}).
  // Such a result must NOT be returned as the assistant's answer — it must throw so runTurn
  // surfaces a real error instead of empty/garbage content.
  it('throws on an is_error result even when subtype is "success" (API error)', async () => {
    function apiErrorQuery(_opts: unknown) {
      async function* gen() {
        yield { type: 'system', subtype: 'init', session_id: 'sess-err' }
        yield {
          type: 'result',
          subtype: 'success',
          is_error: true,
          api_error_status: 529,
          result: 'API Error: 529 Overloaded. This is a server-side issue, usually temporary.',
        }
      }
      return Object.assign(gen(), { interrupt: async () => {} })
    }
    const { ctx } = makeCtx()
    const provider = new LocalAgentProvider(apiErrorQuery as never)
    const p = provider.send({ userText: 'x' }, ctx)
    await expect(p).rejects.toThrow(/529/)
    // and it must surface as our clean wrapper, NOT the raw SDK string leaked as a normal completion
    await expect(p).rejects.toThrow(/local-agent turn failed:/)
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
    await expect(gate).resolves.toBeUndefined()
  })
})

describe('LocalAgentProvider error status', () => {
  it('attaches api_error_status as .status on the thrown error (so overloads are retryable)', async () => {
    function apiErrorQuery(_opts: unknown) {
      async function* gen() {
        yield { type: 'system', subtype: 'init', session_id: 'sess-err' }
        yield { type: 'result', subtype: 'success', is_error: true, api_error_status: 529, result: 'API Error: 529 Overloaded' }
      }
      return Object.assign(gen(), { interrupt: async () => {} })
    }
    const { ctx } = makeCtx()
    const provider = new LocalAgentProvider(apiErrorQuery as never)
    await expect(provider.send({ userText: 'x' }, ctx)).rejects.toMatchObject({ status: 529 })
  })
})
