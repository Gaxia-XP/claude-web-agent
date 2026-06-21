// scripts/e2e-compat.mjs — credential-free e2e for the M5 Compatibility API.
// Boots the compat endpoints with a FAKE provider (no Claude login) and exercises every surface.
import Fastify from 'fastify'
import { openDb } from '../server/store.ts'
import { registerCompatApi } from '../server/compat/index.ts'

const PORT = 8791

// Fake provider: streams two deltas, "uses" a Write tool through the policy (so -auto vs readonly is
// observable), returns the final text + usage. No network, no creds.
class FakeProvider {
  type = 'fake'
  async send(params, ctx) {
    ctx.onDelta('Hello ')
    ctx.onDelta(params.userText)
    const decision = await ctx.permission.resolve('Write', { file_path: '/tmp/x' })
    if (decision.behavior === 'allow') ctx.onToolCall({ id: 't1', name: 'Write', input: {} })
    return { text: 'Hello ' + params.userText + (decision.behavior === 'allow' ? ' [wrote]' : ''), usage: { inputTokens: 2, outputTokens: 3 } }
  }
}

const db = openDb(':memory:')
const app = Fastify()
registerCompatApi(app, { db, makeProvider: () => new FakeProvider() })
await app.listen({ port: PORT, host: '127.0.0.1' })
const base = `http://127.0.0.1:${PORT}`

function assert(cond, msg) { if (!cond) { console.error('❌', msg); process.exit(1) } }

// 1) /v1/models lists the seeded local connection + its -auto variant
const models = await (await fetch(`${base}/v1/models`)).json()
const ids = models.data.map((m) => m.id)
assert(models.object === 'list' && ids.includes('local/sonnet') && ids.includes('local-auto/sonnet'), '/v1/models shape')

// 2) OpenAI non-stream
const oai = await (await fetch(`${base}/v1/chat/completions`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'local/sonnet', messages: [{ role: 'user', content: 'world' }], stream: false }),
})).json()
assert(oai.object === 'chat.completion' && oai.choices[0].message.content.startsWith('Hello world'), 'openai non-stream')

// 3) OpenAI stream
const oaiStream = await (await fetch(`${base}/v1/chat/completions`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'local/sonnet', messages: [{ role: 'user', content: 'world' }], stream: true }),
})).text()
assert(oaiStream.includes('chat.completion.chunk') && oaiStream.trimEnd().endsWith('data: [DONE]'), 'openai stream + [DONE]')

// 4) Anthropic non-stream
const ant = await (await fetch(`${base}/v1/messages`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'local/sonnet', max_tokens: 64, messages: [{ role: 'user', content: 'world' }] }),
})).json()
assert(ant.type === 'message' && ant.content[0].text.startsWith('Hello world'), 'anthropic non-stream')

// 5) Anthropic stream
const antStream = await (await fetch(`${base}/v1/messages`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'local/sonnet', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'world' }] }),
})).text()
assert(antStream.includes('event: message_start') && antStream.includes('event: message_stop'), 'anthropic stream events')

// 6) Policy: -auto allows Write (text gets "[wrote]"), readonly denies it
const autoRes = await (await fetch(`${base}/v1/chat/completions`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'local-auto/sonnet', messages: [{ role: 'user', content: 'go' }], stream: false }),
})).json()
const roRes = await (await fetch(`${base}/v1/chat/completions`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'local/sonnet', messages: [{ role: 'user', content: 'go' }], stream: false }),
})).json()
assert(autoRes.choices[0].message.content.includes('[wrote]'), '-auto policy allows Write')
assert(!roRes.choices[0].message.content.includes('[wrote]'), 'readonly policy denies Write')

await app.close()
// NOTE: no explicit process.exit(0) — after app.close() the better-sqlite3 in-memory DB keeps no
// open handle, so the process exits naturally with code 0. Forcing process.exit(0) here races libuv
// handle teardown on Windows (UV_HANDLE_CLOSING assertion). Failures exit(1) explicitly via assert().
console.log('✅ compat API e2e PASS — /v1/models + openai + anthropic (stream + non-stream) + policy')
