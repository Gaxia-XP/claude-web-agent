import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { FastifyInstance } from 'fastify'
import { openDb } from './store'
import { FakeProvider } from './providers/fake'
import { makeProvider } from './providers/index'
import { ChatHub } from './hub'
import { buildApp } from './app'

const TOKEN = 'test-token-abc'

// Build a real app via buildApp with an in-memory DB. makeProvider is replaced with a
// FakeProvider factory so no real provider/network is touched (the hub never runs a turn
// in these auth tests — we only exercise the onRequest guard + route registration).
function makeApp(opts: { webDist?: string } = {}) {
  const db = openDb(':memory:')
  const hub = new ChatHub({ db, makeProvider: () => new FakeProvider(), genId: randomUUID, now: Date.now })
  const { app, wss } = buildApp({ db, hub, makeProvider, token: TOKEN, webDist: opts.webDist })
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

describe('buildApp auth hook — percent-encoding bypass (Finding 1)', () => {
  // These tests MUST be 401 — before the fix they return 200/201 (bypass).

  it('GET /%61pi/chats (=%61 decodes to "a" -> /api/chats) without token -> 401', async () => {
    const { app } = makeApp()
    const res = await app.inject({ method: 'GET', url: '/%61pi/chats' })
    expect(res.statusCode).toBe(401)
    expect(res.headers['www-authenticate']).toBe('Bearer')
  })

  it('POST /%61pi/chats without token -> 401', async () => {
    const { app } = makeApp()
    const res = await app.inject({ method: 'POST', url: '/%61pi/chats', payload: {} })
    expect(res.statusCode).toBe(401)
  })

  it('GET /v%31/models (=%31 decodes to "1" -> /v1/models) without token -> 401', async () => {
    const { app } = makeApp()
    const res = await app.inject({ method: 'GET', url: '/v%31/models' })
    expect(res.statusCode).toBe(401)
    expect(res.headers['www-authenticate']).toBe('Bearer')
  })

  it('POST /%61pi/query without token -> 401', async () => {
    const { app } = makeApp()
    const res = await app.inject({ method: 'POST', url: '/%61pi/query', payload: {} })
    expect(res.statusCode).toBe(401)
  })

  it('GET /api/%xx (malformed encoding) without token -> 401 or 400, not a crash, never 200', async () => {
    const { app } = makeApp()
    const res = await app.inject({ method: 'GET', url: '/api/%xx' })
    // Fastify may reject malformed percent-encoding at the parser level (400) before our hook
    // runs, OR our hook catches it and returns 401. Either is acceptable — never 200.
    expect([400, 401]).toContain(res.statusCode)
  })

  it('control: GET /api/chats without token -> 401', async () => {
    const { app } = makeApp()
    const res = await app.inject({ method: 'GET', url: '/api/chats' })
    expect(res.statusCode).toBe(401)
  })

  it('control: GET /api/chats WITH valid token -> 200', async () => {
    const { app } = makeApp()
    const res = await app.inject({
      method: 'GET',
      url: '/api/chats',
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(res.statusCode).toBe(200)
  })

  it('double-encoded path /%2561pi/chats without token -> 401 (deny on surviving %)', async () => {
    const { app } = makeApp()
    // %25 decodes to %, so decoded result is /%61pi/chats which still contains %, treat as guarded
    const res = await app.inject({ method: 'GET', url: '/%2561pi/chats' })
    expect(res.statusCode).toBe(401)
  })
})

describe('buildApp static-serving + SPA fallback (Finding 5)', () => {
  // Temp dir is created once per describe block and cleaned up afterward.
  let tmpDir: string
  let app: FastifyInstance

  // We use afterEach but only one test group shares the same tmpDir/app —
  // vitest runs describes sequentially, so this is safe.
  afterEach(() => {
    if (tmpDir) {
      try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })

  function makeTmpDist(): string {
    const dir = mkdtempSync(join(tmpdir(), 'app-test-dist-'))
    mkdirSync(join(dir, 'assets'), { recursive: true })
    writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body>SPA</body></html>', 'utf8')
    writeFileSync(join(dir, 'assets', 'app.js'), 'console.log("app")', 'utf8')
    return dir
  }

  it('(a) GET /assets/app.js with NO token -> 200 (static is allowlisted, pre-login)', async () => {
    tmpDir = makeTmpDist()
    ;({ app } = makeApp({ webDist: tmpDir }))
    const res = await app.inject({ method: 'GET', url: '/assets/app.js' })
    expect(res.statusCode).toBe(200)
  })

  it('(b) GET /deep/link -> 200 text/html (SPA fallback serves index.html)', async () => {
    tmpDir = makeTmpDist()
    ;({ app } = makeApp({ webDist: tmpDir }))
    const res = await app.inject({ method: 'GET', url: '/deep/link' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/html/)
  })

  it('(c) GET /api/bogus WITH valid token -> 404 JSON (not HTML — proves isApi exclusion)', async () => {
    tmpDir = makeTmpDist()
    ;({ app } = makeApp({ webDist: tmpDir }))
    const res = await app.inject({
      method: 'GET',
      url: '/api/bogus',
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(res.statusCode).toBe(404)
    // Must be JSON, not the SPA HTML
    expect(res.headers['content-type']).toMatch(/application\/json/)
    expect(res.json()).toMatchObject({ error: 'not found' })
  })

  it('(d) GET /v1/bogus WITH valid token -> 404 JSON (not HTML)', async () => {
    tmpDir = makeTmpDist()
    ;({ app } = makeApp({ webDist: tmpDir }))
    const res = await app.inject({
      method: 'GET',
      url: '/v1/bogus',
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(res.statusCode).toBe(404)
    expect(res.headers['content-type']).toMatch(/application\/json/)
    expect(res.json()).toMatchObject({ error: 'not found' })
  })

  it('(e) GET /%61pi/bogus without token -> 401, not served as SPA HTML', async () => {
    tmpDir = makeTmpDist()
    ;({ app } = makeApp({ webDist: tmpDir }))
    const res = await app.inject({ method: 'GET', url: '/%61pi/bogus' })
    expect(res.statusCode).toBe(401)
    // Must NOT be the SPA HTML
    expect(res.headers['content-type']).not.toMatch(/text\/html/)
  })
})
