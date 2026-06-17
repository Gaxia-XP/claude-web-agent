import type { ClientMsg, ServerMsg } from '@shared/protocol'

export type WsStatus = 'connecting' | 'open' | 'closed'

// Pure, testable. NEVER hardcode the dev port (#5) — derive everything from host.
export function wsUrl(host: string): string {
  return 'ws://' + host + '/ws'
}

export function createWsClient(opts: {
  onMessage: (m: ServerMsg) => void
  onStatus?: (s: WsStatus) => void
}): { send: (m: ClientMsg) => void; close: () => void } {
  const { onMessage, onStatus } = opts
  const url = wsUrl(location.host)

  let ws: WebSocket
  let closedByUser = false
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  const queue: string[] = []

  const status = (s: WsStatus) => {
    if (onStatus) onStatus(s)
  }

  const connect = () => {
    status('connecting')
    ws = new WebSocket(url)

    ws.onopen = () => {
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
      // Single auto-reconnect attempt after a short delay (unexpected close only).
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
