import { describe, it, expect } from 'vitest'
import { OpenAICompatibleProvider, parseSseData, type FetchLike } from './openaiCompat'
import type { ProviderContext } from './types'
import { ProviderHttpError } from './types'
import type { StoredMessage } from '../../shared/protocol'

async function* chunks(...parts: string[]) {
  for (const p of parts) yield p
}

function ctx() {
  const deltas: string[] = []
  const controller = new AbortController()
  const c: ProviderContext = {
    onDelta: (t) => deltas.push(t),
    onToolCall: () => {},
    onToolResult: () => {},
    permission: { resolve: async () => ({ behavior: 'allow' }) },
    signal: controller.signal,
  }
  return { ctx: c, deltas, controller }
}

const userHistory: StoredMessage[] = [{ id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }], createdAt: 0 }]

describe('parseSseData', () => {
  it('extracts data payloads across chunk boundaries', async () => {
    const out: string[] = []
    for await (const d of parseSseData(chunks('data: a\n', '\ndata: b\n\n', 'data: [DONE]\n\n'))) out.push(d)
    expect(out).toEqual(['a', 'b', '[DONE]'])
  })

  it('handles CRLF line endings', async () => {
    const out: string[] = []
    for await (const d of parseSseData(chunks('data: x\r\n\r\n'))) out.push(d)
    expect(out).toEqual(['x'])
  })
})

describe('OpenAICompatibleProvider', () => {
  it('streams delta content + parses usage, stops at [DONE]', async () => {
    const body =
      'data: {"choices":[{"delta":{"content":"He"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n' +
      'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n' +
      'data: [DONE]\n\n'
    const fetchFn: FetchLike = async () => ({ ok: true, status: 200, body: chunks(body) })
    const p = new OpenAICompatibleProvider({ baseUrl: 'https://api.x/v1', apiKey: 'k', defaultModel: 'm', fetchFn })
    const { ctx: c, deltas } = ctx()
    const result = await p.send({ userText: 'hi', history: userHistory }, c)
    expect(deltas).toEqual(['He', 'llo'])
    expect(result.text).toBe('Hello')
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2 })
  })

  it('sends POST to {baseUrl}/chat/completions with bearer + model + messages + stream', async () => {
    let captured: { url: string; init: Record<string, unknown> } | undefined
    const fetchFn: FetchLike = async (url, init) => {
      captured = { url, init: init as unknown as Record<string, unknown> }
      return { ok: true, status: 200, body: chunks('data: [DONE]\n\n') }
    }
    const p = new OpenAICompatibleProvider({ baseUrl: 'https://api.x/v1/', apiKey: 'sk', defaultModel: 'gpt-x', fetchFn })
    const { ctx: c } = ctx()
    await p.send({ userText: 'hi', model: 'llama', history: userHistory }, c)
    expect(captured?.url).toBe('https://api.x/v1/chat/completions')
    const headers = (captured?.init.headers as Record<string, string>) ?? {}
    expect(headers.authorization).toBe('Bearer sk')
    const parsed = JSON.parse(captured?.init.body as string)
    expect(parsed).toMatchObject({ model: 'llama', stream: true, messages: [{ role: 'user', content: 'hi' }] })
  })

  it('throws on non-ok response', async () => {
    const fetchFn: FetchLike = async () => ({ ok: false, status: 401, body: null })
    const p = new OpenAICompatibleProvider({ baseUrl: 'https://api.x/v1', defaultModel: 'm', fetchFn })
    const { ctx: c } = ctx()
    await expect(p.send({ userText: 'hi', history: userHistory }, c)).rejects.toThrow(/401/)
  })

  it('returns partial text without throwing when aborted', async () => {
    const { ctx: c, deltas, controller } = ctx()
    async function* aborting() {
      yield 'data: {"choices":[{"delta":{"content":"part"}}]}\n\n'
      controller.abort()
      throw new Error('aborted')
    }
    const fetchFn: FetchLike = async () => ({ ok: true, status: 200, body: aborting() })
    const p = new OpenAICompatibleProvider({ baseUrl: 'https://api.x/v1', defaultModel: 'm', fetchFn })
    const result = await p.send({ userText: 'hi', history: userHistory }, c)
    expect(deltas).toEqual(['part'])
    expect(result.text).toBe('part')
  })

  it('breaks out of SSE loop on abort after first delta (no ghost-broadcast of second delta)', async () => {
    const { ctx: c, deltas, controller } = ctx()
    async function* twoEvents() {
      yield 'data: {"choices":[{"delta":{"content":"a"}}]}\n\n'
      yield 'data: {"choices":[{"delta":{"content":"b"}}]}\n\n'
      yield 'data: [DONE]\n\n'
    }
    const fetchFn: FetchLike = async () => ({ ok: true, status: 200, body: twoEvents() })
    const origOnDelta = c.onDelta
    c.onDelta = (t) => {
      origOnDelta(t)
      // abort after the first delta so that 'b' must not be emitted
      controller.abort()
    }
    const p = new OpenAICompatibleProvider({ baseUrl: 'https://api.x/v1', defaultModel: 'm', fetchFn })
    const result = await p.send({ userText: 'hi', history: userHistory }, c)
    // Only 'a' should have been emitted; loop must break before 'b'
    expect(deltas).toEqual(['a'])
    expect(result.text).toBe('a')
  })

  it('omits authorization header when no apiKey', async () => {
    let headers: Record<string, string> = {}
    const fetchFn: FetchLike = async (_url, init) => {
      headers = init.headers
      return { ok: true, status: 200, body: chunks('data: [DONE]\n\n') }
    }
    const p = new OpenAICompatibleProvider({ baseUrl: 'https://api.x/v1', defaultModel: 'm', fetchFn })
    const { ctx: c } = ctx()
    await p.send({ userText: 'hi', history: userHistory }, c)
    expect(headers.authorization).toBeUndefined()
  })
})

describe('OpenAICompatibleProvider error status', () => {
  it('throws a ProviderHttpError carrying the upstream status on a non-ok response', async () => {
    const fetchFn: FetchLike = async () => ({ ok: false, status: 503, body: null })
    const p = new OpenAICompatibleProvider({ baseUrl: 'https://api.x/v1', defaultModel: 'm', fetchFn })
    const { ctx: c } = ctx()
    const err = await p.send({ userText: 'hi', history: userHistory }, c).then(
      () => undefined,
      (e) => e,
    )
    expect(err).toBeInstanceOf(ProviderHttpError)
    expect(err).toMatchObject({ status: 503 })
  })
})
