import { describe, it, expect } from 'vitest'
import type { ServerMsg } from '../shared/protocol'
import type { Provider, ProviderContext, TurnParams, TurnResult } from './providers/types'
import { InteractivePermissionResolver } from './permission'
import { FakeProvider } from './providers/fake'
import { runTurn } from './agent'

class ThrowingProvider implements Provider {
  readonly type = 'throwing'
  async send(_params: TurnParams, _ctx: ProviderContext): Promise<TurnResult> {
    throw new Error('boom')
  }
}

describe('runTurn', () => {
  it('emits error then turn_done when provider throws', async () => {
    const sent: ServerMsg[] = []
    const permission = new InteractivePermissionResolver((m) => sent.push(m), () => 'req1')
    const ac = new AbortController()
    await runTurn(new ThrowingProvider(), { userText: 'hi' }, { send: (m) => sent.push(m), permission, signal: ac.signal })
    const types = sent.map((m) => m.type)
    expect(types).toContain('error')
    expect(types[types.length - 1]).toBe('turn_done')
  })

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
