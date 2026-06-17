/**
 * e2e-resume.mjs — live two-turn SDK resume gate (scrutinize #2)
 *
 * HARD GATE for M2. Proves that the Claude Agent SDK's session resume,
 * driven by the server's in-memory sdkSessionId carry-over, preserves
 * conversation context across TWO turns on ONE WebSocket connection,
 * BEFORE we build SQLite persistence that depends on that behavior.
 *
 * Runs against the CURRENT (M1) server/protocol: user_message has NO
 * chatId yet (protocol v2 lands in Task 3). It relies on server/ws.ts
 * ChatSession keeping sdkSessionId in memory between turns on the same
 * socket (one ChatSession per socket).
 *
 * TEMPORARY: removed in Task 14, superseded by scripts/e2e-multichat.mjs.
 *
 * Usage: npx tsx scripts/e2e-resume.mjs   (requires Claude Agent SDK login)
 * Exit:  0 = PASS, 1 = FAIL.
 */

import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocket } from 'ws'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dir = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dir, '..')
const PORT = 8789 // dedicated port so we never collide with dev (5173) / e2e-ws (8788)
const CODEWORD = 'BANANA47'

// ── Start server child process ─────────────────────────────────────────────
console.log('[e2e-resume] Starting server on port', PORT, '…')
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

// Wait up to 20 s for the server to be ready.
for (let i = 0; i < 40; i++) {
  if (serverReady) break
  await delay(500)
}
if (!serverReady) {
  console.error('[e2e-resume] Server never became ready — aborting')
  server.kill('SIGTERM')
  process.exit(1)
}
console.log('[e2e-resume] Server ready.')

// ── Teardown helper (SIGTERM then SIGKILL, like e2e-ws.mjs) ─────────────────
async function shutdown() {
  console.log('\n[e2e-resume] Killing server…')
  server.kill('SIGTERM')
  await delay(1000)
  if (!server.killed) server.kill('SIGKILL')
}

// ── Open ONE socket and keep it open across both turns ──────────────────────
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)

await new Promise((res, rej) => {
  ws.on('open', res)
  ws.on('error', rej)
})
console.log('[e2e-resume] Socket open — same socket will carry BOTH turns.')

/**
 * Send one user_message on the shared socket, auto-allow any permission
 * request, accumulate assistant_delta text, and resolve on turn_done.
 * Does NOT close the socket — that is the whole point of the gate.
 */
function runTurn(text, timeoutMs = 120_000) {
  return new Promise((res, rej) => {
    let assistantText = ''
    let settled = false

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        ws.off('message', onMessage)
        rej(new Error('turn timed out after ' + timeoutMs + 'ms'))
      }
    }, timeoutMs)

    function onMessage(raw) {
      let msg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      console.log('[ws→client]', JSON.stringify(msg).slice(0, 200))

      if (msg.type === 'assistant_delta') {
        assistantText += msg.text
      } else if (msg.type === 'permission_request') {
        console.log(`[e2e-resume] permission_request for "${msg.name}" → allow`)
        ws.send(JSON.stringify({
          type: 'permission_response',
          requestId: msg.requestId,
          decision: 'allow',
        }))
      } else if (msg.type === 'error') {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          ws.off('message', onMessage)
          rej(new Error('server error: ' + msg.message))
        }
      } else if (msg.type === 'turn_done') {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          ws.off('message', onMessage)
          res(assistantText)
        }
      }
    }

    ws.on('message', onMessage)
    console.log(`\n[e2e-resume] → user_message: "${text}"`)
    ws.send(JSON.stringify({ type: 'user_message', text }))
  })
}

let pass = false
try {
  // ── Turn 1: plant the codeword ────────────────────────────────────────────
  console.log('\n=== TURN 1: plant codeword ===')
  const turn1 = await runTurn(
    `Remember this codeword: ${CODEWORD}. Reply with just OK.`
  )
  console.log('[e2e-resume] Turn 1 assistant text:', JSON.stringify(turn1))

  // ── Turn 2: recall the codeword on the SAME socket ────────────────────────
  console.log('\n=== TURN 2: recall codeword (same socket) ===')
  const turn2 = await runTurn(
    'What was the codeword I told you earlier? Reply with only the codeword.'
  )
  console.log('[e2e-resume] Turn 2 assistant text:', JSON.stringify(turn2))

  pass = turn2.includes(CODEWORD)
  console.log(`\n[e2e-resume] Turn-2 text contains "${CODEWORD}"?`, pass)
} catch (err) {
  console.error('[e2e-resume] ERROR:', err && err.message ? err.message : err)
  pass = false
} finally {
  try { ws.close() } catch {}
  await shutdown()
}

// ── Final verdict ───────────────────────────────────────────────────────────
console.log('\n=== RESUME GATE RESULT ===')
console.log(pass ? 'PASS' : 'FAIL')
if (!pass) process.exit(1)
