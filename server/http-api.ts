import type { FastifyInstance } from 'fastify'
import type { ChatHub } from './hub'
import { listConnections, listChats, getChat, listMessages, type DB } from './store'

export interface HttpApiDeps {
  hub: ChatHub
  db: DB
}

// Native HTTP API (REST + SSE). Shares the ChatHub/ChatRuntime engine with the WS UI so
// turns originated here broadcast to WS subscribers for free (live-sync).
// TODO(M6): bearer-token auth + 0.0.0.0 bind. M4 stays on the localhost listener and does
// NOT enforce a token (see README "Native HTTP API").
export function registerHttpApi(app: FastifyInstance, deps: HttpApiDeps): void {
  const { hub, db } = deps

  // GET /api/connections — public connection metadata (NEVER api_key)
  app.get('/api/connections', async () => ({ connections: listConnections(db) }))

  // GET /api/chats — list chats (updated_at DESC)
  app.get('/api/chats', async () => ({ chats: listChats(db) }))

  // POST /api/chats — create a chat -> { chatId }
  app.post('/api/chats', async (req, reply) => {
    const body = (req.body ?? {}) as { connectionId?: string; model?: string; cwd?: string; title?: string }
    try {
      const chat = hub.createChatFromApi({
        connectionId: body.connectionId,
        model: body.model,
        cwd: body.cwd,
        title: body.title,
      })
      reply.code(201)
      return { chatId: chat.id }
    } catch (err) {
      reply.code(400)
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  // GET /api/chats/:id/messages — stored history
  app.get('/api/chats/:id/messages', async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!getChat(db, id)) {
      reply.code(404)
      return { error: 'chat not found' }
    }
    return { messages: listMessages(db, id) }
  })
}
