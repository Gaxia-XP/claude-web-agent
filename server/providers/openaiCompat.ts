import type { Usage } from '../../shared/protocol'
import type { Provider, ProviderContext, TurnParams, TurnResult } from './types'
import { historyToChatMessages, type ChatMessage } from './messages'

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; body: AsyncIterable<Uint8Array | string> | null }>

// Parse an SSE byte/string stream into the payload after each `data:` line.
// Buffers across chunk boundaries; tolerates CRLF.
export async function* parseSseData(chunks: AsyncIterable<Uint8Array | string>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ''
  const drain = function* (block: string): Generator<string> {
    for (const line of block.split('\n')) {
      if (line.startsWith('data:')) yield line.slice(5).trimStart()
    }
  }
  for await (const chunk of chunks) {
    buffer += (typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })).replace(/\r/g, '')
    let idx: number
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      yield* drain(block)
    }
  }
  if (buffer.length > 0) yield* drain(buffer)
}

const defaultFetch: FetchLike = async (url, init) => {
  const res = await fetch(url, init)
  return { ok: res.ok, status: res.status, body: res.body as AsyncIterable<Uint8Array> | null }
}

export class OpenAICompatibleProvider implements Provider {
  readonly type = 'openai-compatible'
  private baseUrl: string
  private apiKey?: string
  private defaultModel: string
  private fetchFn: FetchLike

  constructor(opts: { baseUrl: string; apiKey?: string; defaultModel: string; fetchFn?: FetchLike }) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '')
    this.apiKey = opts.apiKey
    this.defaultModel = opts.defaultModel
    this.fetchFn = opts.fetchFn ?? defaultFetch
  }

  async send(params: TurnParams, ctx: ProviderContext): Promise<TurnResult> {
    const mapped = historyToChatMessages(params.history ?? [])
    const messages: ChatMessage[] = mapped.length > 0 ? mapped : [{ role: 'user', content: params.userText }]
    const model = params.model ?? this.defaultModel

    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`

    let text = ''
    let usage: Usage | undefined
    try {
      const res = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, messages, stream: true }),
        signal: ctx.signal,
      })
      if (!res.ok) throw new Error(`OpenAI-compatible request failed: HTTP ${res.status}`)
      if (!res.body) throw new Error('OpenAI-compatible response had no body')
      for await (const data of parseSseData(res.body)) {
        if (ctx.signal.aborted) break
        if (data === '[DONE]') break
        let json: unknown
        try {
          json = JSON.parse(data)
        } catch {
          continue
        }
        const obj = json as {
          choices?: { delta?: { content?: unknown } }[]
          usage?: { prompt_tokens?: number; completion_tokens?: number }
        }
        const delta = obj.choices?.[0]?.delta?.content
        if (typeof delta === 'string' && delta) {
          text += delta
          ctx.onDelta(delta)
        }
        if (obj.usage) usage = { inputTokens: obj.usage.prompt_tokens, outputTokens: obj.usage.completion_tokens }
      }
    } catch (err) {
      if (!ctx.signal.aborted) throw err
    }
    return { text, usage }
  }
}
