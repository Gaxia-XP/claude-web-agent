import { describe, it, expect } from 'vitest'
import { wsUrl, classifyClose } from './ws'

describe('wsUrl', () => {
  it('uses ws:// under http', () => {
    expect(wsUrl('localhost:5173', 'http:')).toBe('ws://localhost:5173/ws')
  })

  it('uses wss:// under https (tunnel)', () => {
    expect(wsUrl('agent.example.com', 'https:')).toBe('wss://agent.example.com/ws')
  })

  it('preserves an arbitrary LAN host and port', () => {
    expect(wsUrl('192.168.1.5:8787', 'http:')).toBe('ws://192.168.1.5:8787/ws')
  })
})

describe('classifyClose', () => {
  it('reconnects when the socket had opened before', () => {
    expect(classifyClose({ everOpened: true, consecutiveFailedConnects: 5 })).toBe('reconnect')
  })

  it('reconnects on a single failed connect that never opened', () => {
    expect(classifyClose({ everOpened: false, consecutiveFailedConnects: 1 })).toBe('reconnect')
  })

  it('flags authfail after 2 consecutive failed connects that never opened', () => {
    expect(classifyClose({ everOpened: false, consecutiveFailedConnects: 2 })).toBe('authfail')
  })

  it('stays authfail beyond the threshold', () => {
    expect(classifyClose({ everOpened: false, consecutiveFailedConnects: 3 })).toBe('authfail')
  })
})
