import { describe, it, expect } from 'vitest'
import { hostIsLoopback, qrCandidates, defaultQrBase, qrTarget } from './qr'

describe('qr/hostIsLoopback', () => {
  it('detects loopback / non-routable hosts', () => {
    expect(hostIsLoopback('http://localhost:8787')).toBe(true)
    expect(hostIsLoopback('http://127.0.0.1:8787')).toBe(true)
    expect(hostIsLoopback('http://0.0.0.0:8787')).toBe(true)
  })
  it('treats real LAN / public hosts as non-loopback', () => {
    expect(hostIsLoopback('http://192.168.1.2:8787')).toBe(false)
    expect(hostIsLoopback('http://10.0.0.5:8787')).toBe(false)
    expect(hostIsLoopback('https://example.com')).toBe(false)
  })
  it('returns false for an unparseable origin', () => {
    expect(hostIsLoopback('not a url')).toBe(false)
  })
})

describe('qr/qrCandidates', () => {
  it('lists origin first, then LAN urls, normalized + deduped', () => {
    expect(qrCandidates('http://localhost:8787', ['http://192.168.1.2:8787/', 'http://10.0.0.5:8787'])).toEqual([
      'http://localhost:8787',
      'http://192.168.1.2:8787',
      'http://10.0.0.5:8787',
    ])
  })
  it('dedupes when a LAN url equals the origin', () => {
    expect(qrCandidates('http://192.168.1.2:8787', ['http://192.168.1.2:8787'])).toEqual(['http://192.168.1.2:8787'])
  })
  it('drops blank entries', () => {
    expect(qrCandidates('http://localhost:8787', ['', '  '])).toEqual(['http://localhost:8787'])
  })
})

describe('qr/defaultQrBase', () => {
  it('prefers the first LAN url when the origin is loopback', () => {
    expect(defaultQrBase('http://localhost:8787', ['http://192.168.1.2:8787', 'http://10.0.0.5:8787'])).toBe(
      'http://192.168.1.2:8787',
    )
  })
  it('keeps the origin when it is already a real (non-loopback) host', () => {
    expect(defaultQrBase('http://192.168.1.2:8787', ['http://10.0.0.5:8787'])).toBe('http://192.168.1.2:8787')
  })
  it('falls back to the origin when there are no LAN urls (even if loopback)', () => {
    expect(defaultQrBase('http://localhost:8787', [])).toBe('http://localhost:8787')
  })
})

describe('qr/qrTarget', () => {
  it('builds the auto-login URL with the token on the hash', () => {
    expect(qrTarget('http://192.168.1.2:8787', 'tok123')).toBe('http://192.168.1.2:8787/#token=tok123')
  })
  it('does not double a trailing slash', () => {
    expect(qrTarget('http://192.168.1.2:8787/', 'tok123')).toBe('http://192.168.1.2:8787/#token=tok123')
  })
})
