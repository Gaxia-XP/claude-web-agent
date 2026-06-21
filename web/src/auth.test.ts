import { describe, it, expect } from 'vitest'
import { parseTokenFromHash } from './auth'

describe('parseTokenFromHash', () => {
  it('extracts the token from a #token=... fragment', () => {
    expect(parseTokenFromHash('#token=abc')).toBe('abc')
  })

  it('extracts a long url-safe token verbatim', () => {
    const t = 'Ab_3-xYz0123456789_kQwErTyUiOpAsDfGhJkLzXcVbN'
    expect(parseTokenFromHash('#token=' + t)).toBe(t)
  })

  it('returns null when the token value is empty', () => {
    expect(parseTokenFromHash('#token=')).toBe(null)
  })

  it('returns null for an empty hash', () => {
    expect(parseTokenFromHash('')).toBe(null)
  })

  it('returns null when no token key is present', () => {
    expect(parseTokenFromHash('#other=1')).toBe(null)
  })

  it('returns null for a bare hash', () => {
    expect(parseTokenFromHash('#')).toBe(null)
  })
})
