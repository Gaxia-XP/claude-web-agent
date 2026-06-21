import type { FastifyInstance, FastifyReply } from 'fastify'
import { listCompatModels } from './models'
import { CompatError, resolveCompatTurn, executeCompatTurn, type CompatDeps } from './turn'
import { parseCompatBody, openSseStream } from './wire'

function openaiError(reply: FastifyReply, status: number, message: string): { error: { message: string; type: string } } {
  reply.code(status)
  return { error: { message, type: status === 404 ? 'not_found_error' : status === 400 ? 'invalid_request_error' : 'api_error' } }
}

export function registerOpenAiCompat(app: FastifyInstance, deps: CompatDeps): void {
  app.get('/v1/models', async () => ({
    object: 'list',
    data: listCompatModels(deps.db).map((id) => ({ id, object: 'model', created: 0, owned_by: 'claude-web-agent' })),
  }))

  app.post('/v1/chat/completions', async (req, reply) => {
    const parsed = parseCompatBody(req.body)
    if (!parsed) return openaiError(reply, 400, 'model and a non-empty messages[] (with a user or assistant turn) are required')

    let resolved
    try {
      resolved = resolveCompatTurn(deps, parsed.model)
    } catch (err) {
      if (err instanceof CompatError) return openaiError(reply, err.status, err.message)
      throw err
    }

    const chunk = (delta: Record<string, unknown>, finish: string | null): unknown => ({
      id: 'chatcmpl-compat', object: 'chat.completion.chunk', created: 0, model: parsed.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })

    if (parsed.stream) {
      const sse = openSseStream(reply)
      try {
        sse.write(`data: ${JSON.stringify(chunk({ role: 'assistant' }, null))}\n\n`) // first chunk announces the role
        const out = await executeCompatTurn({
          ...resolved, messages: parsed.messages, signal: sse.signal, turnTimeoutMs: deps.turnTimeoutMs,
          onDelta: (t) => sse.write(`data: ${JSON.stringify(chunk({ content: t }, null))}\n\n`),
        })
        if (out.error) {
          // A provider error after the 200 headers is surfaced as a terminal OpenAI error frame
          // (NOT a finish_reason:'stop' chunk) so a streaming client can tell it apart from a normal
          // completion. The stream still ends with [DONE].
          sse.write(`data: ${JSON.stringify({ error: { message: out.error, type: 'api_error' } })}\n\n`)
        } else {
          sse.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`)
        }
        sse.write('data: [DONE]\n\n')
      } finally {
        sse.end()   // always terminate the stream
        sse.abort() // tear down a timed-out/lingering provider run on every exit path
      }
      return reply
    }

    const ac = new AbortController()
    req.raw.on('close', () => ac.abort()) // client disconnect -> abort the provider run
    let out
    try {
      out = await executeCompatTurn({ ...resolved, messages: parsed.messages, signal: ac.signal, turnTimeoutMs: deps.turnTimeoutMs })
    } finally {
      ac.abort() // abort on return (timeout/normal/error) so no detached provider run lingers
    }
    if (out.error !== undefined) return openaiError(reply, 500, out.error)
    const inT = out.usage?.inputTokens ?? 0
    const outT = out.usage?.outputTokens ?? 0
    reply.code(200)
    return {
      id: 'chatcmpl-compat', object: 'chat.completion', created: 0, model: parsed.model,
      choices: [{ index: 0, message: { role: 'assistant', content: out.text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: inT, completion_tokens: outT, total_tokens: inT + outT },
    }
  })
}
