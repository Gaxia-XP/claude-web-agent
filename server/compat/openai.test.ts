// server/compat/openai.test.ts
import { describe, it, expect } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { openDb } from '../store'
import { makeProvider } from '../providers/index'
import { LocalAgentProvider } from '../providers/localAgent'
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

  // Regression (real socket): the non-stream route must NOT abort the provider run before it finishes.
  // The bug listened on req.raw 'close' (IncomingMessage closes when the request BODY is read, mid-turn)
  // instead of reply.raw 'close' (the response/connection — the real client-disconnect signal). A
  // provider that yields to the event loop and observes ctx.signal returned EMPTY because it was aborted
  // prematurely. This only reproduces over a REAL socket (app.inject's mock request never fires the
  // premature 'close'), so this test does a real listen + fetch.
  it('non-stream over a real socket does not abort the provider before it completes', async () => {
    const slow = {
      type: 'slow',
      async send(params: { userText: string }, ctx: { signal: AbortSignal }) {
        await new Promise((r) => setTimeout(r, 30)) // yield so a premature req-close abort can race in
        if (ctx.signal.aborted) return { text: '' }  // the bug's symptom: aborted mid-turn -> empty
        return { text: 'DONE ' + params.userText, usage: { outputTokens: 1 } }
      },
    }
    const a = Fastify()
    registerOpenAiCompat(a, { db: openDb(':memory:'), makeProvider: () => slow as never })
    await a.listen({ port: 0, host: '127.0.0.1' })
    try {
      const { port } = a.server.address() as { port: number }
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'local/sonnet', messages: [{ role: 'user', content: 'x' }], stream: false }),
      })
      const body = (await res.json()) as { choices: Array<{ message: { content: string } }> }
      expect(body.choices[0].message.content).toBe('DONE x') // '' on the buggy req.raw-close wiring
    } finally {
      await a.close()
    }
  })

  // FIX1 end-to-end through the compat route: a real LocalAgentProvider fed an SDK result with
  // is_error:true (subtype 'success') must throw -> runTurn error event -> compat maps to 500 with the
  // API-error detail. Guards the full path, not just the provider unit (localAgent.test.ts) in isolation.
  it('a local-agent is_error result surfaces as a 500 through the compat route', async () => {
    function isErrorQuery() {
      async function* gen() {
        yield { type: 'system', subtype: 'init', session_id: 's' }
        yield { type: 'result', subtype: 'success', is_error: true, api_error_status: 529, result: 'API Error: 529 Overloaded.' }
      }
      return Object.assign(gen(), { interrupt: async () => {} })
    }
    const a = Fastify()
    registerOpenAiCompat(a, { db: openDb(':memory:'), makeProvider: () => new LocalAgentProvider(isErrorQuery as never) })
    const res = await a.inject({
      method: 'POST', url: '/v1/chat/completions',
      payload: { model: 'local/sonnet', messages: [{ role: 'user', content: 'x' }], stream: false },
    })
    expect(res.statusCode).toBe(500)
    expect((res.json() as { error: { message: string } }).error.message).toMatch(/529/)
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
    registerOpenAiCompat(a, { db: openDb(':memory:'), makeProvider: () => hang as never, turnTimeoutMs: 20 })
    const res = await a.inject({
      method: 'POST', url: '/v1/chat/completions',
      payload: { model: 'local/sonnet', messages: [{ role: 'user', content: 'x' }], stream: false },
    })
    // runTurn times out (20ms) -> 500; the route's finally{ac.abort()} then tears the hung provider
    // down. Reverting fix D (dropping finally{ac.abort()}) leaves sawAbort false -> this test fails.
    expect(res.statusCode).toBe(500)
    expect(sawAbort).toBe(true)
  })
})
