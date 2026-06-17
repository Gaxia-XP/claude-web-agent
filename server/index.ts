import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import { attachWebSocketServer } from './ws'
import { ChatHub } from './hub'
import { openDb } from './store'
import { LocalAgentProvider } from './providers/localAgent'
import { pingMessage } from './health'

const PORT = Number(process.env.PORT ?? 8787)
const DB_PATH = process.env.DB_PATH ?? 'data/chats.db'

mkdirSync(dirname(DB_PATH), { recursive: true })
const db = openDb(DB_PATH)

const app = Fastify({ logger: true })
app.get('/api/health', async () => ({ status: pingMessage() }))

const hub = new ChatHub({
  db,
  makeProvider: () => new LocalAgentProvider(),
  genId: randomUUID,
  now: Date.now,
})

await app.listen({ port: PORT, host: '127.0.0.1' })
attachWebSocketServer(app.server, hub)
app.log.info(`WebSocket listening on ws://127.0.0.1:${PORT}/ws`)
