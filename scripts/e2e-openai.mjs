// Live e2e for the OpenAI-compatible provider — NO external credentials.
// Boots a fake OpenAI-compatible SSE server + the real Fastify/WS/hub stack
// against a temp DB, then drives it over a real WebSocket: create connection ->
// create chat -> user_message -> assert streamed reply + persisted history.
// Run: npx tsx scripts/e2e-openai.mjs
import http from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import { WebSocket } from 'ws'
import { attachWebSocketServer } from '../server/ws'
import { ChatHub } from '../server/hub'
import { openDb, listMessages } from '../server/store'
import { makeProvider } from '../server/providers/index'

function fail(msg) {
  console.error('❌', msg)
  process.exit(1)
}

// 1) Fake OpenAI-compatible server: streams "Hello e2e" then [DONE].
const fake = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.endsWith('/chat/completions')) {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const pieces = ['Hello', ' ', 'e2e']
    for (const p of pieces) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 3, completion_tokens: 3 } })}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
    return
  }
  res.writeHead(404).end()
})
await new Promise((r) => fake.listen(0, r))
const fakePort = fake.address().port
const baseUrl = `http://127.0.0.1:${fakePort}/v1`

// 2) Backend with a temp DB.
const dbPath = join(mkdtempSync(join(tmpdir(), 'cwa-e2e-')), 'chats.db')
const db = openDb(dbPath)
const app = Fastify()
const hub = new ChatHub({ db, makeProvider, genId: randomUUID, now: Date.now })
attachWebSocketServer(app.server, hub)
await app.listen({ port: 0, host: '127.0.0.1' })
const port = app.server.address().port

// 3) Drive over a real WebSocket.
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
const sent = []
let connId
let chatId
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString())
  sent.push(m)
  if (m.type === 'connection_list') {
    const c = m.connections.find((x) => x.name === 'e2e-openai')
    if (c && !connId) {
      connId = c.id
      ws.send(JSON.stringify({ type: 'create_chat', title: 'e2e', connectionId: connId, model: 'fake-model' }))
    }
  }
  if (m.type === 'chat_created') {
    chatId = m.chat.id
    ws.send(JSON.stringify({ type: 'user_message', chatId, text: 'hi there' }))
  }
})

await new Promise((resolve) => ws.on('open', resolve))
ws.send(JSON.stringify({ type: 'create_connection', name: 'e2e-openai', providerType: 'openai-compatible', baseUrl, apiKey: 'unused', defaultModel: 'fake-model' }))

// 4) Wait for turn_done, then assert.
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('timeout waiting for turn_done')), 10000)
  const iv = setInterval(() => {
    if (sent.some((m) => m.type === 'turn_done' && m.chatId === chatId)) {
      clearTimeout(t)
      clearInterval(iv)
      resolve()
    }
  }, 20)
}).catch((e) => fail(e.message))

const text = sent
  .filter((m) => m.type === 'assistant_delta' && m.chatId === chatId)
  .map((m) => m.text)
  .join('')
if (text !== 'Hello e2e') fail(`expected streamed "Hello e2e", got "${text}"`)

const msgs = listMessages(db, chatId)
const roles = msgs.map((m) => m.role).join(',')
if (roles !== 'user,assistant') fail(`expected persisted user,assistant; got ${roles}`)
const asstText = msgs[1].content.find((b) => b.type === 'text')
if (!asstText || asstText.text !== 'Hello e2e') fail('assistant text not persisted correctly')

console.log('✅ openai-compatible e2e PASS — streamed + persisted "Hello e2e"')
ws.close()
await app.close()
fake.close()
process.exit(0)
