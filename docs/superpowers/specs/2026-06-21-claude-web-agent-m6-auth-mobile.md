# M6 — Auth + Mobile — Design Spec

**วันที่:** 2026-06-21
**สถานะ:** Draft (ผ่าน adversarial spec-review 6 lens → fix แล้ว, รอ user review)
**ต่อยอดจาก:** master `1850ae8` (M1–M5 + scrutinize fixes merged), spec หลัก `2026-06-17-claude-web-agent-design.md` §10 (Frontend) + §11 (Security & Auth) + success criterion #4

M6 เป็น milestone สุดท้ายที่วางแผนไว้ ปิดงาน: เปิดให้เข้าจาก LAN/มือถือได้อย่างปลอดภัยด้วย bearer token เดียว และทำ frontend ให้ responsive + มี Login/QR

## 1. เป้าหมาย (Goal) & ขอบเขต

1. **Bearer token เดียว** ป้องกันทั้ง 3 server surfaces: WS (UI), native HTTP (`/api/*`), compat (`/v1/*`)
2. **Bind `0.0.0.0`** (host/port ผ่าน env) — มาพร้อม auth ในชุดเดียว (ห้ามแยก commit) — และ** wire `TURN_TIMEOUT_MS` env** เข้า hub/compat deps (param ถูก plumb ไว้ตั้งแต่ M5 scrutinize fix D แต่ยังไม่มี source; M6 ปิด loop นี้)
3. **Single-origin deployment** — backend serve build ของ web → ได้ base URL เดียว (`http://<ip>:PORT`) ที่ UI + `/api` + `/v1` ใช้ origin/token เดียวกัน → ผู้ใช้เอา **URL + token (= "api key")** ไปเสียบ harness ภายนอก/โปรเจกต์อื่นได้ (สิ่งที่ user ระบุว่าต้องการ)
4. **Frontend:** Login page, auto-login ผ่าน QR, Settings โชว์ URL+token+QR+model-id list, responsive (sidebar→drawer) แบบ polished

ไม่อยู่ในขอบเขต: ดู §13

## 2. การตัดสินใจที่เคาะแล้ว (Resolved Decisions)

| Fork | เลือก | เหตุผล |
|---|---|---|
| Deployment | **Backend serve build (`web/dist`) single-origin** + `npm start` | ได้ base URL+token เดียวไปเสียบ harness/โปรเจกต์อื่น (เป้าหมาย user); token เดียวคุม static+WS+api+v1; QR auto-login ผ่าน origin เดียว |
| WS auth | **Subprotocol header** `['bearer', token]` | token ไม่โผล่ใน URL/log, ไม่มี round-trip, browser-native; reject ที่ handshake |
| HTTP guard | **Global `onRequest` hook** (ใน `buildApp`) | จุดเดียวคุม `/api/*`+`/v1/*`, รับ token จาก `Authorization: Bearer` **หรือ** `x-api-key`, leak ยาก |
| Mobile UI | **Polished pass (impeccable)** | งาน frontend มีเนื้อจริง (drawer, Login, QR, touch) คุ้มที่จะทำให้ดีบนมือถือ |
| Wiring seam | **สกัด `buildApp()` factory** | index.ts + e2e ทั้งหมด boot ผ่าน path เดียว → auth hook/WS/static ถูก test จริงใน e2e (ไม่งั้น e2e build Fastify inline จะไม่มี guard ให้ test) |

**spec §7 `auth`/`auth_ok`/`auth_error` ถูก supersede ด้วย subprotocol** — ไม่เพิ่ม message type นี้ใน protocol (auth จบที่ handshake ก่อนเปิด socket)

## 3. `buildApp()` factory — `server/app.ts` (ไฟล์ใหม่; แก้ Major #5/#16)

**ปัญหา:** auth hook / static / WS-verifyClient / bind ทั้งหมดอยู่ใน `index.ts` แต่ `e2e-{compat,rest,openai}.mjs` สร้าง Fastify เองแบบ inline แล้วเรียก `registerHttpApi/registerCompatApi/attachWebSocketServer` ตรงๆ → ถ้า auth อยู่ใน index.ts เท่านั้น e2e จะ boot server ที่**ไม่มี guard** → การ "แนบ token" ใน e2e จะไม่ได้ test อะไร (missing token ยังได้ 200)

**ทางแก้:** สกัด wiring ทั้งหมดเป็น factory เดียว ใช้ร่วมทั้ง prod และ test

```ts
// server/app.ts
export interface BuildAppDeps {
  db: DB
  hub: ChatHub
  makeProvider: MakeProvider
  token: string                  // bearer token (required — auth บังคับเสมอ)
  turnTimeoutMs?: number
  webDist?: string               // path ของ build web; ถ้า undefined/ไม่มีอยู่ → ข้าม static
}
export function buildApp(deps: BuildAppDeps): { app: FastifyInstance; wss: WebSocketServer }
```

`buildApp` ทำ (ตามลำดับ): สร้าง `Fastify`, ลง **auth `onRequest` hook** (§4) → `registerHttpApi(app,{hub,db})` → `registerCompatApi(app,{db,makeProvider,turnTimeoutMs})` → static/SPA (§7, ถ้า `webDist` มี) → `attachWebSocketServer(app.server, hub, { token })` (§5) → คืน `{app, wss}` (ยังไม่ `listen`; caller listen เอง)

- **`index.ts`** กลายเป็น thin entry: load token, openDb, สร้าง hub, `buildApp(...)`, `app.listen({port,host})`, พิมพ์ banner (§6)
- **e2e** boot ผ่าน `buildApp({...,token: TEST_TOKEN})` แล้ว `listen` + แนบ token ในทุก request/WS + **negative assertion** (ไม่มี/ผิด token → 401/handshake reject; มี → 200/open)

## 4. Token lifecycle + HTTP guard

### 4.1 `server/auth.ts` (ไฟล์ใหม่) — pure/sync, unit-test ได้
```ts
loadOrCreateToken(tokenPath: string): string
extractToken(headers: IncomingHttpHeaders): string | undefined   // Authorization: Bearer <t> | x-api-key: <t>
extractWsToken(secWebSocketProtocol: string | undefined): string | undefined
safeEqual(a: string | undefined, b: string): boolean             // timingSafeEqual + length guard
```
- `loadOrCreateToken`: ไฟล์มีอยู่+trim ไม่ว่าง → คืนค่านั้น (idempotent ข้าม restart); ไม่งั้น `randomBytes(32).toString('base64url')` (43 ตัว, URL-safe → ปลอดภัยใน subprotocol/hash/header) เขียน best-effort `{ mode: 0o600 }` (Windows no-op, ไม่ error)
- path: `process.env.TOKEN_PATH ?? join(dirname(DB_PATH), '.token')` → อยู่ข้าง `data/chats.db`; e2e/test override ผ่าน env
- `extractToken`: ลอง `authorization` (`Bearer ` prefix, scheme case-insensitive) ก่อน แล้ว fallback `x-api-key`
- `extractWsToken`: split header (`,`) + trim, ถ้า element แรก === `'bearer'` คืน element ถัดไป ไม่งั้น `undefined`
- `safeEqual`: `a` undefined / len ต่าง → `false` (เลี่ยง timingSafeEqual throw บน buffer คนละ len); len เท่าค่อย `crypto.timingSafeEqual`
- `.gitignore` ครอบ `.token` แล้ว ✓

### 4.2 Global `onRequest` hook (ลงใน `buildApp`, root instance → ครอบทุก route)
- ทำงานก่อน body-parse (เช็คแค่ header — reject ก่อนอ่าน body)
- **allowlist (ผ่านไม่ต้อง token):** `GET /api/health` + ทุก path ที่**ไม่**ขึ้นต้น `/api/` และ**ไม่** `/v1/` (= static SPA + index.html → Login ต้องโหลดได้ก่อนมี token)
- **guarded:** path ขึ้นต้น `/api/` (ยกเว้น health) หรือ `/v1/` → `safeEqual(extractToken(headers), token)`; ไม่ผ่าน → **401** + header `WWW-Authenticate: Bearer` พร้อม body ที่ **hook ปั้นเอง** (hand-rolled) ตาม surface:

| Path | 401 body |
|---|---|
| `/v1/messages` (Anthropic) | `{ type:'error', error:{ type:'authentication_error', message } }` |
| `/v1/*` อื่น (OpenAI) | `{ error:{ message, type:'authentication_error' } }` |
| `/api/*` (native) | `{ error:'unauthorized' }` |

> **หมายเหตุ (แก้ Minor #9/#17):** body พวกนี้ hook ปั้นเองใน `buildApp` — **ไม่เรียก** `anthropicError`/`openaiError` เดิม เพราะ (1) helper เป็น module-private ไม่ export และ (2) helper map status→type แบบ 404/400/else เท่านั้น (401 จะได้ `api_error` ไม่ใช่ `authentication_error`) โครง envelope เหมือน helper (harness อ่านออก) แต่ค่า discriminant ตั้งเป็น `authentication_error` ตามตารางนี้ (ตารางคือ authoritative)

## 5. WS auth — subprotocol (`server/ws.ts` + `web/src/ws.ts`)

### 5.1 Server (`server/ws.ts`)
- **เปลี่ยน signature (แก้ Minor #16):** `attachWebSocketServer(httpServer: Server, hub: ChatHub, opts?: { token?: string }): WebSocketServer`
  - `opts.token` set → ใส่ `verifyClient` + `handleProtocols`; ไม่ set → เหมือนเดิม (ไม่ auth) → caller 2-arg เดิม compile ได้ (back-compat)
- `new WebSocketServer({ server, path:'/ws', verifyClient, handleProtocols: () => 'bearer' })`
  - `verifyClient: ({ req }, done) => done(safeEqual(extractWsToken(req.headers['sec-websocket-protocol']), token), 401, 'Unauthorized')` → reject ที่ handshake (HTTP 401, ไม่เปิด socket, ไม่แตะ hub)
  - `handleProtocols` echo เฉพาะ marker `'bearer'` (ไม่ echo token; client เห็น `ws.protocol === 'bearer'`)
- `buildApp` เรียกด้วย `{ token }` เสมอ

### 5.2 Client (`web/src/ws.ts`)
- `createWsClient({ ..., token, onAuthError })` → `new WebSocket(wsUrl(location.host, location.protocol), ['bearer', token])`
- **`wsUrl` ต้องเลือก scheme ตาม protocol (แก้ Major wss):** เปลี่ยน signature เป็น `wsUrl(host: string, protocol: string): string` → `(protocol === 'https:' ? 'wss://' : 'ws://') + host + '/ws'` (เดิม hardcode `ws://` → พังเป็น mixed-content ใต้ https tunnel ที่ทั้งสอง spec แนะนำ); call site ส่ง `location.protocol`
- **auth-fail detection (แก้ Minor #13 — baseline เดิมผิด):** createWsClient ปัจจุบัน reconnect แบบ **unbounded** (onclose re-arm timer 1000ms ทุกครั้ง ไม่มี cap; comment "Single auto-reconnect" ใน code คลาดเคลื่อน). M6 ต้องเพิ่ม:
  1. flag `everOpened` (set ใน `onopen`)
  2. ตัวนับ `consecutiveFailedConnects`
  3. helper บริสุทธิ์ `classifyClose({ everOpened, consecutiveFailedConnects }): 'reconnect' | 'authfail'` (unit-test ได้ใน node ไม่ต้องมี socket จริง) — close โดยไม่เคย open 2 ครั้งติด → `'authfail'` → เรียก `onAuthError()` แล้ว**หยุด** reconnect; ไม่งั้น `'reconnect'`
- App ผูก `onAuthError` = `clearToken()` + กลับ Login
- handshake 401 ฝั่ง browser ไม่ให้ status ตรงๆ ผ่าน WebSocket API → ใช้ heuristic นี้ (best-effort, แยก network blip ด้วยตัวนับ)

## 6. Bind `0.0.0.0` + startup banner + QR + timeout (`server/index.ts`)

- `const HOST = process.env.HOST ?? '0.0.0.0'`; `app.listen({ port: PORT, host: HOST })`
- `const TURN_TIMEOUT_MS = process.env.TURN_TIMEOUT_MS ? Number(process.env.TURN_TIMEOUT_MS) : undefined` → ส่งเข้า `buildApp` deps (→ ChatHub + registerCompatApi) (แก้ Minor #10; ถ้าไม่ set → DEFAULT_TURN_TIMEOUT_MS เดิม)
- **ลบ `app.log.info('WebSocket listening on ws://127.0.0.1:${PORT}/ws')` เดิม (index.ts:33)** — banner เป็น single source ของ ready/URL (host เดิม hardcode `127.0.0.1` ผิดใต้ 0.0.0.0) (แก้ Nit #18)
- หลัง listen สำเร็จ พิมพ์ banner ทาง **`console.log` (ไม่ผ่าน Fastify logger)**:
  - enumerate LAN IPv4 ที่ไม่ internal (`os.networkInterfaces()`) → list `http://<ip>:PORT`
  - พิมพ์ token
  - **terminal QR (async — แก้ Minor #12):** `console.log(await qrcode.toString(url, { type:'terminal', small:true }))` (`toString` คืน `Promise<string>`; index.ts มี top-level await อยู่แล้ว — ถ้าไม่ await จะพิมพ์ `[object Promise]` โดย tsc ไม่ฟ้องเพราะ console.log รับ `any`)
- **auto-login URL ใช้ hash fragment:** `http://<lan-ip>:PORT/#token=<token>` — fragment **ไม่ถูกส่งไป server** ตาม HTTP spec → token ไม่มีทางโผล่ใน access/proxy log (เหตุผลหลักที่เลือก `#` แทน `?`)

## 7. Static serving / single-origin (ใน `buildApp`)

- **build outDir (แก้ Blocker):** ตอนนี้ `vite build` (no `root`/`outDir` ใน config) ออกที่ **repo-root `dist/`** ไม่ใช่ `web/dist`. M6 ตั้ง `build: { outDir: 'web/dist', emptyOutDir: true }` ใน `vite.config.ts` (outDir อยู่ใน root → ไม่มี warning; entry `index.html` ที่ repo-root → ออกเป็น `web/dist/index.html`) + เพิ่ม `web/dist/` ใน `.gitignore`
- `@fastify/static` (pin `^7` — ดู §10) root = `web/dist` — register เฉพาะเมื่อ `existsSync(webDist)` (ไม่มี build ก็ไม่ crash; dev ใช้ Vite แยกพอร์ต)
- **SPA fallback:** `app.setNotFoundHandler` → GET + path ไม่ขึ้นต้น `/api`,`/v1`,`/ws` + มี `web/dist/index.html` → ส่ง `index.html` (รองรับ client-side routing); ไม่งั้น 404 ปกติ
- ลำดับ: auth hook ก่อน → static/SPA fallback อยู่ใน allowlist (ไม่ใช่ `/api`,`/v1`) → โหลดได้ไม่ต้อง token ✓ (notFoundHandler รันหลัง onRequest hook → ยังถูก allowlist ครอบถูกต้อง)

## 8. Frontend (React, impeccable pass)

### 8.1 Token bootstrap — `web/src/auth.ts` (ใหม่)
- **pure helper (testable, env=node):** `parseTokenFromHash(hash: string): string | null` — `#token=abc` → `'abc'`, ไม่งั้น `null`
- thin shell (side-effect, ตรวจด้วย tsc เท่านั้น): ตอนโหลดถ้า `parseTokenFromHash(location.hash)` ได้ค่า → `localStorage.setItem('cwa_token', t)` + `history.replaceState(null,'',location.pathname+location.search)` (ลบ hash)
- `getToken(): string | null` / `clearToken(): void`
- `main.tsx`: ไม่มี token → render `<Login/>`; มี → render `<App token=.../>`
- **bootstrap policy (แก้ Minor #8):** returning user ที่มี token → เข้า App เลย แล้วพึ่ง WS auth-fail heuristic (§5.2) ถ้า token หมดอายุ → กลับ Login (ไม่เพิ่ม latency ต่อโหลด). การ probe ทันทีทำเฉพาะตอน Login submit (ดู 8.2)

### 8.2 `Login.tsx` (ใหม่)
- ช่อง paste token + ปุ่ม "เชื่อมต่อ" → **probe ทันที** ผ่าน `apiFetch('/v1/models', token)` (route ที่ guarded — **ไม่ใช้** `/api/health` ที่ allowlist):
  - 200 → `setToken` + เข้า App
  - 401 → ไม่ save + แสดง error inline "token ไม่ถูกต้อง / invalid or expired token"
- ข้อความช่วย "สแกน QR จากหน้า Settings บนเครื่องที่รัน server"; responsive/center/touch
- test: 401-on-probe → คง Login + แสดง error

### 8.3 `ws.ts` (แก้)
- ดู §5.2 (token subprotocol + `wsUrl` scheme + `classifyClose` + onAuthError)

### 8.4 `api.ts` (ใหม่ เล็ก)
- `apiFetch(path, token, init?): Promise<Response>` แนบ `Authorization: Bearer <token>` แล้วคืน Response (ไม่จัดการ 401 เอง — caller เช็ค `res.status`); ใช้ใน Login probe + Settings `/v1/models`

### 8.5 `Settings.tsx` (แก้ — panel "เชื่อมต่อจากที่อื่น / Harness")
ตอบโจทย์ user (URL+key ไปเสียบ harness/โปรเจกต์อื่น) + spec §10:
- Base URL: `location.origin` (UI), `${origin}/v1` (compat)
- Token: ปิดบัง `••••` + reveal + copy
- **QR (browser, async — แก้ Minor #12):** `qrcode.toDataURL(...)` คืน `Promise<string>` → resolve ใส่ state ผ่าน effect: `useEffect(() => { qrcode.toDataURL(`${origin}/#token=${token}`).then(setQrSrc) }, [token])` แล้ว `<img src={qrSrc}>`
- Model-id list: `apiFetch('/v1/models', token)` → โชว์ `<conn>/<model>` + `<conn>-auto/<model>`
- ตัวอย่างเสียบ: OpenAI base `${origin}/v1` + key=token; Anthropic `ANTHROPIC_BASE_URL=${origin}` + `x-api-key=token`
- ปุ่ม **Logout** (clearToken → Login)

### 8.6 Responsive (impeccable)
- Sidebar: `md:` ขึ้นไปคงที่; ต่ำกว่า `md` → **drawer** + hamburger ใน header + overlay/backdrop (แตะปิด)
- Composer/Message: padding/touch target/ฟอนต์เหมาะมือถือ; modal (Permission/NewChat/Folder) responsive
- Login/Settings responsive
- **ใช้ skill `impeccable`** (Q4)

## 9. Protocol / shared changes
- ไม่เพิ่ม message type (auth = subprotocol, จบก่อนเปิด socket); `shared/protocol.ts` ไม่แตะ — api_key containment invariant คงเดิม

## 10. Deps + scripts + dev proxy
- **deps:** `qrcode`, **`@fastify/static@^7`** (สำคัญ: v8/v9 ต้อง Fastify 5 → `FST_ERR_PLUGIN_VERSION_MISMATCH` กับ Fastify 4 ที่ใช้อยู่; bare `npm i @fastify/static` ดึง latest = v9 → ห้าม → `npm i @fastify/static@^7`)
- **devDeps:** `@types/qrcode`
- **scripts:** เพิ่ม `"start": "tsx server/index.ts"` (prod รันหลัง `build:web`)
- **`vite.config.ts`:** (1) เพิ่ม `build: { outDir: 'web/dist', emptyOutDir: true }` (§7); (2) เพิ่ม proxy `/v1` → `http://127.0.0.1:8787` (ปัจจุบันมีแค่ `/api`,`/ws`); `/ws` proxy ส่ง `sec-websocket-protocol` ผ่านอยู่แล้ว ✓

## 11. Test plan + gates
- **unit `server/auth.test.ts`:** loadOrCreateToken (สร้าง+persist+idempotent ผ่าน temp path), extractToken (Authorization + x-api-key + ไม่มี), extractWsToken, safeEqual (เท่า/ไม่เท่า/undefined/len ต่าง)
- **integration (ผ่าน `buildApp`):** HTTP hook — 401 (ไม่มี/ผิด token) บน `/api/chats`,`/api/chats/:id/messages`,`/v1/models`,`/v1/chat/completions`,`/v1/messages` + ผ่านเมื่อ token ถูก; `/api/health` + static index เปิดได้ไม่ต้อง token; ตรวจ 401 body shape/type ต่อ surface
- **integration WS (ผ่าน `buildApp`):** ไม่มี subprotocol → handshake reject/close; `['bearer', wrong]` → reject; `['bearer', token]` → open && `ws.protocol === 'bearer'`
- **frontend (pure helpers, env=node — แก้ Major #6):** `parseTokenFromHash` (มี/ไม่มี/ผิดรูป), `classifyClose` (open รีเซ็ตตัวนับ; close-without-open 2× → authfail), `wsUrl` (http→ws, https→wss); side-effect shell (localStorage/history/WebSocket) ตรวจด้วย tsc เท่านั้น (ไม่เพิ่ม jsdom)
- **e2e (อัปเดต — แก้ Major #4/#5):**
  - `e2e-{compat,rest,openai}.mjs`: boot ผ่าน `buildApp({...,token})` ด้วย temp `TOKEN_PATH`, แนบ token ทุก request/WS, + **negative assertion** (no/wrong token → 401, token → 200)
  - `e2e-multichat.mjs` (เดิมตกหล่น): spawn `tsx server/index.ts` จริง → ต้องเขียน known token ลง temp `TOKEN_PATH` **ก่อน** spawn (loadOrCreateToken idempotent) + ตั้ง env `TOKEN_PATH` ให้ child + ส่ง `['bearer', token]` ในทุก `new WebSocket(...)` + ลบ token file ใน cleanup
  - **libuv exit (แก้ Minor #7/#11 — reconcile):** natural-exit gotcha (ห้าม `process.exit(0)` success path) ใช้กับ **`e2e-compat.mjs` เท่านั้น** (in-memory DB, ไม่มี handle เปิด → UV_HANDLE_CLOSING). `e2e-rest.mjs:168` / `e2e-openai.mjs:101` ใช้ file DB + fake upstream → **คง `process.exit(0)` เดิมไว้** (ต้อง `await fake.close()` ก่อน exit); failure ใช้ `exit(1)` ผ่าน assert
- **gates (จาก repo root):** `npm run typecheck`, `npx tsc -p web/tsconfig.json --noEmit`, `npm test` (baseline **258** + ใหม่), `npm run build:web`, แล้วรัน `npx tsx scripts/e2e-{compat,rest,openai}.mjs` ผ่าน; `e2e-multichat.mjs` รัน manual (ต้อง Claude login)

## 12. Security invariants (คงไว้)
- **auth + bind 0.0.0.0 อยู่ใน milestone/merge เดียว** — กัน window ที่ port เปิด LAN โดยไม่มี token (`-auto` model รัน/เขียนบนเครื่องได้ไม่ถาม)
- token: ไม่ log (Fastify logger ไม่ log header; hash fragment ไม่ถึง server), ไม่ commit (.gitignore), constant-time compare
- api_key containment เดิม (ConnectionMeta ไม่มี apiKey; เฉพาะ getConnectionWithSecret อ่าน) — auth code ไม่แตะ/ไม่ leak
- README: เพิ่มหมายเหตุ bind 0.0.0.0 + token + คำเตือน `-auto` (รัน/เขียนได้หมด ใช้กับ network/harness ที่ไว้ใจเท่านั้น) + แนะนำ tunnel (cloudflared/ngrok; เข้าผ่าน https → wsUrl เลือก wss อัตโนมัติ)

## 13. Out of scope (YAGNI)
- multi-user / หลาย token / token rotation UI (สุ่มใหม่ = ลบ `data/.token` แล้ว restart)
- HTTPS/TLS ในตัว (ใช้ tunnel ภายนอก; client เลือก wss เองตาม protocol)
- rate-limiting / brute-force lockout (token 256-bit สุ่ม + LAN; ระบุเป็น known-limitation ใน README)
- **per-turn cancellation ของ native HTTP API (SSE) + SSE backpressure/drain** — ยังคง defer (TODO `server/http-api.ts:65,99` ที่ tag "is M6"); M6 จะ**ปรับ comment 2 จุดนั้นให้เลิก tag "is M6"** (เป็น "future/deferred") เพื่อไม่ให้เหลือ marker ค้างใน milestone สุดท้าย (แก้ Nit #15)
- per-chat permission scope, advanced reconnect (ค้างจาก milestone ก่อน)

## 14. Success criteria mapping
- **#4 (มือถือผ่าน LAN IP + token responsive):** §5 (WS auth+wss) + §6 (bind+QR) + §7 (single-origin static) + §8 (Login/probe/responsive/QR)
- **เป้าหมาย user (URL+key ไปเสียบ harness/โปรเจกต์อื่น):** §7 single-origin + §8.5 Settings harness panel + §4 (`Authorization`/`x-api-key`) → `${origin}/v1` + token พร้อมใช้กับ open-webui/claude-cli (ต่อ criterion #7/#8 ใต้ auth)
- regression: criteria #1–#3,#5–#9 ต้องยังผ่านใต้ auth (e2e + manual; `e2e-multichat` คุ้ม #1/#2)

## 15. File change map
**ใหม่:** `server/app.ts` (buildApp +`.test.ts`), `server/auth.ts` (+`.test.ts`), `web/src/auth.ts` (+`.test.ts` — parseTokenFromHash), `web/src/api.ts`, `web/src/components/Login.tsx`
**แก้:** `server/index.ts` (thin: token+timeout+buildApp+listen+banner+QR, ลบ ready log line), `server/ws.ts` (attachWebSocketServer + `{token}` opts, verifyClient/handleProtocols), `web/src/ws.ts` (+`ws.test.ts`: token subprotocol + wsUrl scheme + classifyClose + onAuthError), `web/src/main.tsx` (bootstrap/Login gate), `web/src/App.tsx` (token plumbing + drawer/hamburger), `web/src/components/Sidebar.tsx` (drawer), `web/src/components/Settings.tsx` (harness panel+QR+logout), `web/src/components/{Composer,Message,PermissionModal,NewChatModal,FolderPicker}.tsx` (touch/responsive), `web/src/index.css` (responsive util ถ้าจำเป็น), `vite.config.ts` (outDir + `/v1` proxy), `.gitignore` (`web/dist/`), `package.json` (deps+start), `README.md` (security/run), `scripts/e2e-{compat,rest,openai,multichat}.mjs` (token), `server/http-api.ts` (ปรับ comment "is M6" 2 จุด)
**ไม่แตะ:** `shared/protocol.ts`, providers/*, store.ts, hub.ts, chatRuntime.ts, compat/turn|wire|models|openai|anthropic (auth อยู่ที่ hook ชั้น buildApp ไม่แตะ business logic)

## 16. Risks / gotchas
- **vite outDir:** ต้องตั้ง `build.outDir: 'web/dist'` มิฉะนั้น build ไป repo-root `dist/` → `existsSync('web/dist')` false → static ไม่ลง → single-origin พัง (Blocker ที่ review จับ)
- **@fastify/static major:** ใช้ `^7` เท่านั้นกับ Fastify 4 (v8/v9 = Fastify 5)
- **qrcode async:** `toString`/`toDataURL` คืน Promise — banner ต้อง `await`; Settings ต้อง resolve ใน effect→state
- **wsUrl scheme:** ต้องอ่าน `location.protocol` (wss ใต้ https tunnel) ไม่งั้น mixed-content block
- **verifyClient + subprotocol echo:** ตั้ง `handleProtocols: () => 'bearer'` (echo เฉพาะ marker, ห้าม echo token)
- **WS auth-fail ฝั่ง browser:** handshake 401 ไม่ให้ status → heuristic close-without-open 2× (ตัวนับ + everOpened); เดิม reconnect unbounded ต้องเปลี่ยนเป็น bounded
- **frontend test env=node:** ไม่เพิ่ม jsdom — test เฉพาะ pure helper (parseTokenFromHash/classifyClose/wsUrl), side-effect ตรวจ tsc
- **e2e:** ทั้ง 4 ตัวต้อง plumb token; `e2e-multichat` spawn index.ts จริง (token ผ่าน file+env); natural-exit เฉพาะ compat
- **Windows `mode 0o600`:** no-op (best-effort; เครื่อง user เดี่ยว)
- **post-merge `9arm:scrutinize` บังคับ** — caught MAJORs ทุก milestone; รันหลัง merge M6
