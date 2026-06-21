// server/compat/wire.test.ts
import { describe, it, expect } from 'vitest'
import { parseCompatBody } from './wire'

describe('compat/wire parseCompatBody', () => {
  it('parses a valid body (string content)', () => {
    expect(parseCompatBody({ model: 'local/sonnet', messages: [{ role: 'user', content: 'hi' }], stream: true }))
      .toEqual({ model: 'local/sonnet', messages: [{ role: 'user', content: 'hi' }], stream: true })
  })

  it('flattens an array-of-text-blocks content and drops non-text blocks', () => {
    const r = parseCompatBody({
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }, { type: 'image', source: {} }] }],
    })
    expect(r?.messages[0].content).toBe('ab')
  })

  it('returns null for a system-only body (no user/assistant turn) — the empty-input guard', () => {
    expect(parseCompatBody({ model: 'm', messages: [{ role: 'system', content: 'sys' }] })).toBeNull()
  })

  it('keeps system messages when a user/assistant turn is also present', () => {
    const r = parseCompatBody({ model: 'm', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }] })
    expect(r?.messages.map((m) => m.role)).toEqual(['system', 'user'])
  })

  it('returns null for malformed bodies', () => {
    expect(parseCompatBody({ messages: [{ role: 'user', content: 'x' }] })).toBeNull() // no model
    expect(parseCompatBody({ model: '', messages: [{ role: 'user', content: 'x' }] })).toBeNull() // empty model
    expect(parseCompatBody({ model: 'm', messages: [] })).toBeNull() // empty messages
    expect(parseCompatBody({ model: 'm', messages: [{ role: 'tool', content: 'x' }] })).toBeNull() // bad role
    expect(parseCompatBody({ model: 'm', messages: [{ role: 'user' }] })).toBeNull() // no content
    expect(parseCompatBody(undefined)).toBeNull()
  })
})
