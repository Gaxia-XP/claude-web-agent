/**
 * e2e-ws.mjs — headless WebSocket end-to-end test for M1 Claude Web Agent
 *
 * Starts the Fastify+WS server in a child process, connects a ws client,
 * sends a read-tool prompt, auto-answers permission_request with allow,
 * then sends a write-tool prompt and denies it.
 *
 * Usage: npx tsx scripts/e2e-ws.mjs
 */

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocket } from 'ws'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dir = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dir, '..')
const PORT = 8788 // use a different port so we don't collide with a running dev server

// ── Start server child process ──────────────────────────────────────────────
console.log('[e2e] Starting server on port', PORT, '…')
const server = spawn(
  'npx',
  ['tsx', 'server/index.ts'],
  {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  }
)

let serverReady = false
server.stdout.on('data', (d) => {
  const s = d.toString()
  process.stdout.write('[server] ' + s)
  if (s.includes('WebSocket listening')) serverReady = true
})
server.stderr.on('data', (d) => process.stderr.write('[server-err] ' + d.toString()))
server.on('exit', (code) => console.log('[server] exited', code))

// Wait up to 20 s for server ready
for (let i = 0; i < 40; i++) {
  if (serverReady) break
  await delay(500)
}
if (!serverReady) {
  console.error('[e2e] Server never became ready — aborting')
  server.kill()
  process.exit(1)
}
console.log('[e2e] Server ready.')

// ── Helper: run one WS conversation and collect messages ────────────────────
async function runConversation(prompt, autoAllow, timeoutMs = 90_000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
    const messages = []
    let done = false

    const timer = setTimeout(() => {
      if (!done) {
        done = true
        ws.close()
        resolve({ timeout: true, messages })
      }
    }, timeoutMs)

    ws.on('open', () => {
      console.log(`\n[e2e] Connected. Sending: "${prompt}"`)
      ws.send(JSON.stringify({ type: 'user_message', text: prompt }))
    })

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      messages.push(msg)
      console.log('[ws→client]', JSON.stringify(msg).slice(0, 200))

      if (msg.type === 'permission_request') {
        const decision = autoAllow ? 'allow' : 'deny'
        console.log(`[e2e] permission_request for "${msg.name}" → ${decision}`)
        ws.send(JSON.stringify({ type: 'permission_response', requestId: msg.requestId, decision }))
      }

      if (msg.type === 'turn_done') {
        done = true
        clearTimeout(timer)
        ws.close()
        resolve({ timeout: false, messages })
      }
    })

    ws.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
  })
}

// ── Test 1: read tool (auto-allow) ─────────────────────────────────────────
console.log('\n=== TEST 1: read tool prompt (auto-allow) ===')
const t1 = await runConversation(
  'Read the file package.json and tell me the project name',
  true,
  90_000
)
console.log('\n[e2e] Test 1 summary:')
console.log('  timeout?', t1.timeout)
console.log('  messages received:', t1.messages.length)
const t1Types = t1.messages.map((m) => m.type)
console.log('  message types:', t1Types.join(', '))
const t1HasDelta = t1.messages.some((m) => m.type === 'assistant_delta')
const t1HasToolCall = t1.messages.some((m) => m.type === 'tool_call')
const t1HasTurnDone = t1.messages.some((m) => m.type === 'turn_done')
console.log('  has assistant_delta:', t1HasDelta)
console.log('  has tool_call:', t1HasToolCall)
console.log('  has turn_done:', t1HasTurnDone)

// ── Test 2: write tool (deny) ───────────────────────────────────────────────
console.log('\n=== TEST 2: write tool prompt (deny) ===')
const t2 = await runConversation(
  'Create a file called hello-e2e.txt with the word "hi" in it',
  false,
  90_000
)
console.log('\n[e2e] Test 2 summary:')
console.log('  timeout?', t2.timeout)
const t2HasPermReq = t2.messages.some((m) => m.type === 'permission_request')
const t2HasTurnDone = t2.messages.some((m) => m.type === 'turn_done')
console.log('  has permission_request:', t2HasPermReq)
console.log('  has turn_done:', t2HasTurnDone)

// ── Shut down server ────────────────────────────────────────────────────────
console.log('\n[e2e] Killing server…')
server.kill('SIGTERM')
await delay(1000)
if (!server.killed) server.kill('SIGKILL')

// ── Final verdict ───────────────────────────────────────────────────────────
console.log('\n=== E2E RESULT ===')
const pass =
  !t1.timeout && t1HasDelta && t1HasToolCall && t1HasTurnDone &&
  !t2.timeout && t2HasPermReq && t2HasTurnDone
console.log(pass ? 'PASS' : 'FAIL')
if (!pass) process.exit(1)
