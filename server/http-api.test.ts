import { describe, it, expect } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { openDb, listChats, createChat, appendMessage, DEFAULT_CONNECTION_ID } from './store'
import { FakeProvider } from './providers/fake'
import { ChatHub } from './hub'
import { registerHttpApi, serverMsgToSse } from './http-api'
import { PolicyPermissionResolver } from './permission'
import type { ServerMsg } from '../shared/protocol'

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

describe('serverMsgToSse', () => {
  it('maps assistant_delta -> delta frame', () => {
    expect(serverMsgToSse({ type: 'assistant_delta', chatId: 'c', text: 'hi' })).toBe(
      'event: delta\ndata: {"text":"hi"}\n\n',
    )
  })
  it('maps tool_call -> tool_call frame', () => {
    expect(serverMsgToSse({ type: 'tool_call', chatId: 'c', id: 't1', name: 'Write', input: { a: 1 } })).toBe(
      'event: tool_call\ndata: {"id":"t1","name":"Write","input":{"a":1}}\n\n',
    )
  })
  it('maps turn_done -> done frame', () => {
    expect(serverMsgToSse({ type: 'turn_done', chatId: 'c', usage: { outputTokens: 3 } })).toBe(
      'event: done\ndata: {"usage":{"outputTokens":3}}\n\n',
    )
  })
  it('maps error -> error frame', () => {
    expect(serverMsgToSse({ type: 'error', chatId: 'c', message: 'boom' })).toBe(
      'event: error\ndata: {"message":"boom"}\n\n',
    )
  })
  it('maps tool_result -> tool_result frame', () => {
    expect(serverMsgToSse({ type: 'tool_result', chatId: 'c', id: 't1', result: { ok: true } })).toBe(
      'event: tool_result\ndata: {"id":"t1","result":{"ok":true}}\n\n',
    )
  })
  it('returns null for interactive/housekeeping messages', () => {
    expect(serverMsgToSse({ type: 'permission_request', chatId: 'c', requestId: 'r', name: 'Write', input: {} })).toBeNull()
    expect(serverMsgToSse({ type: 'chat_list', chats: [] })).toBeNull()
  })
})

describe('http-api turn endpoints (non-stream)', () => {
  it('POST /api/chats/:id/messages (stream:false) returns { text, toolCalls, usage }', async () => {
    const { app, hub, db } = makeApp()
    const chat = hub.createChatFromApi({ title: 'T' })
    // default policy = readonly -> FakeProvider's Write is denied -> no toolCalls
    const res = await app.inject({
      method: 'POST',
      url: `/api/chats/${chat.id}/messages`,
      payload: { text: 'hi', stream: false },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { text: string; toolCalls: unknown[]; usage: { outputTokens?: number } }
    expect(body.text).toBe('Hello hi')
    expect(body.toolCalls).toEqual([])
    expect(body.usage).toEqual({ outputTokens: 3 })
    // persisted
    const msgs = await app.inject({ method: 'GET', url: `/api/chats/${chat.id}/messages` })
    expect((msgs.json() as { messages: Array<{ role: string }> }).messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(db).toBeTruthy()
  })

  it('permission:auto allows the Write tool -> toolCalls populated', async () => {
    const { app, hub } = makeApp()
    const chat = hub.createChatFromApi({ title: 'T2' })
    const res = await app.inject({
      method: 'POST',
      url: `/api/chats/${chat.id}/messages`,
      payload: { text: 'hi', stream: false, permission: 'auto' },
    })
    const body = res.json() as { toolCalls: Array<{ name: string }> }
    expect(body.toolCalls.map((t) => t.name)).toEqual(['Write'])
  })

  it('POST messages requires non-empty text (400) and a real chat (404)', async () => {
    const { app, hub } = makeApp()
    const chat = hub.createChatFromApi({ title: 'T3' })
    const noText = await app.inject({ method: 'POST', url: `/api/chats/${chat.id}/messages`, payload: {} })
    expect(noText.statusCode).toBe(400)
    const ghost = await app.inject({ method: 'POST', url: '/api/chats/ghost/messages', payload: { text: 'hi' } })
    expect(ghost.statusCode).toBe(404)
  })

  it('POST /api/query creates a chat and returns { chatId, text, toolCalls, usage }', async () => {
    const { app } = makeApp()
    const res = await app.inject({ method: 'POST', url: '/api/query', payload: { text: 'once', stream: false } })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { chatId: string; text: string; toolCalls: unknown[] }
    expect(body.chatId).toBeTruthy()
    expect(body.text).toBe('Hello once')
  })
})

// A chat row + a hub whose enqueueApiTurn returns a fixed outcome — lets us drive runApiTurn's
// cancelled-vs-empty mapping deterministically without racing a real concurrent interrupt.
function makeAppWithEnqueue(
  enqueueApiTurn: () => Promise<{ text: string; cancelled?: boolean }>,
): { app: FastifyInstance } {
  const db = openDb(':memory:')
  createChat(db, { id: 'c1', title: 'T', connectionId: DEFAULT_CONNECTION_ID, model: 'sonnet', now: 1000 })
  const hub = { enqueueApiTurn } as unknown as ChatHub
  const app = Fastify()
  registerHttpApi(app, { hub, db })
  return { app }
}

describe('http-api stream (SSE) + cancelled-turn signalling', () => {
  it('stream: a normal turn streams delta + terminal done frames (inject/hijack happy path)', async () => {
    const { app, hub } = makeApp()
    const chat = hub.createChatFromApi({ title: 'S' })
    const res = await app.inject({
      method: 'POST',
      url: `/api/chats/${chat.id}/messages`,
      payload: { text: 'hi', stream: true, permission: 'auto' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('event: delta')
    expect(res.body).toContain('event: done')
    // exactly ONE terminal done (regression guard for the doneEmitted double-done class) and NO
    // error frame on a successful turn (guards a spurious cancelled/error over-fire on the happy path)
    expect(res.body.match(/event: done/g)).toHaveLength(1)
    expect(res.body).not.toContain('event: error')
  })

  it('non-stream: a cancelled queued turn returns 409 (not an ambiguous empty 200)', async () => {
    const { app } = makeAppWithEnqueue(async () => ({ text: '', cancelled: true }))
    const res = await app.inject({
      method: 'POST',
      url: '/api/chats/c1/messages',
      payload: { text: 'hi', stream: false },
    })
    expect(res.statusCode).toBe(409)
    expect((res.json() as { error: string }).error).toMatch(/cancel/i)
  })

  it('stream: a cancelled queued turn emits an error frame BEFORE the terminal done', async () => {
    const { app } = makeAppWithEnqueue(async () => ({ text: '', cancelled: true }))
    const res = await app.inject({
      method: 'POST',
      url: '/api/chats/c1/messages',
      payload: { text: 'hi', stream: true },
    })
    expect(res.statusCode).toBe(200)
    const body = res.body
    expect(body).toContain('event: error')
    expect(body).toContain('event: done')
    // error must precede the terminal done so a streaming client sees the signal first
    expect(body.indexOf('event: error')).toBeLessThan(body.indexOf('event: done'))
  })

  it('non-stream: a legitimately empty (non-cancelled) turn still returns 200', async () => {
    const { app } = makeAppWithEnqueue(async () => ({ text: '' }))
    const res = await app.inject({
      method: 'POST',
      url: '/api/chats/c1/messages',
      payload: { text: 'hi', stream: false },
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { text: string }).text).toBe('')
  })

  it('stream: a legitimately empty (non-cancelled) turn emits a terminal done and NO error frame', async () => {
    // SSE counterpart of the non-stream-200 guard above: pins the stream over-trigger gate
    // (`if (outcome?.cancelled ...)`) so a future narrowing cannot spuriously emit an error frame
    // on a genuinely empty-but-completed turn.
    const { app } = makeAppWithEnqueue(async () => ({ text: '' }))
    const res = await app.inject({
      method: 'POST',
      url: '/api/chats/c1/messages',
      payload: { text: 'hi', stream: true },
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('event: done')
    expect(res.body).not.toContain('event: error')
  })

  it('integration: a REAL queued turn cleared by a concurrent interrupt resolves { cancelled:true } through hub.enqueueApiTurn', async () => {
    // The makeAppWithEnqueue tests above pin the http MAPPING (cancelled -> 409 / SSE error) against a
    // synthetic outcome. This pins the OTHER half end-to-end through the real ChatRuntime + hub: a
    // parked turn#1 keeps the runtime busy so turn#2 stays QUEUED, then a concurrent WS interrupt
    // clears it. enqueue() is synchronous, so turn#2 is queued the instant enqueueApiTurn returns
    // (before the interrupt) -> race-free, no timers. The two halves meet at Promise<TurnOutcome>.
    const holder: { release: (() => void) | undefined } = { release: undefined }
    let started!: () => void
    const startedP = new Promise<void>((r) => { started = r })
    const parking = {
      type: 'park',
      async send() {
        started() // turn#1 is now RUNNING (parked) -> runtime busy
        await new Promise<void>((r) => { holder.release = r })
        return { text: 'done' }
      },
    }
    const db = openDb(':memory:')
    let idN = 0
    let nowN = 1000
    const hub = new ChatHub({ db, makeProvider: () => parking, genId: () => `id-${++idN}`, now: () => ++nowN })
    const chat = hub.createChatFromApi({ title: 'P' })
    // turn#1 occupies the runtime via the WS surface and parks (deterministic: await startedP)
    const conn = hub.addConnection(() => {})
    conn.handle(JSON.stringify({ type: 'user_message', chatId: chat.id, text: 'one' }))
    await startedP
    // turn#2 enqueues behind the parked turn#1 -> stays QUEUED (enqueue is synchronous)
    const second = hub.enqueueApiTurn(chat.id, 'two', { resolver: new PolicyPermissionResolver('auto') })
    conn.handle(JSON.stringify({ type: 'interrupt', chatId: chat.id })) // clears the queued turn#2
    holder.release?.() // release turn#1 so the runtime drains cleanly
    const outcome = await second
    expect(outcome).toEqual({ text: '', cancelled: true })
  })
})

describe('GET /api/usage', () => {
  it('returns the summed token usage across messages', async () => {
    const { app, db } = makeApp()
    const chat = createChat(db, { id: 'usage-chat', title: 'T', connectionId: DEFAULT_CONNECTION_ID, model: 'sonnet', now: 1 })
    appendMessage(db, { chatId: chat.id, id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'x' }], usage: { inputTokens: 7, outputTokens: 1 }, createdAt: 1 })
    const res = await app.inject({ method: 'GET', url: '/api/usage' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ inputTokens: 7, outputTokens: 1 })
  })
})
