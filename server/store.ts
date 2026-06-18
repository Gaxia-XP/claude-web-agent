import Database from "better-sqlite3"
import type { ChatMeta, StoredMessage, StoredContentBlock, Usage, ConnectionMeta } from "../shared/protocol"

export type DB = Database.Database

export const DEFAULT_CONNECTION_ID = "local"

export type ConnectionRow = ConnectionMeta

export type ConnectionWithSecret = ConnectionRow & { apiKey?: string }

export function openDb(path: string): DB {
  const db = new Database(path)
  db.pragma("foreign_keys = ON")
  migrate(db)
  ensureDefaultLocalConnection(db)
  return db
}

export function migrate(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS connections (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      base_url TEXT,
      api_key TEXT,
      default_model TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      connection_id TEXT NOT NULL REFERENCES connections(id),
      model TEXT NOT NULL,
      cwd TEXT,
      sdk_session_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      usage TEXT,
      created_at INTEGER NOT NULL
    );
  `)
}

export function ensureDefaultLocalConnection(db: DB): void {
  const now = Date.now()
  db.prepare(
    `INSERT OR IGNORE INTO connections
       (id, type, name, base_url, api_key, default_model, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(DEFAULT_CONNECTION_ID, "local-agent", "local", null, null, "sonnet", now, now)
}

type ConnectionDbRow = {
  id: string
  type: string
  name: string
  base_url: string | null
  api_key: string | null
  default_model: string
  created_at: number
  updated_at: number
}

function mapConnection(r: ConnectionDbRow): ConnectionRow {
  const out: ConnectionRow = {
    id: r.id,
    type: r.type,
    name: r.name,
    defaultModel: r.default_model,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
  if (r.base_url !== null) out.baseUrl = r.base_url
  return out
}

export function listConnections(db: DB): ConnectionRow[] {
  const rows = db
    .prepare(
      `SELECT id, type, name, base_url, api_key, default_model, created_at, updated_at
         FROM connections ORDER BY created_at ASC`,
    )
    .all() as ConnectionDbRow[]
  return rows.map(mapConnection)
}

export function getConnection(db: DB, id: string): ConnectionRow | undefined {
  const row = db
    .prepare(
      `SELECT id, type, name, base_url, api_key, default_model, created_at, updated_at
         FROM connections WHERE id = ?`,
    )
    .get(id) as ConnectionDbRow | undefined
  return row ? mapConnection(row) : undefined
}

export function getConnectionWithSecret(db: DB, id: string): ConnectionWithSecret | undefined {
  const row = db
    .prepare(
      `SELECT id, type, name, base_url, api_key, default_model, created_at, updated_at
         FROM connections WHERE id = ?`,
    )
    .get(id) as ConnectionDbRow | undefined
  if (!row) return undefined
  const out: ConnectionWithSecret = mapConnection(row)
  if (row.api_key !== null) out.apiKey = row.api_key
  return out
}

export function createConnection(
  db: DB,
  c: { id: string; type: string; name: string; baseUrl?: string; apiKey?: string; defaultModel: string; now: number },
): ConnectionRow {
  db.prepare(
    `INSERT INTO connections (id, type, name, base_url, api_key, default_model, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(c.id, c.type, c.name, c.baseUrl ?? null, c.apiKey ?? null, c.defaultModel, c.now, c.now)
  const meta: ConnectionRow = {
    id: c.id,
    type: c.type,
    name: c.name,
    defaultModel: c.defaultModel,
    createdAt: c.now,
    updatedAt: c.now,
  }
  if (c.baseUrl !== undefined) meta.baseUrl = c.baseUrl
  return meta
}

export function updateConnection(
  db: DB,
  id: string,
  patch: { name?: string; baseUrl?: string; apiKey?: string; defaultModel?: string },
  now: number,
): void {
  const sets: string[] = []
  const vals: unknown[] = []
  if (patch.name !== undefined) {
    sets.push("name = ?")
    vals.push(patch.name)
  }
  if (patch.baseUrl !== undefined) {
    sets.push("base_url = ?")
    vals.push(patch.baseUrl)
  }
  if (patch.apiKey !== undefined) {
    sets.push("api_key = ?")
    vals.push(patch.apiKey)
  }
  if (patch.defaultModel !== undefined) {
    sets.push("default_model = ?")
    vals.push(patch.defaultModel)
  }
  sets.push("updated_at = ?")
  vals.push(now)
  vals.push(id)
  db.prepare(`UPDATE connections SET ${sets.join(", ")} WHERE id = ?`).run(...(vals as never[]))
}

export function deleteConnection(db: DB, id: string): void {
  db.prepare(`DELETE FROM connections WHERE id = ?`).run(id)
}

export function countChatsForConnection(db: DB, id: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM chats WHERE connection_id = ?`).get(id) as { n: number }
  return row.n
}

type ChatDbRow = {
  id: string
  title: string
  connection_id: string
  model: string
  cwd: string | null
  created_at: number
  updated_at: number
}

function mapChat(r: ChatDbRow): ChatMeta {
  const out: ChatMeta = {
    id: r.id,
    title: r.title,
    connectionId: r.connection_id,
    model: r.model,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
  if (r.cwd !== null) out.cwd = r.cwd
  return out
}

export function createChat(
  db: DB,
  c: { id: string; title: string; connectionId: string; model: string; cwd?: string; now: number },
): ChatMeta {
  db.prepare(
    `INSERT INTO chats
       (id, title, connection_id, model, cwd, sdk_session_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(c.id, c.title, c.connectionId, c.model, c.cwd ?? null, null, c.now, c.now)
  const meta: ChatMeta = {
    id: c.id,
    title: c.title,
    connectionId: c.connectionId,
    model: c.model,
    createdAt: c.now,
    updatedAt: c.now,
  }
  if (c.cwd !== undefined) meta.cwd = c.cwd
  return meta
}

export function listChats(db: DB): ChatMeta[] {
  const rows = db
    .prepare(
      `SELECT id, title, connection_id, model, cwd, created_at, updated_at
         FROM chats ORDER BY updated_at DESC`,
    )
    .all() as ChatDbRow[]
  return rows.map(mapChat)
}

export function getChat(db: DB, id: string): ChatMeta | undefined {
  const row = db
    .prepare(
      `SELECT id, title, connection_id, model, cwd, created_at, updated_at
         FROM chats WHERE id = ?`,
    )
    .get(id) as ChatDbRow | undefined
  return row ? mapChat(row) : undefined
}

export function renameChat(db: DB, id: string, title: string, now: number): void {
  db.prepare(`UPDATE chats SET title = ?, updated_at = ? WHERE id = ?`).run(title, now, id)
}

export function deleteChat(db: DB, id: string): void {
  db.prepare(`DELETE FROM chats WHERE id = ?`).run(id)
}

export function setChatSdkSession(db: DB, id: string, sdkSessionId: string, now: number): void {
  db.prepare(`UPDATE chats SET sdk_session_id = ?, updated_at = ? WHERE id = ?`).run(
    sdkSessionId,
    now,
    id,
  )
}

export function getChatSdkSession(db: DB, id: string): string | undefined {
  const row = db.prepare(`SELECT sdk_session_id FROM chats WHERE id = ?`).get(id) as
    | { sdk_session_id: string | null }
    | undefined
  if (!row || row.sdk_session_id === null) return undefined
  return row.sdk_session_id
}

export function appendMessage(db: DB, m: StoredMessage & { chatId: string }): void {
  const content = JSON.stringify(m.content)
  const usage = m.usage !== undefined ? JSON.stringify(m.usage) : null
  db.prepare(
    `INSERT INTO messages (id, chat_id, role, content, usage, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(m.id, m.chatId, m.role, content, usage, m.createdAt)
}

type MessageDbRow = {
  id: string
  role: "user" | "assistant"
  content: string
  usage: string | null
  created_at: number
}

export function listMessages(db: DB, chatId: string): StoredMessage[] {
  const rows = db
    .prepare(
      `SELECT id, role, content, usage, created_at
         FROM messages WHERE chat_id = ? ORDER BY created_at ASC, rowid ASC`,
    )
    .all(chatId) as MessageDbRow[]
  return rows.flatMap((r) => {
    let content: StoredContentBlock[]
    try {
      content = JSON.parse(r.content) as StoredContentBlock[]
    } catch {
      // A single corrupt row must not make the whole chat unopenable.
      return []
    }
    const msg: StoredMessage = {
      id: r.id,
      role: r.role,
      content,
      createdAt: r.created_at,
    }
    if (r.usage !== null) {
      try {
        msg.usage = JSON.parse(r.usage) as Usage
      } catch {
        // ignore unparseable usage; keep the message
      }
    }
    return [msg]
  })
}
