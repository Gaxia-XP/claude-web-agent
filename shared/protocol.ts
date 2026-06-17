export type ToolCall = { id: string; name: string; input: unknown }
export type Usage = { inputTokens?: number; outputTokens?: number; costUsd?: number }

export type DirEntry = { name: string; path: string }

export type StoredContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; result: unknown }
  | { type: 'error'; message: string }

export type StoredMessage = {
  id: string
  role: 'user' | 'assistant'
  content: StoredContentBlock[]
  usage?: Usage
  createdAt: number
}

export type ConnectionMeta = {
  id: string
  type: string
  name: string
  baseUrl?: string
  defaultModel: string
  createdAt: number
  updatedAt: number
}

export type ChatMeta = {
  id: string
  title: string
  connectionId: string
  model: string
  cwd?: string
  createdAt: number
  updatedAt: number
}

export type ClientMsg =
  | { type: 'create_chat'; title?: string; model?: string; cwd?: string; connectionId?: string }
  | { type: 'subscribe'; chatId: string }
  | { type: 'unsubscribe'; chatId: string }
  | { type: 'user_message'; chatId: string; text: string }
  | { type: 'permission_response'; requestId: string; decision: 'allow' | 'deny' }
  | { type: 'interrupt'; chatId: string }
  | { type: 'rename_chat'; chatId: string; title: string }
  | { type: 'delete_chat'; chatId: string }
  | { type: 'list_dirs'; path?: string }
  | {
      type: 'create_connection'
      name: string
      providerType: string
      baseUrl?: string
      apiKey?: string
      defaultModel: string
    }
  | { type: 'update_connection'; id: string; name?: string; baseUrl?: string; apiKey?: string; defaultModel?: string }
  | { type: 'delete_connection'; id: string }

export type ServerMsg =
  | { type: 'chat_list'; chats: ChatMeta[] }
  | { type: 'connection_list'; connections: ConnectionMeta[] }
  | { type: 'chat_created'; chat: ChatMeta }
  | { type: 'chat_renamed'; chatId: string; title: string }
  | { type: 'chat_deleted'; chatId: string }
  | { type: 'chat_history'; chatId: string; messages: StoredMessage[] }
  | { type: 'assistant_delta'; chatId: string; text: string }
  | { type: 'tool_call'; chatId: string; id: string; name: string; input: unknown }
  | { type: 'tool_result'; chatId: string; id: string; result: unknown }
  | { type: 'permission_request'; chatId: string; requestId: string; name: string; input: unknown }
  | { type: 'turn_done'; chatId: string; usage?: Usage }
  | { type: 'dir_list'; path: string; parent?: string; entries: DirEntry[] }
  | { type: 'error'; message: string; chatId?: string }

export function parseClientMsg(raw: string): ClientMsg | null {
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  switch (o.type) {
    case 'create_chat': {
      const m: Extract<ClientMsg, { type: 'create_chat' }> = { type: 'create_chat' }
      if (typeof o.title === 'string') m.title = o.title
      if (typeof o.model === 'string') m.model = o.model
      if (typeof o.cwd === 'string') m.cwd = o.cwd
      if (typeof o.connectionId === 'string') m.connectionId = o.connectionId
      return m
    }
    case 'subscribe':
      return typeof o.chatId === 'string' ? { type: 'subscribe', chatId: o.chatId } : null
    case 'unsubscribe':
      return typeof o.chatId === 'string' ? { type: 'unsubscribe', chatId: o.chatId } : null
    case 'user_message':
      return typeof o.chatId === 'string' && typeof o.text === 'string'
        ? { type: 'user_message', chatId: o.chatId, text: o.text }
        : null
    case 'permission_response':
      return typeof o.requestId === 'string' && (o.decision === 'allow' || o.decision === 'deny')
        ? { type: 'permission_response', requestId: o.requestId, decision: o.decision }
        : null
    case 'interrupt':
      return typeof o.chatId === 'string' ? { type: 'interrupt', chatId: o.chatId } : null
    case 'rename_chat':
      return typeof o.chatId === 'string' && typeof o.title === 'string'
        ? { type: 'rename_chat', chatId: o.chatId, title: o.title }
        : null
    case 'delete_chat':
      return typeof o.chatId === 'string' ? { type: 'delete_chat', chatId: o.chatId } : null
    case 'list_dirs': {
      const m: { type: 'list_dirs'; path?: string } = { type: 'list_dirs' }
      if (typeof o.path === 'string') m.path = o.path
      return m
    }
    case 'create_connection': {
      if (
        typeof o.name === 'string' &&
        typeof o.providerType === 'string' &&
        typeof o.defaultModel === 'string'
      ) {
        const m: Extract<ClientMsg, { type: 'create_connection' }> = {
          type: 'create_connection',
          name: o.name,
          providerType: o.providerType,
          defaultModel: o.defaultModel,
        }
        if (typeof o.baseUrl === 'string') m.baseUrl = o.baseUrl
        if (typeof o.apiKey === 'string') m.apiKey = o.apiKey
        return m
      }
      return null
    }
    case 'update_connection': {
      if (typeof o.id !== 'string') return null
      const m: Extract<ClientMsg, { type: 'update_connection' }> = { type: 'update_connection', id: o.id }
      if (typeof o.name === 'string') m.name = o.name
      if (typeof o.baseUrl === 'string') m.baseUrl = o.baseUrl
      if (typeof o.apiKey === 'string') m.apiKey = o.apiKey
      if (typeof o.defaultModel === 'string') m.defaultModel = o.defaultModel
      return m
    }
    case 'delete_connection':
      return typeof o.id === 'string' ? { type: 'delete_connection', id: o.id } : null
    default:
      return null
  }
}
