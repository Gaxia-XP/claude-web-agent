import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { parseClientMsg, type ServerMsg } from '../shared/protocol'
import { InteractivePermissionResolver } from './permission'
import { runTurn } from './agent'
import type { Provider } from './providers/types'

export class ChatSession {
  private permission: InteractivePermissionResolver
  private sdkSessionId?: string
  private currentAbort?: AbortController
  private queue: string[] = []
  private running = false
  private disposed = false

  constructor(
    private send: (m: ServerMsg) => void,
    private provider: Provider,
    private opts: { cwd?: string; model?: string } = {},
  ) {
    this.permission = new InteractivePermissionResolver(send, () => randomUUID())
  }

  handle(raw: string): void {
    if (this.disposed) return
    const msg = parseClientMsg(raw)
    if (!msg) return
    switch (msg.type) {
      case 'user_message':
        this.queue.push(msg.text)
        void this.drain()
        break
      case 'permission_response':
        this.permission.handleResponse(msg.requestId, msg.decision)
        break
      case 'interrupt':
        this.currentAbort?.abort()
        this.permission.cancelAll('interrupted by user')
        break
    }
  }

  dispose(): void {
    this.disposed = true
    this.currentAbort?.abort()
    this.permission.cancelAll('connection closed')
    this.queue = []
  }

  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.queue.length > 0 && !this.disposed) {
        const userText = this.queue.shift() as string
        const ac = new AbortController()
        this.currentAbort = ac
        const result = await runTurn(
          this.provider,
          { userText, cwd: this.opts.cwd, model: this.opts.model ?? 'sonnet', sdkSessionId: this.sdkSessionId },
          { send: this.send, permission: this.permission, signal: ac.signal },
        )
        if (result.sdkSessionId) this.sdkSessionId = result.sdkSessionId
      }
    } finally {
      this.running = false
    }
  }
}

export function attachWebSocketServer(httpServer: Server, makeProvider: () => Provider): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' })
  wss.on('connection', (socket: WebSocket) => {
    const send = (m: ServerMsg) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(m))
    }
    const session = new ChatSession(send, makeProvider(), { cwd: process.cwd() })
    socket.on('message', (data) => session.handle(data.toString()))
    socket.on('error', () => {})
    socket.on('close', () => session.dispose())
  })
  return wss
}
