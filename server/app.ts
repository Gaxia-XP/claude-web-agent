import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import type { WebSocketServer } from 'ws'
import { attachWebSocketServer } from './ws'
import { ChatHub } from './hub'
import { registerHttpApi } from './http-api'
import { registerCompatApi } from './compat/index'
import { extractToken, safeEqual } from './auth'
import { pingMessage } from './health'
import type { DB } from './store'
import type { ProviderConfig } from './providers/index'
import type { Provider } from './providers/types'

export interface BuildAppDeps {
  db: DB
  hub: ChatHub
  makeProvider: (cfg: ProviderConfig) => Provider
  token: string
  turnTimeoutMs?: number
  webDist?: string
}

// §4: a request is allowlisted (token NOT required) when it is GET /api/health, or any path that
// is neither an /api/* call nor a /v1/* call (i.e. static SPA assets / index.html). Everything else
// is guarded. Bare /api and /v1 (no trailing slash) are also guarded so a future bare-path route
// cannot silently bypass the auth boundary.
function isAllowlisted(req: FastifyRequest): boolean {
  const path = req.url.split('?')[0]
  if (req.method === 'GET' && path === '/api/health') return true
  if (path === '/api' || path.startsWith('/api/')) return false
  if (path === '/v1' || path.startsWith('/v1/')) return false
  return true
}

// §4: send the per-surface hand-rolled 401 body. We do NOT reuse the compat openaiError/anthropicError
// helpers — they are file-private AND map non-404/400 statuses to 'api_error', whereas the contract
// requires 'authentication_error' here. Always advertise the scheme via WWW-Authenticate: Bearer.
function sendUnauthorized(req: FastifyRequest, reply: FastifyReply): void {
  const path = req.url.split('?')[0]
  const message = 'missing or invalid token'
  reply.code(401).header('WWW-Authenticate', 'Bearer')
  if (path === '/v1/messages') {
    reply.send({ type: 'error', error: { type: 'authentication_error', message } })
  } else if (path.startsWith('/v1/')) {
    reply.send({ error: { message, type: 'authentication_error' } })
  } else {
    reply.send({ error: 'unauthorized' })
  }
}

// Central wiring factory. Builds a Fastify instance with the global auth guard + all routes and
// attaches the (token-guarded) WebSocket server to its underlying http server. Does NOT call listen.
export function buildApp(deps: BuildAppDeps): { app: FastifyInstance; wss: WebSocketServer } {
  const { db, hub, makeProvider, token, turnTimeoutMs, webDist } = deps
  const app = Fastify({ logger: false })

  // Global guard runs before every route. Allowlisted requests pass through untouched; guarded ones
  // must present a matching token (Authorization: Bearer | x-api-key) or get a hand-rolled 401.
  app.addHook('onRequest', async (req, reply) => {
    if (isAllowlisted(req)) return
    if (safeEqual(extractToken(req.headers), token)) return
    sendUnauthorized(req, reply)
  })

  // /api/health is allowlisted above; register it here (moved out of index.ts in M6) so the route exists.
  app.get('/api/health', async () => ({ status: pingMessage() }))

  registerHttpApi(app, { hub, db })
  registerCompatApi(app, { db, makeProvider, turnTimeoutMs })

  // §7 static / single-origin: serve the built SPA only when the dist exists (dev/test omit it).
  if (webDist && existsSync(webDist)) {
    app.register(fastifyStatic, { root: webDist })
    const indexHtml = join(webDist, 'index.html')
    // SPA fallback: any GET that isn't an API/WS path serves index.html so client-side routing works.
    app.setNotFoundHandler((req, reply) => {
      const path = req.url.split('?')[0]
      const isApi = path === '/api' || path.startsWith('/api/') || path === '/v1' || path.startsWith('/v1/') || path === '/ws'
      if (req.method === 'GET' && !isApi && existsSync(indexHtml)) {
        return reply.type('text/html').sendFile('index.html')
      }
      reply.code(404).send({ error: 'not found' })
    })
  }

  const wss = attachWebSocketServer(app.server, hub, { token })
  return { app, wss }
}
