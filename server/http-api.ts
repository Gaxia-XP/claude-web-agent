import type { FastifyInstance, FastifyReply } from 'fastify'
import type { ServerMsg, ToolCall } from '../shared/protocol'
import type { TurnOutcome } from './chatRuntime'
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
    // No-op 'error' handler — REQUIRED, not decorative (do not remove). A client disconnect
    // surfaces first on the underlying socket, but a raw.write() that passed the canWrite() check
    // below can still emit an async stream 'error' (EPIPE / write-after-destroy) in the TOCTOU
    // window before it flushes; an unhandled stream 'error' would crash the process. So canWrite()
    // guards the common case and THIS handler additionally absorbs that race — it is exactly what
    // fixed M4's dead-socket crash vector. The turn keeps running (persist + WS live-sync) — same
    // as the WS surface, where a disconnect does not abort the turn. Per-turn cancellation is M6.
    raw.on('error', () => {})
    const canWrite = (): boolean => !raw.writableEnded && !raw.destroyed
    raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    if (replyChatId && canWrite()) raw.write(sseFrame('chat', { chatId: replyChatId }))
    // Track whether the turn emitted its own terminal frame (turn_done -> `done`). Build-failure
    // (enqueueApiTurn throws before any event) and queued-turn-interrupted (settles with no
    // turn_done) paths never emit one, leaving a streaming client to hang on an unclosed stream.
    let doneEmitted = false
    const onEvent = (m: ServerMsg): void => {
      if (m.type === 'turn_done') doneEmitted = true
      if (!canWrite()) return
      const frame = serverMsgToSse(m)
      if (frame) raw.write(frame)
    }
    let outcome: TurnOutcome | undefined
    try {
      outcome = await hub.enqueueApiTurn(chatId, text, { resolver, onEvent })
    } catch (err) {
      if (canWrite()) raw.write(sseFrame('error', { message: err instanceof Error ? err.message : String(err) }))
    }
    // A queued turn cleared by a concurrent WS interrupt (or chat close) resolves with
    // { cancelled: true } and emits NO events — surface an explicit `error` frame so a streaming
    // client can tell cancellation apart from a normal turn (it otherwise sees only a bare `done`).
    if (outcome?.cancelled && canWrite()) {
      raw.write(sseFrame('error', { message: 'turn cancelled', code: 'aborted' }))
    }
    // Guarantee EVERY SSE stream terminates with a `done` frame (after any `error`), so clients
    // can rely on it as the end-of-turn signal regardless of build-failure / interrupt / cancel paths.
    // Backpressure note: a stalled-but-alive reader buffers this turn's frames in the Node
    // stream (bounded per turn, localhost) — explicit flow control / drain handling is M6.
    if (!doneEmitted && canWrite()) raw.write(sseFrame('done', {}))
    if (canWrite()) raw.end()
    return reply
  }

  // Non-stream: collect tool calls + any error event, return JSON.
  // A queued turn cleared by a concurrent WS interrupt (or chat close) resolves with
  // { cancelled: true } and no error event -> we return 409 (below). That distinguishes it from a
  // legitimately empty turn (text: '' with cancelled absent -> a normal 200). The user row is
  // persisted either way and the no-hang guarantee holds. (The SSE path signals the same case with
  // an `error` frame before its terminal `done`.)
  const toolCalls: ToolCall[] = []
  let errorMessage: string | undefined
  const onEvent = (m: ServerMsg): void => {
    if (m.type === 'tool_call') toolCalls.push({ id: m.id, name: m.name, input: m.input })
    else if (m.type === 'error') errorMessage = m.message
  }
  let result: TurnOutcome
  try {
    result = await hub.enqueueApiTurn(chatId, text, { resolver, onEvent })
  } catch (err) {
    reply.code(500)
    return { error: err instanceof Error ? err.message : String(err) }
  }
  if (result.cancelled) {
    reply.code(409)
    return { ...(replyChatId ? { chatId: replyChatId } : {}), error: 'turn cancelled', code: 'aborted' }
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
