import type { ClientMsg, ServerMsg } from '@shared/protocol'

export type WsStatus = 'connecting' | 'open' | 'closed'

// Pure, testable. NEVER hardcode the dev port (#5) — derive everything from host.
// Scheme follows the page protocol so an https tunnel uses wss (no mixed-content).
export function wsUrl(host: string, protocol: string): string {
  return (protocol === 'https:' ? 'wss://' : 'ws://') + host + '/ws'
}

// Pure auth-fail heuristic. The browser WebSocket API does not surface the
// handshake 401 status, so we infer it: a socket that closes WITHOUT ever
// opening, twice in a row, is treated as an auth failure (bad/expired token).
// A socket that did open (everOpened) is just a network blip -> keep reconnecting.
export function classifyClose(s: {
  everOpened: boolean
  consecutiveFailedConnects: number
}): 'reconnect' | 'authfail' {
  if (!s.everOpened && s.consecutiveFailedConnects >= 2) return 'authfail'
  return 'reconnect'
}

export function createWsClient(opts: {
  onMessage: (m: ServerMsg) => void
  onStatus?: (s: WsStatus) => void
  token: string
  onAuthError?: () => void
}): { send: (m: ClientMsg) => void; close: () => void } {
  const { onMessage, onStatus, token, onAuthError } = opts
  const url = wsUrl(location.host, location.protocol)

  let ws: WebSocket
  let closedByUser = false
  let everOpened = false
  let consecutiveFailedConnects = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  const queue: string[] = []

  const status = (s: WsStatus) => {
    if (onStatus) onStatus(s)
  }

  const connect = () => {
    status('connecting')
    // Bearer token rides in the subprotocol so it never appears in the URL/logs.
    ws = new WebSocket(url, ['bearer', token])

    ws.onopen = () => {
      everOpened = true
      consecutiveFailedConnects = 0
      status('open')
      for (const q of queue) ws.send(q)
      queue.length = 0
    }

    ws.onmessage = (ev) => {
      try {
        onMessage(JSON.parse(ev.data as string) as ServerMsg)
      } catch {
        /* ignore malformed frames */
      }
    }

    ws.onerror = () => {
      status('closed')
    }

    ws.onclose = () => {
      status('closed')
      if (closedByUser) return
      // Count a close that never reached onopen as a failed connect attempt.
      if (!everOpened) consecutiveFailedConnects += 1
      if (classifyClose({ everOpened, consecutiveFailedConnects }) === 'authfail') {
        // Bad/expired token: stop the (previously unbounded) reconnect loop and
        // hand control back to the app (-> clear token, show Login).
        if (onAuthError) onAuthError()
        return
      }
      // Otherwise reconnect after a short delay.
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer)
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined
        connect()
      }, 1000)
    }
  }

  connect()

  return {
    send(m: ClientMsg) {
      const raw = JSON.stringify(m)
      if (ws.readyState === WebSocket.OPEN) ws.send(raw)
      else queue.push(raw)
    },
    close() {
      closedByUser = true
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer)
        reconnectTimer = undefined
      }
      ws.close()
    },
  }
}
