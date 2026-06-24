import { describe, it, expect } from 'vitest'
import { isTransientError, sendWithRetry } from './retry'
import { ProviderHttpError } from './providers/types'
import type { Provider, ProviderContext, TurnResult } from './providers/types'

const ctx = (): ProviderContext => ({
  onDelta: () => {},
  onToolCall: () => {},
  onToolResult: () => {},
  permission: { resolve: async () => ({ behavior: 'allow' }) },
  signal: new AbortController().signal,
})
const noDelay = async () => {}

describe('isTransientError', () => {
  it('treats 429 and 5xx as transient', () => {
    for (const s of [429, 500, 502, 503, 504]) expect(isTransientError(new ProviderHttpError(s, 'x'))).toBe(true)
  })
  it('treats 4xx (except 429) as permanent', () => {
    for (const s of [400, 401, 403, 404, 409]) expect(isTransientError(new ProviderHttpError(s, 'x'))).toBe(false)
  })
  it('treats a network/connection error as transient', () => {
    expect(isTransientError(new TypeError('fetch failed'))).toBe(true)
    expect(isTransientError(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(true)
  })
  it('treats an unknown error as permanent', () => {
    expect(isTransientError(new Error('boom'))).toBe(false)
  })
})

describe('sendWithRetry', () => {
  function provider(send: Provider['send']): Provider {
    return { type: 'openai-compatible', send } as Provider
  }
  it('retries a transient error (no delta yet) then succeeds', async () => {
    let calls = 0
    const p = provider(async () => {
      calls++
      if (calls < 3) throw new ProviderHttpError(503, 'down')
      return { text: 'ok' } as TurnResult
    })
    const result = await sendWithRetry(p, {} as never, ctx(), { getEmitted: () => false, signal: new AbortController().signal, sleep: noDelay })
    expect(result.text).toBe('ok')
    expect(calls).toBe(3)
  })
  it('does NOT retry once a delta has streamed', async () => {
    let calls = 0
    const p = provider(async () => {
      calls++
      throw new ProviderHttpError(503, 'down')
    })
    await expect(
      sendWithRetry(p, {} as never, ctx(), { getEmitted: () => true, signal: new AbortController().signal, sleep: noDelay }),
    ).rejects.toMatchObject({ status: 503 })
    expect(calls).toBe(1)
  })
  it('does NOT retry a permanent error', async () => {
    let calls = 0
    const p = provider(async () => {
      calls++
      throw new ProviderHttpError(409, 'conflict')
    })
    await expect(
      sendWithRetry(p, {} as never, ctx(), { getEmitted: () => false, signal: new AbortController().signal, sleep: noDelay }),
    ).rejects.toMatchObject({ status: 409 })
    expect(calls).toBe(1)
  })
  it('gives up after maxRetries and rethrows the last error', async () => {
    let calls = 0
    const p = provider(async () => {
      calls++
      throw new ProviderHttpError(503, 'down')
    })
    await expect(
      sendWithRetry(p, {} as never, ctx(), { getEmitted: () => false, signal: new AbortController().signal, maxRetries: 3, sleep: noDelay }),
    ).rejects.toMatchObject({ status: 503 })
    expect(calls).toBe(4) // 1 initial + 3 retries
  })
  it('stops retrying when the signal aborts during backoff', async () => {
    const ac = new AbortController()
    let calls = 0
    const p = provider(async () => {
      calls++
      throw new ProviderHttpError(503, 'down')
    })
    const sleep = async () => {
      ac.abort()
    }
    await expect(
      sendWithRetry(p, {} as never, ctx(), { getEmitted: () => false, signal: ac.signal, sleep }),
    ).rejects.toMatchObject({ status: 503 })
    expect(calls).toBe(1)
  })
})
