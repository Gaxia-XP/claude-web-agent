import { describe, it, expect } from 'vitest'
import type { ServerMsg } from '../shared/protocol'
import { FakeProvider } from './providers/fake'
import { ChatSession } from './ws'

describe('ChatSession', () => {
  it('runs a turn on user_message and answers an auto-emitted permission request', async () => {
    const sent: ServerMsg[] = []
    const session = new ChatSession((m) => sent.push(m), new FakeProvider())

    session.handle(JSON.stringify({ type: 'user_message', text: 'world' }))

    // รอ permission_request โผล่ แล้วตอบ allow ผ่าน handle()
    await waitFor(() => sent.some((m) => m.type === 'permission_request'))
    const req = sent.find((m) => m.type === 'permission_request') as Extract<ServerMsg, { type: 'permission_request' }>
    session.handle(JSON.stringify({ type: 'permission_response', requestId: req.requestId, decision: 'allow' }))

    await waitFor(() => sent.some((m) => m.type === 'turn_done'))
    const types = sent.map((m) => m.type)
    expect(types).toContain('assistant_delta')
    expect(types).toContain('tool_call')
    expect(types[types.length - 1]).toBe('turn_done')
  })

  it('ignores malformed messages', () => {
    const sent: ServerMsg[] = []
    const session = new ChatSession((m) => sent.push(m), new FakeProvider())
    expect(() => session.handle('{not json')).not.toThrow()
    expect(sent).toHaveLength(0)
  })

  it('dispose() unblocks a turn parked on a permission request and emits turn_done', async () => {
    const sent: ServerMsg[] = []
    const session = new ChatSession((m) => sent.push(m), new FakeProvider())

    session.handle(JSON.stringify({ type: 'user_message', text: 'world' }))

    // Wait for the permission_request to be emitted (turn is parked)
    await waitFor(() => sent.some((m) => m.type === 'permission_request'))

    // Dispose the session instead of answering the permission request
    session.dispose()

    // The turn should complete with a turn_done (error path: deny causes no toolCall, then returns)
    await waitFor(() => sent.some((m) => m.type === 'turn_done'))
    expect(sent.some((m) => m.type === 'turn_done')).toBe(true)
  })

  it('handle() after dispose() does not start a new turn', async () => {
    const sent: ServerMsg[] = []
    const session = new ChatSession((m) => sent.push(m), new FakeProvider())

    session.dispose()
    session.handle(JSON.stringify({ type: 'user_message', text: 'hello' }))

    // Wait a short time to confirm no turn starts
    await new Promise((r) => setTimeout(r, 50))
    expect(sent.some((m) => m.type === 'turn_done')).toBe(false)
    expect(sent.some((m) => m.type === 'assistant_delta')).toBe(false)
  })
})

function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = () => {
      if (cond()) return resolve()
      if (Date.now() - start > timeoutMs) return reject(new Error('timeout'))
      setTimeout(tick, 5)
    }
    tick()
  })
}
