import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { wsUrl, classifyClose } from './ws'

// ---------------------------------------------------------------------------
// Pure unit tests — these do not depend on globals
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Stateful integration tests for createWsClient
// Uses fake WebSocket + fake fetch stubs + fake timers in env=node.
// ---------------------------------------------------------------------------

// Minimal fake WebSocket that lets the test drive onopen/onclose/onerror.
class FakeWebSocket {
  static OPEN = 1
  static CLOSED = 3
  readyState: number = 0 // CONNECTING
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: (() => void) | null = null

  // Track all instances created so tests can drive them.
  static instances: FakeWebSocket[] = []

  constructor(
    public url: string,
    public protocols: string[],
  ) {
    FakeWebSocket.instances.push(this)
  }

  send(_data: string) {}

  close() {
    this.readyState = FakeWebSocket.CLOSED
    if (this.onclose) this.onclose()
  }

  // Helpers for tests to simulate server events.
  simulateOpen() {
    this.readyState = FakeWebSocket.OPEN
    if (this.onopen) this.onopen()
  }

  simulateClose() {
    this.readyState = FakeWebSocket.CLOSED
    if (this.onclose) this.onclose()
  }
}

describe('createWsClient stateful tests', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    // Stub globals needed by createWsClient.
    Object.defineProperty(globalThis, 'WebSocket', {
      value: FakeWebSocket,
      writable: true,
      configurable: true,
    })
    Object.defineProperty(globalThis, 'location', {
      value: { host: 'localhost:8787', protocol: 'http:' },
      writable: true,
      configurable: true,
    })
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    // Clean up globals.
    // @ts-expect-error — deleting injected globals
    delete globalThis.WebSocket
    // @ts-expect-error
    delete globalThis.location
  })

  it('(a) 401 probe: open once then two close-without-open -> onAuthError fires once, no reconnect', async () => {
    // Stub fetch to return 401.
    const fetchStub = vi.fn().mockResolvedValue({ status: 401 } as Response)
    vi.stubGlobal('fetch', fetchStub)

    const onAuthError = vi.fn()
    const { createWsClient } = await import('./ws')
    createWsClient({
      onMessage: () => {},
      token: 'tok',
      onAuthError,
    })

    // First connect — let it open successfully.
    let ws = FakeWebSocket.instances[0]
    ws.simulateOpen()
    expect(onAuthError).not.toHaveBeenCalled()

    // Now close without opening (simulates token rotated mid-session).
    ws.simulateClose()
    // After 1 s the reconnect fires.
    vi.advanceTimersByTime(1000)

    ws = FakeWebSocket.instances[1]
    // This connect closes without opening → consecutiveFailedConnects = 1, no authfail yet.
    ws.simulateClose()
    vi.advanceTimersByTime(1000)

    ws = FakeWebSocket.instances[2]
    // Second close-without-open → consecutiveFailedConnects = 2, authfail → probe.
    ws.simulateClose()

    // Let the probe promise settle.
    await vi.runAllTimersAsync()

    // fetch should have been called with /v1/models.
    expect(fetchStub).toHaveBeenCalledWith(
      '/v1/models',
      expect.objectContaining({
        headers: expect.anything(),
      }),
    )
    // 401 confirmed → onAuthError fires exactly once.
    expect(onAuthError).toHaveBeenCalledTimes(1)
    // No further reconnect timer should be set.
    const instanceCountAfter = FakeWebSocket.instances.length
    vi.advanceTimersByTime(2000)
    expect(FakeWebSocket.instances.length).toBe(instanceCountAfter)
  })

  it('(b) network-down probe: two close-without-open with fetch REJECT -> onAuthError NOT fired, reconnect scheduled', async () => {
    // Stub fetch to reject (network unreachable).
    const fetchStub = vi.fn().mockRejectedValue(new Error('net::ERR_CONNECTION_REFUSED'))
    vi.stubGlobal('fetch', fetchStub)

    const onAuthError = vi.fn()
    const { createWsClient } = await import('./ws')
    createWsClient({
      onMessage: () => {},
      token: 'tok',
      onAuthError,
    })

    let ws = FakeWebSocket.instances[0]
    // Close without opening → consecutiveFailedConnects = 1.
    ws.simulateClose()
    vi.advanceTimersByTime(1000)

    ws = FakeWebSocket.instances[1]
    // Close without opening → consecutiveFailedConnects = 2, authfail → probe.
    ws.simulateClose()

    // Let the probe promise settle (fetch rejects).
    await vi.runAllTimersAsync()

    // onAuthError must NOT have been called — token is preserved.
    expect(onAuthError).not.toHaveBeenCalled()
    // A reconnect should have been scheduled → new WebSocket instance created.
    expect(FakeWebSocket.instances.length).toBeGreaterThan(2)
  })
})
