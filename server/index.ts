import Fastify from 'fastify'
import { attachWebSocketServer } from './ws'
import { LocalAgentProvider } from './providers/localAgent'
import { pingMessage } from './health'

const PORT = Number(process.env.PORT ?? 8787)

const app = Fastify({ logger: true })
app.get('/api/health', async () => ({ status: pingMessage() }))

await app.listen({ port: PORT, host: '127.0.0.1' })
attachWebSocketServer(app.server, () => new LocalAgentProvider())
app.log.info(`WebSocket listening on ws://127.0.0.1:${PORT}/ws`)
