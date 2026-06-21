import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import qrcode from 'qrcode'
import { ChatHub } from './hub'
import { openDb } from './store'
import { makeProvider } from './providers/index'
import { loadOrCreateToken } from './auth'
import { buildApp } from './app'
import { lanUrls } from './banner'

const PORT = Number(process.env.PORT ?? 8787)
const HOST = process.env.HOST ?? '0.0.0.0'
const DB_PATH = process.env.DB_PATH ?? 'data/chats.db'
const TOKEN_PATH = process.env.TOKEN_PATH ?? join(dirname(DB_PATH), '.token')
// undefined -> ChatHub/compat fall back to their built-in default timeout
const TURN_TIMEOUT_MS = process.env.TURN_TIMEOUT_MS
  ? Number(process.env.TURN_TIMEOUT_MS)
  : undefined

mkdirSync(dirname(DB_PATH), { recursive: true })
const db = openDb(DB_PATH)
const token = loadOrCreateToken(TOKEN_PATH)

const hub = new ChatHub({
  db,
  makeProvider,
  genId: randomUUID,
  now: Date.now,
  turnTimeoutMs: TURN_TIMEOUT_MS,
})

const webDist = join(process.cwd(), 'web/dist')
const { app } = buildApp({
  db,
  hub,
  makeProvider,
  token,
  turnTimeoutMs: TURN_TIMEOUT_MS,
  webDist,
})

await app.listen({ port: PORT, host: HOST })

// Banner via console.log (NOT the Fastify logger) so it prints as plain,
// scrapable lines. e2e-multichat.mjs keys on the substring 'listening on'.
const urls = lanUrls(networkInterfaces(), PORT)
const allUrls = [`http://localhost:${PORT}`, ...urls]
console.log('')
console.log('  Claude Web Agent is up.')
for (const url of allUrls) {
  console.log(`  listening on ${url}`)
}
console.log('')
console.log(`  token: ${token}`)

// Auto-login URL: token rides the hash fragment so it never reaches server
// logs. Prefer the first real LAN ip (phones can reach it); fall back to
// localhost when no LAN interface is present.
const primary = urls[0] ?? `http://localhost:${PORT}`
const autoLoginUrl = `${primary}/#token=${token}`
console.log('')
console.log(`  Scan to open on your phone (${autoLoginUrl}):`)
// qrcode.toString returns a Promise — must be awaited, else it logs
// "[object Promise]". tsc cannot catch this because console.log is :any.
console.log(await qrcode.toString(autoLoginUrl, { type: 'terminal', small: true }))
