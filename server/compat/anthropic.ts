import type { FastifyInstance, FastifyReply } from 'fastify'
import { CompatError, resolveCompatTurn, executeCompatTurn, type CompatDeps } from './turn'
import { parseCompatBody, openSseStream } from './wire'

function anthropicError(reply: FastifyReply, status: number, message: string): { type: string; error: { type: string; message: string } } {
  reply.code(status)
  return { type: 'error', error: { type: status === 404 ? 'not_found_error' : status === 400 ? 'invalid_request_error' : 'api_error', message } }
}

export function registerAnthropicCompat(app: FastifyInstance, deps: CompatDeps): void {
  app.post('/v1/messages', async (req, reply) => {
    const parsed = parseCompatBody(req.body)
    if (!parsed) return anthropicError(reply, 400, 'model and a non-empty messages[] (with a user or assistant turn) are required')

    let resolved
    try {
      resolved = resolveCompatTurn(deps, parsed.model)
    } catch (err) {
      if (err instanceof CompatError) return anthropicError(reply, err.status, err.message)
      throw err
    }

    if (parsed.stream) {
      const sse = openSseStream(reply)
      const frame = (event: string, data: unknown): void => sse.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      try {
        frame('message_start', { type: 'message_start', message: { id: 'msg_compat', type: 'message', role: 'assistant', model: parsed.model, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } })
        frame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
        const out = await executeCompatTurn({
          ...resolved, messages: parsed.messages, signal: sse.signal,
          onDelta: (t) => frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } }),
        })
        frame('content_block_stop', { type: 'content_block_stop', index: 0 })
        if (out.error) {
          // A provider error after the 200 headers is surfaced as a real Anthropic `error` event
          // (NOT a normal end_turn terminal) so a client can distinguish failure from success.
          frame('error', { type: 'error', error: { type: 'api_error', message: out.error } })
        } else {
          frame('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: out.usage?.inputTokens ?? 0, output_tokens: out.usage?.outputTokens ?? 0 } })
          frame('message_stop', { type: 'message_stop' })
        }
      } finally {
        sse.end()
        sse.abort()
      }
      return reply
    }

    const ac = new AbortController()
    req.raw.on('close', () => ac.abort()) // client disconnect -> abort the provider run
    let out
    try {
      out = await executeCompatTurn({ ...resolved, messages: parsed.messages, signal: ac.signal })
    } finally {
      ac.abort() // abort on return (timeout/normal/error) so no detached provider run lingers
    }
    if (out.error !== undefined) return anthropicError(reply, 500, out.error)
    reply.code(200)
    return {
      id: 'msg_compat', type: 'message', role: 'assistant', model: parsed.model,
      content: [{ type: 'text', text: out.text }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: out.usage?.inputTokens ?? 0, output_tokens: out.usage?.outputTokens ?? 0 },
    }
  })
}
