import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { openDb } from './store'
import { FakeProvider } from './providers/fake'
import { makeProvider } from './providers/index'
import { ChatHub } from './hub'
import { buildApp } from './app'

const TOKEN = 'test-token-abc'

// Build a real app via buildApp with an in-memory DB. makeProvider is replaced with a
// FakeProvider factory so no real provider/network is touched (the hub never runs a turn
// in these auth tests — we only exercise the onRequest guard + route registration).
function makeApp() {
  const db = openDb(':memory:')
  const hub = new ChatHub({ db, makeProvider: () => new FakeProvider(), genId: randomUUID, now: Date.now })
  const { app, wss } = buildApp({ db, hub, makeProvider, token: TOKEN })
  return { app, wss, db }
}

describe('buildApp auth hook (§4)', () => {
  it('GET /api/health is allowlisted (no token -> 200)', async () => {
    const { app } = makeApp()
    const res = await app.inject({ method: 'GET', url: '/api/health' })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { status: string }).status).toBeTruthy()
  })

  it('GET /api/chats without a token -> 401 { error: "unauthorized" } + WWW-Authenticate', async () => {
    const { app } = makeApp()
    const res = await app.inject({ method: 'GET', url: '/api/chats' })
    expect(res.statusCode).toBe(401)
    expect(res.headers['www-authenticate']).toBe('Bearer')
    expect(res.json()).toEqual({ error: 'unauthorized' })
  })

  it('GET /api/chats with Authorization: Bearer <token> -> 200', async () => {
    const { app } = makeApp()
    const res = await app.inject({
      method: 'GET',
      url: '/api/chats',
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { chats: unknown[] }).chats).toEqual([])
  })

  it('GET /api/chats with x-api-key: <token> also authorizes -> 200', async () => {
    const { app } = makeApp()
    const res = await app.inject({
      method: 'GET',
      url: '/api/chats',
      headers: { 'x-api-key': TOKEN },
    })
    expect(res.statusCode).toBe(200)
  })

  it('GET /api/chats with a wrong token -> 401', async () => {
    const { app } = makeApp()
    const res = await app.inject({
      method: 'GET',
      url: '/api/chats',
      headers: { authorization: 'Bearer wrong' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'unauthorized' })
  })

  it('POST /v1/chat/completions without a token -> 401 OpenAI-shaped authentication_error', async () => {
    const { app } = makeApp()
    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: {} })
    expect(res.statusCode).toBe(401)
    expect(res.headers['www-authenticate']).toBe('Bearer')
    const body = res.json() as { error: { type: string; message: string } }
    expect(body.error.type).toBe('authentication_error')
    expect(typeof body.error.message).toBe('string')
  })

  it('POST /v1/messages without a token -> 401 Anthropic-shaped authentication_error', async () => {
    const { app } = makeApp()
    const res = await app.inject({ method: 'POST', url: '/v1/messages', payload: {} })
    expect(res.statusCode).toBe(401)
    expect(res.headers['www-authenticate']).toBe('Bearer')
    const body = res.json() as { type: string; error: { type: string; message: string } }
    expect(body.type).toBe('error')
    expect(body.error.type).toBe('authentication_error')
  })

  it('GET /v1/models without a token -> 401 generic /v1 authentication_error', async () => {
    const { app } = makeApp()
    const res = await app.inject({ method: 'GET', url: '/v1/models' })
    expect(res.statusCode).toBe(401)
    const body = res.json() as { error: { type: string; message: string } }
    expect(body.error.type).toBe('authentication_error')
  })

  it('a non-/api, non-/v1 path is allowlisted by the guard (reaches notFound -> 404, NOT 401)', async () => {
    const { app } = makeApp()
    const res = await app.inject({ method: 'GET', url: '/index.html' })
    // No webDist registered in tests -> default Fastify 404, but crucially NOT a 401 from the guard.
    expect(res.statusCode).toBe(404)
  })

  it('bare /api (no trailing slash) without a token -> 401, not 404 (latent-hole guard)', async () => {
    const { app } = makeApp()
    const res = await app.inject({ method: 'GET', url: '/api' })
    expect(res.statusCode).toBe(401)
    expect(res.headers['www-authenticate']).toBe('Bearer')
  })

  it('bare /v1 (no trailing slash) without a token -> 401, not 404 (latent-hole guard)', async () => {
    const { app } = makeApp()
    const res = await app.inject({ method: 'GET', url: '/v1' })
    expect(res.statusCode).toBe(401)
    expect(res.headers['www-authenticate']).toBe('Bearer')
  })
})
