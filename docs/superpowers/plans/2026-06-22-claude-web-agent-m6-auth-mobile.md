# M6 — Auth + Mobile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Secure the Claude Web Agent for LAN/mobile use with one bearer token across WS + native HTTP + compat, bind 0.0.0.0, serve the web build single-origin, and make the UI responsive — the last planned milestone.

**Architecture:** A new `buildApp()` factory centralizes wiring (auth onRequest hook + native HTTP + compat + static/SPA + token-gated WS) so `index.ts` and all e2e scripts boot the same auth-guarded stack. Token is random-generated to `data/.token`, printed at startup with a QR. Frontend gates on a token (Login page / QR auto-login), sends it via WS subprotocol + Authorization header, and goes responsive (sidebar -> drawer).

**Tech Stack:** Node 20 + TypeScript ESM, Fastify ^4, @fastify/static@^7, ws ^8, qrcode, better-sqlite3; React 18 + Vite + Tailwind; vitest (env=node).

## Global Constraints
- Code style: single quotes, no semicolons, 2-space indent, English comments (server/store.ts double-quotes is untouched).
- Deps: @fastify/static@^7 ONLY (v8/v9 require Fastify 5); add qrcode + @types/qrcode.
- Token: `randomBytes(32).toString('base64url')`; path `process.env.TOKEN_PATH ?? join(dirname(DB_PATH), '.token')`; never log/commit it.
- Auth: HTTP `Authorization: Bearer` or `x-api-key`; WS subprotocol `['bearer', token]`; auto-login via `#token=` hash fragment.
- vitest env=node has no DOM — unit-test pure helpers only; browser shells verified by tsc. Do NOT add jsdom.
- Gates (repo root): `npm run typecheck` ; `npx tsc -p web/tsconfig.json --noEmit` ; `npm test` (baseline 258, additive) ; `npm run build:web` ; `npx tsx scripts/e2e-{compat,rest,openai}.mjs`.
- libuv: keep natural-exit (no `process.exit(0)`) in e2e-compat only; e2e-rest/openai keep their existing exits.

---

### Task 1: Dependencies + build config
**Files:**
- Modify: `package.json` (line 13 scripts block; lines 15-24 dependencies; lines 25-40 devDependencies)
- Modify: `vite.config.ts` (lines 5-18 config object: add `build`, extend `server.proxy`)
- Modify: `.gitignore` (after line 2 `dist/`)
- Verify only: `web/dist/index.html` (existsSync after build)

**Interfaces:**
- Consumes: existing `package.json` scripts (`build:web`: `vite build`, `typecheck`: `tsc --noEmit`), existing `vite.config.ts` `server.proxy` with `/api` + `/ws`.
- Produces:
  - npm dep `qrcode` (runtime, used by T14 README/QR helpers and Settings T10), npm dep `@fastify/static@^7` (used by T4 `buildApp` static serving), devDep `@types/qrcode`.
  - npm script `start`: `tsx server/index.ts` (used by README T14 / manual run).
  - vite `build.outDir = 'web/dist'` + `build.emptyOutDir = true` so `npm run build:web` emits `web/dist/index.html` (consumed by T4 `webDist` static root + SPA fallback; the spec requires the importer at repo-root `index.html` to build into `web/dist`).
  - vite `server.proxy['/v1']` -> `http://127.0.0.1:8787` (used by T8/T10 compat-API calls in dev).
  - `.gitignore` ignores `web/dist/` (build artifact never committed).

- [ ] **Step 1: Add `start` script to package.json**

Edit the `scripts` block. Change:
```json
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
```
to:
```json
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "start": "tsx server/index.ts"
  },
```

- [ ] **Step 2: Add `qrcode` runtime dependency**

In the `dependencies` block, change:
```json
    "better-sqlite3": "^11.0.0",
    "fastify": "^4.28.0",
```
to (insert `@fastify/static` and `qrcode`; keep alphabetical-ish grouping with the existing `@`-scoped deps at top, plain deps after):
```json
    "@fastify/static": "^7.0.4",
    "better-sqlite3": "^11.0.0",
    "fastify": "^4.28.0",
    "qrcode": "^1.5.4",
```
Note: `@fastify/static@^7` ONLY — v8/v9 require Fastify 5 and throw `FST_ERR_PLUGIN_VERSION_MISMATCH` on Fastify 4.

- [ ] **Step 3: Add `@types/qrcode` devDependency**

In the `devDependencies` block, change:
```json
    "@types/node": "^20.14.0",
    "@types/react": "^18.3.3",
```
to:
```json
    "@types/node": "^20.14.0",
    "@types/qrcode": "^1.5.5",
    "@types/react": "^18.3.3",
```

- [ ] **Step 4: Verify the final package.json**

After Steps 1-3, `package.json` `dependencies`, `devDependencies`, and `scripts` blocks must read exactly:
```json
  "scripts": {
    "dev": "concurrently -n server,web -c blue,green \"npm:dev:server\" \"npm:dev:web\"",
    "dev:server": "tsx watch server/index.ts",
    "dev:web": "vite",
    "build:web": "vite build",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "start": "tsx server/index.ts"
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^0.3.179",
    "@anthropic-ai/sdk": "^0.104.2",
    "@fastify/static": "^7.0.4",
    "better-sqlite3": "^11.0.0",
    "fastify": "^4.28.0",
    "qrcode": "^1.5.4",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-markdown": "^9.0.1",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/node": "^20.14.0",
    "@types/qrcode": "^1.5.5",
    "@types/react": "^18.3.3",
    "@types/react-dom": "^18.3.0",
    "@types/ws": "^8.5.10",
    "@vitejs/plugin-react": "^4.3.1",
    "autoprefixer": "^10.4.19",
    "concurrently": "^8.2.2",
    "postcss": "^8.4.39",
    "tailwindcss": "^3.4.6",
    "tsx": "^4.16.0",
    "typescript": "^5.5.3",
    "vite": "^5.3.3",
    "vitest": "^2.0.0"
  }
```

- [ ] **Step 5: Install the new deps**

Run: `npm install`
Expected: install completes with exit code 0; no `FST_ERR_PLUGIN_VERSION_MISMATCH`; `node_modules/@fastify/static/package.json` reports a `7.x` version and `node_modules/qrcode` + `node_modules/@types/qrcode` exist. Confirm resolved major:
Run: `node -p "require('@fastify/static/package.json').version"`
Expected: a string starting with `7.` (e.g. `7.0.4`).

- [ ] **Step 6: Add `build` block + `/v1` proxy to vite.config.ts**

Replace the entire config object body. Change:
```ts
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@shared': fileURLToPath(new URL('./shared', import.meta.url)) },
  },
  server: {
    port: 5173,
    fs: { allow: ['.'] },
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
    },
  },
})
```
to:
```ts
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@shared': fileURLToPath(new URL('./shared', import.meta.url)) },
  },
  // Entry index.html lives at repo root; default outDir is repo-root dist/ which is wrong.
  // Build the SPA into web/dist so the server can serve it as a single origin (spec §7).
  build: {
    outDir: 'web/dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    fs: { allow: ['.'] },
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/v1': 'http://127.0.0.1:8787',
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
    },
  },
})
```

- [ ] **Step 7: Ignore the build output in .gitignore**

Edit `.gitignore`. Change:
```
node_modules/
dist/
data/
```
to:
```
node_modules/
dist/
web/dist/
data/
```

- [ ] **Step 8: Typecheck stays clean**

Run: `npm run typecheck`
Expected: exits 0 with no output (no new TS errors; this task adds no app code, only deps/config).

- [ ] **Step 9: Build the web SPA and confirm output path**

Run: `npm run build:web`
Expected: Vite build completes with exit code 0 and logs that output went to `web/dist` (e.g. a line containing `web/dist/index.html`). Then confirm the artifact exists:
Run: `node -e "process.exit(require('fs').existsSync('web/dist/index.html') ? 0 : 1)"`
Expected: exit code 0 (file `web/dist/index.html` exists). If it instead landed in repo-root `dist/`, Step 6 was applied incorrectly — re-check `build.outDir`.

- [ ] **Step 10: Baseline test suite still green**

Run: `npm test`
Expected: vitest runs the existing suite and reports `258 passed` (baseline unchanged — this task adds no tests). Exit code 0.

- [ ] **Step 11: Commit**

Run:
```
git add package.json package-lock.json vite.config.ts .gitignore
git commit -m 'chore(m6): add qrcode + @fastify/static@^7 deps, web/dist build config, start script'
```
Note: `package-lock.json` is regenerated by `npm install` in Step 5; include it so the pinned `@fastify/static@7.x` resolution is committed. If the repo has no lockfile, drop it from the `git add` list.

---

### Task 2: server/auth.ts — token + header helpers

**Files:**
- Read first: `server/index.ts`, `server/store.ts` (confirm DB_PATH default + import-style conventions)
- Create: `server/auth.ts`
- Create (Test): `server/auth.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks. Node built-ins only: `crypto` (`randomBytes`, `timingSafeEqual`), `fs` (`readFileSync`, `writeFileSync`, `mkdirSync`, `existsSync`, `chmodSync`), `path` (`dirname`).
- Produces (consumed by Task 3 `server/ws.ts`, Task 4 `server/app.ts`, Task 5 `server/index.ts`):
  - `export function loadOrCreateToken(tokenPath: string): string`
  - `export function extractToken(headers: import('http').IncomingHttpHeaders): string | undefined`  // Authorization: Bearer | x-api-key
  - `export function extractWsToken(secWebSocketProtocol: string | undefined): string | undefined`  // split ',' trim; if [0]==='bearer' return [1]
  - `export function safeEqual(a: string | undefined, b: string): boolean`  // crypto.timingSafeEqual + length guard

- [ ] **Step 1: Read real files to match conventions.** Read `server/index.ts` (confirm `DB_PATH = process.env.DB_PATH ?? 'data/chats.db'`, ESM import style, single quotes / no semicolons) and `server/store.ts` (confirm it uses double quotes — NOT touched here — and that `auth.ts` follows the contract style: single quotes / no semicolons). No edits.

- [ ] **Step 2: Write the failing test `server/auth.test.ts`.** Covers all four helpers. Uses `os.tmpdir()` + `randomUUID()` for an isolated TOKEN_PATH so it never collides with the repo `.token`.

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { loadOrCreateToken, extractToken, extractWsToken, safeEqual } from './auth'

function tmpTokenPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'auth-test-'))
  return join(dir, '.token')
}

describe('loadOrCreateToken', () => {
  it('creates and persists a 43-char base64url token when file is absent', () => {
    const p = tmpTokenPath()
    expect(existsSync(p)).toBe(false)
    const t = loadOrCreateToken(p)
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(existsSync(p)).toBe(true)
    expect(readFileSync(p, 'utf8')).toBe(t)
    rmSync(p, { force: true })
  })

  it('is idempotent: returns the existing token on subsequent calls', () => {
    const p = tmpTokenPath()
    const first = loadOrCreateToken(p)
    const second = loadOrCreateToken(p)
    expect(second).toBe(first)
    rmSync(p, { force: true })
  })

  it('trims surrounding whitespace/newline from an existing token file', () => {
    const p = tmpTokenPath()
    const first = loadOrCreateToken(p)
    // simulate a token written with a trailing newline by an editor
    writeFileSync(p, first + '\n', 'utf8')
    expect(loadOrCreateToken(p)).toBe(first)
    rmSync(p, { force: true })
  })
})

describe('extractToken', () => {
  it('reads Authorization: Bearer <t>', () => {
    expect(extractToken({ authorization: 'Bearer abc123' })).toBe('abc123')
  })

  it('reads Authorization: bearer <t> case-insensitively', () => {
    expect(extractToken({ authorization: 'bearer abc123' })).toBe('abc123')
  })

  it('reads x-api-key <t>', () => {
    expect(extractToken({ 'x-api-key': 'xyz789' })).toBe('xyz789')
  })

  it('prefers Authorization Bearer over x-api-key when both present', () => {
    expect(extractToken({ authorization: 'Bearer abc123', 'x-api-key': 'xyz789' })).toBe('abc123')
  })

  it('returns undefined when no auth header is present', () => {
    expect(extractToken({})).toBeUndefined()
  })

  it('returns undefined for a non-Bearer Authorization scheme', () => {
    expect(extractToken({ authorization: 'Basic abc123' })).toBeUndefined()
  })
})

describe('extractWsToken', () => {
  it('reads the token from "bearer, <tok>"', () => {
    expect(extractWsToken('bearer, tok123')).toBe('tok123')
  })

  it('reads with no space after the comma', () => {
    expect(extractWsToken('bearer,tok123')).toBe('tok123')
  })

  it('returns undefined when the first protocol is not "bearer"', () => {
    expect(extractWsToken('foo, tok123')).toBeUndefined()
  })

  it('returns undefined for a single protocol with no token', () => {
    expect(extractWsToken('bearer')).toBeUndefined()
  })

  it('returns undefined for an undefined header', () => {
    expect(extractWsToken(undefined)).toBeUndefined()
  })
})

describe('safeEqual', () => {
  it('returns true for equal strings', () => {
    expect(safeEqual('same-token', 'same-token')).toBe(true)
  })

  it('returns false for unequal strings of equal length', () => {
    expect(safeEqual('aaaaaaaa', 'bbbbbbbb')).toBe(false)
  })

  it('returns false for length mismatch', () => {
    expect(safeEqual('short', 'a-much-longer-token')).toBe(false)
  })

  it('returns false when a is undefined', () => {
    expect(safeEqual(undefined, 'token')).toBe(false)
  })
})
```

- [ ] **Step 3: Run the test — expect it to FAIL.**
  Run: `npm test -- server/auth.test.ts`
  Expected: vitest reports the suite cannot resolve `./auth` (module not found) — i.e. all cases fail to load. This confirms the test is wired before any implementation exists.

- [ ] **Step 4: Implement `server/auth.ts` (minimal, pure/sync).**

```ts
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'

// Load the bearer token from tokenPath, creating it on first run.
// Token = 32 random bytes base64url-encoded -> 43 URL-safe chars.
// Returns the trimmed token so an editor-added trailing newline is tolerated.
export function loadOrCreateToken(tokenPath: string): string {
  if (existsSync(tokenPath)) {
    const existing = readFileSync(tokenPath, 'utf8').trim()
    if (existing) return existing
  }
  const token = randomBytes(32).toString('base64url')
  mkdirSync(dirname(tokenPath), { recursive: true })
  writeFileSync(tokenPath, token, 'utf8')
  // Best-effort owner-only perms; a no-op on Windows filesystems.
  try {
    chmodSync(tokenPath, 0o600)
  } catch {
    // ignore: chmod is not meaningful on Windows
  }
  return token
}

// Extract the token from an HTTP request: Authorization: Bearer <t> OR x-api-key: <t>.
export function extractToken(headers: import('http').IncomingHttpHeaders): string | undefined {
  const auth = headers.authorization
  if (typeof auth === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim())
    if (match) return match[1].trim()
  }
  const apiKey = headers['x-api-key']
  if (typeof apiKey === 'string' && apiKey.trim()) return apiKey.trim()
  return undefined
}

// Extract the token from a WebSocket Sec-WebSocket-Protocol header value.
// Expected form: 'bearer, <token>'. Returns undefined when malformed.
export function extractWsToken(secWebSocketProtocol: string | undefined): string | undefined {
  if (!secWebSocketProtocol) return undefined
  const parts = secWebSocketProtocol.split(',').map((p) => p.trim())
  if (parts[0] === 'bearer' && parts[1]) return parts[1]
  return undefined
}

// Constant-time comparison with a length guard so length differences do not throw.
export function safeEqual(a: string | undefined, b: string): boolean {
  if (typeof a !== 'string') return false
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}
```

- [ ] **Step 5: Run the test — expect it to PASS.**
  Run: `npm test -- server/auth.test.ts`
  Expected: all cases green (4 describe blocks). Then run the typecheck gate `npm run typecheck` — Expected: exit 0, no errors.

- [ ] **Step 6: Confirm the full vitest baseline still grows, not breaks.**
  Run: `npm test`
  Expected: prior baseline 258 passing PLUS the new `server/auth.test.ts` cases, 0 failures.

- [ ] **Step 7: Commit.**
  Run: `git add server/auth.ts server/auth.test.ts`
  Run: `git commit -m 'feat(m6): add server/auth.ts token + header helpers (TDD)'`

---

### Task 3: server/ws.ts — token subprotocol auth

**Files:**
- Modify: `server/ws.ts` (lines 1-18 — add `opts` param + auth-mode `WebSocketServer` config; keep per-connection wiring)
- Test: `server/ws.test.ts` (Create — integration: real `http.Server` listen on port 0 + `ws` client)

**Interfaces:**
- Consumes (from Task 2 `server/auth.ts`): `export function extractWsToken(secWebSocketProtocol: string | undefined): string | undefined` ; `export function safeEqual(a: string | undefined, b: string): boolean`
- Consumes (real code): `ChatHub.addConnection(send: (m: ServerMsg) => void): ConnectionHandle` where `ConnectionHandle = { handle(raw: string): void; close(): void }` (`server/hub.ts`). `new ChatHub({ db, makeProvider, genId, now, turnTimeoutMs? })`. `openDb(path): DB` (`server/store.ts`).
- Produces (Task 4 `buildApp` consumes): `export function attachWebSocketServer(httpServer: import('node:http').Server, hub: ChatHub, opts?: { token?: string }): WebSocketServer`

- [ ] **Step 1: Write the failing integration test.**

Create `server/ws.test.ts` with the complete content below. It spins a bare `http.Server`, attaches the WS server with a token, listens on port 0, and asserts the three subprotocol cases. Uses real `openDb(':memory:')` + `ChatHub` so `addConnection` wiring is exercised end-to-end.

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import WebSocket from 'ws'
import { openDb } from './store'
import { ChatHub } from './hub'
import { makeProvider } from './providers/index'
import { attachWebSocketServer } from './ws'

// Build a real http.Server + ChatHub, attach the WS server with a token, and
// start listening on an ephemeral port. Returns the live ws:// origin + teardown.
function startServer(token?: string): Promise<{ url: string; close: () => Promise<void> }> {
  const db = openDb(':memory:')
  const hub = new ChatHub({ db, makeProvider, genId: () => 'id', now: () => 0 })
  const httpServer: Server = createServer()
  attachWebSocketServer(httpServer, hub, token ? { token } : undefined)
  return new Promise((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const { port } = httpServer.address() as AddressInfo
      resolve({
        url: `ws://127.0.0.1:${port}/ws`,
        close: () =>
          new Promise<void>((done) => {
            db.close()
            httpServer.close(() => done())
          }),
      })
    })
  })
}

// Connect once and resolve which terminal event fired first: 'open' or 'rejected'.
// 'rejected' covers both the verifyClient 401 (client 'error') and any close-before-open.
function probe(url: string, protocols?: string[]): Promise<{ result: 'open' | 'rejected'; protocol: string }> {
  return new Promise((resolve) => {
    const ws = protocols ? new WebSocket(url, protocols) : new WebSocket(url)
    let settled = false
    const settle = (result: 'open' | 'rejected', protocol = '') => {
      if (settled) return
      settled = true
      resolve({ result, protocol })
      ws.close()
    }
    ws.on('open', () => settle('open', ws.protocol))
    ws.on('error', () => settle('rejected'))
    ws.on('unexpected-response', () => settle('rejected'))
    ws.on('close', () => settle('rejected'))
  })
}

describe('attachWebSocketServer token subprotocol auth', () => {
  let teardown: (() => Promise<void>) | null = null
  afterEach(async () => {
    if (teardown) await teardown()
    teardown = null
  })

  it('accepts a client presenting the correct bearer token and reports protocol bearer', async () => {
    const { url, close } = await startServer('T')
    teardown = close
    const r = await probe(url, ['bearer', 'T'])
    expect(r.result).toBe('open')
    expect(r.protocol).toBe('bearer')
  })

  it('rejects a client presenting the wrong bearer token (never opens)', async () => {
    const { url, close } = await startServer('T')
    teardown = close
    const r = await probe(url, ['bearer', 'WRONG'])
    expect(r.result).toBe('rejected')
  })

  it('rejects a client with no subprotocol (never opens)', async () => {
    const { url, close } = await startServer('T')
    teardown = close
    const r = await probe(url)
    expect(r.result).toBe('rejected')
  })

  it('opens with no auth when opts.token is absent (back-compat)', async () => {
    const { url, close } = await startServer()
    teardown = close
    const r = await probe(url)
    expect(r.result).toBe('open')
  })
})
```

- [ ] **Step 2: Run the test — confirm it fails.**

Run: `npx vitest run server/ws.test.ts`

Expected: FAIL. The auth cases fail because the current 2-arg `attachWebSocketServer` ignores `opts`, so the wrong-token and no-subprotocol clients OPEN instead of being rejected (e.g. `expected 'open' to be 'rejected'`). TypeScript also rejects the 3rd argument, surfacing as a type error in the test compile.

- [ ] **Step 3: Implement the auth-mode `WebSocketServer` in `server/ws.ts`.**

Replace the entire file with the version below. New `opts?: { token?: string }` param: when a token is present, construct the `WebSocketServer` with `handleProtocols` (so the accepted socket reports `bearer`) and `verifyClient` (so the HTTP upgrade is rejected with 401 when `safeEqual` fails). When absent, fall back to the exact current behavior. The per-connection wiring block is identical to before.

```ts
import type { Server } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import type { ServerMsg } from '../shared/protocol'
import type { ChatHub } from './hub'
import { extractWsToken, safeEqual } from './auth'

export function attachWebSocketServer(
  httpServer: Server,
  hub: ChatHub,
  opts?: { token?: string },
): WebSocketServer {
  const token = opts?.token
  // With a token: gate the HTTP upgrade via verifyClient and force the accepted
  // subprotocol to 'bearer'. Without one: keep the original unauthenticated path.
  const wss = token
    ? new WebSocketServer({
        server: httpServer,
        path: '/ws',
        handleProtocols: () => 'bearer',
        verifyClient: ({ req }, done) =>
          done(
            safeEqual(extractWsToken(req.headers['sec-websocket-protocol']), token),
            401,
            'Unauthorized',
          ),
      })
    : new WebSocketServer({ server: httpServer, path: '/ws' })
  wss.on('connection', (socket: WebSocket) => {
    const send = (m: ServerMsg) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(m))
    }
    const handle = hub.addConnection(send)
    socket.on('message', (data) => handle.handle(data.toString()))
    socket.on('close', () => handle.close())
    socket.on('error', () => {})
  })
  return wss
}
```

- [ ] **Step 4: Run the test — confirm it passes.**

Run: `npx vitest run server/ws.test.ts`

Expected: PASS — all 4 tests green (`4 passed`). Correct-token client opens with `ws.protocol === 'bearer'`; wrong-token and no-subprotocol clients are rejected (never open); no-token server still opens.

- [ ] **Step 5: Run typecheck + full baseline to confirm no regression.**

Run: `npm run typecheck ; npm test`

Expected: `npm run typecheck` exits 0 (no errors). `npm test` shows the prior full-suite total PLUS the 4 new `server/ws.test.ts` tests, 0 failed (test counts are cumulative across tasks — only the +4 delta from this task matters).

- [ ] **Step 6: Commit.**

Run: `git add server/ws.ts server/ws.test.ts`

Run: `git commit -m 'feat(m6): WS token subprotocol auth in attachWebSocketServer'`

Note: a stray top-level `await fake.close()` is not relevant here — this task adds no script changes; e2e updates land in Tasks 12-13.

---

I now have everything I need. I've confirmed: the Fastify `.inject()` test pattern with `openDb(':memory:')` + `FakeProvider`, the exact §4 hand-rolled bodies differ from `openaiError`/`anthropicError` (which add `not_found_error`/`invalid_request_error`/`api_error` types), the `CompatDeps`/`HubDeps` shapes, `makeProvider`/`Provider` signatures, the `/api/health` route lives in index.ts today (not http-api.ts), and the auth.ts signatures from Task 2 (`extractToken`, `safeEqual`). Now writing the task markdown.

### Task 4: server/app.ts — buildApp factory + auth hook

**Files:**
- Create: `server/app.ts`
- Test: `server/app.test.ts`
- Consume (already exists): `server/auth.ts` (Task 2), `server/ws.ts` (Task 3), `server/http-api.ts`, `server/compat/index.ts`, `server/hub.ts`, `server/providers/index.ts`, `server/store.ts`

**Interfaces:**
- Consumes:
  - `loadOrCreateToken(tokenPath: string): string` — not used here; token is injected via deps
  - `extractToken(headers: import('http').IncomingHttpHeaders): string | undefined` (server/auth.ts, Task 2)
  - `safeEqual(a: string | undefined, b: string): boolean` (server/auth.ts, Task 2)
  - `attachWebSocketServer(httpServer: import('http').Server, hub: ChatHub, opts?: { token?: string }): WebSocketServer` (server/ws.ts, Task 3)
  - `registerHttpApi(app: FastifyInstance, deps: { hub: ChatHub; db: DB }): void` (server/http-api.ts)
  - `registerCompatApi(app: FastifyInstance, deps: CompatDeps): void` where `CompatDeps = { db: DB; makeProvider: (cfg: ProviderConfig) => Provider; turnTimeoutMs?: number }` (server/compat/index.ts, server/compat/turn.ts)
  - `ChatHub` ctor `new ChatHub({ db, makeProvider, genId, now, turnTimeoutMs? }: HubDeps)` (server/hub.ts)
  - `makeProvider(cfg: ProviderConfig): Provider` ; `ProviderConfig = { type; baseUrl?; apiKey?; defaultModel }` (server/providers/index.ts)
  - `openDb(path): DB` (server/store.ts)
  - `pingMessage()` (server/health.ts) — used by the `/api/health` route registered inside `buildApp`
- Produces (Task 5 server/index.ts relies on these exact signatures):
  - `export interface BuildAppDeps { db: DB; hub: ChatHub; makeProvider: (cfg: ProviderConfig) => Provider; token: string; turnTimeoutMs?: number; webDist?: string }`
  - `export function buildApp(deps: BuildAppDeps): { app: FastifyInstance; wss: WebSocketServer }`

Notes carried from the contract that shape this task:
- §4 401 bodies are HAND-ROLLED in the hook (do NOT reuse `anthropicError`/`openaiError`; those map 401→`api_error` and are file-private anyway). Per-surface table:
  - `/v1/messages` → `{ type:'error', error:{ type:'authentication_error', message } }`
  - other `/v1/*` → `{ error:{ message, type:'authentication_error' } }`
  - `/api/*` → `{ error:'unauthorized' }`
- Allowlist (no token): `GET /api/health` ; any path NOT starting with `/api/` AND NOT `/v1/` (static SPA / index.html). Guarded: `/api/*` except health, and `/v1/*`.
- Every guarded 401 also sets header `WWW-Authenticate: Bearer`.
- `/api/health` is currently registered in `server/index.ts` (line 20). In M6 it moves INTO `buildApp` (so the allowlist has a real route to hit and Task 5's index.ts shrinks to wiring). Register it inside `buildApp` BEFORE `registerHttpApi`.
- Static/SPA (§7) is wired here only when `webDist && existsSync(webDist)`. Tests in this task pass no `webDist`, so that branch is dormant; the SPA notFoundHandler + `@fastify/static` are exercised by Task 5 / e2e.

- [ ] **Step 1: Write the failing test `server/app.test.ts`.** Mirror the `http-api.test.ts` harness (in-memory DB, `FakeProvider`, `app.inject`). Construct the hub exactly per the brief: `new ChatHub({ db, makeProvider, genId: randomUUID, now: Date.now })`. Note the `import` paths use NO `.ts` extension (matches every other `server/*.test.ts`).

```ts
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { openDb } from './store'
import { FakeProvider } from './providers/fake'
import { makeProvider } from './providers/index'
import { ChatHub } from './hub'
import { buildApp } from './app'

const TOKEN = 'test-token-abc'

// Build a real app via buildApp with an in-memory DB. makeProvider is replaced with a
// FakeProvider factory so no real provider/network is touched (the hub never runs a turn
// in these auth tests — we only exercise the onRequest guard + route registration).
function makeApp() {
  const db = openDb(':memory:')
  const hub = new ChatHub({ db, makeProvider: () => new FakeProvider(), genId: randomUUID, now: Date.now })
  const { app, wss } = buildApp({ db, hub, makeProvider, token: TOKEN })
  return { app, wss, db }
}

describe('buildApp auth hook (§4)', () => {
  it('GET /api/health is allowlisted (no token -> 200)', async () => {
    const { app } = makeApp()
    const res = await app.inject({ method: 'GET', url: '/api/health' })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { status: string }).status).toBeTruthy()
  })

  it('GET /api/chats without a token -> 401 { error: "unauthorized" } + WWW-Authenticate', async () => {
    const { app } = makeApp()
    const res = await app.inject({ method: 'GET', url: '/api/chats' })
    expect(res.statusCode).toBe(401)
    expect(res.headers['www-authenticate']).toBe('Bearer')
    expect(res.json()).toEqual({ error: 'unauthorized' })
  })

  it('GET /api/chats with Authorization: Bearer <token> -> 200', async () => {
    const { app } = makeApp()
    const res = await app.inject({
      method: 'GET',
      url: '/api/chats',
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { chats: unknown[] }).chats).toEqual([])
  })

  it('GET /api/chats with x-api-key: <token> also authorizes -> 200', async () => {
    const { app } = makeApp()
    const res = await app.inject({
      method: 'GET',
      url: '/api/chats',
      headers: { 'x-api-key': TOKEN },
    })
    expect(res.statusCode).toBe(200)
  })

  it('GET /api/chats with a wrong token -> 401', async () => {
    const { app } = makeApp()
    const res = await app.inject({
      method: 'GET',
      url: '/api/chats',
      headers: { authorization: 'Bearer wrong' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'unauthorized' })
  })

  it('POST /v1/chat/completions without a token -> 401 OpenAI-shaped authentication_error', async () => {
    const { app } = makeApp()
    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: {} })
    expect(res.statusCode).toBe(401)
    expect(res.headers['www-authenticate']).toBe('Bearer')
    const body = res.json() as { error: { type: string; message: string } }
    expect(body.error.type).toBe('authentication_error')
    expect(typeof body.error.message).toBe('string')
  })

  it('POST /v1/messages without a token -> 401 Anthropic-shaped authentication_error', async () => {
    const { app } = makeApp()
    const res = await app.inject({ method: 'POST', url: '/v1/messages', payload: {} })
    expect(res.statusCode).toBe(401)
    expect(res.headers['www-authenticate']).toBe('Bearer')
    const body = res.json() as { type: string; error: { type: string; message: string } }
    expect(body.type).toBe('error')
    expect(body.error.type).toBe('authentication_error')
  })

  it('GET /v1/models without a token -> 401 generic /v1 authentication_error', async () => {
    const { app } = makeApp()
    const res = await app.inject({ method: 'GET', url: '/v1/models' })
    expect(res.statusCode).toBe(401)
    const body = res.json() as { error: { type: string; message: string } }
    expect(body.error.type).toBe('authentication_error')
  })

  it('a non-/api, non-/v1 path is allowlisted by the guard (reaches notFound -> 404, NOT 401)', async () => {
    const { app } = makeApp()
    const res = await app.inject({ method: 'GET', url: '/index.html' })
    // No webDist registered in tests -> default Fastify 404, but crucially NOT a 401 from the guard.
    expect(res.statusCode).toBe(404)
  })
})
```

- [ ] **Step 2: Run the test — confirm it fails for the right reason.**
  Run: `npm test -- server/app.test.ts`
  Expected: vitest fails to resolve the import `./app` (e.g. `Failed to load url ./app` / `Cannot find module './app'`) — the module does not exist yet. (If `server/auth.ts` from Task 2 is missing in this worktree, the failure will instead point at `./auth` inside `app.ts` once Step 3 lands — that is the cross-task dependency; Task 2 must be committed first.)

- [ ] **Step 3: Create `server/app.ts`.** Register the `/api/health` route + onRequest guard FIRST, then the API registrars, then static/SPA, then attach WS. The guard returns the hand-rolled body and calls `reply.send(...)` (which short-circuits the request — downstream route handlers never run).

```ts
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
import type { Provider, ProviderConfig } from './providers/index' // ProviderConfig is the value-less type re-export

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
// is guarded.
function isAllowlisted(req: FastifyRequest): boolean {
  const path = req.url.split('?')[0]
  if (req.method === 'GET' && path === '/api/health') return true
  if (path.startsWith('/api/')) return false
  if (path.startsWith('/v1/')) return false
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
  const app = Fastify({ logger: true })

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
      const isApi = path.startsWith('/api/') || path.startsWith('/v1/') || path === '/ws'
      if (req.method === 'GET' && !isApi && existsSync(indexHtml)) {
        return reply.type('text/html').sendFile('index.html')
      }
      reply.code(404).send({ error: 'not found' })
    })
  }

  const wss = attachWebSocketServer(app.server, hub, { token })
  return { app, wss }
}
```

- [ ] **Step 4: Run the test — confirm it passes.**
  Run: `npm test -- server/app.test.ts`
  Expected: all 9 tests in `buildApp auth hook (§4)` pass (`9 passed`), and the full-suite baseline grows (these tests ADD to the 258 baseline).

- [ ] **Step 5: Typecheck the whole server.**
  Run: `npm run typecheck`
  Expected: exit 0, no errors. (Confirms `BuildAppDeps`/`buildApp` types line up with the real `ChatHub`, `CompatDeps`, `attachWebSocketServer` opts, and the `@fastify/static` v7 register signature.)

- [ ] **Step 6: Run the full unit suite to confirm no regression.**
  Run: `npm test`
  Expected: all prior tests still pass and the full-suite total grows by the 9 new `server/app.test.ts` tests, 0 failed (counts are cumulative across tasks — only the +9 delta from this task matters).

- [ ] **Step 7: Commit.**
  Run:
  ```
  git add server/app.ts server/app.test.ts
  git commit -m 'feat(m6): buildApp factory + global bearer/x-api-key auth hook (§4)'
  ```

---

### Task 5: server/index.ts thin entry + banner/QR

**Files:**
- Create: `server/banner.ts` (pure `lanUrls` helper)
- Create: `server/banner.test.ts` (vitest, env=node)
- Modify: `server/index.ts` (full rewrite — current 34 lines, lines 1–34)

**Interfaces:**
- Consumes (from earlier tasks / real code):
  - `loadOrCreateToken(tokenPath: string): string` — `server/auth.ts` (Task 2)
  - `buildApp(deps: BuildAppDeps): { app: FastifyInstance; wss: WebSocketServer }` where `BuildAppDeps = { db: DB; hub: ChatHub; makeProvider: (cfg: ProviderConfig) => Provider; token: string; turnTimeoutMs?: number; webDist?: string }` — `server/app.ts` (Task 4). `buildApp` does NOT call `app.listen`.
  - `new ChatHub({ db, makeProvider, genId, now, turnTimeoutMs? })` — `server/hub.ts` (`HubDeps` already has optional `turnTimeoutMs`)
  - `openDb(path: string): DB` — `server/store.ts`
  - `makeProvider(cfg: ProviderConfig): Provider` — `server/providers/index.ts`
  - `qrcode.toString(text, opts): Promise<string>` — `qrcode` dep (added Task 1)
- Produces (later tasks rely on):
  - `export function lanUrls(interfaces: ReturnType<typeof import('os').networkInterfaces>, port: number): string[]` — `server/banner.ts`
  - Stdout readiness marker: a `console.log` line whose text contains `listening on http://<ip>:<PORT>` (Task 13 re-keys `e2e-multichat.mjs` on the substring `listening`; the marker must survive removal of the old `app.log.info('WebSocket listening …')` line)

---

- [ ] **Step 1: Write failing test for `lanUrls` (TDD red)**

Create `server/banner.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { lanUrls } from './banner'

// A fake os.networkInterfaces() shape: non-internal IPv4 entries become URLs,
// internal (loopback) and IPv6 entries are filtered out.
const fakeInterfaces = {
  lo: [
    { address: '127.0.0.1', family: 'IPv4', internal: true, netmask: '255.0.0.0', mac: '00:00:00:00:00:00', cidr: '127.0.0.1/8' },
    { address: '::1', family: 'IPv6', internal: true, netmask: 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', mac: '00:00:00:00:00:00', scopeid: 0, cidr: '::1/128' },
  ],
  eth0: [
    { address: '192.168.1.42', family: 'IPv4', internal: false, netmask: '255.255.255.0', mac: 'aa:bb:cc:dd:ee:ff', cidr: '192.168.1.42/24' },
    { address: 'fe80::1', family: 'IPv6', internal: false, netmask: 'ffff:ffff:ffff:ffff::', mac: 'aa:bb:cc:dd:ee:ff', scopeid: 2, cidr: 'fe80::1/64' },
  ],
  wlan0: [
    { address: '10.0.0.7', family: 'IPv4', internal: false, netmask: '255.255.255.0', mac: '11:22:33:44:55:66', cidr: '10.0.0.7/24' },
  ],
} as unknown as ReturnType<typeof import('node:os').networkInterfaces>

describe('lanUrls', () => {
  it('returns one http URL per non-internal IPv4 address', () => {
    expect(lanUrls(fakeInterfaces, 8787)).toEqual([
      'http://192.168.1.42:8787',
      'http://10.0.0.7:8787',
    ])
  })

  it('uses the supplied port', () => {
    expect(lanUrls(fakeInterfaces, 3000)).toEqual([
      'http://192.168.1.42:3000',
      'http://10.0.0.7:3000',
    ])
  })

  it('ignores internal and IPv6 addresses (loopback-only -> empty)', () => {
    const loopbackOnly = { lo: fakeInterfaces.lo } as unknown as ReturnType<typeof import('node:os').networkInterfaces>
    expect(lanUrls(loopbackOnly, 8787)).toEqual([])
  })

  it('tolerates undefined interface entries', () => {
    const withUndef = { lo: undefined, eth0: fakeInterfaces.eth0 } as unknown as ReturnType<typeof import('node:os').networkInterfaces>
    expect(lanUrls(withUndef, 8787)).toEqual(['http://192.168.1.42:8787'])
  })
})
```

- [ ] **Step 2: Run the test — expect red**

Run: `npm test -- banner`
Expected: vitest fails to resolve `./banner` (module not found) / `lanUrls is not a function` — test file collected but failing.

- [ ] **Step 3: Implement `server/banner.ts` (TDD green)**

Create `server/banner.ts`:

```ts
import type { networkInterfaces } from 'node:os'

// Build one http URL per non-internal IPv4 address from os.networkInterfaces().
// Loopback (internal) and IPv6 entries are filtered out. Pure + deterministic
// (insertion order of the interfaces object), so it is unit-tested directly.
export function lanUrls(
  interfaces: ReturnType<typeof networkInterfaces>,
  port: number,
): string[] {
  const urls: string[] = []
  for (const entries of Object.values(interfaces)) {
    if (!entries) continue
    for (const iface of entries) {
      if (iface.family === 'IPv4' && !iface.internal) {
        urls.push(`http://${iface.address}:${port}`)
      }
    }
  }
  return urls
}
```

- [ ] **Step 4: Run the test — expect green**

Run: `npm test -- banner`
Expected: 4 passing tests in `server/banner.test.ts`; the full-suite total grows by 4 (counts are cumulative across tasks — only the +4 delta matters).

- [ ] **Step 5: Rewrite `server/index.ts` (thin entry + banner + QR)**

Replace the ENTIRE contents of `server/index.ts` (current lines 1–34) with:

```ts
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
// scrapable lines. e2e-multichat.mjs keys on the substring 'listening'.
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
```

- [ ] **Step 6: Typecheck the server (server tsconfig + global)**

Run: `npm run typecheck`
Expected: exits 0, no diagnostics. Confirms `qrcode` default import resolves (Task 1 added `@types/qrcode`), `buildApp`/`loadOrCreateToken`/`lanUrls` import cleanly, and the top-level `await` is accepted (ESM, `"type": "module"`).

- [ ] **Step 7: Full vitest run (no regressions)**

Run: `npm test`
Expected: all pass; the full-suite total grows by the 4 new banner tests, 0 failures (counts are cumulative across tasks).

- [ ] **Step 8: Smoke the banner end-to-end (readiness marker + real QR, not `[object Promise]`)**

Run: `DB_PATH=$(mktemp -u --suffix=.db) PORT=8799 npx tsx server/index.ts`
Expected: stdout contains a line `  listening on http://localhost:8799` and `  listening on http://<lan-ip>:8799` per LAN interface, a `  token: <43-char>` line, and a rendered terminal QR block of block characters (NOT the literal string `[object Promise]`). Stop it with Ctrl-C after confirming. (Note: the impeccable skill is not used here — this is a terminal banner, not a UI surface — but spacing/labels above are the final concrete form.)

- [ ] **Step 9: Commit**

Run:
```
git add server/index.ts server/banner.ts server/banner.test.ts
git commit -m 'feat(m6): thin index.ts entry with LAN banner + terminal QR + 0.0.0.0 bind'
```

---

Cross-task note for Task 13: the readiness substring is now `listening on` (emitted by `  listening on http://...`); `e2e-multichat.mjs` line 52 (`s.includes('WebSocket listening')`) must be updated to `s.includes('listening on')` in Task 13 (NOT bare `listening` — Fastify's pino logger prints `Server listening at …` which also contains `listening`).

**Files (absolute):**
- `P:\AI_PROJECT\Claude\WebPage\.claude\worktrees\eloquent-agnesi-1ce8f0\server\index.ts`
- `P:\AI_PROJECT\Claude\WebPage\.claude\worktrees\eloquent-agnesi-1ce8f0\server\banner.ts`
- `P:\AI_PROJECT\Claude\WebPage\.claude\worktrees\eloquent-agnesi-1ce8f0\server\banner.test.ts`

---

### Task 6: web/src/auth.ts — token bootstrap
**Files:**
- Create: web/src/auth.ts
- Test: web/src/auth.test.ts

**Interfaces:**
- Consumes: nothing (standalone module; browser `localStorage`/`location`/`history` globals via DOM lib)
- Produces (relied on by T8 main.tsx + Login.tsx, T10 Settings.tsx):
  - `parseTokenFromHash(hash: string): string | null` (pure)
  - `getToken(): string | null`
  - `setToken(t: string): void`
  - `clearToken(): void`
  - `bootstrapToken(): string | null`

- [ ] **Step 1: Write the failing test for the pure helper**

Create `web/src/auth.test.ts` (the global vitest environment is `node`; this file tests ONLY the pure `parseTokenFromHash` — no DOM):

```ts
import { describe, it, expect } from 'vitest'
import { parseTokenFromHash } from './auth'

describe('parseTokenFromHash', () => {
  it('extracts the token from a #token=... fragment', () => {
    expect(parseTokenFromHash('#token=abc')).toBe('abc')
  })

  it('extracts a long url-safe token verbatim', () => {
    const t = 'Ab_3-xYz0123456789_kQwErTyUiOpAsDfGhJkLzXcVbN'
    expect(parseTokenFromHash('#token=' + t)).toBe(t)
  })

  it('returns null when the token value is empty', () => {
    expect(parseTokenFromHash('#token=')).toBe(null)
  })

  it('returns null for an empty hash', () => {
    expect(parseTokenFromHash('')).toBe(null)
  })

  it('returns null when no token key is present', () => {
    expect(parseTokenFromHash('#other=1')).toBe(null)
  })

  it('returns null for a bare hash', () => {
    expect(parseTokenFromHash('#')).toBe(null)
  })
})
```

- [ ] **Step 2: Run the test — expect failure (module/export missing)**

Run: `npx vitest run web/src/auth.test.ts`
Expected: fails to resolve `./auth` (file does not exist yet) — red.

- [ ] **Step 3: Implement web/src/auth.ts**

Create `web/src/auth.ts`:

```ts
// Token storage + URL-hash bootstrap for the single bearer token (M6 auth).
// parseTokenFromHash is pure (unit-tested in env=node). The getter/setter/
// bootstrap shells touch browser globals and are verified by tsc only.
const TOKEN_KEY = 'cwa_token'

// Pure: '#token=abc' -> 'abc'; '#token=' / '' / no-token -> null.
export function parseTokenFromHash(hash: string): string | null {
  // URLSearchParams wants the part after '#'; tolerate a leading '#' or '?'.
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  const token = new URLSearchParams(raw).get('token')
  return token && token.length > 0 ? token : null
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(t: string): void {
  localStorage.setItem(TOKEN_KEY, t)
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
}

// On load: if the URL carries '#token=...', persist it and strip the fragment
// (so the token never lingers in the address bar / history), then return the
// effective stored token.
export function bootstrapToken(): string | null {
  const fromHash = parseTokenFromHash(location.hash)
  if (fromHash) {
    setToken(fromHash)
    history.replaceState(null, '', location.pathname + location.search)
  }
  return getToken()
}
```

- [ ] **Step 4: Run the test — expect pass**

Run: `npx vitest run web/src/auth.test.ts`
Expected: all 6 `parseTokenFromHash` cases pass — green.

- [ ] **Step 5: Confirm the module type-checks standalone**

Run: `npx tsc -p web/tsconfig.json --noEmit`
Expected: no NEW errors introduced by `web/src/auth.ts` (the file is standalone and uses only DOM-lib globals already in `lib`). The whole-web typecheck is otherwise unchanged from baseline at this point.

- [ ] **Step 6: Run the full suite (no regressions)**

Run: `npm test`
Expected: previous full-suite total + 6 new tests; 0 failures.

- [ ] **Step last: Commit**
`git add web/src/auth.ts web/src/auth.test.ts ; git commit -m 'feat(web-auth): add token storage + parseTokenFromHash bootstrap (T6)'`

---

### Task 7: web/src/ws.ts — token subprotocol, wss scheme, bounded reconnect
**Files:**
- Modify: web/src/ws.ts (whole file rewritten — lines 1-77)
- Test: web/src/ws.test.ts (whole file rewritten — lines 1-12)

**Interfaces:**
- Consumes: `ClientMsg`, `ServerMsg` from `@shared/protocol` (unchanged)
- Produces (relied on by T8 App.tsx):
  - `type WsStatus = 'connecting' | 'open' | 'closed'` (unchanged)
  - `wsUrl(host: string, protocol: string): string`
  - `classifyClose(s: { everOpened: boolean; consecutiveFailedConnects: number }): 'reconnect' | 'authfail'` (pure)
  - `createWsClient(opts: { onMessage: (m: ServerMsg) => void; onStatus?: (s: WsStatus) => void; token: string; onAuthError?: () => void }): { send: (m: ClientMsg) => void; close: () => void }`

Note on the gate: `npx tsc -p web/tsconfig.json` is intentionally NOT a T7 gate. App.tsx still calls the OLD `createWsClient({ onMessage, onStatus })` (no `token`) and the OLD `wsUrl(location.host)` is gone — so whole-web tsc is RED mid-migration here. App.tsx is rewired in T8, where whole-web tsc goes green. This matches this project's accepted "tsc red mid-migration" convention.

- [ ] **Step 1: Update the test first (new helper signatures + classifyClose truth table)**

Replace the ENTIRE contents of `web/src/ws.test.ts` (current lines 1-12) with:

```ts
import { describe, it, expect } from 'vitest'
import { wsUrl, classifyClose } from './ws'

describe('wsUrl', () => {
  it('uses ws:// under http', () => {
    expect(wsUrl('localhost:5173', 'http:')).toBe('ws://localhost:5173/ws')
  })

  it('uses wss:// under https (tunnel)', () => {
    expect(wsUrl('agent.example.com', 'https:')).toBe('wss://agent.example.com/ws')
  })

  it('preserves an arbitrary LAN host and port', () => {
    expect(wsUrl('192.168.1.5:8787', 'http:')).toBe('ws://192.168.1.5:8787/ws')
  })
})

describe('classifyClose', () => {
  it('reconnects when the socket had opened before', () => {
    expect(classifyClose({ everOpened: true, consecutiveFailedConnects: 5 })).toBe('reconnect')
  })

  it('reconnects on a single failed connect that never opened', () => {
    expect(classifyClose({ everOpened: false, consecutiveFailedConnects: 1 })).toBe('reconnect')
  })

  it('flags authfail after 2 consecutive failed connects that never opened', () => {
    expect(classifyClose({ everOpened: false, consecutiveFailedConnects: 2 })).toBe('authfail')
  })

  it('stays authfail beyond the threshold', () => {
    expect(classifyClose({ everOpened: false, consecutiveFailedConnects: 3 })).toBe('authfail')
  })
})
```

- [ ] **Step 2: Run the test — expect failure**

Run: `npx vitest run web/src/ws.test.ts`
Expected: fails — `classifyClose` is not exported and `wsUrl` arity changed — red.

- [ ] **Step 3: Rewrite web/src/ws.ts**

Replace the ENTIRE contents of `web/src/ws.ts` (current lines 1-77) with:

```ts
import type { ClientMsg, ServerMsg } from '@shared/protocol'

export type WsStatus = 'connecting' | 'open' | 'closed'

// Pure, testable. NEVER hardcode the dev port (#5) — derive everything from host.
// Scheme follows the page protocol so an https tunnel uses wss (no mixed-content).
export function wsUrl(host: string, protocol: string): string {
  return (protocol === 'https:' ? 'wss://' : 'ws://') + host + '/ws'
}

// Pure auth-fail heuristic. The browser WebSocket API does not surface the
// handshake 401 status, so we infer it: a socket that closes WITHOUT ever
// opening, twice in a row, is treated as an auth failure (bad/expired token).
// A socket that did open (everOpened) is just a network blip -> keep reconnecting.
export function classifyClose(s: {
  everOpened: boolean
  consecutiveFailedConnects: number
}): 'reconnect' | 'authfail' {
  if (!s.everOpened && s.consecutiveFailedConnects >= 2) return 'authfail'
  return 'reconnect'
}

export function createWsClient(opts: {
  onMessage: (m: ServerMsg) => void
  onStatus?: (s: WsStatus) => void
  token: string
  onAuthError?: () => void
}): { send: (m: ClientMsg) => void; close: () => void } {
  const { onMessage, onStatus, token, onAuthError } = opts
  const url = wsUrl(location.host, location.protocol)

  let ws: WebSocket
  let closedByUser = false
  let everOpened = false
  let consecutiveFailedConnects = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  const queue: string[] = []

  const status = (s: WsStatus) => {
    if (onStatus) onStatus(s)
  }

  const connect = () => {
    status('connecting')
    // Bearer token rides in the subprotocol so it never appears in the URL/logs.
    ws = new WebSocket(url, ['bearer', token])

    ws.onopen = () => {
      everOpened = true
      consecutiveFailedConnects = 0
      status('open')
      for (const q of queue) ws.send(q)
      queue.length = 0
    }

    ws.onmessage = (ev) => {
      try {
        onMessage(JSON.parse(ev.data as string) as ServerMsg)
      } catch {
        /* ignore malformed frames */
      }
    }

    ws.onerror = () => {
      status('closed')
    }

    ws.onclose = () => {
      status('closed')
      if (closedByUser) return
      // Count a close that never reached onopen as a failed connect attempt.
      if (!everOpened) consecutiveFailedConnects += 1
      if (classifyClose({ everOpened, consecutiveFailedConnects }) === 'authfail') {
        // Bad/expired token: stop the (previously unbounded) reconnect loop and
        // hand control back to the app (-> clear token, show Login).
        if (onAuthError) onAuthError()
        return
      }
      // Otherwise reconnect after a short delay.
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer)
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined
        connect()
      }, 1000)
    }
  }

  connect()

  return {
    send(m: ClientMsg) {
      const raw = JSON.stringify(m)
      if (ws.readyState === WebSocket.OPEN) ws.send(raw)
      else queue.push(raw)
    },
    close() {
      closedByUser = true
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer)
        reconnectTimer = undefined
      }
      ws.close()
    },
  }
}
```

- [ ] **Step 4: Run the test — expect pass**

Run: `npx vitest run web/src/ws.test.ts`
Expected: all `wsUrl` (3) + `classifyClose` (4) cases pass — green.

- [ ] **Step 5: Run the full suite (pure helpers green; whole-web tsc deferred)**

Run: `npm test`
Expected: previous full-suite total + (net change for ws.test.ts: it had 2 tests, now 7 → +5) ; 0 failures. Do NOT run `npx tsc -p web/tsconfig.json` as a gate here — App.tsx still calls the old `createWsClient` signature, so whole-web tsc is expected RED until T8.

- [ ] **Step last: Commit**
`git add web/src/ws.ts web/src/ws.test.ts ; git commit -m 'feat(web-ws): token subprotocol, wss scheme, bounded reconnect + classifyClose (T7)'`

---

### Task 8: web/src/api.ts + Login.tsx + main.tsx rewrite + App.tsx token transform
**Files:**
- Create: web/src/api.ts
- Create: web/src/components/Login.tsx
- Modify: web/src/main.tsx (whole file rewritten — lines 1-11)
- Modify: web/src/App.tsx (signature line 44; createWsClient useEffect lines 55-67)
- Test: web/src/api.test.ts (new)
- Modify: package.json (add `qrcode` dep + `@types/qrcode` devDep — installed now so T10's Settings import resolves; this task is where whole-web tsc must go green)

**Interfaces:**
- Consumes (from T6/T7): `bootstrapToken`, `clearToken`, `setToken` from `./auth`; `createWsClient` `{ token, onAuthError }` from `./ws`
- Produces:
  - `apiFetch(path: string, token: string, init?: RequestInit): Promise<Response>` (relied on by Login.tsx + T10 Settings.tsx)
  - `Login` component, prop `{ onAuthed: (token: string) => void }` (relied on by main.tsx)
  - `App` FINAL signature `{ token: string; onLogout: () => void }` (relied on by main.tsx; extended-not-changed by T9/T10)

- [ ] **Step 1: Install qrcode deps (needed before whole-web tsc, used by T10)**

Run: `npm i qrcode@^1.5.4 ; npm i -D @types/qrcode@^1.5.5`
Expected: `package.json` gains `"qrcode"` under dependencies and `"@types/qrcode"` under devDependencies; `package-lock.json` updated.

- [ ] **Step 2: Create web/src/api.ts**

```ts
// Thin fetch wrapper that attaches the bearer token. It does NOT handle 401
// itself — callers inspect res.status (Login probe, Settings model list).
export async function apiFetch(path: string, token: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers)
  headers.set('Authorization', 'Bearer ' + token)
  return fetch(path, { ...init, headers })
}
```

- [ ] **Step 3: Add a tiny test for the header (env=node has fetch; stub it)**

Create `web/src/api.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { apiFetch } from './api'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('apiFetch', () => {
  it('attaches an Authorization: Bearer header', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }))
    await apiFetch('/v1/models', 'tok-123')
    const init = spy.mock.calls[0][1] as RequestInit
    const headers = new Headers(init.headers)
    expect(headers.get('Authorization')).toBe('Bearer tok-123')
  })

  it('preserves caller-supplied headers alongside the token', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }))
    await apiFetch('/v1/models', 'tok-123', { headers: { 'X-Test': '1' } })
    const init = spy.mock.calls[0][1] as RequestInit
    const headers = new Headers(init.headers)
    expect(headers.get('X-Test')).toBe('1')
    expect(headers.get('Authorization')).toBe('Bearer tok-123')
  })
})
```

Run: `npx vitest run web/src/api.test.ts`
Expected: 2 tests pass — green.

- [ ] **Step 4: Create web/src/components/Login.tsx**

```tsx
import { useState } from 'react'
import { apiFetch } from '../api'
import { setToken } from '../auth'

// Standalone login gate: paste the bearer token, probe a guarded route to
// validate it, then hand the token up to Root (main.tsx) on success.
export function Login({ onAuthed }: { onAuthed: (token: string) => void }) {
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    const token = value.trim()
    if (!token || busy) return
    setBusy(true)
    setError(null)
    try {
      // Probe a GUARDED route (not /api/health, which is allow-listed).
      const res = await apiFetch('/v1/models', token)
      if (res.ok) {
        setToken(token)
        onAuthed(token)
        return
      }
      setError('token ไม่ถูกต้อง / invalid or expired token')
    } catch {
      setError('เชื่อมต่อไม่ได้ / could not reach the server')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-gray-50 px-4 py-10">
      <div className="flex w-full max-w-sm flex-col gap-4 rounded-2xl border bg-white p-6 shadow-sm sm:p-8">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold">Claude Web Agent</h1>
          <p className="text-sm text-gray-500">วาง token เพื่อเชื่อมต่อ</p>
        </div>

        <label className="text-sm font-medium text-gray-700" htmlFor="login-token">
          Token
        </label>
        <input
          id="login-token"
          type="password"
          autoComplete="off"
          className="w-full rounded-lg border px-3 py-3 font-mono text-base outline-none focus:ring-2 focus:ring-blue-400"
          placeholder="วาง token ที่นี่"
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            if (error) setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void submit()
            }
          }}
        />

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
            {error}
          </div>
        )}

        <button
          className="min-h-[44px] w-full rounded-lg bg-blue-600 px-4 py-3 text-base font-medium text-white hover:bg-blue-700 disabled:opacity-40"
          disabled={!value.trim() || busy}
          onClick={() => void submit()}
        >
          {busy ? 'กำลังเชื่อมต่อ…' : 'เชื่อมต่อ'}
        </button>

        <p className="text-center text-xs text-gray-400">
          สแกน QR จากหน้า Settings บนเครื่องที่รัน server เพื่อเข้าอัตโนมัติ
        </p>
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Rewrite web/src/main.tsx**

Replace the ENTIRE contents of `web/src/main.tsx` (current lines 1-11) with:

```tsx
import { StrictMode, useState } from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'
import { App } from './App'
import { Login } from './components/Login'
import { bootstrapToken, clearToken } from './auth'

// Root owns the token. One state-driven path covers both logout (Settings) and
// WS auth-fail: clearing the token unmounts App and remounts Login.
function Root() {
  const [token, setToken] = useState<string | null>(() => bootstrapToken())
  if (!token) return <Login onAuthed={setToken} />
  return (
    <App
      token={token}
      onLogout={() => {
        clearToken()
        setToken(null)
      }}
    />
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
```

- [ ] **Step 6: Transform App signature (App.tsx line 44)**

Find (exact, current line 44):

```tsx
export function App() {
```

Replace with:

```tsx
export function App({ token, onLogout }: { token: string; onLogout: () => void }) {
```

- [ ] **Step 7: Rewire the createWsClient useEffect (App.tsx lines 55-67)**

Find (exact, current lines 55-67):

```tsx
  useEffect(() => {
    const client = createWsClient({
      onMessage: (msg) => dispatch({ kind: 'server', msg }),
      onStatus: (s) => {
        setStatus(s)
        if (s === 'open' && activeChatRef.current) {
          client.send({ type: 'subscribe', chatId: activeChatRef.current })
        }
      },
    })
    clientRef.current = client
    return () => client.close()
  }, [])
```

Replace with:

```tsx
  useEffect(() => {
    const client = createWsClient({
      onMessage: (msg) => dispatch({ kind: 'server', msg }),
      onStatus: (s) => {
        setStatus(s)
        if (s === 'open' && activeChatRef.current) {
          client.send({ type: 'subscribe', chatId: activeChatRef.current })
        }
      },
      token,
      // WS auth-fail shares the in-app return path with the Logout button:
      // onLogout (from main.tsx Root) clears the token and remounts Login.
      onAuthError: onLogout,
    })
    clientRef.current = client
    return () => client.close()
  }, [token, onLogout])
```

- [ ] **Step 8: Whole-web typecheck + build — must be GREEN**

Run: `npx tsc -p web/tsconfig.json --noEmit`
Expected: 0 errors. App now consumes `token`/`onLogout`; main.tsx provides them; ws.ts/api.ts/auth.ts all resolve; qrcode types installed (no Settings consumer yet, but the dep is present). This is the boundary where the whole web compiles green again.

Run: `npm run build:web`
Expected: vite build succeeds (no type or resolution errors).

- [ ] **Step 9: Run the full suite (no regressions)**

Run: `npm test`
Expected: previous full-suite total + 2 new tests (api.test.ts); 0 failures.

- [ ] **Step last: Commit**
`git add web/src/api.ts web/src/api.test.ts web/src/components/Login.tsx web/src/main.tsx web/src/App.tsx package.json package-lock.json ; git commit -m 'feat(web-auth): apiFetch + Login gate + token-aware App/Root wiring (T8)'`

---

### Task 9: web/src/App.tsx + Sidebar.tsx — responsive drawer + hamburger
**Files:**
- Modify: web/src/App.tsx (add `navOpen` state near line 48; header lines ~171-183; Sidebar render lines ~162-169 → drawer wrapper)
- Modify: web/src/components/Sidebar.tsx (`aside` className line 32 → drawer-friendly)

This is a UI task. Note: the `impeccable` skill refines the visuals (spacing, motion, backdrop feel) during execution — the JSX/Tailwind below is the correct, type-checking baseline.

**Interfaces:**
- Consumes: `useState` (already imported in App.tsx line 1); App is in its T8 state `App({ token, onLogout })`
- Produces: App renders `<Sidebar>` as a static rail at `md+` and a slide-in drawer below `md`; Sidebar accepts the same props (no prop changes)

- [ ] **Step 1: Add navOpen state (App.tsx — after the newChat useState)**

The App body currently has these state lines (T8 state, unchanged from baseline here — lines 45-48):

```tsx
  const [state, dispatch] = useReducer(reducer, initialAppState)
  const [status, setStatus] = useState<WsStatus>('connecting')
  const [page, setPage] = useState<'chat' | 'settings'>('chat')
  const [newChat, setNewChat] = useState<NewChatDraft | null>(null)
```

Find (exact):

```tsx
  const [newChat, setNewChat] = useState<NewChatDraft | null>(null)
  const clientRef = useRef<ReturnType<typeof createWsClient> | null>(null)
```

Replace with:

```tsx
  const [newChat, setNewChat] = useState<NewChatDraft | null>(null)
  // Mobile nav drawer (static rail at md+, slide-in below md).
  const [navOpen, setNavOpen] = useState(false)
  const clientRef = useRef<ReturnType<typeof createWsClient> | null>(null)
```

- [ ] **Step 2: Close the drawer when a chat is selected (App.tsx selectChat)**

Find (exact, current lines 76-79):

```tsx
  const selectChat = (id: string) => {
    dispatch({ kind: 'setActive', chatId: id })
    clientRef.current?.send({ type: 'subscribe', chatId: id })
  }
```

Replace with:

```tsx
  const selectChat = (id: string) => {
    dispatch({ kind: 'setActive', chatId: id })
    clientRef.current?.send({ type: 'subscribe', chatId: id })
    setNavOpen(false)
  }
```

- [ ] **Step 3: Wrap Sidebar as a responsive drawer (App.tsx — the chat-page Sidebar render)**

Find (exact, current chat-page render — the `<Sidebar .../>` block at lines 161-169, which begins the main `return`):

```tsx
  return (
    <div className="flex h-full">
      <Sidebar
        chats={state.chats}
        activeChatId={activeId}
        onSelect={selectChat}
        onNew={openNewChat}
        onRename={renameChat}
        onDelete={deleteChat}
      />
      <div className="flex h-full flex-1 flex-col">
```

Replace with:

```tsx
  return (
    <div className="flex h-full">
      {/* Backdrop: only below md, only while the drawer is open. Tap to close. */}
      {navOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
          aria-hidden
          onClick={() => setNavOpen(false)}
        />
      )}
      <div
        className={
          'fixed inset-y-0 left-0 z-40 w-64 transform transition-transform duration-200 md:static md:z-auto md:translate-x-0 ' +
          (navOpen ? 'translate-x-0' : '-translate-x-full')
        }
      >
        <Sidebar
          chats={state.chats}
          activeChatId={activeId}
          onSelect={selectChat}
          onNew={openNewChat}
          onRename={renameChat}
          onDelete={deleteChat}
        />
      </div>
      <div className="flex h-full flex-1 flex-col">
```

- [ ] **Step 4: Add a hamburger button in the header (App.tsx header)**

Find (exact, current header lines 171-183):

```tsx
        <header className="flex items-center justify-between border-b bg-white px-4 py-3">
          <span className="text-lg font-semibold">Claude Web Agent</span>
          <div className="flex items-center gap-2">
            {status === 'closed' && (
              <span className="rounded bg-yellow-100 px-2 py-1 text-xs text-yellow-800">
                การเชื่อมต่อหลุด กำลังเชื่อมต่อใหม่…
              </span>
            )}
            <button className="rounded-lg border px-3 py-1.5 text-sm" onClick={() => setPage('settings')}>
              ⚙ Settings
            </button>
          </div>
        </header>
```

Replace with:

```tsx
        <header className="flex items-center justify-between border-b bg-white px-4 py-3">
          <div className="flex items-center gap-2">
            <button
              className="-ml-1 flex h-9 w-9 items-center justify-center rounded-lg border text-lg md:hidden"
              aria-label="เปิดเมนู"
              onClick={() => setNavOpen(true)}
            >
              ☰
            </button>
            <span className="text-lg font-semibold">Claude Web Agent</span>
          </div>
          <div className="flex items-center gap-2">
            {status === 'closed' && (
              <span className="rounded bg-yellow-100 px-2 py-1 text-xs text-yellow-800">
                การเชื่อมต่อหลุด กำลังเชื่อมต่อใหม่…
              </span>
            )}
            <button className="rounded-lg border px-3 py-1.5 text-sm" onClick={() => setPage('settings')}>
              ⚙ Settings
            </button>
          </div>
        </header>
```

- [ ] **Step 5: Make Sidebar fill the drawer height (Sidebar.tsx aside)**

Find (exact, Sidebar.tsx line 32):

```tsx
    <aside className="flex h-full w-64 flex-col border-r bg-gray-50">
```

Replace with:

```tsx
    <aside className="flex h-full w-64 flex-col border-r bg-gray-50 shadow-lg md:shadow-none">
```

- [ ] **Step 6: Typecheck + build**

Run: `npx tsc -p web/tsconfig.json --noEmit`
Expected: 0 errors.

Run: `npm run build:web`
Expected: vite build succeeds.

- [ ] **Step 7: Run the full suite (no new tests; no regressions)**

Run: `npm test`
Expected: same full-suite total as after T8; 0 failures.

- [ ] **Step last: Commit**
`git add web/src/App.tsx web/src/components/Sidebar.tsx ; git commit -m 'feat(web-mobile): responsive sidebar drawer + hamburger (T9)'`

---

### Task 10: web/src/components/Settings.tsx + App.tsx — harness panel, QR, model list, logout
**Files:**
- Modify: web/src/components/Settings.tsx (add `token`/`onLogout` props lines 19-35; add harness panel + logout in the body; add imports)
- Modify: web/src/App.tsx (pass `token`/`onLogout` to `<Settings>` — the `page === 'settings'` render at lines ~147-156)

UI task. Note: the `impeccable` skill refines the visuals during execution; the JSX/Tailwind below is the correct, type-checking baseline.

**Interfaces:**
- Consumes: `apiFetch` from `../api` (T8); `App` provides `token`/`onLogout` (T8 signature); `QRCode` default import from `qrcode` (dep installed in T8)
- Produces: `Settings` props extended with `token: string` + `onLogout: () => void` (App must pass them; main.tsx's `onLogout` owns clearing the token — Settings only calls `onLogout()`, never `clearToken()`)

- [ ] **Step 1: Pass token/onLogout from App to Settings (App.tsx)**

In the T9-state App, the settings-page render is unchanged from baseline (lines 144-158). Find (exact):

```tsx
  if (page === 'settings') {
    return (
      <div className="flex h-full">
        <Settings
          connections={state.connections}
          chats={state.chats}
          error={state.lastError}
          onCreate={createConnection}
          onUpdate={updateConnection}
          onDelete={deleteConnection}
          onClose={() => setPage('chat')}
        />
      </div>
    )
  }
```

Replace with:

```tsx
  if (page === 'settings') {
    return (
      <div className="flex h-full">
        <Settings
          connections={state.connections}
          chats={state.chats}
          error={state.lastError}
          onCreate={createConnection}
          onUpdate={updateConnection}
          onDelete={deleteConnection}
          onClose={() => setPage('chat')}
          token={token}
          onLogout={onLogout}
        />
      </div>
    )
  }
```

- [ ] **Step 2: Update Settings imports (Settings.tsx top)**

Find (exact, Settings.tsx lines 1-3):

```tsx
import { useState } from 'react'
import type { ConnectionMeta, ChatMeta } from '@shared/protocol'
import { ModelPicker } from './ModelPicker'
```

Replace with:

```tsx
import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import type { ConnectionMeta, ChatMeta } from '@shared/protocol'
import { ModelPicker } from './ModelPicker'
import { apiFetch } from '../api'
```

- [ ] **Step 3: Extend the Settings props (Settings.tsx signature)**

Find (exact, Settings.tsx lines 19-35):

```tsx
export function Settings({
  connections,
  chats,
  error,
  onCreate,
  onUpdate,
  onDelete,
  onClose,
}: {
  connections: ConnectionMeta[]
  chats: ChatMeta[]
  error?: string
  onCreate: (p: ConnectionFormPayload) => void
  onUpdate: (id: string, patch: { name?: string; baseUrl?: string; apiKey?: string; defaultModel?: string }) => void
  onDelete: (id: string) => void
  onClose: () => void
}) {
```

Replace with:

```tsx
export function Settings({
  connections,
  chats,
  error,
  onCreate,
  onUpdate,
  onDelete,
  onClose,
  token,
  onLogout,
}: {
  connections: ConnectionMeta[]
  chats: ChatMeta[]
  error?: string
  onCreate: (p: ConnectionFormPayload) => void
  onUpdate: (id: string, patch: { name?: string; baseUrl?: string; apiKey?: string; defaultModel?: string }) => void
  onDelete: (id: string) => void
  onClose: () => void
  token: string
  onLogout: () => void
}) {
```

- [ ] **Step 4: Add harness state + effects (Settings.tsx — after the existing useState lines)**

Find (exact, Settings.tsx lines 36-38):

```tsx
  // editId: undefined = not editing; '' = creating new; otherwise editing that id
  const [editId, setEditId] = useState<string | undefined>(undefined)
  const [form, setForm] = useState<ConnectionFormPayload>(emptyForm())
```

Replace with:

```tsx
  // editId: undefined = not editing; '' = creating new; otherwise editing that id
  const [editId, setEditId] = useState<string | undefined>(undefined)
  const [form, setForm] = useState<ConnectionFormPayload>(emptyForm())

  // Harness panel state.
  const origin = location.origin
  const [revealToken, setRevealToken] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [qrSrc, setQrSrc] = useState<string | null>(null)
  const [modelIds, setModelIds] = useState<string[] | null>(null)
  const [modelError, setModelError] = useState<string | null>(null)

  // qrcode.toDataURL returns a Promise -> resolve into state, then <img src>.
  useEffect(() => {
    let alive = true
    QRCode.toDataURL(`${origin}/#token=${token}`)
      .then((src) => {
        if (alive) setQrSrc(src)
      })
      .catch(() => {
        if (alive) setQrSrc(null)
      })
    return () => {
      alive = false
    }
  }, [origin, token])

  // Pull the compat model-id list (proves token works + shows what to paste).
  useEffect(() => {
    let alive = true
    apiFetch('/v1/models', token)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error('http ' + res.status))))
      .then((body: { data?: Array<{ id?: string }> }) => {
        if (!alive) return
        const ids = (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string')
        setModelIds(ids)
        setModelError(null)
      })
      .catch(() => {
        if (!alive) return
        setModelIds(null)
        setModelError('โหลดรายการ model ไม่ได้')
      })
    return () => {
      alive = false
    }
  }, [token])

  const copy = (label: string, text: string) => {
    void navigator.clipboard?.writeText(text)
    setCopied(label)
    setTimeout(() => setCopied((c) => (c === label ? null : c)), 1500)
  }
```

- [ ] **Step 5: Add the harness panel + Logout into the scroll body (Settings.tsx — at the end of the scroll container)**

The scroll body currently closes like this (Settings.tsx lines 199-202):

```tsx
          </div>
        )}
      </div>
    </div>
  )
}
```

The `</div>` at line 201 closes `<div className="flex-1 overflow-y-auto p-4">` (opened at line 74). Insert the harness panel + logout BEFORE that closing `</div>`.

Find (exact):

```tsx
          </div>
        )}
      </div>
    </div>
  )
}
```

Replace with:

```tsx
          </div>
        )}

        <section className="mt-6 flex flex-col gap-3 rounded-xl border bg-white p-4">
          <h3 className="text-base font-semibold">เชื่อมต่อจากที่อื่น / Harness</h3>
          <p className="text-sm text-gray-500">
            ใช้ base URL + token ด้านล่างเสียบ harness ภายนอกหรือโปรเจกต์อื่นได้เลย
          </p>

          <div className="grid gap-2 text-sm">
            <div className="flex items-center justify-between gap-2 rounded-lg border bg-gray-50 px-3 py-2">
              <div className="min-w-0">
                <div className="text-xs text-gray-500">Base URL (UI / native /api)</div>
                <div className="truncate font-mono">{origin}</div>
              </div>
              <button
                className="shrink-0 rounded-lg border px-3 py-2 text-xs"
                onClick={() => copy('origin', origin)}
              >
                {copied === 'origin' ? 'คัดลอกแล้ว' : 'คัดลอก'}
              </button>
            </div>

            <div className="flex items-center justify-between gap-2 rounded-lg border bg-gray-50 px-3 py-2">
              <div className="min-w-0">
                <div className="text-xs text-gray-500">Base URL (compat /v1)</div>
                <div className="truncate font-mono">{origin}/v1</div>
              </div>
              <button
                className="shrink-0 rounded-lg border px-3 py-2 text-xs"
                onClick={() => copy('v1', `${origin}/v1`)}
              >
                {copied === 'v1' ? 'คัดลอกแล้ว' : 'คัดลอก'}
              </button>
            </div>

            <div className="flex items-center justify-between gap-2 rounded-lg border bg-gray-50 px-3 py-2">
              <div className="min-w-0">
                <div className="text-xs text-gray-500">Token (= API key)</div>
                <div className="truncate font-mono">{revealToken ? token : '••••••••••••••••'}</div>
              </div>
              <div className="flex shrink-0 gap-1">
                <button
                  className="rounded-lg border px-3 py-2 text-xs"
                  onClick={() => setRevealToken((r) => !r)}
                >
                  {revealToken ? 'ซ่อน' : 'แสดง'}
                </button>
                <button className="rounded-lg border px-3 py-2 text-xs" onClick={() => copy('token', token)}>
                  {copied === 'token' ? 'คัดลอกแล้ว' : 'คัดลอก'}
                </button>
              </div>
            </div>
          </div>

          <div className="flex flex-col items-center gap-2 rounded-lg border bg-gray-50 p-3">
            <div className="text-xs text-gray-500">สแกนเพื่อเข้าจากมือถือ (auto-login)</div>
            {qrSrc ? (
              <img src={qrSrc} alt="QR สำหรับ auto-login" className="h-44 w-44" />
            ) : (
              <div className="flex h-44 w-44 items-center justify-center text-xs text-gray-400">
                กำลังสร้าง QR…
              </div>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <div className="text-xs font-medium text-gray-500">Model ids (compat)</div>
            {modelError ? (
              <p className="text-xs text-red-500">{modelError}</p>
            ) : modelIds === null ? (
              <p className="text-xs text-gray-400">กำลังโหลด…</p>
            ) : modelIds.length === 0 ? (
              <p className="text-xs text-gray-400">ยังไม่มี model</p>
            ) : (
              <ul className="max-h-40 overflow-y-auto rounded-lg border bg-gray-50 p-2 font-mono text-xs">
                {modelIds.map((id) => (
                  <li key={id} className="truncate py-0.5">
                    {id}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex flex-col gap-2 text-xs text-gray-600">
            <div className="rounded-lg border bg-gray-50 p-3">
              <div className="mb-1 font-medium text-gray-700">OpenAI-compatible</div>
              <div className="font-mono">base_url = {origin}/v1</div>
              <div className="font-mono">api_key = &lt;token&gt;</div>
            </div>
            <div className="rounded-lg border bg-gray-50 p-3">
              <div className="mb-1 font-medium text-gray-700">Anthropic</div>
              <div className="font-mono">ANTHROPIC_BASE_URL = {origin}</div>
              <div className="font-mono">x-api-key = &lt;token&gt;</div>
            </div>
          </div>

          <button
            className="mt-1 min-h-[44px] rounded-lg border border-red-200 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50"
            onClick={onLogout}
          >
            ออกจากระบบ / Logout
          </button>
        </section>
      </div>
    </div>
  )
}
```

- [ ] **Step 6: Typecheck + build**

Run: `npx tsc -p web/tsconfig.json --noEmit`
Expected: 0 errors (qrcode types resolve from T8 install; `apiFetch`/`token`/`onLogout` all wired).

Run: `npm run build:web`
Expected: vite build succeeds.

- [ ] **Step 7: Run the full suite (no new tests; no regressions)**

Run: `npm test`
Expected: same full-suite total as after T9; 0 failures.

- [ ] **Step last: Commit**
`git add web/src/components/Settings.tsx web/src/App.tsx ; git commit -m 'feat(web-auth): Settings harness panel + QR + model list + logout (T10)'`

---

### Task 11: touch/responsive polish — Composer, Message, modals, index.css
**Files:**
- Modify: web/src/components/Composer.tsx (buttons + textarea tap targets / padding)
- Modify: web/src/components/Message.tsx (bubble max-width / padding on mobile)
- Modify: web/src/components/PermissionModal.tsx (full-width modal on mobile, ≥44px buttons)
- Modify: web/src/components/NewChatModal.tsx (full-width modal on mobile, ≥44px buttons)
- Modify: web/src/components/FolderPicker.tsx (full-width modal on mobile, tap targets)
- Modify: web/src/index.css (mobile-safe height + tap-highlight reset)

UI task. Note: the `impeccable` skill refines the visuals during execution; the JSX/Tailwind/CSS below is the correct, type-checking baseline (≥44px tap targets, responsive padding/width, modals full-width on mobile).

**Interfaces:**
- Consumes: components in their current state (Composer/Message/PermissionModal/NewChatModal/FolderPicker unchanged from baseline; none touched by T6–T10)
- Produces: no API/signature changes — visual/markup only

- [ ] **Step 1: Composer — bigger tap targets + responsive padding**

Find (exact, Composer.tsx lines 11-35):

```tsx
  return (
    <div className="flex items-end gap-2 border-t bg-white p-3">
      <textarea
        className="flex-1 resize-none rounded-lg border px-3 py-2 outline-none focus:ring-2 focus:ring-blue-400"
        rows={2}
        placeholder="พิมพ์ข้อความ… (Enter ส่ง, Shift+Enter ขึ้นบรรทัด)"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submit()
          }
        }}
      />
      {disabled ? (
        <button className="rounded-lg bg-red-500 px-4 py-2 text-white" onClick={onStop}>
          Stop
        </button>
      ) : (
        <button className="rounded-lg bg-blue-600 px-4 py-2 text-white" onClick={submit}>
          ส่ง
        </button>
      )}
    </div>
  )
```

Replace with:

```tsx
  return (
    <div className="flex items-end gap-2 border-t bg-white p-3 sm:p-4">
      <textarea
        className="flex-1 resize-none rounded-lg border px-3 py-2 text-base outline-none focus:ring-2 focus:ring-blue-400"
        rows={2}
        placeholder="พิมพ์ข้อความ… (Enter ส่ง, Shift+Enter ขึ้นบรรทัด)"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submit()
          }
        }}
      />
      {disabled ? (
        <button
          className="min-h-[44px] shrink-0 rounded-lg bg-red-500 px-4 py-2 text-white"
          onClick={onStop}
        >
          Stop
        </button>
      ) : (
        <button
          className="min-h-[44px] shrink-0 rounded-lg bg-blue-600 px-4 py-2 text-white"
          onClick={submit}
        >
          ส่ง
        </button>
      )}
    </div>
  )
```

- [ ] **Step 2: Message — wider bubble on small screens**

Find (exact, Message.tsx lines 16-22):

```tsx
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} px-3 py-2`}>
      <div
        className={`max-w-[80%] rounded-2xl px-4 py-2 ${
          isUser ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-900'
        }`}
      >
```

Replace with:

```tsx
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} px-3 py-2 sm:px-4`}>
      <div
        className={`max-w-[88%] rounded-2xl px-4 py-2 sm:max-w-[80%] ${
          isUser ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-900'
        }`}
      >
```

- [ ] **Step 3: PermissionModal — full-width on mobile + ≥44px buttons**

Find (exact, PermissionModal.tsx lines 10-27):

```tsx
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-[90%] max-w-md rounded-xl bg-white p-5 shadow-xl">
        <h2 className="text-lg font-semibold">ขออนุญาตใช้เครื่องมือ</h2>
        <p className="mt-1 text-sm text-gray-600">
          Claude ต้องการใช้ <span className="font-mono font-semibold">{prompt.name}</span>
        </p>
        <pre className="mt-2 max-h-48 overflow-auto rounded bg-gray-100 p-2 text-xs">
          {JSON.stringify(prompt.input, null, 2)}
        </pre>
        <div className="mt-4 flex justify-end gap-2">
          <button className="rounded-lg border px-4 py-2" onClick={() => onDecide('deny')}>
            ปฏิเสธ
          </button>
          <button className="rounded-lg bg-blue-600 px-4 py-2 text-white" onClick={() => onDecide('allow')}>
            อนุญาต
          </button>
        </div>
      </div>
    </div>
```

Replace with:

```tsx
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center sm:p-4">
      <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
        <h2 className="text-lg font-semibold">ขออนุญาตใช้เครื่องมือ</h2>
        <p className="mt-1 text-sm text-gray-600">
          Claude ต้องการใช้ <span className="font-mono font-semibold">{prompt.name}</span>
        </p>
        <pre className="mt-2 max-h-48 overflow-auto rounded bg-gray-100 p-2 text-xs">
          {JSON.stringify(prompt.input, null, 2)}
        </pre>
        <div className="mt-4 flex justify-end gap-2">
          <button
            className="min-h-[44px] rounded-lg border px-4 py-2"
            onClick={() => onDecide('deny')}
          >
            ปฏิเสธ
          </button>
          <button
            className="min-h-[44px] rounded-lg bg-blue-600 px-4 py-2 text-white"
            onClick={() => onDecide('allow')}
          >
            อนุญาต
          </button>
        </div>
      </div>
    </div>
```

- [ ] **Step 4: NewChatModal — full-width on mobile + ≥44px buttons**

Find (exact, NewChatModal.tsx lines 31-33):

```tsx
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="flex w-[90%] max-w-md flex-col gap-3 rounded-xl bg-white p-5 shadow-xl">
        <div className="flex items-center justify-between">
```

Replace with:

```tsx
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center sm:p-4">
      <div className="flex w-full max-w-md flex-col gap-3 rounded-xl bg-white p-5 shadow-xl">
        <div className="flex items-center justify-between">
```

Find (exact, NewChatModal.tsx footer lines 69-80):

```tsx
        <div className="mt-2 flex justify-end gap-2">
          <button className="rounded-lg border px-4 py-2 text-sm" onClick={onClose}>
            ยกเลิก
          </button>
          <button
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-40"
            disabled={!draft.connectionId || !draft.model.trim()}
            onClick={onSubmit}
          >
            สร้าง
          </button>
        </div>
```

Replace with:

```tsx
        <div className="mt-2 flex justify-end gap-2">
          <button className="min-h-[44px] rounded-lg border px-4 py-2 text-sm" onClick={onClose}>
            ยกเลิก
          </button>
          <button
            className="min-h-[44px] rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-40"
            disabled={!draft.connectionId || !draft.model.trim()}
            onClick={onSubmit}
          >
            สร้าง
          </button>
        </div>
```

- [ ] **Step 5: FolderPicker — full-width on mobile + ≥44px footer buttons**

Find (exact, FolderPicker.tsx lines 24-25):

```tsx
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="flex max-h-[80vh] w-[90%] max-w-lg flex-col rounded-xl bg-white shadow-xl">
```

Replace with:

```tsx
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center sm:p-4">
      <div className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-xl bg-white shadow-xl">
```

Find (exact, FolderPicker.tsx footer lines 82-92):

```tsx
        <div className="flex justify-end gap-2 border-t p-4">
          <button className="rounded-lg border px-4 py-2 text-sm" onClick={onClose}>
            ยกเลิก
          </button>
          <button
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
            onClick={() => onChoose(state.path)}
          >
            เลือกโฟลเดอร์นี้
          </button>
        </div>
```

Replace with:

```tsx
        <div className="flex justify-end gap-2 border-t p-4">
          <button className="min-h-[44px] rounded-lg border px-4 py-2 text-sm" onClick={onClose}>
            ยกเลิก
          </button>
          <button
            className="min-h-[44px] rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
            onClick={() => onChoose(state.path)}
          >
            เลือกโฟลเดอร์นี้
          </button>
        </div>
```

- [ ] **Step 6: index.css — mobile-safe height + tap-highlight reset**

Replace the ENTIRE contents of `web/src/index.css` (current lines 1-6) with:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

html, body, #root { height: 100%; margin: 0; }
body {
  font-family: ui-sans-serif, system-ui, sans-serif;
  -webkit-tap-highlight-color: transparent;
  -webkit-text-size-adjust: 100%;
}

/* Use the dynamic viewport height on mobile so the chat input is not hidden
   behind the browser chrome / on-screen keyboard. */
@supports (height: 100dvh) {
  html, body, #root { height: 100dvh; }
}
```

- [ ] **Step 7: Typecheck + build**

Run: `npx tsc -p web/tsconfig.json --noEmit`
Expected: 0 errors.

Run: `npm run build:web`
Expected: vite build succeeds (Tailwind compiles the new `min-h-[44px]` / `sm:` / `dvh` utilities; arbitrary values are JIT-supported).

- [ ] **Step 8: Run the full suite (no new tests; no regressions)**

Run: `npm test`
Expected: same full-suite total as after T10; 0 failures.

- [ ] **Step last: Commit**
`git add web/src/components/Composer.tsx web/src/components/Message.tsx web/src/components/PermissionModal.tsx web/src/components/NewChatModal.tsx web/src/components/FolderPicker.tsx web/src/index.css ; git commit -m 'feat(web-mobile): touch targets + responsive modals + dvh viewport (T11)'`

---

### Task 12: e2e-{rest,openai,compat}.mjs — boot via buildApp + token

**Files:**
- Modify: `scripts/e2e-rest.mjs` (imports L7–18, backend wiring L40–47, every `fetch`/`new WebSocket`, teardown L165–168)
- Modify: `scripts/e2e-openai.mjs` (imports L6–16, backend wiring L40–47, `new WebSocket` L50, teardown L98–101)
- Modify: `scripts/e2e-compat.mjs` (imports L3–6, backend wiring L22–25, every `fetch`, teardown L75–79)

**Interfaces:**
- Consumes (from Task 4, server/app.ts): `export function buildApp(deps: BuildAppDeps): { app: FastifyInstance; wss: WebSocketServer }` where `BuildAppDeps = { db; hub; makeProvider; token: string; turnTimeoutMs?; webDist? }`. `buildApp` registers the global onRequest auth hook, `registerHttpApi`, `registerCompatApi`, optional static/SPA, and `attachWebSocketServer(app.server, hub, { token })`; it does NOT call `app.listen`.
- Consumes (real code): `new ChatHub({ db, makeProvider, genId, now })` (server/hub.ts); `openDb(path)`, `listMessages`, `createConnection` (server/store.ts); `makeProvider` (server/providers/index.ts).
- Consumes (§4 guard): guarded `/api/*` (except `GET /api/health`) and `/v1/*` require `Authorization: Bearer <token>` or `x-api-key: <token>`; failure → `401` with body `{ error:'unauthorized' }` for `/api/*`, `{ type:'error', error:{ type:'authentication_error', message } }` for `/v1/messages`, `{ error:{ message, type:'authentication_error' } }` for other `/v1/*`. WS auth via subprotocol `['bearer', token]`.
- Produces: three credential-free e2e scripts that boot the real auth-guarded stack via `buildApp`; consumed by the gate `npx tsx scripts/e2e-{compat,rest,openai}.mjs` (per global constraints) and referenced by Task 14 (README). e2e-rest/e2e-openai keep `process.exit(0)`; e2e-compat keeps natural-exit.

Note: this task only rewires the three scripts; it preserves every existing positive assertion verbatim and only ADDS the negative (401) assertion. No vitest is added (these are standalone driver scripts, not unit tests).

- [ ] **Step 1: Rewrite scripts/e2e-rest.mjs imports to drop inline wiring and add buildApp.**
  Replace the import block (current L12–18) so `Fastify`, `attachWebSocketServer`, and `registerHttpApi` are gone and `buildApp` is imported (extensionless, matching this file's style). Old:
  ```js
  import Fastify from 'fastify'
  import { WebSocket } from 'ws'
  import { attachWebSocketServer } from '../server/ws'
  import { registerHttpApi } from '../server/http-api'
  import { ChatHub } from '../server/hub'
  import { openDb, listMessages, createConnection } from '../server/store'
  import { makeProvider } from '../server/providers/index'
  ```
  New:
  ```js
  import { WebSocket } from 'ws'
  import { buildApp } from '../server/app'
  import { ChatHub } from '../server/hub'
  import { openDb, listMessages, createConnection } from '../server/store'
  import { makeProvider } from '../server/providers/index'
  ```

- [ ] **Step 2: Rewire the e2e-rest backend block to boot via buildApp + a token.**
  Replace the backend section (current L40–49) so the script builds db + hub, calls `buildApp`, and listens itself (buildApp does not call listen). Old:
  ```js
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
  ```
  New:
  ```js
  // 2) Backend: real auth-guarded stack via buildApp, temp DB, seeded openai-compatible connection.
  const TOKEN = 'e2e-token'
  const AUTH = { authorization: `Bearer ${TOKEN}` }
  const dbPath = join(mkdtempSync(join(tmpdir(), 'cwa-e2e-rest-')), 'chats.db')
  const db = openDb(dbPath)
  const hub = new ChatHub({ db, makeProvider, genId: randomUUID, now: Date.now })
  const { app } = buildApp({ db, hub, makeProvider, token: TOKEN })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const port = app.server.address().port
  const api = `http://127.0.0.1:${port}/api`

  // 2a) Negative + positive auth gate: guarded /api/* with no token -> 401; with token -> 200.
  const noTokRes = await fetch(`${api}/connections`)
  if (noTokRes.status !== 401) fail(`unauthenticated GET /api/connections -> ${noTokRes.status} (want 401)`)
  const noTokBody = await noTokRes.json()
  if (noTokBody.error !== 'unauthorized') fail(`401 body was ${JSON.stringify(noTokBody)} (want {error:'unauthorized'})`)
  const okTokRes = await fetch(`${api}/connections`, { headers: AUTH })
  if (okTokRes.status !== 200) fail(`authenticated GET /api/connections -> ${okTokRes.status} (want 200)`)
  ```

- [ ] **Step 3: Add the Bearer token to the e2e-rest WS subscriber.**
  Replace the WS open line (current L63):
  ```js
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  ```
  New:
  ```js
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ['bearer', TOKEN])
  ```

- [ ] **Step 4: Attach AUTH headers to all remaining e2e-rest fetch calls.**
  Each `fetch` that targets `/api/*` must carry the Bearer token. Apply these exact header edits (merging `...AUTH` into existing `headers`, or adding `headers: AUTH` where there were none):
  - POST `/api/chats` (create chat, current L69–73): `headers: { ...AUTH, 'content-type': 'application/json' }`
  - POST `/api/chats/${chatId}/messages` non-stream (L83–87): `headers: { ...AUTH, 'content-type': 'application/json' }`
  - POST `/api/chats/${chatId}/messages` SSE (L93–97): `headers: { ...AUTH, 'content-type': 'application/json' }`
  - POST `/api/query` (L124–128): `headers: { ...AUTH, 'content-type': 'application/json' }`
  - GET `/api/connections` (the existing leak check, L133): `await fetch(`${api}/connections`, { headers: AUTH })`
  - POST `/api/chats` build-failure create (L148–152): `headers: { ...AUTH, 'content-type': 'application/json' }`
  - POST `/api/chats/${bfChatId}/messages` build-failure (L155–159): `headers: { ...AUTH, 'content-type': 'application/json' }`
  For example, the create-chat call becomes:
  ```js
  const createRes = await fetch(`${api}/chats`, {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({ connectionId: connId, model: 'fake-model', title: 'rest' }),
  })
  ```
  and the leak check becomes:
  ```js
  const conns = await (await fetch(`${api}/connections`, { headers: AUTH })).json()
  if (conns.connections.some((c) => 'apiKey' in c)) fail('apiKey leaked in GET /api/connections')
  ```
  Leave the success log and the existing assertions (status checks, role string, deltas, leak check, build-failure error/done events) unchanged.

- [ ] **Step 5: Run e2e-rest and confirm PASS.**
  Run: `npx tsx scripts/e2e-rest.mjs`
  Expected: stdout contains `✅ native HTTP API e2e PASS — REST + SSE + live-sync + persistence + /api/query` and the process exits with code 0 (no `❌` lines).

- [ ] **Step 6: Rewrite scripts/e2e-openai.mjs imports to drop inline wiring and add buildApp.**
  Replace the import block (current L11–16). Old:
  ```js
  import Fastify from 'fastify'
  import { WebSocket } from 'ws'
  import { attachWebSocketServer } from '../server/ws'
  import { ChatHub } from '../server/hub'
  import { openDb, listMessages } from '../server/store'
  import { makeProvider } from '../server/providers/index'
  ```
  New:
  ```js
  import { WebSocket } from 'ws'
  import { buildApp } from '../server/app'
  import { ChatHub } from '../server/hub'
  import { openDb, listMessages } from '../server/store'
  import { makeProvider } from '../server/providers/index'
  ```

- [ ] **Step 7: Rewire the e2e-openai backend block to boot via buildApp + token, with a negative gate assertion.**
  Replace the backend section (current L40–47). Old:
  ```js
  // 2) Backend with a temp DB.
  const dbPath = join(mkdtempSync(join(tmpdir(), 'cwa-e2e-')), 'chats.db')
  const db = openDb(dbPath)
  const app = Fastify()
  const hub = new ChatHub({ db, makeProvider, genId: randomUUID, now: Date.now })
  attachWebSocketServer(app.server, hub)
  await app.listen({ port: 0, host: '127.0.0.1' })
  const port = app.server.address().port
  ```
  New:
  ```js
  // 2) Backend with a temp DB, booted through the real auth-guarded stack via buildApp.
  const TOKEN = 'e2e-token'
  const dbPath = join(mkdtempSync(join(tmpdir(), 'cwa-e2e-')), 'chats.db')
  const db = openDb(dbPath)
  const hub = new ChatHub({ db, makeProvider, genId: randomUUID, now: Date.now })
  const { app } = buildApp({ db, hub, makeProvider, token: TOKEN })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const port = app.server.address().port

  // 2a) Auth gate: guarded /api/* with no token -> 401; with token -> 200.
  const noTokRes = await fetch(`http://127.0.0.1:${port}/api/connections`)
  if (noTokRes.status !== 401) fail(`unauthenticated GET /api/connections -> ${noTokRes.status} (want 401)`)
  const okTokRes = await fetch(`http://127.0.0.1:${port}/api/connections`, { headers: { authorization: `Bearer ${TOKEN}` } })
  if (okTokRes.status !== 200) fail(`authenticated GET /api/connections -> ${okTokRes.status} (want 200)`)
  ```

- [ ] **Step 8: Add the Bearer token to the e2e-openai WS connection.**
  Replace the WS open line (current L50):
  ```js
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  ```
  New:
  ```js
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ['bearer', TOKEN])
  ```
  All driving in this script (create_connection, create_chat, user_message) flows over this authenticated WS, so no other edits are needed. Leave the success log and existing assertions (streamed `Hello e2e`, persisted `user,assistant`, persisted assistant text) unchanged.

- [ ] **Step 9: Run e2e-openai and confirm PASS.**
  Run: `npx tsx scripts/e2e-openai.mjs`
  Expected: stdout contains `✅ openai-compatible e2e PASS — streamed + persisted "Hello e2e"` and the process exits with code 0 (no `❌` lines).

- [ ] **Step 10: Rewrite scripts/e2e-compat.mjs imports to drop inline wiring and add buildApp (.ts extensions).**
  Replace the import block (current L3–6). This file uses `.ts` extensions — keep them. Old:
  ```js
  import Fastify from 'fastify'
  import { openDb } from '../server/store.ts'
  import { registerCompatApi } from '../server/compat/index.ts'
  ```
  New:
  ```js
  import { openDb } from '../server/store.ts'
  import { ChatHub } from '../server/hub.ts'
  import { buildApp } from '../server/app.ts'
  ```

- [ ] **Step 11: Rewire the e2e-compat backend block to boot via buildApp + token (FakeProvider), with a negative gate assertion.**
  Replace the backend section (current L22–26). Old:
  ```js
  const db = openDb(':memory:')
  const app = Fastify()
  registerCompatApi(app, { db, makeProvider: () => new FakeProvider() })
  await app.listen({ port: PORT, host: '127.0.0.1' })
  const base = `http://127.0.0.1:${PORT}`
  ```
  New:
  ```js
  const TOKEN = 'e2e-token'
  const AUTH = { authorization: `Bearer ${TOKEN}` }
  const db = openDb(':memory:')
  const hub = new ChatHub({ db, makeProvider: () => new FakeProvider(), genId: randomUUID, now: Date.now })
  const { app } = buildApp({ db, hub, makeProvider: () => new FakeProvider(), token: TOKEN })
  await app.listen({ port: PORT, host: '127.0.0.1' })
  const base = `http://127.0.0.1:${PORT}`
  ```
  This file does not currently import `randomUUID`; add it at the top of the file (after the existing imports, keeping node-builtin import style):
  ```js
  import { randomUUID } from 'node:crypto'
  ```
  Then, immediately after the `assert` helper definition (current L28), add the auth gate (note `/v1/*` uses the `/v1/*` body shape, not `/api/*`):
  ```js
  // 0) Auth gate: guarded /v1/* with no token -> 401 (authentication_error); with token -> 200.
  const noTokRes = await fetch(`${base}/v1/models`)
  assert(noTokRes.status === 401, `unauthenticated GET /v1/models -> ${noTokRes.status} (want 401)`)
  const noTokBody = await noTokRes.json()
  assert(noTokBody.error && noTokBody.error.type === 'authentication_error', `401 body was ${JSON.stringify(noTokBody)}`)
  ```

- [ ] **Step 12: Attach AUTH headers to all e2e-compat fetch calls.**
  Every `/v1/*` request is now guarded, so add the Bearer token to each:
  - `GET /v1/models` positive check (current L31): `await fetch(`${base}/v1/models`, { headers: AUTH })`
  - `POST /v1/chat/completions` non-stream (L36–39): `headers: { ...AUTH, 'content-type': 'application/json' }`
  - `POST /v1/chat/completions` stream (L43–46): `headers: { ...AUTH, 'content-type': 'application/json' }`
  - `POST /v1/messages` non-stream (L50–53): `headers: { ...AUTH, 'content-type': 'application/json' }`
  - `POST /v1/messages` stream (L57–60): `headers: { ...AUTH, 'content-type': 'application/json' }`
  - `POST /v1/chat/completions` -auto policy (L64–67): `headers: { ...AUTH, 'content-type': 'application/json' }`
  - `POST /v1/chat/completions` readonly policy (L68–71): `headers: { ...AUTH, 'content-type': 'application/json' }`
  For example, the `/v1/models` positive check and the OpenAI non-stream call become:
  ```js
  // 1) /v1/models lists the seeded local connection + its -auto variant
  const models = await (await fetch(`${base}/v1/models`, { headers: AUTH })).json()
  const ids = models.data.map((m) => m.id)
  assert(models.object === 'list' && ids.includes('local/sonnet') && ids.includes('local-auto/sonnet'), '/v1/models shape')

  // 2) OpenAI non-stream
  const oai = await (await fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'local/sonnet', messages: [{ role: 'user', content: 'world' }], stream: false }),
  })).json()
  assert(oai.object === 'chat.completion' && oai.choices[0].message.content.startsWith('Hello world'), 'openai non-stream')
  ```
  Leave every existing assertion message and the natural-exit teardown (the `await app.close()` + comment + final `console.log`, current L75–79) unchanged — do NOT add `process.exit(0)` here.

- [ ] **Step 13: Run e2e-compat and confirm PASS.**
  Run: `npx tsx scripts/e2e-compat.mjs`
  Expected: stdout contains `✅ compat API e2e PASS — /v1/models + openai + anthropic (stream + non-stream) + policy` and the process exits with code 0 naturally (no `❌` lines, no hang).

- [ ] **Step 14: Run all three e2e back-to-back as the gate sees them.**
  Run: `npx tsx scripts/e2e-rest.mjs; npx tsx scripts/e2e-openai.mjs; npx tsx scripts/e2e-compat.mjs`
  Expected: three `✅ ... PASS` lines, one per script, and no `❌` lines.

- [ ] **Step 15: Commit.**
  Run: `git add scripts/e2e-rest.mjs scripts/e2e-openai.mjs scripts/e2e-compat.mjs`
  Run:
  ```
  git commit -m 'test(m6): boot credential-free e2e via buildApp + bearer token

  Rewire e2e-{rest,openai,compat} to construct db+hub and boot the real
  auth-guarded stack through buildApp instead of inline Fastify wiring.
  Attach Authorization: Bearer to every fetch and ['"'"'bearer'"'"', token] to
  every WebSocket, and add a 401-without-token / 200-with-token gate
  assertion to each. Keep process.exit(0) in rest/openai (after fake.close)
  and natural-exit in compat. All existing assertions preserved.

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>'
  ```

---

### Task 13: e2e-multichat.mjs — token via file+env+subprotocol

**Files:**
- Modify: `scripts/e2e-multichat.mjs` (imports block; `TMP`/`DB_PATH` setup near top; child `spawn` env; readiness-detection `data` handler; both `connect()` WebSocket constructions; `removeTempDb()`/cleanup)

**Interfaces:**
- Consumes: `loadOrCreateToken(tokenPath: string): string` (server/auth.ts, Task 2 — idempotent: returns the existing file's token if present); `server/index.ts` (Task 5) reading `TOKEN_PATH` env and printing a banner line whose text includes `'listening on http://<ip>:PORT'`; child spawn `npx tsx server/index.ts` keyed by env `{PORT, DB_PATH, TOKEN_PATH}`; WS auth via subprotocol `['bearer', token]` (server/ws.ts, Task 3 + buildApp wiring, Task 4).
- Produces: nothing (leaf manual regression script; not imported anywhere).

> Note: this remains a MANUAL Claude-login regression covering spec criteria #1 (multi-chat isolation) and #2 (concurrent turns). It is NOT in the automated gate and is NOT run by CI; it requires an interactive `claude` login on the host. The token plumbing below lets it pass the M6 auth guard so the manual run still works.

- [ ] **Step 1: Read the current script to anchor the edits.**
  Run: `npx tsx --version` (sanity: tsx present) and open the file.
  Read `scripts/e2e-multichat.mjs` in full. Confirm the real anchors before editing: the import line(s) (`rmSync` from node:fs, `tmpdir`, `join`, `WebSocket`), the `DB_PATH` construction, the `spawn('npx', ['tsx', 'server/index.ts'], { env: ... })` call, the readiness `child.stdout.on('data', ...)` block (currently keys on `'WebSocket listening'`), the single `new WebSocket(WS_URL)` construction inside `connect()` (the helper is called twice — Connection A and Connection B), and `removeTempDb()`.
  Expected: you can quote each anchor verbatim; the file currently constructs `new WebSocket(WS_URL)` with NO subprotocol and keys readiness on the substring `'WebSocket listening'`.

- [ ] **Step 2: Ensure the imports cover `writeFileSync` + `rmSync` + `tmpdir` + `join`.**
  In the existing `node:fs` import, add `writeFileSync` (and `rmSync` if not already there). Ensure `tmpdir` from `node:os` and `join` from `node:path` are imported. Edit the existing import lines so they read exactly (merge with whatever else the file already imports from these modules — do NOT duplicate a module specifier):
  ```js
  import { writeFileSync, rmSync } from 'node:fs'
  import { tmpdir } from 'node:os'
  import { join } from 'node:path'
  ```
  Expected: no duplicate import of `node:fs` / `node:os` / `node:path`; `writeFileSync`, `rmSync`, `tmpdir`, `join` all in scope.

- [ ] **Step 3: Define the token path + value and write the token file BEFORE spawn.**
  Immediately after the `DB_PATH` (temp-dir) construction and before the `spawn(...)` call, add the token wiring. `loadOrCreateToken` is idempotent, so pre-seeding the file makes the spawned server adopt this exact value:
  ```js
  // M6 auth: pre-seed a known token so the spawned server adopts it (loadOrCreateToken is idempotent),
  // and so the WS subprotocol below can authenticate. Per-pid path avoids cross-run collisions.
  const TOKEN_PATH = join(tmpdir(), 'cwa-e2e-' + process.pid + '.token')
  const TOKEN = 'e2e-multichat-token'
  writeFileSync(TOKEN_PATH, TOKEN)
  ```
  Expected: `TOKEN_PATH` and `TOKEN` are in scope above the spawn; the file exists on disk before the child starts.

- [ ] **Step 4: Pass `TOKEN_PATH` into the child env.**
  Update the `spawn` env so the child inherits the real environment plus the three keys. Replace the existing `env` object on the `spawn('npx', ['tsx', 'server/index.ts'], { ... })` call:
  ```js
  env: { ...process.env, PORT: String(PORT), DB_PATH, TOKEN_PATH },
  ```
  Expected: child receives `PORT`, `DB_PATH`, and `TOKEN_PATH`; `...process.env` preserves PATH so `npx`/`tsx` resolve and the interactive `claude` login is visible to the child.

- [ ] **Step 5: Re-key readiness detection on the NEW banner marker.**
  Task 5's banner prints a line containing `'listening on http://<ip>:PORT'` (the old `app.log.info('WebSocket listening …')` line is gone). Update the readiness `stdout` handler to match the substring `'listening on'` (NOT bare `'listening'` — Fastify's own pino logger emits `'Server listening at …'` which also contains `'listening'`; `'listening on'` matches only our banner). In the `child.stdout.on('data', ...)` block, change the guard:
  ```js
  child.stdout.on('data', (buf) => {
    const text = buf.toString()
    process.stdout.write(text)
    if (!ready && text.includes('listening on')) {
      ready = true
      resolve()
    }
  })
  ```
  Expected: readiness fires on the banner line; `'listening on'` matches our banner (`  listening on http://…`) and NOT Fastify's pino `'Server listening at …'` line. (If the file uses a different variable name than `ready`/`resolve`, keep its existing names — only swap the matched substring from `'WebSocket listening'` to `'listening on'`.)

- [ ] **Step 6: Send the token via subprotocol on the WebSocket construction.**
  In `connect()` (the helper that opens a chat connection — called twice), change the single `new WebSocket(WS_URL)` to pass the `['bearer', TOKEN]` subprotocol so the connection clears the WS `verifyClient` guard (Task 3):
  ```js
  const ws = new WebSocket(WS_URL, ['bearer', TOKEN])
  ```
  Expected: `git grep -n "new WebSocket(WS_URL)" scripts/e2e-multichat.mjs` returns nothing (the bare form is gone); the construction now carries the subprotocol array. Without it, the server closes the socket with 401 and the script hangs/fails.

- [ ] **Step 7: Remove the token file in cleanup.**
  In `removeTempDb()` (the cleanup helper invoked on success and in the failure/`catch` path), add a guarded `rmSync` for the token file alongside the existing temp-dir removal. Match the existing style — if the function already wraps removals in `try { … } catch {}`, add inside that block:
  ```js
  try { rmSync(TOKEN_PATH, { force: true }) } catch {}
  ```
  Expected: after a run (pass or fail) the per-pid `cwa-e2e-<pid>.token` file is gone; `force: true` makes a missing file a no-op so cleanup never throws.

- [ ] **Step 8: Static-check the script parses and the anchors are correct.**
  Run: `node --check scripts/e2e-multichat.mjs`
  Expected: exits 0 (no syntax error).
  Run: `git grep -n "new WebSocket(WS_URL, \['bearer', TOKEN\])" scripts/e2e-multichat.mjs`
  Expected: exactly one match (the single construction in `connect()`).
  Run: `git grep -n "TOKEN_PATH" scripts/e2e-multichat.mjs`
  Expected: matches at the `join(tmpdir(), …)` definition, the `writeFileSync`, the `spawn` env, and the `rmSync` cleanup (4 sites).
  Run: `git grep -n "WebSocket listening" scripts/e2e-multichat.mjs`
  Expected: no matches (old marker fully removed).

- [ ] **Step 9: Confirm the automated gate is unaffected.**
  This script is NOT in the gate, but verify nothing else broke by running the repo's non-interactive checks.
  Run (from repo root): `npm run typecheck` then `npm test`
  Expected: `typecheck` passes; vitest reports the M6 baseline green (258 plus any tests added in earlier tasks) — this script change adds no unit tests and must not change the count.
  Run (manual, requires `claude` login — do NOT run in CI): `npx tsx scripts/e2e-multichat.mjs`
  Expected: prints the readiness banner line containing `listening on http://`, opens two authenticated WS connections, exercises multi-chat isolation (criteria #1) and concurrent turns (criteria #2), then exits cleanly with the per-pid token file and temp DB removed.

- [ ] **Step 10: Commit.**
  Run:
  ```
  git add scripts/e2e-multichat.mjs
  git commit -m 'test(m6): e2e-multichat token via file+env+subprotocol, re-key readiness on new banner'
  ```
  Expected: a single commit containing only `scripts/e2e-multichat.mjs`.

---

### Task 14: README + http-api comment cleanup

**Files:**
- Modify: `README.md` (rewrite §"Native HTTP API" Auth note ~L77-79; add new top-level "Security / Run" section after the intro ~L3; refresh M5-only deferral asides in §"Compatibility API" ~L92, L138-139, L159 and §"Status"/§"Security" ~L163, L169, L171)
- Modify: `server/http-api.ts` (comment at ~L65; comment at ~L99; TODO note at ~L143-144) — comments only, NO code behavior change
- Test: none (docs + comments; verified by `npm run typecheck`)

**Interfaces:**
- Consumes (real signatures, already in code after Tasks 1-13):
  - `server/index.ts` env: `HOST` (default `0.0.0.0`), `PORT` (default `8787`), `DB_PATH` (default `data/chats.db`), `TOKEN_PATH` (default `join(dirname(DB_PATH), '.token')`), `TURN_TIMEOUT_MS`
  - `loadOrCreateToken(tokenPath: string): string` writing the 43-char `base64url` token to `data/.token`
  - `buildApp(deps: BuildAppDeps)` enforces the §4 HTTP onRequest auth guard; `attachWebSocketServer(httpServer, hub, { token })` enforces WS subprotocol auth
  - Auth on HTTP: `Authorization: Bearer <t>` OR `x-api-key: <t>`; compat base URL `<origin>/v1`
  - `npm run build:web` → `web/dist`; `npm start` serves single-origin (static SPA + `/api` + `/v1` + `/ws`)
- Produces: documentation only — no symbols other tasks rely on. This is the LAST task in the milestone.

- [ ] **Step 1: Read the two real files to confirm exact current wording.**
  Run: `git -C . grep -n "is M6\|TODO(M6)\|M6 binds localhost\|arrive in M6\|M5 is localhost\|until M6\|M6 auth is in place\|Tracked for M6\|out of scope until M6\|M6:" -- README.md server/http-api.ts`
  Expected: the matches at `server/http-api.ts:65` (`Per-turn cancellation is M6.`), `server/http-api.ts:99` (`explicit flow control / drain handling is M6.`), `server/http-api.ts:143-144` (`TODO(M6): bearer-token auth + 0.0.0.0 bind. …`), plus the README asides at lines ~77-79, ~92, ~139, ~159, ~163, ~169, ~171. Confirms nothing has drifted before editing.

- [ ] **Step 2: Fix the `http-api.ts` line-65 comment ('is M6' → deferred).**
  In `server/http-api.ts`, replace the trailing sentence of the `raw.on('error')` block comment.
  Old:
  ```ts
  // as the WS surface, where a disconnect does not abort the turn. Per-turn cancellation is M6.
  ```
  New:
  ```ts
  // as the WS surface, where a disconnect does not abort the turn. Per-turn cancellation is deferred.
  ```

- [ ] **Step 3: Fix the `http-api.ts` line-99 comment ('is M6' → deferred / future work).**
  In `server/http-api.ts`, replace the backpressure-note sentence.
  Old:
  ```ts
    // Backpressure note: a stalled-but-alive reader buffers this turn's frames in the Node
    // stream (bounded per turn, localhost) — explicit flow control / drain handling is M6.
  ```
  New:
  ```ts
    // Backpressure note: a stalled-but-alive reader buffers this turn's frames in the Node
    // stream (bounded per turn) — explicit flow control / drain handling is deferred / future work.
  ```
  (The parenthetical drops "localhost" because the server now LAN-binds; the buffering bound is still per-turn.)

- [ ] **Step 4: Replace the `TODO(M6)` note above `registerHttpApi` with a one-line auth note.**
  In `server/http-api.ts` (~L141-144), update the function doc block. NO code below it changes.
  Old:
  ```ts
  // Native HTTP API (REST + SSE). Shares the ChatHub/ChatRuntime engine with the WS UI so
  // turns originated here broadcast to WS subscribers for free (live-sync).
  // TODO(M6): bearer-token auth + 0.0.0.0 bind. M4 stays on the localhost listener and does
  // NOT enforce a token (see README "Native HTTP API").
  export function registerHttpApi(app: FastifyInstance, deps: HttpApiDeps): void {
  ```
  New:
  ```ts
  // Native HTTP API (REST + SSE). Shares the ChatHub/ChatRuntime engine with the WS UI so
  // turns originated here broadcast to WS subscribers for free (live-sync).
  // Auth: bearer-token enforcement for /api/* lives in the buildApp onRequest guard (server/app.ts),
  // not here — these routes assume the request already passed that hook.
  export function registerHttpApi(app: FastifyInstance, deps: HttpApiDeps): void {
  ```

- [ ] **Step 5: Add the new "Security / Run" section to `README.md` (after the intro paragraph).**
  Insert a fresh top-level section immediately after line 3 (the intro paragraph, before `## Prerequisites`). Use this exact markdown:
  ```markdown

  ## Security / Run (LAN + auth)

  The server binds **`0.0.0.0`** by default so you can reach it from other devices on your LAN
  (e.g. your phone). All `/api/*` (except `GET /api/health`) and all `/v1/*` routes require a
  **bearer token**; static files (the SPA) are served without auth.

  ### The token

  On first start the server generates a 43-char URL-safe token and writes it to **`data/.token`**
  (gitignored). The same token is reused on every later start. The startup banner prints the token,
  the LAN URLs, and a **QR code** that encodes `http://<lan-ip>:<port>/#token=<token>`.

  Connect a phone by either:
  - **Scan the QR code** with the phone camera — it opens the app and auto-logs-in via the URL
    hash (`#token=…`), which is consumed client-side and never sent to the server (so the token
    stays out of server logs).
  - **Open `http://<lan-ip>:<port>` and paste the token** into the Login screen.

  ### Environment variables

  | Var | Default | Meaning |
  | --- | --- | --- |
  | `HOST` | `0.0.0.0` | Bind address. Set `127.0.0.1` to restrict to localhost. |
  | `PORT` | `8787` | Listen port. |
  | `TOKEN_PATH` | `<dir of DB_PATH>/.token` | Where the bearer token is stored/read. |
  | `DB_PATH` | `data/chats.db` | SQLite database file (`:memory:` for ephemeral). |
  | `TURN_TIMEOUT_MS` | unset | Per-turn cap (ms) applied to hub turns, incl. compat `/v1`. |

  ### Single-origin production run

  ```bash
  npm run build:web    # builds the SPA to web/dist
  npm start            # serves web/dist + /api + /v1 + /ws from one origin (HOST:PORT)
  ```

  In dev (`npm run dev`) Vite proxies `/api`, `/v1`, and `/ws` to `127.0.0.1:8787` instead.

  ### Using the compat API from a harness

  All `/v1/*` calls require the token (Tasks above). Point a harness at this origin:

  - **OpenAI-compatible** (open-webui, etc.): base URL `http://<host>:<port>/v1`, API key = the token.
  - **Anthropic-compatible** (claude-cli / Claude Code):
    ```bash
    export ANTHROPIC_BASE_URL=http://<host>:<port>
    export ANTHROPIC_API_KEY=<token>     # sent as x-api-key; the server checks it
    ```

  > **WARNING — `-auto` model ids run and write on the host.** A model id like `local-auto/<model>`
  > runs the local-agent with **no permission prompts** — it may read, write, and execute commands on
  > the machine hosting this server without confirmation. Use `-auto` ids only on trusted networks and
  > with harnesses you trust. Prefer the plain `<conn>/<model>` (read-only) id otherwise.

  ### Remote access over a tunnel

  To reach the server from outside your LAN, front it with a tunnel instead of port-forwarding:

  ```bash
  cloudflared tunnel --url http://localhost:8787   # or: ngrok http 8787
  ```

  The tunnel gives you an `https://…` URL; the web client detects `https:` and connects the
  WebSocket over `wss://` automatically. The bearer token still gates every request.

  ```

- [ ] **Step 6: Update the §"Native HTTP API" Auth bullet (was "M4 … arrive in M6").**
  In `README.md`, replace the M4 deferral bullet (currently lines ~77-79).
  Old:
  ```markdown
  - **Auth:** M4 binds localhost only and does NOT enforce a bearer token yet. LAN bind
    (`0.0.0.0`) + `Authorization: Bearer <token>` arrive in M6 — do not expose this port to an
    untrusted network until then.
  ```
  New:
  ```markdown
  - **Auth:** every `/api/*` route (except `GET /api/health`) requires the bearer token —
    `Authorization: Bearer <token>` or `x-api-key: <token>` (see "Security / Run" above).
  ```

- [ ] **Step 7: Refresh the compat-API localhost asides (lines ~92 and ~139).**
  In `README.md`, the "Compatibility API" intro and "Security warning" sections.
  Old (~L91-92):
  ```markdown
  claude-cli, Claude Code, etc.) can point at. Base URL: `http://127.0.0.1:8787/v1`
  (M5 is localhost-only; LAN bind + bearer token arrive in M6).
  ```
  New:
  ```markdown
  claude-cli, Claude Code, etc.) can point at. Base URL: `http://<host>:<port>/v1`
  (LAN-bound by default; every `/v1/*` call requires the bearer token — see "Security / Run").
  ```
  Old (~L137-139, the "Security warning" body):
  ```markdown
  `-auto` models run the local-agent with **no permission prompts** — the agent may read, write,
  and execute on your machine without confirmation. Only expose these model ids to trusted harnesses.
  The server binds `127.0.0.1` in M5; do not reverse-proxy it to a network until M6 auth is in place.
  ```
  New:
  ```markdown
  `-auto` models run the local-agent with **no permission prompts** — the agent may read, write,
  and execute on your machine without confirmation. Only expose these model ids to trusted harnesses.
  All `/v1/*` calls require the bearer token; still, only enable `-auto` ids on trusted networks.
  ```

- [ ] **Step 8: Drop the "(M6)" parentheticals from the compat key-API setup blocks (~L130-132).**
  In `README.md`, the "claude-cli / Claude Code setup" and "open-webui setup" steps still say "M5 ignores". Update them to require the token.
  Old (open-webui step 3, ~L123):
  ```markdown
  3. Enter any string as the API key (M5 ignores it).
  ```
  New:
  ```markdown
  3. Enter the bearer token (from `data/.token` / the startup banner) as the API key.
  ```
  Old (claude-cli block, ~L129-132):
  ```bash
  export ANTHROPIC_BASE_URL=http://127.0.0.1:8787/v1
  export ANTHROPIC_API_KEY=anything       # M5 ignores the token
  # Claude Code / claude-cli will route POST /v1/messages through this server.
  ```
  New:
  ```bash
  export ANTHROPIC_BASE_URL=http://<host>:<port>
  export ANTHROPIC_API_KEY=<token>        # sent as x-api-key; the server checks it
  # Claude Code / claude-cli will route POST /v1/messages through this server.
  ```
  (Note: `ANTHROPIC_BASE_URL` drops the `/v1` suffix — the Anthropic SDK appends `/v1/messages` itself; matches the Security/Run block.)

- [ ] **Step 9: Fix the last compat-limitations aside ("(M6)" / "No auth … (M5)", ~L158-159).**
  In `README.md`, the final bullet of "Limitations & behavior notes".
  Old:
  ```markdown
  - No keep-alive ping yet — a long first-token gap on a slow local-agent turn could hit an intermediary
    idle timeout (M6). No auth, no persistence, no live-sync (M5).
  ```
  New:
  ```markdown
  - No keep-alive ping yet — a long first-token gap on a slow local-agent turn could hit an intermediary
    idle timeout (deferred). Compat turns have no persistence and no live-sync to the WebSocket UI.
  ```

- [ ] **Step 10: Update the §"Status" line and its M6 forward-reference (~L163).**
  In `README.md`, append M6 to the status narrative.
  Old:
  ```markdown
  **M5 — Compatibility API (`/v1`).** M1 established the baseline (local-agent streaming + tool use). M2 added multi-chat, SQLite persistence, resume, and FolderPicker. M3 added the full provider system: create / edit / delete connections from the Settings page, pick connection + model in the New Chat modal, and route each turn through the correct provider. M4 adds the native HTTP REST + SSE surface (see "Native HTTP API" above). M5 adds the OpenAI-compatible (`/v1/chat/completions`) and Anthropic-compatible (`/v1/messages`) gateway endpoints (see "Compatibility API" above). See `docs/superpowers/specs/` for the full roadmap (M6: LAN bind + auth).
  ```
  New:
  ```markdown
  **M6 — auth + mobile.** M1 established the baseline (local-agent streaming + tool use). M2 added multi-chat, SQLite persistence, resume, and FolderPicker. M3 added the full provider system: create / edit / delete connections from the Settings page, pick connection + model in the New Chat modal, and route each turn through the correct provider. M4 added the native HTTP REST + SSE surface (see "Native HTTP API" above). M5 added the OpenAI-compatible (`/v1/chat/completions`) and Anthropic-compatible (`/v1/messages`) gateway endpoints (see "Compatibility API" above). M6 adds LAN bind (`0.0.0.0`), bearer-token auth on all `/api/*` and `/v1/*` routes, a Login screen with QR auto-login, and a responsive mobile layout (see "Security / Run" above). See `docs/superpowers/specs/` for the full roadmap.
  ```

- [ ] **Step 11: Update the §"Security" `list_dirs` aside and the LAN-out-of-scope line (~L169, L171).**
  In `README.md`, the two M6-deferral sentences in the Security section now describe shipped behavior.
  Old (~L169):
  ```markdown
  **`list_dirs` exposes the server's directory tree (names only).** This is acceptable because the server binds `127.0.0.1` (localhost only). Before any non-localhost bind — LAN access, reverse proxy, or public exposure — `list_dirs` MUST be bounded to an allowed set of roots and/or require authentication. (Tracked for M6.)
  ```
  New:
  ```markdown
  **`list_dirs` exposes the server's directory tree (names only).** The server LAN-binds (`0.0.0.0`) by default, but `list_dirs` runs over the WebSocket, which now requires the bearer token (subprotocol `['bearer', <token>]`) — so an unauthenticated LAN peer cannot reach it. It is still names-only and not scoped to a root set; treat exposure beyond a trusted network (e.g. a public tunnel) as sensitive.
  ```
  Old (~L171):
  ```markdown
  **LAN access and authentication** are out of scope until M6. Do not expose this server to a network without auth in place.
  ```
  New:
  ```markdown
  **LAN access and authentication** ship in M6: the server binds `0.0.0.0` and every `/api/*` (except `GET /api/health`), `/v1/*`, and WebSocket connection is gated by the bearer token in `data/.token`. Do not expose the server publicly without the token in place (the QR / `#token=` flow is the supported way to share it). For remote access, prefer a tunnel (cloudflared / ngrok) over raw port-forwarding.
  ```

- [ ] **Step 12: Add a compat-API e2e line to the §"Testing" block, if missing.** (No change required — `e2e-compat.mjs` is already listed at ~L190; confirm it still reads correctly after edits.) Verify by re-reading the Testing block.
  Run: `git -C . grep -n "e2e-compat\|e2e-rest\|e2e-openai" -- README.md`
  Expected: all three e2e scripts still listed under "## Testing"; no leftover "M5"/"M6" deferral wording in that block.

- [ ] **Step 13: Verify no stale 'is M6' / 'TODO(M6)' / 'until M6' / 'in M5' wording remains.**
  Run: `git -C . grep -n "is M6\|TODO(M6)\|arrive in M6\|until M6\|in M5\|M5 ignores\|M5 is localhost\|Tracked for M6\|out of scope until M6\|127.0.0.1:8787/v1" -- README.md server/http-api.ts`
  Expected: NO matches (empty output). Every M5/M6-deferral aside has been rewritten to describe shipped behavior; the only remaining "M5"/"M6" mentions are the historical narrative in §"Status".

- [ ] **Step 14: Typecheck (server) — confirm comment-only edits did not break anything.**
  Run: `npm run typecheck`
  Expected: exits 0, no errors (comments in `server/http-api.ts` changed; no code touched).

- [ ] **Step 15: Typecheck (web) and rebuild — confirm README edits are docs-only and the build is unaffected.**
  Run: `npx tsc -p web/tsconfig.json --noEmit`
  Expected: exits 0, no errors.
  Run: `npm run build:web`
  Expected: build succeeds, emits `web/dist/index.html` (no errors). README/comment edits cannot affect the build; this is a sanity gate that the working tree is still green at the end of the milestone.

- [ ] **Step 16: Commit.**
  Run:
  ```bash
  git add README.md server/http-api.ts
  git commit -m 'docs(m6): README Security/Run section + drop M5/M6 deferral asides; http-api comments to deferred'
  ```
  Expected: one commit containing exactly the two files; `git status` clean afterward.

> Visual/structural note: this task is docs + comments only — there is no UI surface, so the impeccable skill does not apply. The Security/Run section is plain GitHub-flavored Markdown matching the existing README's heading depth (`##` top-level, `###` sub) and table style (`| --- |`).

Files touched (absolute):
- `P:\AI_PROJECT\Claude\WebPage\.claude\worktrees\eloquent-agnesi-1ce8f0\README.md`
- `P:\AI_PROJECT\Claude\WebPage\.claude\worktrees\eloquent-agnesi-1ce8f0\server\http-api.ts`