import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { loadOrCreateToken, extractToken, extractWsToken, safeEqual } from './auth'

function tmpTokenPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'auth-test-'))
  return join(dir, '.token')
}

describe('loadOrCreateToken', () => {
  it('creates and persists a 43-char base64url token when file is absent', () => {
    const p = tmpTokenPath()
    expect(existsSync(p)).toBe(false)
    const t = loadOrCreateToken(p)
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(existsSync(p)).toBe(true)
    expect(readFileSync(p, 'utf8')).toBe(t)
    rmSync(p, { force: true })
  })

  it('is idempotent: returns the existing token on subsequent calls', () => {
    const p = tmpTokenPath()
    const first = loadOrCreateToken(p)
    const second = loadOrCreateToken(p)
    expect(second).toBe(first)
    rmSync(p, { force: true })
  })

  it('trims surrounding whitespace/newline from an existing token file', () => {
    const p = tmpTokenPath()
    const first = loadOrCreateToken(p)
    // simulate a token written with a trailing newline by an editor
    writeFileSync(p, first + '\n', 'utf8')
    expect(loadOrCreateToken(p)).toBe(first)
    rmSync(p, { force: true })
  })
})

describe('extractToken', () => {
  it('reads Authorization: Bearer <t>', () => {
    expect(extractToken({ authorization: 'Bearer abc123' })).toBe('abc123')
  })

  it('reads Authorization: bearer <t> case-insensitively', () => {
    expect(extractToken({ authorization: 'bearer abc123' })).toBe('abc123')
  })

  it('reads x-api-key <t>', () => {
    expect(extractToken({ 'x-api-key': 'xyz789' })).toBe('xyz789')
  })

  it('prefers Authorization Bearer over x-api-key when both present', () => {
    expect(extractToken({ authorization: 'Bearer abc123', 'x-api-key': 'xyz789' })).toBe('abc123')
  })

  it('returns undefined when no auth header is present', () => {
    expect(extractToken({})).toBeUndefined()
  })

  it('returns undefined for a non-Bearer Authorization scheme', () => {
    expect(extractToken({ authorization: 'Basic abc123' })).toBeUndefined()
  })
})

describe('extractWsToken', () => {
  it('reads the token from "bearer, <tok>"', () => {
    expect(extractWsToken('bearer, tok123')).toBe('tok123')
  })

  it('reads with no space after the comma', () => {
    expect(extractWsToken('bearer,tok123')).toBe('tok123')
  })

  it('returns undefined when the first protocol is not "bearer"', () => {
    expect(extractWsToken('foo, tok123')).toBeUndefined()
  })

  it('returns undefined for a single protocol with no token', () => {
    expect(extractWsToken('bearer')).toBeUndefined()
  })

  it('returns undefined for an undefined header', () => {
    expect(extractWsToken(undefined)).toBeUndefined()
  })
})

describe('safeEqual', () => {
  it('returns true for equal strings', () => {
    expect(safeEqual('same-token', 'same-token')).toBe(true)
  })

  it('returns false for unequal strings of equal length', () => {
    expect(safeEqual('aaaaaaaa', 'bbbbbbbb')).toBe(false)
  })

  it('returns false for length mismatch', () => {
    expect(safeEqual('short', 'a-much-longer-token')).toBe(false)
  })

  it('returns false when a is undefined', () => {
    expect(safeEqual(undefined, 'token')).toBe(false)
  })
})
