import type { ClientMsg, ServerMsg } from '@shared/protocol'
import { apiFetch } from './api'

export type WsStatus = 'connecting' | 'open' | 'closed'

// Pure, testable. NEVER hardcode the dev port (#5) — derive everything from host.
// Scheme follows the page protocol so an https tunnel uses wss (no mixed-content).
export function wsUrl(host: string, protocol: string): string {
  return (protocol === 'https:' ? 'wss://' : 'ws://') + host + '/ws'
}

// Pure auth-fail heuristic. The browser WebSocket API does not surface the
// handshake 401 status, so we infer it: a socket that closes WITHOUT ever
// opening, twice in a row, is treated as a potential auth failure.
// Callers must then probe /v1/models to confirm before destroying the token.
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
  // everOpened is reset to false at the START of every connect() attempt so
  // that a post-open close (rotated/revoked token) is detectable as a failed
  // connect rather than masked by a previous successful open. [FIX #3/#12]
  let everOpened = false
  let consecutiveFailedConnects = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  const queue: string[] = []

  const status = (s: WsStatus) => {
    if (onStatus) onStatus(s)
  }

  // Probe /v1/models with the current token to disambiguate a genuine 401
  // (bad/expired/rotated token) from a transient network or server-down blip.
  // [FIX #4/#11]
  const probeAndMaybeAuthError = async () => {
    try {
      const res = await apiFetch('/v1/models', token)
      if (res.status === 401) {
        // Confirmed bad token — hand control back to the app (clear token, Login).
        if (onAuthError) onAuthError()
        return
      }
      // Non-401 (server up but returning something else, or any 2xx/5xx) —
      // server is reachable but not indicating a bad token. Reset the streak
      // so the probe fires again after the next run of failures, then reconnect.
    } catch {
      // Fetch rejected (network down / server unreachable) — keep the token.
    }
    // Token appears valid or server unreachable: schedule a reconnect.
    consecutiveFailedConnects = 0
    if (!closedByUser) {
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer)
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined
        connect()
      }, 1000)
    }
  }

  const connect = () => {
    // Reset everOpened at the start of EVERY attempt so a post-open close
    // increments the failed-connect counter correctly. [FIX #3/#12]
    everOpened = false
    status('connecting')

    // Guard against synchronous throw from WebSocket constructor, which happens
    // when the token contains a character that is invalid in a subprotocol header
    // (e.g. comma, space, control chars). The same token would throw on every
    // retry, so treat it as a structural auth failure. [FIX #7]
    try {
      // Bearer token rides in the subprotocol so it never appears in the URL/logs.
      ws = new WebSocket(url, ['bearer', token])
    } catch {
      status('closed')
      if (onAuthError) onAuthError()
      return
    }

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
        // Do NOT immediately destroy the token — probe first to tell a genuine
        // 401 from a network/server-down blip. [FIX #4/#11]
        probeAndMaybeAuthError()
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
