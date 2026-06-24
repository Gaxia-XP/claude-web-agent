import Anthropic from '@anthropic-ai/sdk'
import type { Usage } from '../../shared/protocol'
import type { Provider, ProviderContext, TurnParams, TurnResult } from './types'
import { historyToChatMessages, type ChatMessage } from './messages'

const DEFAULT_MAX_TOKENS = 16000

// Minimal structural view of the Anthropic stream events we read. Decouples this
// provider (and its tests) from the exact SDK event types.
export type AnthropicStreamEvent =
  | { type: 'message_start'; message: { usage?: { input_tokens?: number } } }
  | { type: 'content_block_delta'; delta: { type: string; text?: string } }
  | { type: 'message_delta'; usage?: { output_tokens?: number } }
  | { type: string }

export type AnthropicStreamBody = {
  model: string
  max_tokens: number
  messages: ChatMessage[]
}

export type AnthropicStreamFn = (
  body: AnthropicStreamBody,
  opts: { signal: AbortSignal },
) => AsyncIterable<AnthropicStreamEvent>

// Build the Anthropic SDK client, optionally pointed at an Anthropic-compatible gateway when a
// non-empty baseUrl is given (e.g. a self-hosted proxy or a reseller that speaks `/v1/messages`).
// The SDK appends `/v1/messages` to baseURL. A blank/undefined baseUrl keeps the SDK default
// (https://api.anthropic.com).
export function makeAnthropicClient(opts: { apiKey: string; baseUrl?: string }): Anthropic {
  // Trim whitespace + trailing slashes: the SDK joins baseURL + '/v1/messages' verbatim, so a
  // trailing slash would build a double-slash path. Blank -> undefined keeps the SDK default.
  const baseURL = opts.baseUrl?.trim().replace(/\/+$/, '')
  return new Anthropic({ apiKey: opts.apiKey, maxRetries: 0, ...(baseURL ? { baseURL } : {}) })
}

export class AnthropicApiProvider implements Provider {
  readonly type = 'anthropic-api'
  private defaultModel: string
  private streamFn: AnthropicStreamFn

  constructor(opts: { apiKey: string; defaultModel: string; baseUrl?: string; streamFn?: AnthropicStreamFn }) {
    this.defaultModel = opts.defaultModel
    if (opts.streamFn) {
      this.streamFn = opts.streamFn
    } else {
      const client = makeAnthropicClient({ apiKey: opts.apiKey, baseUrl: opts.baseUrl })
      // The SDK's MessageStream is AsyncIterable over raw stream events.
      this.streamFn = (body, o) =>
        client.messages.stream(body as never, { signal: o.signal }) as unknown as AsyncIterable<AnthropicStreamEvent>
    }
  }

  async send(params: TurnParams, ctx: ProviderContext): Promise<TurnResult> {
    const mapped = historyToChatMessages(params.history ?? [])
    const messages: ChatMessage[] = mapped.length > 0 ? mapped : [{ role: 'user', content: params.userText }]
    const model = params.model ?? this.defaultModel

    let text = ''
    let inputTokens: number | undefined
    let outputTokens: number | undefined

    try {
      const stream = this.streamFn({ model, max_tokens: DEFAULT_MAX_TOKENS, messages }, { signal: ctx.signal })
      for await (const ev of stream) {
        if (ctx.signal.aborted) break
        if (ev.type === 'content_block_delta') {
          const d = (ev as { delta: { type: string; text?: string } }).delta
          if (d.type === 'text_delta' && typeof d.text === 'string') {
            text += d.text
            ctx.onDelta(d.text)
          }
        } else if (ev.type === 'message_start') {
          inputTokens = (ev as { message: { usage?: { input_tokens?: number } } }).message.usage?.input_tokens
        } else if (ev.type === 'message_delta') {
          outputTokens = (ev as { usage?: { output_tokens?: number } }).usage?.output_tokens
        }
      }
    } catch (err) {
      // On user interrupt the SDK aborts the stream and throws — return partial
      // text instead of surfacing an error bubble. Re-throw genuine failures.
      if (!ctx.signal.aborted) throw err
    }

    const usage: Usage | undefined =
      inputTokens !== undefined || outputTokens !== undefined ? { inputTokens, outputTokens } : undefined
    return { text, usage }
  }
}
