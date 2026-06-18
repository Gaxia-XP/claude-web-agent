import type { FastifyInstance, FastifyReply } from 'fastify'
import type { ServerMsg, ToolCall } from '../shared/protocol'
import type { TurnResult } from './providers/types'
import type { ChatHub } from './hub'
import { PolicyPermissionResolver, type PermissionPolicy } from './permission'
import { listConnections, listChats, getChat, listMessages, type DB } from './store'

export interface HttpApiDeps {
  hub: ChatHub
  db: DB
}

// 'readonly' (default) unless explicitly 'auto'. Any other/absent value -> 'readonly'.
function parsePolicy(v: unknown): PermissionPolicy {
  return v === 'auto' ? 'auto' : 'readonly'
}

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

// Map a broadcast ServerMsg to a native-API SSE frame, or null to skip messages irrelevant
// to a non-interactive API caller (permission_*, chat/connection housekeeping). Event names
// follow the native-API contract: delta / tool_call / tool_result / done / error.
export function serverMsgToSse(m: ServerMsg): string | null {
  switch (m.type) {
    case 'assistant_delta':
      return sseFrame('delta', { text: m.text })
    case 'tool_call':
      return sseFrame('tool_call', { id: m.id, name: m.name, input: m.input })
    case 'tool_result':
      return sseFrame('tool_result', { id: m.id, result: m.result })
    case 'turn_done':
      return sseFrame('done', { usage: m.usage })
    case 'error':
      return sseFrame('error', { message: m.message })
    default:
      return null
  }
}

// Run a native-API turn through the shared hub runtime, returning either an SSE stream
// (stream=true, via reply.hijack) or a JSON object { text, toolCalls, usage }. `replyChatId`,
// when provided, is echoed back (used by /api/query so the caller learns the new chatId).
async function runApiTurn(
  hub: ChatHub,
  reply: FastifyReply,
  chatId: string,
  text: string,
  policy: PermissionPolicy,
  stream: boolean,
  replyChatId?: string,
): Promise<unknown> {
  const resolver = new PolicyPermissionResolver(policy)

  if (stream) {
    reply.hijack()
    const raw = reply.raw
    raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    if (replyChatId) raw.write(sseFrame('chat', { chatId: replyChatId }))
    const onEvent = (m: ServerMsg): void => {
      if (raw.writableEnded) return
      const frame = serverMsgToSse(m)
      if (frame) raw.write(frame)
    }
    try {
      await hub.enqueueApiTurn(chatId, text, { resolver, onEvent })
    } catch (err) {
      if (!raw.writableEnded) raw.write(sseFrame('error', { message: err instanceof Error ? err.message : String(err) }))
    }
    if (!raw.writableEnded) raw.end()
    return reply
  }

  // Non-stream: collect tool calls + any error event, return JSON.
  const toolCalls: ToolCall[] = []
  let errorMessage: string | undefined
  const onEvent = (m: ServerMsg): void => {
    if (m.type === 'tool_call') toolCalls.push({ id: m.id, name: m.name, input: m.input })
    else if (m.type === 'error') errorMessage = m.message
  }
  let result: TurnResult
  try {
    result = await hub.enqueueApiTurn(chatId, text, { resolver, onEvent })
  } catch (err) {
    reply.code(500)
    return { error: err instanceof Error ? err.message : String(err) }
  }
  if (errorMessage !== undefined) {
    reply.code(500)
    return { ...(replyChatId ? { chatId: replyChatId } : {}), error: errorMessage }
  }
  reply.code(200)
  return {
    ...(replyChatId ? { chatId: replyChatId } : {}),
    text: result.text,
    toolCalls,
    usage: result.usage,
  }
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

  // POST /api/chats/:id/messages — send a message; stream:false -> JSON, stream:true -> SSE
  app.post('/api/chats/:id/messages', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { text?: string; stream?: boolean; permission?: string }
    if (typeof body.text !== 'string' || body.text === '') {
      reply.code(400)
      return { error: 'text is required' }
    }
    if (!getChat(db, id)) {
      reply.code(404)
      return { error: 'chat not found' }
    }
    return runApiTurn(hub, reply, id, body.text, parsePolicy(body.permission), body.stream === true)
  })

  // POST /api/query — create a one-off chat then run a single turn (stream or non-stream)
  app.post('/api/query', async (req, reply) => {
    const body = (req.body ?? {}) as {
      text?: string
      connectionId?: string
      model?: string
      cwd?: string
      title?: string
      stream?: boolean
      permission?: string
    }
    if (typeof body.text !== 'string' || body.text === '') {
      reply.code(400)
      return { error: 'text is required' }
    }
    let chatId: string
    try {
      const chat = hub.createChatFromApi({
        connectionId: body.connectionId,
        model: body.model,
        cwd: body.cwd,
        title: body.title ?? 'API query',
      })
      chatId = chat.id
    } catch (err) {
      reply.code(400)
      return { error: err instanceof Error ? err.message : String(err) }
    }
    return runApiTurn(hub, reply, chatId, body.text, parsePolicy(body.permission), body.stream === true, chatId)
  })
}
