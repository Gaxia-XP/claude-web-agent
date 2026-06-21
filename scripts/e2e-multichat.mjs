/**
 * e2e-multichat.mjs — headless multi-chat + persistence + resume end-to-end test (M2)
 *
 * Proves the full M2 stack THROUGH the SQLite DB:
 *   1. Connection A: create_chat {cwd: <repo root>} -> capture chatId, subscribe.
 *   2. Turn 1: tell Claude a codeword, wait for turn_done.
 *   3. Turn 2: ask Claude for the codeword -> assert reply contains it
 *      (only possible if the SDK session resumed via persisted sdk_session_id).
 *   4. Connection B (simulated reload): subscribe -> expect chat_history with
 *      4 messages (user, assistant, user, assistant) -> assert length + roles.
 *   5. rename_chat -> expect chat_renamed; delete_chat -> expect chat_deleted.
 *
 * The server runs against a THROWAWAY temp DB (env DB_PATH) on a dedicated PORT,
 * so it never touches data/chats.db. Requires a Claude login on this machine.
 *
 * Usage: npx tsx scripts/e2e-multichat.mjs
 * Exit:  0 on PASS, 1 on FAIL.
 */

import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocket } from 'ws'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeFileSync, rmSync } from 'node:fs'

const __dir = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dir, '..')
const PORT = 8790 // dedicated port, distinct from dev (5173/8787)
const DB_PATH = join(tmpdir(), 'cwa-e2e-' + process.pid + '.db')

// M6 auth: pre-seed a known token so the spawned server adopts it (loadOrCreateToken is idempotent),
// and so the WS subprotocol below can authenticate. Per-pid path avoids cross-run collisions.
const TOKEN_PATH = join(tmpdir(), 'cwa-e2e-' + process.pid + '.token')
const TOKEN = 'e2e-multichat-token'
writeFileSync(TOKEN_PATH, TOKEN)

const WS_URL = `ws://127.0.0.1:${PORT}/ws`
const CODEWORD = 'KIWI88'

// ── Start server child process with throwaway DB ─────────────────────────────
console.log('[e2e] Starting server on port', PORT, 'with DB_PATH', DB_PATH, '…')
const server = spawn(
  'npx',
  ['tsx', 'server/index.ts'],
  {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DB_PATH, TOKEN_PATH },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  }
)

let serverReady = false
server.stdout.on('data', (d) => {
  const s = d.toString()
  process.stdout.write('[server] ' + s)
  if (s.includes('listening on')) serverReady = true
})
server.stderr.on('data', (d) => process.stderr.write('[server-err] ' + d.toString()))
server.on('exit', (code) => console.log('[server] exited', code))

// ── Cleanup helpers ──────────────────────────────────────────────────────────
function killServer() {
  try {
    server.kill('SIGTERM')
  } catch {}
}
function removeTempDb() {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(DB_PATH + suffix, { force: true })
    } catch {}
  }
  try { rmSync(TOKEN_PATH, { force: true }) } catch {}
}
async function teardown() {
  console.log('\n[e2e] Killing server…')
  killServer()
  await delay(1000)
  if (!server.killed) {
    try {
      server.kill('SIGKILL')
    } catch {}
  }
  removeTempDb()
}
function fail(reason) {
  console.error('\n[e2e] FAILURE:', reason)
  return false
}

// Wait up to 20 s for server ready
for (let i = 0; i < 40; i++) {
  if (serverReady) break
  await delay(500)
}
if (!serverReady) {
  console.error('[e2e] Server never became ready — aborting')
  await teardown()
  process.exit(1)
}
console.log('[e2e] Server ready.')

// ── WS helpers ───────────────────────────────────────────────────────────────
function connect() {
  return new Promise((res, rej) => {
    const ws = new WebSocket(WS_URL, ['bearer', TOKEN])
    ws.on('open', () => res(ws))
    ws.on('error', rej)
  })
}

// Wait for a server message matching `pred`, collecting all messages along the
// way. Auto-answers any permission_request with `allow`. Rejects on timeout.
function waitFor(ws, pred, timeoutMs = 120_000) {
  return new Promise((res, rej) => {
    const collected = []
    const onMessage = (raw) => {
      const msg = JSON.parse(raw.toString())
      collected.push(msg)
      console.log('[ws→client]', JSON.stringify(msg).slice(0, 200))
      if (msg.type === 'permission_request') {
        console.log(`[e2e] permission_request for "${msg.name}" → allow`)
        ws.send(JSON.stringify({ type: 'permission_response', requestId: msg.requestId, decision: 'allow' }))
      }
      if (pred(msg)) {
        clearTimeout(timer)
        ws.off('message', onMessage)
        res({ matched: msg, collected })
      }
    }
    const timer = setTimeout(() => {
      ws.off('message', onMessage)
      rej(new Error('timeout waiting for predicate; collected types: ' + collected.map((m) => m.type).join(', ')))
    }, timeoutMs)
    ws.on('message', onMessage)
  })
}

// ── Main flow ────────────────────────────────────────────────────────────────
let pass = true
try {
  // Connection A
  const a = await connect()
  console.log('\n[e2e] Connection A open.')

  // create_chat with cwd = repo root
  a.send(JSON.stringify({ type: 'create_chat', cwd: ROOT }))
  const created = await waitFor(a, (m) => m.type === 'chat_created')
  const chatId = created.matched.chat.id
  if (!chatId) { pass = fail('chat_created missing chat.id'); throw new Error('stop') }
  console.log('[e2e] chatId =', chatId)

  // subscribe
  a.send(JSON.stringify({ type: 'subscribe', chatId }))
  await waitFor(a, (m) => m.type === 'chat_history' && m.chatId === chatId)
  console.log('[e2e] subscribed; got initial chat_history.')

  // Turn 1: give the codeword
  console.log('\n=== TURN 1: store codeword ===')
  a.send(JSON.stringify({
    type: 'user_message',
    chatId,
    text: `Remember codeword ${CODEWORD}. Reply with just OK.`,
  }))
  await waitFor(a, (m) => m.type === 'turn_done' && m.chatId === chatId)
  console.log('[e2e] Turn 1 done.')

  // Turn 2: ask for the codeword — resume must carry context through the DB
  console.log('\n=== TURN 2: recall codeword (tests resume) ===')
  a.send(JSON.stringify({
    type: 'user_message',
    chatId,
    text: 'What codeword did I give you? Reply with only the codeword.',
  }))
  const turn2 = await waitFor(a, (m) => m.type === 'turn_done' && m.chatId === chatId)
  const turn2Text = turn2.collected
    .filter((m) => m.type === 'assistant_delta' && m.chatId === chatId)
    .map((m) => m.text)
    .join('')
  console.log('[e2e] Turn 2 assistant text:', JSON.stringify(turn2Text))
  if (!turn2Text.includes(CODEWORD)) {
    pass = fail(`resume failed — Turn 2 reply did not contain "${CODEWORD}"`)
  } else {
    console.log(`[e2e] OK — resume worked, reply contains "${CODEWORD}".`)
  }
  a.close()

  // Connection B — simulate browser reload
  console.log('\n=== RELOAD: Connection B reads persisted history ===')
  const b = await connect()
  b.send(JSON.stringify({ type: 'subscribe', chatId }))
  const histB = await waitFor(b, (m) => m.type === 'chat_history' && m.chatId === chatId)
  const messages = histB.matched.messages
  const roles = messages.map((m) => m.role)
  console.log('[e2e] persisted message count:', messages.length, 'roles:', roles.join(','))
  if (messages.length !== 4) {
    pass = fail(`expected 4 persisted messages, got ${messages.length}`)
  }
  const expectedRoles = ['user', 'assistant', 'user', 'assistant']
  if (JSON.stringify(roles) !== JSON.stringify(expectedRoles)) {
    pass = fail(`expected roles ${expectedRoles.join(',')}, got ${roles.join(',')}`)
  } else {
    console.log('[e2e] OK — persistence verified (4 msgs, correct roles).')
  }

  // rename
  console.log('\n=== RENAME ===')
  b.send(JSON.stringify({ type: 'rename_chat', chatId, title: 'renamed' }))
  const renamed = await waitFor(b, (m) => m.type === 'chat_renamed' && m.chatId === chatId)
  if (renamed.matched.title !== 'renamed') {
    pass = fail(`expected chat_renamed title "renamed", got "${renamed.matched.title}"`)
  } else {
    console.log('[e2e] OK — chat_renamed received.')
  }

  // delete
  console.log('\n=== DELETE ===')
  b.send(JSON.stringify({ type: 'delete_chat', chatId }))
  await waitFor(b, (m) => m.type === 'chat_deleted' && m.chatId === chatId)
  console.log('[e2e] OK — chat_deleted received.')
  b.close()
} catch (e) {
  if (e instanceof Error && e.message !== 'stop') {
    pass = fail(e.message)
  }
}

// ── Teardown + verdict ───────────────────────────────────────────────────────
await teardown()

console.log('\n=== E2E MULTICHAT RESULT ===')
console.log(pass ? 'PASS' : 'FAIL')
if (!pass) process.exit(1)
