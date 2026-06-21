import { describe, it, expect, vi, afterEach } from 'vitest'
import { apiFetch } from './api'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('apiFetch', () => {
  it('attaches an Authorization: Bearer header', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }))
    await apiFetch('/v1/models', 'tok-123')
    const init = spy.mock.calls[0][1] as RequestInit
    const headers = new Headers(init.headers)
    expect(headers.get('Authorization')).toBe('Bearer tok-123')
  })

  it('preserves caller-supplied headers alongside the token', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }))
    await apiFetch('/v1/models', 'tok-123', { headers: { 'X-Test': '1' } })
    const init = spy.mock.calls[0][1] as RequestInit
    const headers = new Headers(init.headers)
    expect(headers.get('X-Test')).toBe('1')
    expect(headers.get('Authorization')).toBe('Bearer tok-123')
  })
})
