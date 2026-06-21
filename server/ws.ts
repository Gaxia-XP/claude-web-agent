import type { Server } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import type { ServerMsg } from '../shared/protocol'
import type { ChatHub } from './hub'
import { extractWsToken, safeEqual } from './auth'

export function attachWebSocketServer(
  httpServer: Server,
  hub: ChatHub,
  opts?: { token?: string },
): WebSocketServer {
  const token = opts?.token
  // With a token: gate the HTTP upgrade via verifyClient and force the accepted
  // subprotocol to 'bearer'. Without one: keep the original unauthenticated path.
  const wss = token
    ? new WebSocketServer({
        server: httpServer,
        path: '/ws',
        handleProtocols: () => 'bearer',
        verifyClient: ({ req }, done) =>
          done(
            safeEqual(extractWsToken(req.headers['sec-websocket-protocol']), token),
            401,
            'Unauthorized',
          ),
      })
    : new WebSocketServer({ server: httpServer, path: '/ws' })
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
