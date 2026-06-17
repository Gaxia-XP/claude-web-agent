import {
  parseClientMsg,
  type ClientMsg,
  type ServerMsg,
} from '../shared/protocol'
import {
  DEFAULT_CONNECTION_ID,
  getChat,
  getConnection,
  getConnectionWithSecret,
  createChat,
  listChats,
  listMessages,
  listConnections,
  createConnection,
  updateConnection,
  deleteConnection,
  countChatsForConnection,
  renameChat,
  deleteChat,
  type DB,
} from './store'
import { ChatRuntime } from './chatRuntime'
import { listDirs } from './fsbrowse'
import type { Provider } from './providers/types'
import type { ProviderConfig } from './providers/index'

export type HubDeps = {
  db: DB
  makeProvider: (cfg: ProviderConfig) => Provider
  genId: () => string
  now: () => number
  turnTimeoutMs?: number
}

export type ConnectionHandle = {
  handle(raw: string): void
  close(): void
}

type Send = (m: ServerMsg) => void

export class ChatHub {
  private runtimes = new Map<string, ChatRuntime>()
  private subscribers = new Map<string, Set<Send>>()
  private allSends = new Set<Send>()

  constructor(private deps: HubDeps) {}

  addConnection(send: Send): ConnectionHandle {
    this.allSends.add(send)
    // immediately push the current chat list and connection list to the new connection
    send({ type: 'chat_list', chats: listChats(this.deps.db) })
    send({ type: 'connection_list', connections: listConnections(this.deps.db) })

    return {
      handle: (raw: string) => this.handle(raw, send),
      close: () => this.close(send),
    }
  }

  private broadcastConnections(): void {
    this.broadcastAll({ type: 'connection_list', connections: listConnections(this.deps.db) })
  }

  private broadcast(m: ServerMsg): void {
    const chatId = (m as { chatId?: string }).chatId
    if (!chatId) return
    const subs = this.subscribers.get(chatId)
    if (!subs) return
    for (const s of subs) s(m)
  }

  private broadcastAll(m: ServerMsg): void {
    for (const s of this.allSends) s(m)
  }

  private subscribe(chatId: string, send: Send): void {
    let subs = this.subscribers.get(chatId)
    if (!subs) {
      subs = new Set<Send>()
      this.subscribers.set(chatId, subs)
    }
    subs.add(send)
  }

  private unsubscribe(chatId: string, send: Send): void {
    this.subscribers.get(chatId)?.delete(send)
  }

  private evictRuntimesForConnection(connectionId: string): void {
    for (const [chatId, rt] of this.runtimes) {
      const chat = getChat(this.deps.db, chatId)
      if (chat && chat.connectionId === connectionId) {
        rt.dispose()
        this.runtimes.delete(chatId)
      }
    }
  }

  private getOrCreateRuntime(chatId: string): ChatRuntime {
    let rt = this.runtimes.get(chatId)
    if (rt) return rt
    const chat = getChat(this.deps.db, chatId)
    const conn = chat ? getConnectionWithSecret(this.deps.db, chat.connectionId) : undefined
    if (!conn) throw new Error(`no connection resolved for chat ${chatId}`)
    const cfg: ProviderConfig = { type: conn.type, defaultModel: conn.defaultModel }
    if (conn.baseUrl !== undefined) cfg.baseUrl = conn.baseUrl
    if (conn.apiKey !== undefined) cfg.apiKey = conn.apiKey
    rt = new ChatRuntime(chatId, {
      db: this.deps.db,
      provider: this.deps.makeProvider(cfg),
      broadcast: (m) => this.broadcast(m),
      genId: this.deps.genId,
      now: this.deps.now,
      turnTimeoutMs: this.deps.turnTimeoutMs,
      // #5: re-broadcast chat_list after a turn so sidebar reorders by recency
      onActivity: () => this.broadcastAll({ type: 'chat_list', chats: listChats(this.deps.db) }),
    })
    this.runtimes.set(chatId, rt)
    return rt
  }

  private handle(raw: string, send: Send): void {
    const msg = parseClientMsg(raw)
    if (!msg) return
    try {
      this.route(msg, send)
    } catch (err) {
      console.error('[hub] uncaught error handling client message:', err)
      const chatId = (msg as { chatId?: string }).chatId
      send(chatId ? { type: 'error', chatId, message: 'internal error' } : { type: 'error', message: 'internal error' })
    }
  }

  private route(msg: ClientMsg, send: Send): void {
    switch (msg.type) {
      case 'create_chat': {
        const id = this.deps.genId()
        const now = this.deps.now()
        const connectionId = msg.connectionId ?? DEFAULT_CONNECTION_ID
        const conn = getConnection(this.deps.db, connectionId)
        if (!conn) {
          send({ type: 'error', message: 'connection not found' })
          break
        }
        const chat = createChat(this.deps.db, {
          id,
          title: msg.title ?? 'New chat',
          connectionId,
          model: msg.model ?? conn.defaultModel,
          cwd: msg.cwd,
          now,
        })
        send({ type: 'chat_created', chat })
        this.subscribe(chat.id, send)
        this.broadcastAll({ type: 'chat_list', chats: listChats(this.deps.db) })
        break
      }
      case 'subscribe': {
        this.subscribe(msg.chatId, send)
        send({ type: 'chat_history', chatId: msg.chatId, messages: listMessages(this.deps.db, msg.chatId) })
        break
      }
      case 'unsubscribe': {
        this.unsubscribe(msg.chatId, send)
        break
      }
      case 'user_message': {
        // Guard: reject messages for chats that don't exist (deleted or never created).
        // Without this, enqueue() eagerly appends a DB row whose chat_id has no parent
        // chats row → better-sqlite3 throws SQLITE_CONSTRAINT_FOREIGNKEY synchronously.
        if (!getChat(this.deps.db, msg.chatId)) {
          send({ type: 'error', chatId: msg.chatId, message: 'chat not found' })
          break
        }
        // auto-subscribe the sender so it receives the turn it triggered
        this.subscribe(msg.chatId, send)
        try {
          this.getOrCreateRuntime(msg.chatId).enqueue(msg.text)
        } catch (err) {
          send({ type: 'error', chatId: msg.chatId, message: err instanceof Error ? err.message : String(err) })
          send({ type: 'turn_done', chatId: msg.chatId })
        }
        break
      }
      case 'permission_response': {
        for (const rt of this.runtimes.values()) {
          rt.handlePermissionResponse(msg.requestId, msg.decision)
        }
        break
      }
      case 'interrupt': {
        this.runtimes.get(msg.chatId)?.interrupt()
        break
      }
      case 'rename_chat': {
        renameChat(this.deps.db, msg.chatId, msg.title, this.deps.now())
        this.broadcastAll({ type: 'chat_renamed', chatId: msg.chatId, title: msg.title })
        this.broadcastAll({ type: 'chat_list', chats: listChats(this.deps.db) })
        break
      }
      case 'delete_chat': {
        const rt = this.runtimes.get(msg.chatId)
        rt?.dispose()
        this.runtimes.delete(msg.chatId)
        deleteChat(this.deps.db, msg.chatId)
        this.broadcastAll({ type: 'chat_deleted', chatId: msg.chatId })
        this.broadcastAll({ type: 'chat_list', chats: listChats(this.deps.db) })
        break
      }
      case 'create_connection': {
        const id = this.deps.genId()
        const now = this.deps.now()
        createConnection(this.deps.db, {
          id,
          type: msg.providerType,
          name: msg.name,
          baseUrl: msg.baseUrl,
          apiKey: msg.apiKey,
          defaultModel: msg.defaultModel,
          now,
        })
        this.broadcastConnections()
        break
      }
      case 'update_connection': {
        updateConnection(
          this.deps.db,
          msg.id,
          { name: msg.name, baseUrl: msg.baseUrl, apiKey: msg.apiKey, defaultModel: msg.defaultModel },
          this.deps.now(),
        )
        this.evictRuntimesForConnection(msg.id)
        this.broadcastConnections()
        break
      }
      case 'delete_connection': {
        if (msg.id === DEFAULT_CONNECTION_ID) {
          send({ type: 'error', message: 'cannot delete the default local connection' })
          break
        }
        if (countChatsForConnection(this.deps.db, msg.id) > 0) {
          send({ type: 'error', message: 'cannot delete a connection that has chats' })
          break
        }
        deleteConnection(this.deps.db, msg.id)
        this.broadcastConnections()
        break
      }
      case 'list_dirs': {
        listDirs(msg.path)
          .then((r) => send({ type: 'dir_list', path: r.path, parent: r.parent, entries: r.entries }))
          .catch((err: unknown) => send({ type: 'error', message: err instanceof Error ? err.message : String(err) }))
        break
      }
    }
  }

  private close(send: Send): void {
    this.allSends.delete(send)
    for (const subs of this.subscribers.values()) subs.delete(send)
    // NOTE: do NOT dispose runtimes — turns keep running for other subscribers.
  }
}
