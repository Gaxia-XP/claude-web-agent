import { describe, it, expect } from 'vitest'
import type { ServerMsg } from '../shared/protocol'
import { openDb, listChats, listMessages, getChat } from './store'
import { FakeProvider } from './providers/fake'
import { ChatHub } from './hub'

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
    expect(sent).toHaveLength(1)
    expect(sent[0].type).toBe('chat_list')
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
})
