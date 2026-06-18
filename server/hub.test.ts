import { describe, it, expect } from 'vitest'
import type { ServerMsg } from '../shared/protocol'
import { openDb, listChats, listMessages, getChat, createConnection } from './store'
import { FakeProvider } from './providers/fake'
import { ChatHub } from './hub'
import type { Provider } from './providers/types'
import type { ProviderConfig } from './providers/index'
import { PolicyPermissionResolver } from './permission'

function makeHub() {
  const db = openDb(':memory:')
  let idN = 0
  let nowN = 1000
  const hub = new ChatHub({
    db,
    makeProvider: () => new FakeProvider(),
    genId: () => `id-${++idN}`,
    now: () => ++nowN,
  })
  return { db, hub }
}

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

function created(handle: { handle(raw: string): void }, sent: ServerMsg[]): string {
  handle.handle(JSON.stringify({ type: 'create_chat', title: 'Chat A' }))
  const ev = sent.find((m) => m.type === 'chat_created') as Extract<ServerMsg, { type: 'chat_created' }>
  return ev.chat.id
}

describe('ChatHub', () => {
  it('(1) sends chat_list immediately on addConnection', () => {
    const { hub } = makeHub()
    const sent: ServerMsg[] = []
    hub.addConnection((m) => sent.push(m))
    expect(sent).toHaveLength(2)
    expect(sent[0].type).toBe('chat_list')
    expect(sent[1].type).toBe('connection_list')
  })

  it('(2) create_chat -> chat_created + chat_list, and a chats row exists', () => {
    const { db, hub } = makeHub()
    const sent: ServerMsg[] = []
    const handle = hub.addConnection((m) => sent.push(m))
    const chatId = created(handle, sent)

    const createdEv = sent.find((m) => m.type === 'chat_created') as Extract<ServerMsg, { type: 'chat_created' }>
    expect(createdEv.chat.id).toBe(chatId)
    expect(createdEv.chat.title).toBe('Chat A')
    expect(createdEv.chat.connectionId).toBe('local')
    expect(createdEv.chat.model).toBe('sonnet')
    // a chat_list also went out after creation
    expect(sent.filter((m) => m.type === 'chat_list').length).toBeGreaterThanOrEqual(2)
    // row persisted
    const rows = listChats(db)
    expect(rows.map((r) => r.id)).toContain(chatId)
  })

  it('(3) subscribe -> chat_history with listMessages', () => {
    const { db, hub } = makeHub()
    const sent: ServerMsg[] = []
    const handle = hub.addConnection((m) => sent.push(m))
    const chatId = created(handle, sent)

    handle.handle(JSON.stringify({ type: 'subscribe', chatId }))
    const hist = sent.find((m) => m.type === 'chat_history') as Extract<ServerMsg, { type: 'chat_history' }>
    expect(hist).toBeTruthy()
    expect(hist.chatId).toBe(chatId)
    expect(hist.messages).toEqual(listMessages(db, chatId))
  })

  it('(4) user_message drives a turn; deltas/turn_done carry chatId; messages persist', async () => {
    const { db, hub } = makeHub()
    const sent: ServerMsg[] = []
    const handle = hub.addConnection((m) => sent.push(m))
    const chatId = created(handle, sent)

    handle.handle(JSON.stringify({ type: 'subscribe', chatId }))
    handle.handle(JSON.stringify({ type: 'user_message', chatId, text: 'world' }))

    await waitFor(() => sent.some((m) => m.type === 'permission_request'))
    const req = sent.find((m) => m.type === 'permission_request') as Extract<ServerMsg, { type: 'permission_request' }>
    expect(req.chatId).toBe(chatId)
    handle.handle(JSON.stringify({ type: 'permission_response', requestId: req.requestId, decision: 'allow' }))

    await waitFor(() => sent.some((m) => m.type === 'turn_done'))
    const delta = sent.find((m) => m.type === 'assistant_delta') as Extract<ServerMsg, { type: 'assistant_delta' }>
    const done = sent.find((m) => m.type === 'turn_done') as Extract<ServerMsg, { type: 'turn_done' }>
    expect(delta.chatId).toBe(chatId)
    expect(done.chatId).toBe(chatId)

    // user + assistant message persisted
    const msgs = listMessages(db, chatId)
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  it('(5) LIVE SYNC: two subscribers both receive deltas from one user_message', async () => {
    const { hub } = makeHub()
    const sentA: ServerMsg[] = []
    const handleA = hub.addConnection((m) => sentA.push(m))
    const chatId = created(handleA, sentA)

    const sentB: ServerMsg[] = []
    const handleB = hub.addConnection((m) => sentB.push(m))

    handleA.handle(JSON.stringify({ type: 'subscribe', chatId }))
    handleB.handle(JSON.stringify({ type: 'subscribe', chatId }))
    handleA.handle(JSON.stringify({ type: 'user_message', chatId, text: 'world' }))

    await waitFor(() => sentA.some((m) => m.type === 'permission_request'))
    const req = sentA.find((m) => m.type === 'permission_request') as Extract<ServerMsg, { type: 'permission_request' }>
    handleA.handle(JSON.stringify({ type: 'permission_response', requestId: req.requestId, decision: 'allow' }))

    await waitFor(() => sentA.some((m) => m.type === 'turn_done') && sentB.some((m) => m.type === 'turn_done'))
    expect(sentA.some((m) => m.type === 'assistant_delta')).toBe(true)
    expect(sentB.some((m) => m.type === 'assistant_delta')).toBe(true)
  })

  it('(6) rename_chat -> broadcastAll chat_renamed', () => {
    const { hub } = makeHub()
    const sent: ServerMsg[] = []
    const handle = hub.addConnection((m) => sent.push(m))
    const chatId = created(handle, sent)

    handle.handle(JSON.stringify({ type: 'rename_chat', chatId, title: 'Renamed' }))
    const renamed = sent.find((m) => m.type === 'chat_renamed') as Extract<ServerMsg, { type: 'chat_renamed' }>
    expect(renamed.chatId).toBe(chatId)
    expect(renamed.title).toBe('Renamed')
  })

  it('(7) delete_chat -> broadcastAll chat_deleted; chat + messages gone', () => {
    const { db, hub } = makeHub()
    const sent: ServerMsg[] = []
    const handle = hub.addConnection((m) => sent.push(m))
    const chatId = created(handle, sent)

    handle.handle(JSON.stringify({ type: 'delete_chat', chatId }))
    const deleted = sent.find((m) => m.type === 'chat_deleted') as Extract<ServerMsg, { type: 'chat_deleted' }>
    expect(deleted.chatId).toBe(chatId)
    expect(getChat(db, chatId)).toBeUndefined()
    expect(listMessages(db, chatId)).toHaveLength(0)
  })

  it('(8) list_dirs -> dir_list for an existing path', async () => {
    const { hub } = makeHub()
    const sent: ServerMsg[] = []
    const handle = hub.addConnection((m) => sent.push(m))

    handle.handle(JSON.stringify({ type: 'list_dirs', path: process.cwd() }))
    await waitFor(() => sent.some((m) => m.type === 'dir_list'))
    const dl = sent.find((m) => m.type === 'dir_list') as Extract<ServerMsg, { type: 'dir_list' }>
    expect(dl.path).toBe(process.cwd())
    expect(Array.isArray(dl.entries)).toBe(true)
  })

  it('(8b) #5: after a turn completes, a subscribed connection receives an updated chat_list', async () => {
    const { hub } = makeHub()
    const sent: ServerMsg[] = []
    const handle = hub.addConnection((m) => sent.push(m))
    const chatId = created(handle, sent)

    // count chat_list messages received so far (initial + after create_chat)
    const beforeCount = sent.filter((m) => m.type === 'chat_list').length

    handle.handle(JSON.stringify({ type: 'subscribe', chatId }))
    handle.handle(JSON.stringify({ type: 'user_message', chatId, text: 'ping' }))

    await waitFor(() => sent.some((m) => m.type === 'permission_request'))
    const req = sent.find((m) => m.type === 'permission_request') as Extract<ServerMsg, { type: 'permission_request' }>
    handle.handle(JSON.stringify({ type: 'permission_response', requestId: req.requestId, decision: 'allow' }))

    await waitFor(() => sent.some((m) => m.type === 'turn_done'))

    // After the turn, at least one additional chat_list must have been broadcast
    const afterCount = sent.filter((m) => m.type === 'chat_list').length
    expect(afterCount).toBeGreaterThan(beforeCount)
  })

  // ── B1 regression: user_message for unknown/deleted chatId must NOT crash ─────
  it('(B1a) user_message for a never-existed chatId -> error ServerMsg with that chatId, no throw, no DB rows', () => {
    const { db, hub } = makeHub()
    const sent: ServerMsg[] = []
    const handle = hub.addConnection((m) => sent.push(m))

    // Send user_message for a chatId that was never created
    handle.handle(JSON.stringify({ type: 'user_message', chatId: 'ghost-chat', text: 'hello' }))

    const err = sent.find((m) => m.type === 'error') as Extract<ServerMsg, { type: 'error' }> | undefined
    expect(err).toBeTruthy()
    expect(err?.chatId).toBe('ghost-chat')
    // No chat or message rows created
    expect(listChats(db)).toHaveLength(0)
    expect(listMessages(db, 'ghost-chat')).toHaveLength(0)
  })

  it('(B1b) create_chat -> delete_chat -> user_message for that chatId -> error, server stays alive', () => {
    const { db, hub } = makeHub()
    const sent: ServerMsg[] = []
    const handle = hub.addConnection((m) => sent.push(m))
    const chatId = created(handle, sent)

    // Delete the chat
    handle.handle(JSON.stringify({ type: 'delete_chat', chatId }))
    expect(getChat(db, chatId)).toBeUndefined()

    // Clear sent so we can check only what comes after the delete
    sent.length = 0

    // Now send user_message for the deleted chatId — must NOT throw
    handle.handle(JSON.stringify({ type: 'user_message', chatId, text: 'oops' }))

    const err = sent.find((m) => m.type === 'error') as Extract<ServerMsg, { type: 'error' }> | undefined
    expect(err).toBeTruthy()
    expect(err?.chatId).toBe(chatId)
    // No messages were persisted
    expect(listMessages(db, chatId)).toHaveLength(0)
  })

  it('(10) routes provider by the chat\'s connection.type via makeProvider(cfg)', async () => {
    const db = openDb(':memory:')
    createConnection(db, {
      id: 'anth',
      type: 'anthropic-api',
      name: 'Anthropic',
      apiKey: 'sk-secret',
      defaultModel: 'claude-opus-4-8',
      now: 500,
    })
    const cfgs: ProviderConfig[] = []
    let idN = 0
    let nowN = 1000
    const stubProvider: Provider = {
      type: 'stub',
      async send(_p, ctx) {
        ctx.onDelta('ok')
        return { text: 'ok' }
      },
    }
    const hub = new ChatHub({
      db,
      makeProvider: (cfg) => {
        cfgs.push(cfg)
        return stubProvider
      },
      genId: () => `id-${++idN}`,
      now: () => ++nowN,
    })
    const sent: ServerMsg[] = []
    const handle = hub.addConnection((m) => sent.push(m))
    handle.handle(JSON.stringify({ type: 'create_chat', title: 'A', connectionId: 'anth' }))
    const chatId = (sent.find((m) => m.type === 'chat_created') as Extract<ServerMsg, { type: 'chat_created' }>).chat.id
    handle.handle(JSON.stringify({ type: 'user_message', chatId, text: 'hi' }))
    await waitFor(() => sent.some((m) => m.type === 'turn_done'))
    // makeProvider received the REAL connection type + secret server-side
    expect(cfgs[0]).toMatchObject({ type: 'anthropic-api', defaultModel: 'claude-opus-4-8', apiKey: 'sk-secret' })
  })

  it('(11) addConnection sends connection_list immediately (with seeded local, no api_key)', () => {
    const { hub } = makeHub()
    const sent: ServerMsg[] = []
    hub.addConnection((m) => sent.push(m))
    const cl = sent.find((m) => m.type === 'connection_list') as Extract<ServerMsg, { type: 'connection_list' }>
    expect(cl).toBeTruthy()
    expect(cl.connections.some((c) => c.id === 'local')).toBe(true)
    expect(cl.connections.every((c) => (c as Record<string, unknown>).apiKey === undefined)).toBe(true)
  })

  it('(12) create_connection -> broadcastAll connection_list including the new one (no api_key)', () => {
    const { hub } = makeHub()
    const sent: ServerMsg[] = []
    const handle = hub.addConnection((m) => sent.push(m))
    handle.handle(
      JSON.stringify({
        type: 'create_connection',
        name: 'My Anthropic',
        providerType: 'anthropic-api',
        apiKey: 'sk-secret',
        defaultModel: 'claude-opus-4-8',
      }),
    )
    const lists = sent.filter((m) => m.type === 'connection_list') as Extract<ServerMsg, { type: 'connection_list' }>[]
    const last = lists[lists.length - 1]
    const added = last.connections.find((c) => c.name === 'My Anthropic')
    expect(added).toMatchObject({ type: 'anthropic-api', defaultModel: 'claude-opus-4-8' })
    expect((added as Record<string, unknown>).apiKey).toBeUndefined()
  })

  it('(13) update_connection changes name/model in next connection_list', () => {
    const { hub } = makeHub()
    const sent: ServerMsg[] = []
    const handle = hub.addConnection((m) => sent.push(m))
    handle.handle(
      JSON.stringify({ type: 'create_connection', name: 'A', providerType: 'openai-compatible', baseUrl: 'https://x/v1', defaultModel: 'm1' }),
    )
    const created = (sent.filter((m) => m.type === 'connection_list').pop() as Extract<ServerMsg, { type: 'connection_list' }>).connections.find((c) => c.name === 'A')!
    handle.handle(JSON.stringify({ type: 'update_connection', id: created.id, name: 'B', defaultModel: 'm2' }))
    const last = (sent.filter((m) => m.type === 'connection_list').pop() as Extract<ServerMsg, { type: 'connection_list' }>).connections.find((c) => c.id === created.id)!
    expect(last.name).toBe('B')
    expect(last.defaultModel).toBe('m2')
  })

  it('(14) delete_connection refuses to delete local (error, still present)', () => {
    const { hub } = makeHub()
    const sent: ServerMsg[] = []
    const handle = hub.addConnection((m) => sent.push(m))
    handle.handle(JSON.stringify({ type: 'delete_connection', id: 'local' }))
    expect(sent.some((m) => m.type === 'error')).toBe(true)
    const last = sent.filter((m) => m.type === 'connection_list').pop() as Extract<ServerMsg, { type: 'connection_list' }>
    expect(last.connections.some((c) => c.id === 'local')).toBe(true)
  })

  it('(15) delete_connection refuses when chats reference it', () => {
    const { hub } = makeHub()
    const sent: ServerMsg[] = []
    const handle = hub.addConnection((m) => sent.push(m))
    handle.handle(JSON.stringify({ type: 'create_connection', name: 'A', providerType: 'anthropic-api', apiKey: 'k', defaultModel: 'm' }))
    const conn = (sent.filter((m) => m.type === 'connection_list').pop() as Extract<ServerMsg, { type: 'connection_list' }>).connections.find((c) => c.name === 'A')!
    handle.handle(JSON.stringify({ type: 'create_chat', title: 'bound', connectionId: conn.id }))
    sent.length = 0
    handle.handle(JSON.stringify({ type: 'delete_connection', id: conn.id }))
    expect(sent.some((m) => m.type === 'error')).toBe(true)
  })

  it('(16) delete_connection removes an unused connection', () => {
    const { hub } = makeHub()
    const sent: ServerMsg[] = []
    const handle = hub.addConnection((m) => sent.push(m))
    handle.handle(JSON.stringify({ type: 'create_connection', name: 'A', providerType: 'anthropic-api', apiKey: 'k', defaultModel: 'm' }))
    const conn = (sent.filter((m) => m.type === 'connection_list').pop() as Extract<ServerMsg, { type: 'connection_list' }>).connections.find((c) => c.name === 'A')!
    handle.handle(JSON.stringify({ type: 'delete_connection', id: conn.id }))
    const last = sent.filter((m) => m.type === 'connection_list').pop() as Extract<ServerMsg, { type: 'connection_list' }>
    expect(last.connections.some((c) => c.id === conn.id)).toBe(false)
  })

  it('(17) update_connection evicts cached runtime; next user_message rebuilds with new config', async () => {
    const db = openDb(':memory:')
    createConnection(db, {
      id: 'anth',
      type: 'anthropic-api',
      name: 'Anthropic',
      apiKey: 'sk-old-key',
      defaultModel: 'claude-opus-4-8',
      now: 500,
    })
    const cfgs: ProviderConfig[] = []
    let idN = 0
    let nowN = 1000
    const stubProvider: Provider = {
      type: 'stub',
      async send(_p, ctx) {
        ctx.onDelta('ok')
        return { text: 'ok' }
      },
    }
    const hub = new ChatHub({
      db,
      makeProvider: (cfg) => {
        cfgs.push(cfg)
        return stubProvider
      },
      genId: () => `id-${++idN}`,
      now: () => ++nowN,
    })
    const sent: ServerMsg[] = []
    const handle = hub.addConnection((m) => sent.push(m))

    // Create a chat bound to the 'anth' connection
    handle.handle(JSON.stringify({ type: 'create_chat', title: 'A', connectionId: 'anth' }))
    const chatId = (sent.find((m) => m.type === 'chat_created') as Extract<ServerMsg, { type: 'chat_created' }>).chat.id

    // First user_message: builds runtime with old apiKey
    handle.handle(JSON.stringify({ type: 'user_message', chatId, text: 'first' }))
    await waitFor(() => sent.some((m) => m.type === 'turn_done'))
    expect(cfgs).toHaveLength(1)
    expect(cfgs[0]).toMatchObject({ apiKey: 'sk-old-key' })

    // Update the connection with a new apiKey
    handle.handle(JSON.stringify({ type: 'update_connection', id: 'anth', name: 'Anthropic', apiKey: 'sk-new-key', defaultModel: 'claude-opus-4-8' }))

    // Clear turn_done from sent so we can wait for the second one
    const firstDoneIdx = sent.findIndex((m) => m.type === 'turn_done')
    sent.splice(0, firstDoneIdx + 1)

    // Second user_message: runtime must be rebuilt with new apiKey
    handle.handle(JSON.stringify({ type: 'user_message', chatId, text: 'second' }))
    await waitFor(() => sent.some((m) => m.type === 'turn_done'))

    // makeProvider must have been called TWICE, second call with the NEW key
    expect(cfgs).toHaveLength(2)
    expect(cfgs[1]).toMatchObject({ apiKey: 'sk-new-key' })
  })

  it('(M5) getOrCreateRuntime throws -> client gets chat-scoped error + turn_done (not chatId-less error, not a hang)', async () => {
    const db = openDb(':memory:')
    // Create an anthropic-api connection WITHOUT an apiKey
    createConnection(db, {
      id: 'anth-no-key',
      type: 'anthropic-api',
      name: 'Anthropic (no key)',
      defaultModel: 'claude-opus-4-8',
      now: 500,
    })
    let idN = 0
    let nowN = 1000
    const hub = new ChatHub({
      db,
      makeProvider: (cfg) => {
        if (cfg.type === 'anthropic-api' && !cfg.apiKey) {
          throw new Error('anthropic-api connection requires an api key')
        }
        return new FakeProvider()
      },
      genId: () => `id-${++idN}`,
      now: () => ++nowN,
    })
    const sent: ServerMsg[] = []
    const handle = hub.addConnection((m) => sent.push(m))

    // Create a chat bound to the misconfigured connection
    handle.handle(JSON.stringify({ type: 'create_chat', title: 'Bad', connectionId: 'anth-no-key' }))
    const chatId = (sent.find((m) => m.type === 'chat_created') as Extract<ServerMsg, { type: 'chat_created' }>).chat.id

    // Send user_message — this triggers getOrCreateRuntime which throws
    handle.handle(JSON.stringify({ type: 'user_message', chatId, text: 'hello' }))

    // Must receive chat-scoped error (with chatId) — not a chatId-less error
    const err = sent.find((m) => m.type === 'error') as Extract<ServerMsg, { type: 'error' }> | undefined
    expect(err).toBeTruthy()
    expect(err?.chatId).toBe(chatId)
    expect(err?.message).toMatch(/api key/i)

    // Must also receive turn_done with chatId so the client clears the spinner
    const done = sent.find((m) => m.type === 'turn_done') as Extract<ServerMsg, { type: 'turn_done' }> | undefined
    expect(done).toBeTruthy()
    expect(done?.chatId).toBe(chatId)
  })

  it('(9) close() removes the conn from subscribers and does NOT dispose runtimes', async () => {
    const { hub } = makeHub()
    const sentA: ServerMsg[] = []
    const handleA = hub.addConnection((m) => sentA.push(m))
    const chatId = created(handleA, sentA)

    const sentB: ServerMsg[] = []
    const handleB = hub.addConnection((m) => sentB.push(m))
    handleB.handle(JSON.stringify({ type: 'subscribe', chatId }))

    // B leaves
    handleB.close()
    const before = sentB.length

    // A drives a turn; B must not receive anything new
    handleA.handle(JSON.stringify({ type: 'subscribe', chatId }))
    handleA.handle(JSON.stringify({ type: 'user_message', chatId, text: 'world' }))
    await waitFor(() => sentA.some((m) => m.type === 'permission_request'))
    const req = sentA.find((m) => m.type === 'permission_request') as Extract<ServerMsg, { type: 'permission_request' }>
    handleA.handle(JSON.stringify({ type: 'permission_response', requestId: req.requestId, decision: 'allow' }))
    await waitFor(() => sentA.some((m) => m.type === 'turn_done'))

    expect(sentB.length).toBe(before)
    // runtime still alive: a second user_message from A still works (not disposed)
    handleA.handle(JSON.stringify({ type: 'user_message', chatId, text: 'again' }))
    await waitFor(() => sentA.filter((m) => m.type === 'permission_request').length >= 2)
    expect(sentA.filter((m) => m.type === 'permission_request').length).toBeGreaterThanOrEqual(2)
  })

  // ── M4: native HTTP API hub methods ───────────────────────────────────────
  it('(m4-1) createChatFromApi creates a chat, broadcasts chat_list, returns ChatMeta', () => {
    const { db, hub } = makeHub()
    const sent: ServerMsg[] = []
    hub.addConnection((m) => sent.push(m))
    sent.length = 0
    const chat = hub.createChatFromApi({ title: 'Via API' })
    expect(chat.title).toBe('Via API')
    expect(chat.connectionId).toBe('local')
    expect(chat.model).toBe('sonnet')
    expect(listChats(db).map((c) => c.id)).toContain(chat.id)
    expect(sent.some((m) => m.type === 'chat_list')).toBe(true)
  })

  it('(m4-2) createChatFromApi throws for an unknown connectionId', () => {
    const { hub } = makeHub()
    expect(() => hub.createChatFromApi({ connectionId: 'nope' })).toThrow(/connection not found/)
  })

  it('(m4-3) enqueueApiTurn runs an auto-policy turn and broadcasts to a WS subscriber', async () => {
    const { db, hub } = makeHub()
    const sub: ServerMsg[] = []
    const subHandle = hub.addConnection((m) => sub.push(m))
    const chat = hub.createChatFromApi({ title: 'API turn' })
    subHandle.handle(JSON.stringify({ type: 'subscribe', chatId: chat.id }))

    const apiEvents: ServerMsg[] = []
    const result = await hub.enqueueApiTurn(chat.id, 'hi', {
      resolver: new PolicyPermissionResolver('auto'),
      onEvent: (m) => apiEvents.push(m),
    })

    // FakeProvider: 'Hello ' + 'hi'; Write auto-allowed by 'auto'
    expect(result.text).toBe('Hello hi')
    expect(apiEvents.some((m) => m.type === 'assistant_delta')).toBe(true)
    expect(apiEvents.some((m) => m.type === 'turn_done')).toBe(true)
    // LIVE SYNC: the WS subscriber ALSO received the turn
    expect(sub.some((m) => m.type === 'assistant_delta' && m.chatId === chat.id)).toBe(true)
    expect(sub.some((m) => m.type === 'turn_done' && m.chatId === chat.id)).toBe(true)
    expect(listMessages(db, chat.id).map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  it('(m4-4) enqueueApiTurn under readonly policy denies the Write tool (no tool_call)', async () => {
    const { hub } = makeHub()
    hub.addConnection(() => {})
    const chat = hub.createChatFromApi({ title: 'ro' })
    const apiEvents: ServerMsg[] = []
    const result = await hub.enqueueApiTurn(chat.id, 'hi', {
      resolver: new PolicyPermissionResolver('readonly'),
      onEvent: (m) => apiEvents.push(m),
    })
    expect(result.text).toBe('Hello hi')
    expect(apiEvents.some((m) => m.type === 'tool_call')).toBe(false)
  })

  it('(m4-5) enqueueApiTurn on a build failure broadcasts error+turn_done and throws', () => {
    const db = openDb(':memory:')
    createConnection(db, { id: 'anth-no-key', type: 'anthropic-api', name: 'no key', defaultModel: 'm', now: 1 })
    let idN = 0
    let nowN = 1000
    const hub = new ChatHub({
      db,
      makeProvider: (cfg) => {
        if (cfg.type === 'anthropic-api' && !cfg.apiKey) throw new Error('anthropic-api connection requires an api key')
        return new FakeProvider()
      },
      genId: () => `id-${++idN}`,
      now: () => ++nowN,
    })
    const sub: ServerMsg[] = []
    const subHandle = hub.addConnection((m) => sub.push(m))
    const chat = hub.createChatFromApi({ connectionId: 'anth-no-key', title: 'bad' })
    subHandle.handle(JSON.stringify({ type: 'subscribe', chatId: chat.id }))
    sub.length = 0

    // getOrCreateRuntime throws synchronously inside enqueueApiTurn
    expect(() =>
      hub.enqueueApiTurn(chat.id, 'hi', { resolver: new PolicyPermissionResolver('auto'), onEvent: () => {} }),
    ).toThrow(/api key/i)
    // WS subscriber got chat-scoped error + turn_done so its spinner clears
    expect(sub.some((m) => m.type === 'error' && m.chatId === chat.id)).toBe(true)
    expect(sub.some((m) => m.type === 'turn_done' && m.chatId === chat.id)).toBe(true)
  })
})
