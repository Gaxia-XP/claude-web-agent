import { describe, it, expect } from 'vitest'
import { AnthropicApiProvider, makeAnthropicClient, type AnthropicStreamEvent } from './anthropicApi'
import type { ProviderContext } from './types'
import type { StoredMessage } from '../../shared/protocol'

function ctx(overrides: Partial<ProviderContext> = {}): { ctx: ProviderContext; deltas: string[] } {
  const deltas: string[] = []
  const controller = new AbortController()
  const c: ProviderContext = {
    onDelta: (t) => deltas.push(t),
    onToolCall: () => {},
    onToolResult: () => {},
    permission: { resolve: async () => ({ behavior: 'allow' }) },
    signal: controller.signal,
    ...overrides,
  }
  return { ctx: c, deltas }
}

const userHistory: StoredMessage[] = [{ id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }], createdAt: 0 }]

describe('AnthropicApiProvider', () => {
  it('streams text deltas, accumulates text + usage', async () => {
    async function* fake(): AsyncIterable<AnthropicStreamEvent> {
      yield { type: 'message_start', message: { usage: { input_tokens: 5 } } }
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } }
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } }
      yield { type: 'message_delta', usage: { output_tokens: 2 } }
      yield { type: 'message_stop' }
    }
    const p = new AnthropicApiProvider({ apiKey: 'sk', defaultModel: 'claude-opus-4-8', streamFn: () => fake() })
    const { ctx: c, deltas } = ctx()
    const result = await p.send({ userText: 'hi', history: userHistory }, c)
    expect(deltas).toEqual(['Hel', 'lo'])
    expect(result.text).toBe('Hello')
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 2 })
    expect(result.sdkSessionId).toBeUndefined()
  })

  it('passes model + built messages + signal to streamFn', async () => {
    let captured: { body: unknown; signal: AbortSignal } | undefined
    async function* fake(): AsyncIterable<AnthropicStreamEvent> {
      yield { type: 'message_stop' }
    }
    const p = new AnthropicApiProvider({
      apiKey: 'sk',
      defaultModel: 'claude-opus-4-8',
      streamFn: (body, opts) => {
        captured = { body, signal: opts.signal }
        return fake()
      },
    })
    const { ctx: c } = ctx()
    await p.send({ userText: 'hi', model: 'claude-sonnet-4-6', history: userHistory }, c)
    expect(captured?.body).toMatchObject({
      model: 'claude-sonnet-4-6',
      max_tokens: 16000,
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(captured?.signal).toBeDefined()
  })

  it('returns partial text without throwing when aborted mid-stream', async () => {
    const controller = new AbortController()
    async function* fake(): AsyncIterable<AnthropicStreamEvent> {
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } }
      controller.abort()
      throw new Error('aborted') // SDK throws on abort
    }
    const p = new AnthropicApiProvider({ apiKey: 'sk', defaultModel: 'm', streamFn: () => fake() })
    const { ctx: c, deltas } = ctx({ signal: controller.signal })
    const result = await p.send({ userText: 'hi', history: userHistory }, c)
    expect(deltas).toEqual(['partial'])
    expect(result.text).toBe('partial')
  })

  it('stops emitting deltas once ctx.signal is aborted mid-stream', async () => {
    const controller = new AbortController()
    async function* fake(): AsyncIterable<AnthropicStreamEvent> {
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'one' } }
      controller.abort() // abort BEFORE the next event is consumed
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'two' } }
    }
    const p = new AnthropicApiProvider({ apiKey: 'sk', defaultModel: 'm', streamFn: () => fake() })
    const deltas: string[] = []
    const c: ProviderContext = {
      onDelta: (t) => deltas.push(t),
      onToolCall: () => {},
      onToolResult: () => {},
      permission: { resolve: async () => ({ behavior: 'allow' }) },
      signal: controller.signal,
    }
    const result = await p.send({ userText: 'hi', history: userHistory }, c)
    // the in-loop `if (ctx.signal.aborted) break` must drop 'two'
    expect(deltas).toEqual(['one'])
    expect(result.text).toBe('one')
  })

  it('falls back to userText when history is empty', async () => {
    let captured: unknown
    async function* fake(): AsyncIterable<AnthropicStreamEvent> {
      yield { type: 'message_stop' }
    }
    const p = new AnthropicApiProvider({
      apiKey: 'sk',
      defaultModel: 'm',
      streamFn: (body) => {
        captured = body
        return fake()
      },
    })
    const { ctx: c } = ctx()
    await p.send({ userText: 'solo', history: [] }, c)
    expect(captured).toMatchObject({ messages: [{ role: 'user', content: 'solo' }] })
  })
})

describe('makeAnthropicClient', () => {
  it('uses the default Anthropic base URL when none is given', () => {
    expect(makeAnthropicClient({ apiKey: 'sk' }).baseURL).toBe('https://api.anthropic.com')
  })
  it('points the client at a custom base URL (Anthropic-compatible gateway)', () => {
    expect(makeAnthropicClient({ apiKey: 'sk', baseUrl: 'https://api.maxplus-ai.cc' }).baseURL).toBe(
      'https://api.maxplus-ai.cc',
    )
  })
  it('ignores an empty/blank base URL (keeps the default)', () => {
    expect(makeAnthropicClient({ apiKey: 'sk', baseUrl: '' }).baseURL).toBe('https://api.anthropic.com')
  })
  it('strips a trailing slash so the SDK does not build a double-slash path', () => {
    expect(makeAnthropicClient({ apiKey: 'sk', baseUrl: 'https://api.maxplus-ai.cc/' }).baseURL).toBe(
      'https://api.maxplus-ai.cc',
    )
  })
})
