import { describe, it, expect } from 'vitest'
import { wsUrl } from './ws'

describe('wsUrl', () => {
  it('builds a ws:// url from host:port', () => {
    expect(wsUrl('localhost:5173')).toBe('ws://localhost:5173/ws')
  })

  it('preserves an arbitrary LAN host and port', () => {
    expect(wsUrl('192.168.1.5:8787')).toBe('ws://192.168.1.5:8787/ws')
  })
})
