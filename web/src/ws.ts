import type { ClientMsg, ServerMsg } from '@shared/protocol'

export function createWsClient(onMessage: (m: ServerMsg) => void) {
  const url = `ws://${location.hostname}:5173/ws` // ผ่าน Vite proxy
  const ws = new WebSocket(url)
  const queue: string[] = []

  ws.onopen = () => {
    for (const q of queue) ws.send(q)
    queue.length = 0
  }
  ws.onmessage = (ev) => {
    try {
      onMessage(JSON.parse(ev.data) as ServerMsg)
    } catch {
      /* ignore */
    }
  }

  return {
    send(m: ClientMsg) {
      const raw = JSON.stringify(m)
      if (ws.readyState === WebSocket.OPEN) ws.send(raw)
      else queue.push(raw)
    },
    close() {
      ws.close()
    },
  }
}
