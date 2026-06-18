// Live e2e for the native HTTP API (REST + SSE) — NO external credentials.
// Boots a fake OpenAI-compatible SSE upstream + the real Fastify/REST/WS/hub stack against
// a temp DB, seeds an openai-compatible connection in the DB, then: creates a chat over REST,
// sends a non-stream message, sends a streaming (SSE) message, and asserts a subscribed WS
// ALSO received the turn (live-sync) + persistence + /api/query + no api_key leak.
// Run: npx tsx scripts/e2e-rest.mjs
import http from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import { WebSocket } from 'ws'
import { attachWebSocketServer } from '../server/ws'
import { registerHttpApi } from '../server/http-api'
import { ChatHub } from '../server/hub'
import { openDb, listMessages, createConnection } from '../server/store'
import { makeProvider } from '../server/providers/index'

function fail(msg) {
  console.error('❌', msg)
  process.exit(1)
}

// 1) Fake OpenAI-compatible upstream: streams "Hello rest" then [DONE].
const fake = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.endsWith('/chat/completions')) {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const p of ['Hello', ' ', 'rest']) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 3, completion_tokens: 3 } })}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
    return
  }
  res.writeHead(404).end()
})
await new Promise((r) => fake.listen(0, r))
const baseUrl = `http://127.0.0.1:${fake.address().port}/v1`

// 2) Backend: Fastify + REST API + WS, temp DB, seeded openai-compatible connection.
const dbPath = join(mkdtempSync(join(tmpdir(), 'cwa-e2e-rest-')), 'chats.db')
const db = openDb(dbPath)
const app = Fastify()
const hub = new ChatHub({ db, makeProvider, genId: randomUUID, now: Date.now })
registerHttpApi(app, { hub, db })
attachWebSocketServer(app.server, hub)
await app.listen({ port: 0, host: '127.0.0.1' })
const port = app.server.address().port
const api = `http://127.0.0.1:${port}/api`

const connId = randomUUID()
createConnection(db, {
  id: connId,
  type: 'openai-compatible',
  name: 'e2e-rest',
  baseUrl,
  apiKey: 'unused',
  defaultModel: 'fake-model',
  now: Date.now(),
})

// 3) A WS subscriber to prove live-sync of REST-originated turns.
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
const wsMsgs = []
ws.on('message', (raw) => wsMsgs.push(JSON.parse(raw.toString())))
await new Promise((resolve) => ws.on('open', resolve))

// 4) Create a chat over REST.
const createRes = await fetch(`${api}/chats`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ connectionId: connId, model: 'fake-model', title: 'rest' }),
})
if (createRes.status !== 201) fail(`POST /api/chats -> ${createRes.status}`)
const { chatId } = await createRes.json()
if (!chatId) fail('POST /api/chats returned no chatId')

// Subscribe the WS to the chat so it receives the turn broadcasts.
ws.send(JSON.stringify({ type: 'subscribe', chatId }))
await new Promise((r) => setTimeout(r, 50))

// 5) Non-stream message.
const nsRes = await fetch(`${api}/chats/${chatId}/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: 'hi', stream: false }),
})
const ns = await nsRes.json()
if (ns.text !== 'Hello rest') fail(`non-stream text was ${JSON.stringify(ns)}`)

// 6) Streaming (SSE) message.
const sseRes = await fetch(`${api}/chats/${chatId}/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: 'again', stream: true }),
})
if (!sseRes.ok) fail(`SSE status ${sseRes.status}`)
const sseBody = await sseRes.text()
const sseDeltas = [...sseBody.matchAll(/event: delta\ndata: (.+)/g)].map((m) => JSON.parse(m[1]).text).join('')
if (sseDeltas !== 'Hello rest') fail(`SSE deltas were "${sseDeltas}" (raw: ${sseBody})`)
if (!/event: done/.test(sseBody)) fail('SSE stream missing "done" event')

// 7) Live-sync: the WS subscriber received both turns' deltas + turn_done for this chat.
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('timeout waiting for WS turn_done')), 10000)
  const iv = setInterval(() => {
    const dones = wsMsgs.filter((m) => m.type === 'turn_done' && m.chatId === chatId).length
    if (dones >= 2) {
      clearTimeout(t)
      clearInterval(iv)
      resolve()
    }
  }, 20)
}).catch((e) => fail(e.message))
const wsText = wsMsgs.filter((m) => m.type === 'assistant_delta' && m.chatId === chatId).map((m) => m.text).join('')
if (wsText !== 'Hello restHello rest') fail(`WS live-sync deltas were "${wsText}"`)

// 8) Persistence: two turns -> user,assistant,user,assistant.
const roles = listMessages(db, chatId).map((m) => m.role).join(',')
if (roles !== 'user,assistant,user,assistant') fail(`persisted roles were ${roles}`)

// 9) /api/query one-off.
const qRes = await fetch(`${api}/query`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ connectionId: connId, model: 'fake-model', text: 'once', stream: false }),
})
const q = await qRes.json()
if (!q.chatId || q.text !== 'Hello rest') fail(`/api/query returned ${JSON.stringify(q)}`)

// 10) GET /api/connections never leaks api_key.
const conns = await (await fetch(`${api}/connections`)).json()
if (conns.connections.some((c) => 'apiKey' in c)) fail('apiKey leaked in GET /api/connections')

console.log('✅ native HTTP API e2e PASS — REST + SSE + live-sync + persistence + /api/query')
ws.close()
await app.close()
fake.close()
process.exit(0)
