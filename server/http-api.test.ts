import { describe, it, expect } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { openDb, listChats } from './store'
import { FakeProvider } from './providers/fake'
import { ChatHub } from './hub'
import { registerHttpApi } from './http-api'

function makeApp(): { app: FastifyInstance; hub: ChatHub; db: ReturnType<typeof openDb> } {
  const db = openDb(':memory:')
  let idN = 0
  let nowN = 1000
  const hub = new ChatHub({
    db,
    makeProvider: () => new FakeProvider(),
    genId: () => `id-${++idN}`,
    now: () => ++nowN,
  })
  const app = Fastify()
  registerHttpApi(app, { hub, db })
  return { app, hub, db }
}

describe('http-api read + create endpoints', () => {
  it('GET /api/connections returns the seeded local connection, never api_key', async () => {
    const { app } = makeApp()
    const res = await app.inject({ method: 'GET', url: '/api/connections' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { connections: Array<Record<string, unknown>> }
    expect(body.connections.some((c) => c.id === 'local')).toBe(true)
    expect(body.connections.every((c) => c.apiKey === undefined)).toBe(true)
  })

  it('GET /api/chats is empty initially, then lists a created chat', async () => {
    const { app, hub } = makeApp()
    const empty = await app.inject({ method: 'GET', url: '/api/chats' })
    expect((empty.json() as { chats: unknown[] }).chats).toHaveLength(0)
    const chat = hub.createChatFromApi({ title: 'X' })
    const res = await app.inject({ method: 'GET', url: '/api/chats' })
    const ids = (res.json() as { chats: Array<{ id: string }> }).chats.map((c) => c.id)
    expect(ids).toContain(chat.id)
  })

  it('POST /api/chats creates a chat and returns { chatId } with 201', async () => {
    const { app, db } = makeApp()
    const res = await app.inject({ method: 'POST', url: '/api/chats', payload: { title: 'Created' } })
    expect(res.statusCode).toBe(201)
    const { chatId } = res.json() as { chatId: string }
    expect(chatId).toBeTruthy()
    expect(listChats(db).map((c) => c.id)).toContain(chatId)
  })

  it('POST /api/chats with an unknown connectionId returns 400', async () => {
    const { app } = makeApp()
    const res = await app.inject({ method: 'POST', url: '/api/chats', payload: { connectionId: 'nope' } })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: string }).error).toMatch(/connection not found/)
  })

  it('GET /api/chats/:id/messages returns history; 404 for unknown chat', async () => {
    const { app, hub } = makeApp()
    const chat = hub.createChatFromApi({ title: 'M' })
    const ok = await app.inject({ method: 'GET', url: `/api/chats/${chat.id}/messages` })
    expect(ok.statusCode).toBe(200)
    expect((ok.json() as { messages: unknown[] }).messages).toEqual([])
    const missing = await app.inject({ method: 'GET', url: '/api/chats/ghost/messages' })
    expect(missing.statusCode).toBe(404)
  })
})
