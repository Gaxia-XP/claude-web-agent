import type { FastifyInstance, FastifyReply } from 'fastify'
import { listCompatModels } from './models'
import { CompatError, resolveCompatTurn, executeCompatTurn, type CompatDeps, type CompatMessage } from './turn'

type ChatBody = { model?: unknown; messages?: unknown; stream?: unknown }

// Validate + normalize the request body into { model, messages, stream }. Returns null on bad input.
function parseChatBody(body: ChatBody): { model: string; messages: CompatMessage[]; stream: boolean } | null {
  if (typeof body.model !== 'string' || body.model === '') return null
  if (!Array.isArray(body.messages) || body.messages.length === 0) return null
  const messages: CompatMessage[] = []
  for (const m of body.messages) {
    const role = (m as { role?: unknown }).role
    const content = (m as { content?: unknown }).content
    if ((role === 'system' || role === 'user' || role === 'assistant') && typeof content === 'string') {
      messages.push({ role, content })
    } else return null
  }
  return { model: body.model, messages, stream: (body as { stream?: unknown }).stream === true }
}

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
    const parsed = parseChatBody((req.body ?? {}) as ChatBody)
    if (!parsed) return openaiError(reply, 400, 'model and a non-empty messages[] are required')

    let resolved
    try {
      resolved = resolveCompatTurn(deps, parsed.model)
    } catch (err) {
      if (err instanceof CompatError) return openaiError(reply, err.status, err.message)
      throw err
    }

    const ac = new AbortController()

    if (parsed.stream) {
      reply.hijack()
      const raw = reply.raw
      raw.on('error', () => {}) // load-bearing crash-guard (M4): absorbs post-canWrite EPIPE races
      raw.on('close', () => ac.abort())
      const canWrite = (): boolean => !raw.writableEnded && !raw.destroyed
      raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      const write = (obj: unknown): void => { if (canWrite()) raw.write(`data: ${JSON.stringify(obj)}\n\n`) }
      const chunk = (delta: Record<string, unknown>, finish: string | null): unknown => ({
        id: 'chatcmpl-compat', object: 'chat.completion.chunk', created: 0, model: parsed.model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })
      write(chunk({ role: 'assistant' }, null)) // OpenAI's first chunk announces the role
      const out = await executeCompatTurn({
        ...resolved, messages: parsed.messages, signal: ac.signal, onDelta: (t) => write(chunk({ content: t }, null)),
      })
      if (out.error && canWrite()) write(chunk({ content: `\n[error] ${out.error}` }, null))
      write(chunk({}, 'stop'))
      if (canWrite()) raw.write('data: [DONE]\n\n')
      if (canWrite()) raw.end()
      return reply
    }

    const out = await executeCompatTurn({ ...resolved, messages: parsed.messages, signal: ac.signal })
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
