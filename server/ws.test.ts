import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import WebSocket from 'ws'
import { openDb } from './store'
import { ChatHub } from './hub'
import { makeProvider } from './providers/index'
import { attachWebSocketServer } from './ws'

// Build a real http.Server + ChatHub, attach the WS server with a token, and
// start listening on an ephemeral port. Returns the live ws:// origin + teardown.
function startServer(token?: string): Promise<{ url: string; close: () => Promise<void> }> {
  const db = openDb(':memory:')
  const hub = new ChatHub({ db, makeProvider, genId: () => 'id', now: () => 0 })
  const httpServer: Server = createServer()
  attachWebSocketServer(httpServer, hub, token ? { token } : undefined)
  return new Promise((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const { port } = httpServer.address() as AddressInfo
      resolve({
        url: `ws://127.0.0.1:${port}/ws`,
        close: () =>
          new Promise<void>((done) => {
            db.close()
            httpServer.close(() => done())
          }),
      })
    })
  })
}

// Connect once and resolve which terminal event fired first: 'open' or 'rejected'.
// 'rejected' covers both the verifyClient 401 (client 'error') and any close-before-open.
function probe(url: string, protocols?: string[]): Promise<{ result: 'open' | 'rejected'; protocol: string }> {
  return new Promise((resolve) => {
    const ws = protocols ? new WebSocket(url, protocols) : new WebSocket(url)
    let settled = false
    const settle = (result: 'open' | 'rejected', protocol = '') => {
      if (settled) return
      settled = true
      resolve({ result, protocol })
      ws.close()
    }
    ws.on('open', () => settle('open', ws.protocol))
    ws.on('error', () => settle('rejected'))
    ws.on('unexpected-response', () => settle('rejected'))
    ws.on('close', () => settle('rejected'))
  })
}

describe('attachWebSocketServer token subprotocol auth', () => {
  let teardown: (() => Promise<void>) | null = null
  afterEach(async () => {
    if (teardown) await teardown()
    teardown = null
  })

  it('accepts a client presenting the correct bearer token and reports protocol bearer', async () => {
    const { url, close } = await startServer('T')
    teardown = close
    const r = await probe(url, ['bearer', 'T'])
    expect(r.result).toBe('open')
    expect(r.protocol).toBe('bearer')
  })

  it('rejects a client presenting the wrong bearer token (never opens)', async () => {
    const { url, close } = await startServer('T')
    teardown = close
    const r = await probe(url, ['bearer', 'WRONG'])
    expect(r.result).toBe('rejected')
  })

  it('rejects a client with no subprotocol (never opens)', async () => {
    const { url, close } = await startServer('T')
    teardown = close
    const r = await probe(url)
    expect(r.result).toBe('rejected')
  })

  it('opens with no auth when opts.token is absent (back-compat)', async () => {
    const { url, close } = await startServer()
    teardown = close
    const r = await probe(url)
    expect(r.result).toBe('open')
  })
})
