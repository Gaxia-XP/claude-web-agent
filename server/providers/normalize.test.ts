import { describe, it, expect } from 'vitest'
import { normalizeToolResult } from './normalize'

describe('normalizeToolResult', () => {
  it('returns a plain string unchanged', () => {
    expect(normalizeToolResult('file body')).toBe('file body')
  })

  it('joins text blocks of an array with newlines', () => {
    const raw = [
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ]
    expect(normalizeToolResult(raw)).toBe('a\nb')
  })

  it('ignores non-text blocks inside an array', () => {
    const raw = [
      { type: 'text', text: 'a' },
      { type: 'image', source: { data: 'xxx' } },
      { type: 'text', text: 'b' },
    ]
    expect(normalizeToolResult(raw)).toBe('a\nb')
  })

  it('unwraps a single text block object', () => {
    expect(normalizeToolResult({ type: 'text', text: 'x' })).toBe('x')
  })

  it('returns empty string for null', () => {
    expect(normalizeToolResult(null)).toBe('')
  })

  it('returns empty string for undefined', () => {
    expect(normalizeToolResult(undefined)).toBe('')
  })

  it('JSON.stringify for an arbitrary object', () => {
    expect(normalizeToolResult({ foo: 1 })).toBe('{"foo":1}')
  })
})
