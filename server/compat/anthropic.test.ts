// server/compat/anthropic.test.ts
import { describe, it, expect } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { openDb } from '../store'
import { registerAnthropicCompat } from './anthropic'

const echo = {
  type: 'echo',
  async send(params: { userText: string }, ctx: { onDelta: (t: string) => void }) {
    ctx.onDelta('Hi ')
    ctx.onDelta(params.userText)
    return { text: 'Hi ' + params.userText, usage: { inputTokens: 2, outputTokens: 3 } }
  },
}
function appEcho(): FastifyInstance {
  const a = Fastify()
  registerAnthropicCompat(a, { db: openDb(':memory:'), makeProvider: () => echo as never })
  return a
}

describe('compat anthropic /v1/messages', () => {
  it('non-stream returns an Anthropic message object', async () => {
    const res = await appEcho().inject({
      method: 'POST', url: '/v1/messages',
      payload: { model: 'local-auto/sonnet', max_tokens: 64, messages: [{ role: 'user', content: 'there' }] },
    })
    expect(res.statusCode).toBe(200)
    const b = res.json() as { type: string; role: string; content: Array<{ type: string; text: string }>; stop_reason: string; usage: { input_tokens: number; output_tokens: number } }
    expect(b.type).toBe('message')
    expect(b.role).toBe('assistant')
    expect(b.content).toEqual([{ type: 'text', text: 'Hi there' }])
    expect(b.stop_reason).toBe('end_turn')
    expect(b.usage).toEqual({ input_tokens: 2, output_tokens: 3 })
  })

  it('stream emits the Anthropic SSE event sequence in order', async () => {
    const res = await appEcho().inject({
      method: 'POST', url: '/v1/messages',
      payload: { model: 'local-auto/sonnet', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'there' }] },
    })
    expect(res.statusCode).toBe(200)
    const body = res.body
    for (const ev of ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']) {
      expect(body).toContain(`event: ${ev}`)
    }
    expect(body).toContain('"type":"text_delta"')
    expect(body).toContain('"text":"Hi "')
    // ordering: start precedes a delta precedes stop
    expect(body.indexOf('event: message_start')).toBeLessThan(body.indexOf('event: content_block_delta'))
    expect(body.indexOf('event: content_block_delta')).toBeLessThan(body.indexOf('event: message_stop'))
  })

  it('unknown model -> 404 Anthropic-style error', async () => {
    const a = Fastify(); registerAnthropicCompat(a, { db: openDb(':memory:'), makeProvider: () => echo as never })
    const res = await a.inject({ method: 'POST', url: '/v1/messages', payload: { model: 'ghost/x', messages: [{ role: 'user', content: 'x' }] } })
    expect(res.statusCode).toBe(404)
    expect((res.json() as { type: string; error: { type: string } }).type).toBe('error')
  })
})
