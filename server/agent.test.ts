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
