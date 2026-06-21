import type { FastifyInstance, FastifyReply } from 'fastify'
import { CompatError, resolveCompatTurn, executeCompatTurn, type CompatDeps, type CompatMessage } from './turn'

type MsgBody = { model?: unknown; messages?: unknown; stream?: unknown }

function parseBody(body: MsgBody): { model: string; messages: CompatMessage[]; stream: boolean } | null {
  if (typeof body.model !== 'string' || body.model === '') return null
  if (!Array.isArray(body.messages) || body.messages.length === 0) return null
  const messages: CompatMessage[] = []
  for (const m of body.messages) {
    const role = (m as { role?: unknown }).role
    const content = (m as { content?: unknown }).content
    // Anthropic content may be a string or an array of text blocks — flatten to text.
    let text: string | null = null
    if (typeof content === 'string') text = content
    else if (Array.isArray(content)) {
      text = content.filter((b) => (b as { type?: unknown }).type === 'text').map((b) => (b as { text: string }).text).join('')
    }
    if ((role === 'user' || role === 'assistant' || role === 'system') && text !== null) messages.push({ role, content: text })
    else return null
  }
  return { model: body.model, messages, stream: (body as { stream?: unknown }).stream === true }
}

function anthropicError(reply: FastifyReply, status: number, message: string): { type: string; error: { type: string; message: string } } {
  reply.code(status)
  return { type: 'error', error: { type: status === 404 ? 'not_found_error' : status === 400 ? 'invalid_request_error' : 'api_error', message } }
}

export function registerAnthropicCompat(app: FastifyInstance, deps: CompatDeps): void {
  app.post('/v1/messages', async (req, reply) => {
    const parsed = parseBody((req.body ?? {}) as MsgBody)
    if (!parsed) return anthropicError(reply, 400, 'model and a non-empty messages[] are required')

    let resolved
    try {
      resolved = resolveCompatTurn(deps, parsed.model)
    } catch (err) {
      if (err instanceof CompatError) return anthropicError(reply, err.status, err.message)
      throw err
    }

    const ac = new AbortController()

    if (parsed.stream) {
      reply.hijack()
      const raw = reply.raw
      raw.on('error', () => {}) // load-bearing crash-guard (M4)
      raw.on('close', () => ac.abort())
      const canWrite = (): boolean => !raw.writableEnded && !raw.destroyed
      raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      const frame = (event: string, data: unknown): void => { if (canWrite()) raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) }

      frame('message_start', { type: 'message_start', message: { id: 'msg_compat', type: 'message', role: 'assistant', model: parsed.model, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } })
      frame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      const out = await executeCompatTurn({
        ...resolved, messages: parsed.messages, signal: ac.signal,
        onDelta: (t) => frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } }),
      })
      if (out.error) frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `\n[error] ${out.error}` } })
      frame('content_block_stop', { type: 'content_block_stop', index: 0 })
      frame('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: out.usage?.outputTokens ?? 0 } })
      frame('message_stop', { type: 'message_stop' })
      if (canWrite()) raw.end()
      return reply
    }

    const out = await executeCompatTurn({ ...resolved, messages: parsed.messages, signal: ac.signal })
    if (out.error !== undefined) return anthropicError(reply, 500, out.error)
    reply.code(200)
    return {
      id: 'msg_compat', type: 'message', role: 'assistant', model: parsed.model,
      content: [{ type: 'text', text: out.text }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: out.usage?.inputTokens ?? 0, output_tokens: out.usage?.outputTokens ?? 0 },
    }
  })
}
