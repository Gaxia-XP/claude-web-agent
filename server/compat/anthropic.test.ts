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

// A provider whose send() throws — surfaced by executeCompatTurn as { error }.
const boom = { type: 'boom', async send() { throw new Error('upstream exploded') } }
function appBoom(): FastifyInstance {
  const a = Fastify()
  registerAnthropicCompat(a, { db: openDb(':memory:'), makeProvider: () => boom as never })
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

  it('(B) a system-only body -> 400 (empty-input guard)', async () => {
    const res = await appEcho().inject({
      method: 'POST', url: '/v1/messages',
      payload: { model: 'local/sonnet', messages: [{ role: 'system', content: 'sys' }] },
    })
    expect(res.statusCode).toBe(400)
  })

  it('(D) a non-stream provider runtime error -> 500', async () => {
    const res = await appBoom().inject({
      method: 'POST', url: '/v1/messages',
      payload: { model: 'local/sonnet', messages: [{ role: 'user', content: 'x' }] },
    })
    expect(res.statusCode).toBe(500)
    expect((res.json() as { type: string }).type).toBe('error')
  })

  it('(C) a streaming provider error emits an `error` event, NOT a normal end_turn terminal', async () => {
    const res = await appBoom().inject({
      method: 'POST', url: '/v1/messages',
      payload: { model: 'local/sonnet', messages: [{ role: 'user', content: 'x' }], stream: true },
    })
    expect(res.statusCode).toBe(200)
    const body = res.body
    expect(body).toContain('event: error')
    expect(body).toContain('exploded')
    expect(body).not.toContain('event: message_stop') // failure must be distinguishable from success
  })

  it('(input_tokens) a successful stream surfaces input_tokens in the terminal message_delta', async () => {
    const res = await appEcho().inject({
      method: 'POST', url: '/v1/messages',
      payload: { model: 'local-auto/sonnet', stream: true, messages: [{ role: 'user', content: 'there' }] },
    })
    // message_delta usage now carries input_tokens (echo provider reports inputTokens:2), not just output_tokens
    expect(res.body).toMatch(/"usage":\{"input_tokens":2,"output_tokens":3\}/)
  })

  // Regression (real socket): same bug/fix as the OpenAI route — abort must hang off reply.raw 'close',
  // not req.raw 'close' (which fires when the request BODY is read, aborting the turn before it produces
  // output -> empty 200). Only reproduces over a real socket (see openai.test.ts for the full rationale).
  it('non-stream over a real socket does not abort the provider before it completes', async () => {
    const slow = {
      type: 'slow',
      async send(params: { userText: string }, ctx: { signal: AbortSignal }) {
        await new Promise((r) => setTimeout(r, 30))
        if (ctx.signal.aborted) return { text: '' }
        return { text: 'DONE ' + params.userText, usage: { outputTokens: 1 } }
      },
    }
    const a = Fastify()
    registerAnthropicCompat(a, { db: openDb(':memory:'), makeProvider: () => slow as never })
    await a.listen({ port: 0, host: '127.0.0.1' })
    try {
      const { port } = a.server.address() as { port: number }
      const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'local/sonnet', messages: [{ role: 'user', content: 'x' }] }),
      })
      const body = (await res.json()) as { content: Array<{ type: string; text: string }> }
      expect(body.content).toEqual([{ type: 'text', text: 'DONE x' }]) // '' on the buggy req.raw-close wiring
    } finally {
      await a.close()
    }
  })

  it('(D) on a turn timeout the route aborts the lingering provider run (no detached leak)', async () => {
    let sawAbort = false
    const hang = {
      type: 'hang',
      async send(_p: unknown, ctx: { signal: AbortSignal }) {
        await new Promise<void>((res) => ctx.signal.addEventListener('abort', () => { sawAbort = true; res() }))
        return { text: '' }
      },
    }
    const a = Fastify()
    registerAnthropicCompat(a, { db: openDb(':memory:'), makeProvider: () => hang as never, turnTimeoutMs: 20 })
    const res = await a.inject({
      method: 'POST', url: '/v1/messages',
      payload: { model: 'local/sonnet', messages: [{ role: 'user', content: 'x' }] },
    })
    expect(res.statusCode).toBe(500)
    expect(sawAbort).toBe(true) // reverting fix D's finally{ac.abort()} leaves this false
  })
})
