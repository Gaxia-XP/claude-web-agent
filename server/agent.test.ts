import { describe, it, expect } from 'vitest'
import type { ServerMsg } from '../shared/protocol'
import type { PermissionResolver } from './permission'
import type { Provider, ProviderContext, TurnParams, TurnResult } from './providers/types'
import { FakeProvider } from './providers/fake'
import { runTurn } from './agent'

const CHAT_ID = 'chat-1'

/** Auto-allow stub: lets any tool through without an interactive round-trip. */
const allowAll: PermissionResolver = { resolve: async () => ({ behavior: 'allow' }) }

class ThrowingProvider implements Provider {
  readonly type = 'throwing'
  async send(_params: TurnParams, _ctx: ProviderContext): Promise<TurnResult> {
    throw new Error('boom')
  }
}

/** Emits NO delta but returns a non-empty final text (exercises #3 fallback). */
class NoDeltaProvider implements Provider {
  readonly type = 'no-delta'
  async send(_params: TurnParams, _ctx: ProviderContext): Promise<TurnResult> {
    return { text: 'final answer' }
  }
}

/** send() never resolves (exercises #4 watchdog). */
class NeverProvider implements Provider {
  readonly type = 'never'
  send(_params: TurnParams, _ctx: ProviderContext): Promise<TurnResult> {
    return new Promise<TurnResult>(() => {
      /* intentionally never resolves */
    })
  }
}

describe('runTurn', () => {
  it('emits error then turn_done when provider throws, both carrying chatId', async () => {
    const sent: ServerMsg[] = []
    const permission: PermissionResolver = allowAll
    const ac = new AbortController()
    const result = await runTurn(
      new ThrowingProvider(),
      { userText: 'hi' },
      { chatId: CHAT_ID, send: (m) => sent.push(m), permission, signal: ac.signal },
    )
    expect(result.text).toBe('')
    const err = sent.find((m) => m.type === 'error') as Extract<ServerMsg, { type: 'error' }>
    expect(err).toBeTruthy()
    expect(err.chatId).toBe(CHAT_ID)
    expect(err.message).toContain('boom')
    const last = sent[sent.length - 1]
    expect(last.type).toBe('turn_done')
    expect((last as Extract<ServerMsg, { type: 'turn_done' }>).chatId).toBe(CHAT_ID)
  })

  it('wires provider callbacks into the ServerMsg stream, each carrying chatId, turn_done last', async () => {
    const sent: ServerMsg[] = []
    const permission: PermissionResolver = allowAll
    const ac = new AbortController()

    const result = await runTurn(
      new FakeProvider(),
      { userText: 'world' },
      { chatId: CHAT_ID, send: (m) => sent.push(m), permission, signal: ac.signal },
    )

    expect(result.text).toBe('Hello world')
    expect(result.sdkSessionId).toBe('sess-1')

    const types = sent.map((m) => m.type)
    expect(types).toContain('assistant_delta')
    expect(types).toContain('tool_call')
    expect(types).toContain('tool_result')
    expect(types[types.length - 1]).toBe('turn_done')

    // assistant_delta, tool_call, tool_result, and the final turn_done each carry chatId.
    const delta = sent.find((m) => m.type === 'assistant_delta') as Extract<ServerMsg, { type: 'assistant_delta' }>
    const call = sent.find((m) => m.type === 'tool_call') as Extract<ServerMsg, { type: 'tool_call' }>
    const res = sent.find((m) => m.type === 'tool_result') as Extract<ServerMsg, { type: 'tool_result' }>
    const done = sent[sent.length - 1] as Extract<ServerMsg, { type: 'turn_done' }>
    expect(delta.chatId).toBe(CHAT_ID)
    expect(call.chatId).toBe(CHAT_ID)
    expect(res.chatId).toBe(CHAT_ID)
    expect(done.type).toBe('turn_done')
    expect(done.chatId).toBe(CHAT_ID)
  })

  it('(#3) emits a single assistant_delta from result.text when provider emitted no delta', async () => {
    const sent: ServerMsg[] = []
    const permission: PermissionResolver = allowAll
    const ac = new AbortController()

    const result = await runTurn(
      new NoDeltaProvider(),
      { userText: 'q' },
      { chatId: CHAT_ID, send: (m) => sent.push(m), permission, signal: ac.signal },
    )
    expect(result.text).toBe('final answer')

    const deltas = sent.filter((m) => m.type === 'assistant_delta') as Extract<ServerMsg, { type: 'assistant_delta' }>[]
    expect(deltas).toHaveLength(1)
    expect(deltas[0].chatId).toBe(CHAT_ID)
    expect(deltas[0].text).toBe('final answer')

    // Fallback delta must come before turn_done.
    const deltaIdx = sent.findIndex((m) => m.type === 'assistant_delta')
    const doneIdx = sent.findIndex((m) => m.type === 'turn_done')
    expect(deltaIdx).toBeLessThan(doneIdx)
    expect(sent[doneIdx].type).toBe('turn_done')
    expect((sent[doneIdx] as Extract<ServerMsg, { type: 'turn_done' }>).chatId).toBe(CHAT_ID)
  })

  it('(#4) times out via the watchdog: emits error then turn_done and resolves to empty text', async () => {
    const sent: ServerMsg[] = []
    const permission: PermissionResolver = allowAll
    const ac = new AbortController()

    const start = Date.now()
    const result = await runTurn(
      new NeverProvider(),
      { userText: 'slow' },
      { chatId: CHAT_ID, send: (m) => sent.push(m), permission, signal: ac.signal, turnTimeoutMs: 20 },
    )
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(500)
    expect(result.text).toBe('')

    const err = sent.find((m) => m.type === 'error') as Extract<ServerMsg, { type: 'error' }>
    expect(err).toBeTruthy()
    expect(err.chatId).toBe(CHAT_ID)
    expect(err.message).toBe('turn timed out')

    const last = sent[sent.length - 1]
    expect(last.type).toBe('turn_done')
    expect((last as Extract<ServerMsg, { type: 'turn_done' }>).chatId).toBe(CHAT_ID)
  })
})
