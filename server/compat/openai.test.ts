// server/compat/openai.test.ts
import { describe, it, expect } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { openDb } from '../store'
import { makeProvider } from '../providers/index'
import { registerOpenAiCompat } from './openai'

function app(): FastifyInstance {
  const a = Fastify()
  registerOpenAiCompat(a, { db: openDb(':memory:'), makeProvider }) // seeded local-agent conn "local"
  return a
}

describe('compat openai /v1/models', () => {
  it('lists model ids in the OpenAI list shape incl the -auto local variant', async () => {
    const res = await app().inject({ method: 'GET', url: '/v1/models' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { object: string; data: Array<{ id: string; object: string }> }
    expect(body.object).toBe('list')
    const ids = body.data.map((m) => m.id)
    expect(ids).toContain('local/sonnet')
    expect(ids).toContain('local-auto/sonnet')
    expect(body.data.every((m) => m.object === 'model')).toBe(true)
  })
})

// A deterministic provider that emits two deltas then returns — lets us assert mapping without creds.
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
  registerOpenAiCompat(a, { db: openDb(':memory:'), makeProvider: () => echo as never })
  return a
}

// A provider whose send() throws — runTurn catches it, emits an error event, and returns {text:''},
// so executeCompatTurn surfaces { error }. Lets us assert the error-path wire shape.
const boom = { type: 'boom', async send() { throw new Error('upstream exploded') } }
function appBoom(): FastifyInstance {
  const a = Fastify()
  registerOpenAiCompat(a, { db: openDb(':memory:'), makeProvider: () => boom as never })
  return a
}

describe('compat openai /v1/chat/completions', () => {
  it('non-stream returns a chat.completion with the final text + usage', async () => {
    const res = await appEcho().inject({
      method: 'POST', url: '/v1/chat/completions',
      payload: { model: 'local-auto/sonnet', messages: [{ role: 'user', content: 'there' }], stream: false },
    })
    expect(res.statusCode).toBe(200)
    const b = res.json() as { object: string; choices: Array<{ message: { content: string }; finish_reason: string }>; usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }
    expect(b.object).toBe('chat.completion')
    expect(b.choices[0].message.content).toBe('Hi there')
    expect(b.choices[0].finish_reason).toBe('stop')
    expect(b.usage).toEqual({ prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 })
  })

  it('stream emits chat.completion.chunk frames then [DONE]', async () => {
    const res = await appEcho().inject({
      method: 'POST', url: '/v1/chat/completions',
      payload: { model: 'local-auto/sonnet', messages: [{ role: 'user', content: 'there' }], stream: true },
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('"object":"chat.completion.chunk"')
    expect(res.body).toContain('"content":"Hi "')
    expect(res.body).toContain('"finish_reason":"stop"')
    expect(res.body.trimEnd().endsWith('data: [DONE]')).toBe(true)
  })

  it('unknown model id -> 404 with an OpenAI-style error body', async () => {
    const res = await app().inject({
      method: 'POST', url: '/v1/chat/completions',
      payload: { model: 'ghost/x', messages: [{ role: 'user', content: 'x' }] },
    })
    expect(res.statusCode).toBe(404)
    expect((res.json() as { error: { message: string } }).error.message).toMatch(/connection|model/i)
  })

  it('missing messages -> 400', async () => {
    const res = await app().inject({ method: 'POST', url: '/v1/chat/completions', payload: { model: 'local/sonnet' } })
    expect(res.statusCode).toBe(400)
  })

  it('(B) a system-only body -> 400 (empty-input guard)', async () => {
    const res = await app().inject({
      method: 'POST', url: '/v1/chat/completions',
      payload: { model: 'local/sonnet', messages: [{ role: 'system', content: 'sys' }] },
    })
    expect(res.statusCode).toBe(400)
  })

  it('(D) a non-stream provider runtime error -> 500', async () => {
    const res = await appBoom().inject({
      method: 'POST', url: '/v1/chat/completions',
      payload: { model: 'local/sonnet', messages: [{ role: 'user', content: 'x' }], stream: false },
    })
    expect(res.statusCode).toBe(500)
    expect((res.json() as { error: { message: string } }).error.message).toMatch(/exploded/)
  })

  it('(C) a streaming provider error emits a terminal error frame, NOT a finish_reason:stop', async () => {
    const res = await appBoom().inject({
      method: 'POST', url: '/v1/chat/completions',
      payload: { model: 'local/sonnet', messages: [{ role: 'user', content: 'x' }], stream: true },
    })
    expect(res.statusCode).toBe(200) // headers already sent before the error
    const body = res.body
    expect(body).toContain('"error"')
    expect(body).toContain('exploded')
    expect(body).not.toContain('"finish_reason":"stop"') // must NOT masquerade as a normal completion
    expect(body.trimEnd().endsWith('data: [DONE]')).toBe(true)
  })
})
