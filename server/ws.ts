import type { Server } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import type { ServerMsg } from '../shared/protocol'
import type { ChatHub } from './hub'

export function attachWebSocketServer(httpServer: Server, hub: ChatHub): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' })
  wss.on('connection', (socket: WebSocket) => {
    const send = (m: ServerMsg) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(m))
    }
    const handle = hub.addConnection(send)
    socket.on('message', (data) => handle.handle(data.toString()))
    socket.on('close', () => handle.close())
    socket.on('error', () => {})
  })
  return wss
}
