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
