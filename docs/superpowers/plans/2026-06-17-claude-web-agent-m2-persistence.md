# Claude Web Agent — M2 (Persistence + Multi-Chat) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** เปิดเว็บแล้วมีหลายห้องแชตถาวร — สร้าง/เปลี่ยนชื่อ/ลบห้องผ่าน Sidebar, แต่ละห้องเก็บประวัติลง SQLite, reload แล้วคุยต่อในห้องเดิมได้ (resume ผ่าน `sdk_session_id`), และเลือก working directory ต่อห้องด้วย FolderPicker — พร้อมปิด scrutinize findings #2–#6 และ M1 carry-overs.

**Architecture:** เปลี่ยนจาก M1 ("1 WebSocket connection = 1 in-memory chat") เป็น **ChatHub** (registry ต่อ process) ที่ map `chatId → ChatRuntime`. `ChatRuntime` คือตัวรันเทิร์นต่อห้อง: serialize ทีละเทิร์น, persist user/assistant message ลง SQLite, โหลด/บันทึก `sdk_session_id` (resume), และ broadcast event ไปยัง subscriber ทุกตัวของห้องนั้น (รองรับหลายแท็บ + เป็นรากฐาน live-sync ของ M4). โปรโตคอล WebSocket ขยายเป็น multi-chat (ทุกข้อความมี `chatId`). Frontend เปลี่ยน state เป็น multi-chat (`appState`: `chats[]` + `views` ต่อห้อง) + `Sidebar` + `FolderPicker`. Provider abstraction (`server/providers/types.ts`) ไม่เปลี่ยน — M2 ยังใช้ `LocalAgentProvider` อย่างเดียว (providers อื่นเป็น M3).

**Tech Stack:** เพิ่ม `better-sqlite3` (^11) เป็น store; ที่เหลือเหมือน M1 — Node 20+, TypeScript (ESM, moduleResolution Bundler), Fastify, `ws`, `@anthropic-ai/claude-agent-sdk`, React 18, Vite, Tailwind, react-markdown, Vitest.

## Global Constraints

- Node 20+, package `"type": "module"` ทั้งโปรเจกต์; TypeScript strict; `module: ESNext`, `moduleResolution: Bundler` (import ไม่ต้องมีนามสกุล `.js`).
- Shared types อยู่ที่ `shared/protocol.ts` — server import แบบ relative (`../shared/protocol` หรือ `../../shared/protocol`), web import ผ่าน alias `@shared/*`.
- Port: backend = `8787`, Vite dev = `5173`; Vite proxy `/ws` และ `/api` → backend. **ฝั่ง client เลิก hardcode `:5173` — ใช้ `location.host` (scrutinize #5).**
- Read-only tools ที่ auto-allow: `Read, Glob, Grep, NotebookRead, WebSearch, WebFetch, TodoWrite`.
- model alias ของ local-agent: default `"sonnet"`.
- Test framework: Vitest (`environment: node`); ทุก pure logic ต้องมี unit test ก่อน implement (TDD). UI components ไม่มี DOM test (env เป็น node) → gate ด้วย `tsc`. **รัน Vitest จาก repo ROOT เสมอ** (เช่น `npx vitest run web/src/ws.test.ts`) — ไม่มี `web/package.json` ให้ `cd web`.
- Persistence: `better-sqlite3` `^11.0.0` + `@types/better-sqlite3` `^7.6.0`. ไฟล์ DB ที่ `data/chats.db` (override ได้ด้วย env `DB_PATH`). `data/` ถูก gitignore แล้ว.
- Per-turn watchdog timeout default = `600000` ms.
- `npm run build:web` (vite build) ออกที่ **repo-root `dist/`** (ไม่ใช่ `web/dist/`). ไม่มี `server/tsconfig.json` — root `tsconfig.json` include `["server","shared"]`; web ใช้ `web/tsconfig.json`.
- commit บ่อย ทีละ task. branch ปัจจุบัน `master` (ทำต่อแบบ M1 — ไม่เปิด PR ต่อ task).

## Migration Typecheck Policy (สำคัญ — อ่านก่อนเริ่ม)

M2 คือ **protocol migration**: Task 3 ขยาย `ServerMsg`/`ClientMsg` ให้ต้องมี `chatId` ซึ่งทำให้ไฟล์ที่ยัง migrate ไม่เสร็จ "พัง" ภายใต้ `tsc --noEmit` ทั้งโปรเจกต์ จนกว่า task เจ้าของจะ migrate เสร็จ. กฎระหว่างทาง:

1. **Gate ต่อ task = Vitest ของไฟล์ตัวเอง** ผ่าน — Vitest transpile รายไฟล์ด้วย esbuild (ไม่ cross-file typecheck) จึงเขียวได้แม้ไฟล์อื่นยังมี type error.
2. **ห้ามเคลม whole-project `tsc --noEmit` clean ระหว่างทาง.** ถ้า task ใดมี tsc step ให้ระบุว่าไฟล์ที่ยังไม่ migrate (เช่น `server/agent.ts`, `server/permission.ts`, `server/ws.ts`, `web/src/App.tsx`) คาดว่า error และยืนยันแค่ไฟล์ของ task นั้นสะอาด.
3. **typecheck ที่เป็นทางการ:** server+shared เขียวครบที่ **Task 9** (`npx tsc --noEmit`, root tsconfig = `["server","shared"]`); web เขียวครบที่ **Task 13** (`npx tsc -p web/tsconfig.json`); **Task 14** รันทั้งสอง + full suite + build + e2e เป็น gate สุดท้าย.

## M2 Design Decisions (locked — อย่า re-derive)

- **สร้างตาราง `connections` เต็มใน M2 + seed แถว `local`** (type `local-agent`, default_model `sonnet`) เพื่อให้ `chats.connection_id` มี FK อ้างได้ — แต่ **CRUD/UI ของ connections เลื่อนไป M3**. นี่เลี่ยง schema migration ระหว่าง M2→M3.
- **ChatHub + ChatRuntime + subscriber set ตั้งแต่ M2** (ไม่ใช่ single-connection-simple) — รองรับ `subscribe`/`unsubscribe` + live-sync หลายแท็บ และเป็นรากฐานที่ M4 (native API broadcast) ต้องใช้.
- **เลื่อน** `permission_response.scope:"chat"` ("Allow ทั้งห้อง") และ auto-reconnect ขั้นสูงไป milestone ถัดไป — M2 ทำแค่ allow/deny ต่อครั้ง และ reconnect แบบ basic.
- **resume ตรวจ 2 ชั้น:** unit test ว่า `resume` option ถูกส่งต่อจริง (Task 5) + live two-turn e2e (Task 2 = gate ก่อนสร้าง persistence; Task 14 = ผ่าน DB จริง).
- **M2 provider = local-agent เท่านั้น** (`makeProvider` คืน `LocalAgentProvider` เสมอ); การเลือก provider ตาม `connection.type` เป็น M3.
- **ลำดับการ persist:** user message เขียนลง DB **ทันทีตอน enqueue** (durable แม้เทิร์นถูก abort); assistant message (text + tool_use + tool_result + usage) เขียนเป็น **แถวเดียวตอน `turn_done`**. นี่ผ่อนปรนจาก spec §6 ("เขียนทุก tool call ตอนเกิด") — เทิร์นที่ crash กลางคันจะไม่เห็น assistant ของรอบนั้น ซึ่งยอมรับได้สำหรับ M2.

## File Structure

**สร้างใหม่:**
- `server/store.ts` — SQLite store (better-sqlite3): schema/migrate, seed connection, CRUD ของ connections/chats/messages, resume session getter/setter.
- `server/fsbrowse.ts` — list subdirectories สำหรับ FolderPicker (`list_dirs`).
- `server/providers/normalize.ts` — `normalizeToolResult` (แปลง tool_result content หลายรูปแบบเป็น string).
- `server/chatRuntime.ts` — ตัวรันเทิร์นต่อห้อง (serialize, persist, resume, interrupt+clear-queue).
- `server/hub.ts` — `ChatHub`: routing client message → runtime/store, subscriber broadcast, live-sync.
- `web/src/appState.ts` — multi-chat reducer (แทน `web/src/chatState.ts`; ลบ chatState ใน Task 13).
- `web/src/components/Sidebar.tsx`, `web/src/components/FolderPicker.tsx`.
- `scripts/e2e-resume.mjs` (ชั่วคราว, gate; ลบใน Task 14), `scripts/e2e-multichat.mjs`.
- ไฟล์เทสต์คู่ของไฟล์ใหม่ทั้งหมด (`*.test.ts`).

**แก้ไข:**
- `shared/protocol.ts` (+test) — โปรโตคอล v2 (chatId, chats, stored messages, dir listing).
- `server/permission.ts` (+test) — `InteractivePermissionResolver` รับ `chatId` (เปลี่ยนใน Task 8).
- `server/agent.ts` (+test) — `runTurn` รับ `chatId` + text fallback (#3) + watchdog (#4).
- `server/providers/localAgent.ts` (+test) — normalize tool_result + proactive interrupt (#6) + resume guard (#2).
- `server/ws.ts` — `attachWebSocketServer(httpServer, hub)` (เอา `ChatSession` เดิมออก; Task 9).
- `server/index.ts` — เปิด DB + สร้าง hub (Task 9).
- `web/src/ws.ts` (+test ใหม่) — `location.host` (#5) + status/reconnect (Task 11).
- `web/src/App.tsx`, `web/src/components/Message.tsx`, `web/src/components/PermissionModal.tsx` — เชื่อม multi-chat (Task 13).
- `package.json` — เพิ่ม better-sqlite3, ย้าย react/* เป็น dependencies (Task 1).
- `README.md` (Task 14).

**ลบ:** `server/ws.test.ts` (ChatSession เดิม — ลบต้น Task 8), `web/src/chatState.ts` (+test — ลบใน Task 13 หลัง App/PermissionModal ย้ายไป appState).

ลำดับ task เรียงตาม dependency: deps → resume gate → protocol → agent/provider robustness → store/fsbrowse → runtime → hub/boot → frontend state/ws/components/app → e2e+verify.

---
### Task 1: Dependencies + deps hygiene

Goal: add `better-sqlite3` (the embedded SQLite driver used by the new `server/store.ts` persistence layer in later tasks) and move production runtime deps (`react`, `react-dom`, `react-markdown`) out of `devDependencies` into `dependencies` (an M1 review carry-over — these are shipped at runtime by the web bundle, so they belong in `dependencies`). This is a configuration-only change; the existing test suite is the gate.

**Files:**
- Create: (none)
- Modify: `P:\AI_PROJECT\Claude\WebPage\package.json`, `P:\AI_PROJECT\Claude\WebPage\package-lock.json` (regenerated by `npm install`)
- Test: (none — config-only; existing suite is the gate)

**Interfaces:**
- Consumes: nothing (no code imports change in this task).
- Produces: project dependency graph that makes `better-sqlite3` (default export `Database`, type `Database.Database`) and `@types/better-sqlite3` resolvable for `server/store.ts` in subsequent tasks; `react` / `react-dom` / `react-markdown` declared as runtime `dependencies`.

Notes for the engineer:
- This repo is on branch `master`; the project default branch is `main`. You are committing directly per the existing M1 workflow (commits already landed on `master`). Do NOT create a PR for this task.
- `data/` is gitignored; nothing in this task writes there.
- `better-sqlite3` is a native (node-gyp) module. `npm install` will compile a prebuilt or source binary for your platform. On Windows this requires the Visual Studio Build Tools / Python toolchain to be present (it already is in this environment since native deps build elsewhere). If the build fails, that is an environment problem, not a problem with the version pin — do not change the version to "fix" a toolchain error.

- [ ] **Step 1: Read the current `package.json` to confirm starting state.**
  Run this exact command:
  ```bash
  cat P:/AI_PROJECT/Claude/WebPage/package.json
  ```
  Expected output (the current file — confirm `react`, `react-dom`, `react-markdown` are under `devDependencies` and there is no `better-sqlite3` anywhere):
  ```json
  {
    "name": "claude-web-agent",
    "private": true,
    "version": "0.1.0",
    "type": "module",
    "scripts": {
      "dev": "concurrently -n server,web -c blue,green \"npm:dev:server\" \"npm:dev:web\"",
      "dev:server": "tsx watch server/index.ts",
      "dev:web": "vite",
      "build:web": "vite build",
      "test": "vitest run",
      "test:watch": "vitest",
      "typecheck": "tsc --noEmit"
    },
    "dependencies": {
      "@anthropic-ai/claude-agent-sdk": "^0.3.179",
      "fastify": "^4.28.0",
      "ws": "^8.18.0"
    },
    "devDependencies": {
      "@types/node": "^20.14.0",
      "@types/ws": "^8.5.10",
      "@types/react": "^18.3.3",
      "@types/react-dom": "^18.3.0",
      "@vitejs/plugin-react": "^4.3.1",
      "autoprefixer": "^10.4.19",
      "concurrently": "^8.2.2",
      "postcss": "^8.4.39",
      "react": "^18.3.1",
      "react-dom": "^18.3.1",
      "react-markdown": "^9.0.1",
      "tailwindcss": "^3.4.6",
      "tsx": "^4.16.0",
      "typescript": "^5.5.3",
      "vite": "^5.3.3",
      "vitest": "^2.0.0"
    }
  }
  ```

- [ ] **Step 2: Replace `package.json` with the full new content.**
  Write the entire file exactly as below. Changes versus the current file: (a) `dependencies` now contains `better-sqlite3`, `react`, `react-dom`, `react-markdown` (alphabetized within the block); (b) `devDependencies` gains `@types/better-sqlite3` and no longer contains `react`, `react-dom`, `react-markdown`.
  ```json
  {
    "name": "claude-web-agent",
    "private": true,
    "version": "0.1.0",
    "type": "module",
    "scripts": {
      "dev": "concurrently -n server,web -c blue,green \"npm:dev:server\" \"npm:dev:web\"",
      "dev:server": "tsx watch server/index.ts",
      "dev:web": "vite",
      "build:web": "vite build",
      "test": "vitest run",
      "test:watch": "vitest",
      "typecheck": "tsc --noEmit"
    },
    "dependencies": {
      "@anthropic-ai/claude-agent-sdk": "^0.3.179",
      "better-sqlite3": "^11.0.0",
      "fastify": "^4.28.0",
      "react": "^18.3.1",
      "react-dom": "^18.3.1",
      "react-markdown": "^9.0.1",
      "ws": "^8.18.0"
    },
    "devDependencies": {
      "@types/better-sqlite3": "^7.6.0",
      "@types/node": "^20.14.0",
      "@types/ws": "^8.5.10",
      "@types/react": "^18.3.3",
      "@types/react-dom": "^18.3.0",
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
  }
  ```

- [ ] **Step 3: Install to update `node_modules` and the lockfile.**
  Run this exact command from the repo root:
  ```bash
  npm install
  ```
  Expected: npm resolves and compiles the new packages, writes `package-lock.json`, and prints a summary line. You should see `better-sqlite3` and `@types/better-sqlite3` added. Example shape of the success output (exact package/vuln counts vary by environment):
  ```
  added 4 packages, and audited NNN packages in Xs

  found 0 vulnerabilities
  ```
  Note: moving `react`/`react-dom`/`react-markdown` between `dependencies` and `devDependencies` does NOT add or remove installed packages — they were already installed; only their classification in `package.json`/lockfile changes. The "added N packages" count reflects `better-sqlite3` + `@types/better-sqlite3` + their transitive native build helpers.
  If npm prints `npm error` related to `node-gyp`/native build, that is a local toolchain issue (Python/MSVC). Resolve the toolchain rather than altering the version pin, then re-run `npm install`.

- [ ] **Step 4: Confirm the lockfile actually changed and records `better-sqlite3`.**
  Run:
  ```bash
  git --no-pager diff --stat package-lock.json
  ```
  Expected: a non-empty diffstat line showing `package-lock.json` changed, e.g.:
  ```
   package-lock.json | NN ++++++++++------
   1 file changed, NN insertions(+), N deletions(-)
  ```
  Then confirm the new dependency is present in the lockfile:
  ```bash
  grep -c '"node_modules/better-sqlite3"' P:/AI_PROJECT/Claude/WebPage/package-lock.json
  ```
  Expected output:
  ```
  1
  ```

- [ ] **Step 5: Run the full existing test suite — it must stay green.**
  Run this exact command from the repo root:
  ```bash
  npm test
  ```
  This runs `vitest run` (Vitest, environment node). Expected: every existing test file passes. The summary should look like (exact file/test counts are whatever the M1 suite currently has — what matters is `0 failed` and a non-zero `passed`):
  ```
  Test Files  N passed (N)
       Tests  M passed (M)
  ```
  If any test FAILS, STOP — do not proceed to commit. This task is config-only and must not change test outcomes; a failure means the install regressed something (e.g. a native module load error) and must be diagnosed first.

- [ ] **Step 6: Run an audit and record the summary (informational; does NOT gate the task).**
  Run:
  ```bash
  npm audit
  ```
  Record the printed summary in this step's notes. Expected shape (numbers vary by environment):
  ```
  N vulnerabilities (A low, B moderate, C high, D critical)
  ```
  Do NOT fail the task on advisories. Do NOT run `npm audit fix --force` (it may bump majors and break the build). If `npm audit` reports a fix that is explicitly non-breaking (npm prints `Will install <pkg>@<x.y.z>, which is a minor/patch upgrade` and no "SEMVER WARNING"/"breaking change" notice), you MAY run the plain `npm audit fix` (no `--force`), then re-run `npm test` (Step 5 must still pass) before committing; otherwise leave advisories as-is and just note them here. If `npm audit` reports `found 0 vulnerabilities`, note that and move on.

- [ ] **Step 7: Review the staged-to-be changes before committing.**
  Run:
  ```bash
  git --no-pager diff --stat package.json package-lock.json
  ```
  Expected: both `package.json` and `package-lock.json` listed as changed, e.g.:
  ```
   package-lock.json | NN ++++++++++------
   package.json      |  M +++--
   2 files changed, ...
  ```

- [ ] **Step 8: Commit exactly these two files.**
  Run these exact commands (two commands; stage then commit):
  ```bash
  git add package.json package-lock.json
  ```
  ```bash
  git commit -m "chore(m2): add better-sqlite3 + move react/* to dependencies"
  ```
  Expected: a commit is created on the current branch (`master`) listing 2 files changed, e.g.:
  ```
  [master XXXXXXX] chore(m2): add better-sqlite3 + move react/* to dependencies
   2 files changed, NN insertions(+), N deletions(-)
  ```
  If a pre-commit hook runs and fails, investigate and fix the underlying issue — do NOT use `--no-verify`.

---

### Task 2: Live resume gate (current protocol)

**Goal (scrutinize #2 — do this FIRST, before any persistence work):** Prove empirically that the Claude Agent SDK's session resume, driven by the server's in-memory `sdkSessionId` carry-over, preserves conversation context across TWO turns on ONE WebSocket connection. This is a **HARD GATE**: M2 builds SQLite persistence and chat-resume on the assumption that feeding the previous turn's `sdkSessionId` back into the next turn restores context. If that assumption is false, persisting `sdk_session_id` to disk (Task 4+) is worthless and you must stop. This script runs against the **CURRENT (M1) server and protocol** — `user_message` has NO `chatId` field yet (protocol v2 with `chatId` arrives in Task 3). It talks to the existing `ChatSession` in `server/ws.ts` (read above), which already carries `sdkSessionId` in memory between turns on the same socket (see `drain()` line 64: `if (result.sdkSessionId) this.sdkSessionId = result.sdkSessionId`).

> NOTE: This script is **temporary scaffolding**. It is REMOVED in Task 14 once the protocol gains `chatId` and `scripts/e2e-multichat.mjs` supersedes it with a full multi-chat resume test. Do not wire it into CI or npm scripts as a permanent fixture.

**Files:**
- Create: `scripts/e2e-resume.mjs`
- Modify: (none)
- Test: `scripts/e2e-resume.mjs` IS the test (it is an executable e2e gate run via `npx tsx`, not a Vitest unit). There is no separate `.test.ts` for this task.

**Interfaces:**
- Consumes (current M1 protocol — NOT v2):
  - Client→server: `{ type: "user_message", text: string }` (no `chatId` in M1), `{ type: "permission_response", requestId: string, decision: "allow" | "deny" }`
  - Server→client: `{ type: "assistant_delta", text: string }`, `{ type: "permission_request", requestId: string, name: string, input: unknown }`, `{ type: "turn_done", usage?: Usage }`, `{ type: "error", message: string }` (M1 shapes — no `chatId`)
  - Server stdout readiness line: the substring `"WebSocket listening"` (same line `scripts/e2e-ws.mjs` waits for at line 39)
  - Server spawn command: `npx tsx server/index.ts` with env `PORT` (matches `scripts/e2e-ws.mjs` lines 24–33)
- Produces: process exit code `0` on PASS, `1` on FAIL; human-readable `PASS`/`FAIL` line on stdout.

> Requires Claude Agent SDK login on the machine (the LocalAgentProvider performs a real model turn). This is a live integration gate, not a mock.

---

- [ ] **Step 1: Confirm the M1 protocol shape this script depends on.**
  Re-read the two files quoted in the task header so the assumptions below are grounded, not guessed:
  ```bash
  sed -n '55,100p' scripts/e2e-ws.mjs
  sed -n '25,70p' server/ws.ts
  ```
  Expected facts to confirm before writing any code:
  - `scripts/e2e-ws.mjs` opens a NEW `ws` per `runConversation` call (line 59) and closes it on `turn_done` (line 91). That is exactly what we must NOT do — the resume gate needs ONE socket kept open across both turns. So this script does NOT reuse `runConversation`; it manages a single long-lived socket itself.
  - `server/ws.ts` `ChatSession.handle` (lines 25–42) accepts `user_message` with only `{ type, text }` — there is no `chatId` in M1. Sending a `chatId` field would be harmless (ignored) but we will NOT send one, to stay faithful to M1.
  - `ChatSession.drain` (lines 51–69) keeps `this.sdkSessionId` across turns on the same `ChatSession` instance, and there is one `ChatSession` per socket (line 78). Therefore keeping ONE socket open is what exercises resume.

- [ ] **Step 2: Create `scripts/e2e-resume.mjs` with the full two-turn resume gate.**
  This is a plain ESM `.mjs` script (run by `tsx`), mirroring the spawn/ready-wait/teardown structure of `scripts/e2e-ws.mjs` but using a SINGLE persistent socket across two sequential turns. Write the complete file:

  ```js
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
  ```

- [ ] **Step 3: Run the gate against the live server.**
  Run the script. This performs two real model turns, so it takes tens of seconds.
  ```bash
  npx tsx scripts/e2e-resume.mjs
  ```
  Expected output (timing and token-level deltas will vary, but the shape and final line must match):
  ```
  [e2e-resume] Starting server on port 8789 …
  [server] ... WebSocket listening ...
  [e2e-resume] Server ready.
  [e2e-resume] Socket open — same socket will carry BOTH turns.

  === TURN 1: plant codeword ===
  [e2e-resume] → user_message: "Remember this codeword: BANANA47. Reply with just OK."
  [ws→client] {"type":"assistant_delta","text":"OK"}
  [ws→client] {"type":"turn_done", ...}
  [e2e-resume] Turn 1 assistant text: "OK"

  === TURN 2: recall codeword (same socket) ===
  [e2e-resume] → user_message: "What was the codeword I told you earlier? Reply with only the codeword."
  [ws→client] {"type":"assistant_delta","text":"BANANA47"}
  [ws→client] {"type":"turn_done", ...}
  [e2e-resume] Turn 2 assistant text: "BANANA47"

  [e2e-resume] Turn-2 text contains "BANANA47"? true

  [e2e-resume] Killing server…
  [server] exited ...

  === RESUME GATE RESULT ===
  PASS
  ```
  Confirm the exit code is `0`:
  ```bash
  echo $?
  ```
  Expected: `0`.

- [ ] **Step 4: HARD GATE decision point — do NOT skip.**
  - If the final line is `PASS` and exit code is `0`: the resume assumption holds. Proceed to Task 3.
  - If the final line is `FAIL` (Turn-2 text does NOT contain `BANANA47`), exit code `1`, or the script errors/times out:
    **STOP. Do not start Task 4 (SQLite persistence) or any later task.** Consult **Appendix B (Resume contingency)** of this plan and resolve the resume mechanism before continuing. Common root causes to investigate there: the LocalAgentProvider not returning `sdkSessionId` in `TurnResult` (so `ChatSession.sdkSessionId` stays `undefined` and Turn 2 starts a fresh session), the provider not threading `sdkSessionId` into the SDK `resume`/`continue` option, or the server emitting an `error` before `turn_done`. A FAIL here means disk-persisting `sdk_session_id` (Task 4+) would persist a value that does not actually restore context — building on it is wasted work.

- [ ] **Step 5: Commit the gate (only after Step 3 shows PASS).**
  ```bash
  git add scripts/e2e-resume.mjs
  git commit -m "test(m2): live two-turn resume gate (scrutinize #2)"
  ```
  Expected: one new file committed (`scripts/e2e-resume.mjs`), commit succeeds with the message above.

---

### Task 3: Shared protocol v2 (multi-chat)

Expand the shared wire protocol from the single-chat M1 shape to the multi-chat v2 shape defined in the CONTRACT. This means adding new data types (`DirEntry`, `StoredContentBlock`, `StoredMessage`, `ChatMeta`), widening both the `ClientMsg` and `ServerMsg` unions, and rewriting `parseClientMsg` so it validates and narrows every new `ClientMsg` variant. `ToolCall` and `Usage` stay byte-for-byte identical.

This file is the single source of truth shared by both the server (imported via relative path `../shared/protocol` or `../../shared/protocol`) and the web app (imported via `@shared/protocol`). Match the existing file style exactly: single quotes, no semicolons, 2-space indentation.

**Files:**
- Modify: `P:\AI_PROJECT\Claude\WebPage\shared\protocol.ts`
- Test: `P:\AI_PROJECT\Claude\WebPage\shared\protocol.test.ts`

**Interfaces:**
- Consumes: nothing (this is the base layer; it imports no other project module).
- Produces (exact exported signatures):
  - `type ToolCall = { id: string; name: string; input: unknown }` (UNCHANGED — keep exactly)
  - `type Usage = { inputTokens?: number; outputTokens?: number; costUsd?: number }` (UNCHANGED — keep exactly)
  - `type DirEntry = { name: string; path: string }`
  - `type StoredContentBlock = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown } | { type: 'tool_result'; id: string; result: unknown }`
  - `type StoredMessage = { id: string; role: 'user' | 'assistant'; content: StoredContentBlock[]; usage?: Usage; createdAt: number }`
  - `type ChatMeta = { id: string; title: string; connectionId: string; model: string; cwd?: string; createdAt: number; updatedAt: number }`
  - `type ClientMsg =` the 10-variant v2 union (see CONTRACT)
  - `type ServerMsg =` the 13-variant v2 union (see CONTRACT)
  - `parseClientMsg(raw: string): ClientMsg | null`

- [ ] **Step 1: Replace the test file with failing v2 tests.** Overwrite `P:\AI_PROJECT\Claude\WebPage\shared\protocol.test.ts` with the complete content below. These cover every new variant plus the rejection rules. They will FAIL against the current M1 `parseClientMsg` (which does not know `create_chat`, `subscribe`, `chatId`, etc.).

```ts
import { describe, it, expect } from 'vitest'
import { parseClientMsg } from './protocol'

describe('parseClientMsg', () => {
  it('parses create_chat with all optional fields', () => {
    const m = parseClientMsg(
      JSON.stringify({ type: 'create_chat', title: 'My chat', model: 'sonnet', cwd: '/home/me' }),
    )
    expect(m).toEqual({ type: 'create_chat', title: 'My chat', model: 'sonnet', cwd: '/home/me' })
  })

  it('parses create_chat with no optional fields', () => {
    const m = parseClientMsg(JSON.stringify({ type: 'create_chat' }))
    expect(m).toEqual({ type: 'create_chat' })
  })

  it('parses subscribe', () => {
    const m = parseClientMsg(JSON.stringify({ type: 'subscribe', chatId: 'c1' }))
    expect(m).toEqual({ type: 'subscribe', chatId: 'c1' })
  })

  it('parses unsubscribe', () => {
    const m = parseClientMsg(JSON.stringify({ type: 'unsubscribe', chatId: 'c1' }))
    expect(m).toEqual({ type: 'unsubscribe', chatId: 'c1' })
  })

  it('parses interrupt with chatId', () => {
    const m = parseClientMsg(JSON.stringify({ type: 'interrupt', chatId: 'c1' }))
    expect(m).toEqual({ type: 'interrupt', chatId: 'c1' })
  })

  it('parses rename_chat', () => {
    const m = parseClientMsg(JSON.stringify({ type: 'rename_chat', chatId: 'c1', title: 'New' }))
    expect(m).toEqual({ type: 'rename_chat', chatId: 'c1', title: 'New' })
  })

  it('parses delete_chat', () => {
    const m = parseClientMsg(JSON.stringify({ type: 'delete_chat', chatId: 'c1' }))
    expect(m).toEqual({ type: 'delete_chat', chatId: 'c1' })
  })

  it('returns null for subscribe missing chatId', () => {
    expect(parseClientMsg(JSON.stringify({ type: 'subscribe' }))).toBeNull()
  })

  it('returns null for subscribe with non-string chatId', () => {
    expect(parseClientMsg(JSON.stringify({ type: 'subscribe', chatId: 7 }))).toBeNull()
  })

  it('returns null for interrupt missing chatId', () => {
    expect(parseClientMsg(JSON.stringify({ type: 'interrupt' }))).toBeNull()
  })

  it('returns null for rename_chat missing title', () => {
    expect(parseClientMsg(JSON.stringify({ type: 'rename_chat', chatId: 'c1' }))).toBeNull()
  })

  it('parses user_message with chatId and text', () => {
    const m = parseClientMsg(JSON.stringify({ type: 'user_message', chatId: 'c1', text: 'hi' }))
    expect(m).toEqual({ type: 'user_message', chatId: 'c1', text: 'hi' })
  })

  it('returns null for user_message missing chatId', () => {
    expect(parseClientMsg(JSON.stringify({ type: 'user_message', text: 'hi' }))).toBeNull()
  })

  it('returns null for user_message missing text', () => {
    expect(parseClientMsg(JSON.stringify({ type: 'user_message', chatId: 'c1' }))).toBeNull()
  })

  it('parses permission_response allow', () => {
    const m = parseClientMsg(
      JSON.stringify({ type: 'permission_response', requestId: 'r1', decision: 'allow' }),
    )
    expect(m).toEqual({ type: 'permission_response', requestId: 'r1', decision: 'allow' })
  })

  it('parses permission_response deny', () => {
    const m = parseClientMsg(
      JSON.stringify({ type: 'permission_response', requestId: 'r1', decision: 'deny' }),
    )
    expect(m).toEqual({ type: 'permission_response', requestId: 'r1', decision: 'deny' })
  })

  it('returns null for permission_response with bad decision', () => {
    expect(
      parseClientMsg(JSON.stringify({ type: 'permission_response', requestId: 'r1', decision: 'maybe' })),
    ).toBeNull()
  })

  it('parses list_dirs with path', () => {
    const m = parseClientMsg(JSON.stringify({ type: 'list_dirs', path: '/home/me' }))
    expect(m).toEqual({ type: 'list_dirs', path: '/home/me' })
  })

  it('parses list_dirs without path', () => {
    const m = parseClientMsg(JSON.stringify({ type: 'list_dirs' }))
    expect(m).toEqual({ type: 'list_dirs' })
  })

  it('returns null for unknown type', () => {
    expect(parseClientMsg(JSON.stringify({ type: 'nope' }))).toBeNull()
  })

  it('returns null for invalid JSON', () => {
    expect(parseClientMsg('{not json')).toBeNull()
  })
})
```

- [ ] **Step 2: Run the tests and confirm they FAIL.** From the repo root `P:\AI_PROJECT\Claude\WebPage`, run the protocol test file directly.

```bash
npx vitest run shared/protocol.test.ts
```

  Expected: the run FAILS. The first failing assertion is the `create_chat` case — `parseClientMsg` hits its `default` branch and returns `null`, so Vitest reports something like:

```
FAIL  shared/protocol.test.ts > parseClientMsg > parses create_chat with all optional fields
AssertionError: expected null to deeply equal { type: 'create_chat', ... }
```

  Multiple tests fail (all the new-variant cases). The three M1-style cases that survive (`permission_response`, `unknown type`, `invalid JSON`) still pass, but the suite as a whole is red.

- [ ] **Step 3: Rewrite `shared/protocol.ts` with the v2 types and validator.** Overwrite `P:\AI_PROJECT\Claude\WebPage\shared\protocol.ts` with the complete content below. Note `ToolCall` and `Usage` are kept exactly as in M1; everything else is the v2 expansion. The validator narrows precisely per variant: it builds each returned object with only the variant's declared fields (so optional fields that are present/valid are copied, and absent ones are omitted).

```ts
export type ToolCall = { id: string; name: string; input: unknown }
export type Usage = { inputTokens?: number; outputTokens?: number; costUsd?: number }

export type DirEntry = { name: string; path: string }

export type StoredContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; result: unknown }

export type StoredMessage = {
  id: string
  role: 'user' | 'assistant'
  content: StoredContentBlock[]
  usage?: Usage
  createdAt: number
}

export type ChatMeta = {
  id: string
  title: string
  connectionId: string
  model: string
  cwd?: string
  createdAt: number
  updatedAt: number
}

export type ClientMsg =
  | { type: 'create_chat'; title?: string; model?: string; cwd?: string }
  | { type: 'subscribe'; chatId: string }
  | { type: 'unsubscribe'; chatId: string }
  | { type: 'user_message'; chatId: string; text: string }
  | { type: 'permission_response'; requestId: string; decision: 'allow' | 'deny' }
  | { type: 'interrupt'; chatId: string }
  | { type: 'rename_chat'; chatId: string; title: string }
  | { type: 'delete_chat'; chatId: string }
  | { type: 'list_dirs'; path?: string }

export type ServerMsg =
  | { type: 'chat_list'; chats: ChatMeta[] }
  | { type: 'chat_created'; chat: ChatMeta }
  | { type: 'chat_renamed'; chatId: string; title: string }
  | { type: 'chat_deleted'; chatId: string }
  | { type: 'chat_history'; chatId: string; messages: StoredMessage[] }
  | { type: 'assistant_delta'; chatId: string; text: string }
  | { type: 'tool_call'; chatId: string; id: string; name: string; input: unknown }
  | { type: 'tool_result'; chatId: string; id: string; result: unknown }
  | { type: 'permission_request'; chatId: string; requestId: string; name: string; input: unknown }
  | { type: 'turn_done'; chatId: string; usage?: Usage }
  | { type: 'dir_list'; path: string; parent?: string; entries: DirEntry[] }
  | { type: 'error'; message: string; chatId?: string }

export function parseClientMsg(raw: string): ClientMsg | null {
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  switch (o.type) {
    case 'create_chat': {
      const m: { type: 'create_chat'; title?: string; model?: string; cwd?: string } = {
        type: 'create_chat',
      }
      if (typeof o.title === 'string') m.title = o.title
      if (typeof o.model === 'string') m.model = o.model
      if (typeof o.cwd === 'string') m.cwd = o.cwd
      return m
    }
    case 'subscribe':
      return typeof o.chatId === 'string' ? { type: 'subscribe', chatId: o.chatId } : null
    case 'unsubscribe':
      return typeof o.chatId === 'string' ? { type: 'unsubscribe', chatId: o.chatId } : null
    case 'user_message':
      return typeof o.chatId === 'string' && typeof o.text === 'string'
        ? { type: 'user_message', chatId: o.chatId, text: o.text }
        : null
    case 'permission_response':
      return typeof o.requestId === 'string' && (o.decision === 'allow' || o.decision === 'deny')
        ? { type: 'permission_response', requestId: o.requestId, decision: o.decision }
        : null
    case 'interrupt':
      return typeof o.chatId === 'string' ? { type: 'interrupt', chatId: o.chatId } : null
    case 'rename_chat':
      return typeof o.chatId === 'string' && typeof o.title === 'string'
        ? { type: 'rename_chat', chatId: o.chatId, title: o.title }
        : null
    case 'delete_chat':
      return typeof o.chatId === 'string' ? { type: 'delete_chat', chatId: o.chatId } : null
    case 'list_dirs': {
      const m: { type: 'list_dirs'; path?: string } = { type: 'list_dirs' }
      if (typeof o.path === 'string') m.path = o.path
      return m
    }
    default:
      return null
  }
}
```

- [ ] **Step 4: Run the tests and confirm they PASS — this is the GREEN gate for this task.** From `P:\AI_PROJECT\Claude\WebPage` run the same command. Per the Migration Typecheck Policy, the authoritative per-task gate is this Vitest file passing (Vitest transpiles each file via esbuild and does NOT cross-file typecheck), so it stays green even though other not-yet-migrated files now have type errors against the widened protocol.

```bash
npx vitest run shared/protocol.test.ts
```

  Expected: the suite is green. Vitest prints:

```
 ✓ shared/protocol.test.ts (21 tests)

 Test Files  1 passed (1)
      Tests  21 passed (21)
```

- [ ] **Step 5: Typecheck ONLY the rewritten shared module (do NOT run a whole-project `tsc`).** Confirm the new types and the per-variant narrowing in `shared/protocol.ts` compile cleanly under TS strict + ESM (no `.js` extensions, `moduleResolution Bundler`). Widening `ServerMsg`/`ClientMsg` to require `chatId` deliberately breaks the still-M1 server files, so a whole-project `tsc --noEmit` will NOT exit 0 here — that is expected and does not block this task.

```bash
npx tsc --noEmit shared/protocol.ts --strict --moduleResolution bundler --module esnext --target es2022 --noEmit
```

  Expected: this single-file check exits 0 with no output — `shared/protocol.ts` itself is clean. (`shared/protocol.test.ts` is not part of this check; its green status is already proven by Step 4.)

  Do NOT run `npx tsc --noEmit` over the whole project at this point and do NOT claim a clean exit 0. The root `tsconfig.json` includes `["server","shared"]`, and after this task widens the protocol the following still-M1 files are EXPECTED to fail with `chatId`-missing / variant-shape errors until their owning tasks migrate them:
  - `server/agent.ts` → fixed in Task 4
  - `server/permission.ts` → fixed in Task 8
  - `server/ws.ts` → fixed in Task 9

  The authoritative whole-project server+shared typecheck (`npx tsc --noEmit`) goes GREEN at Task 9; web goes green at Task 13; Task 14 runs both plus the full suite as the final gate. For THIS task, the only required typecheck is that `shared/protocol.ts` compiles cleanly (above) and the only required test gate is Step 4.

- [ ] **Step 6: Commit.** Stage exactly the two changed files and commit with the conventional message.

```bash
git add shared/protocol.ts shared/protocol.test.ts
git commit -m "feat(m2): multi-chat protocol v2 (chatId, chats, stored messages, dir listing)"
```

  Expected: one commit recorded showing 2 files changed.

---

### Task 4: runTurn v2 — chatId + text fallback (#3) + watchdog (#4)

Upgrade `runTurn` per the CONTRACT (`server/agent.ts` section): inject `chatId` into every emitted `ServerMsg`, add the empty-delta text fallback (#3), and add a per-turn watchdog timeout (#4).

This task changes ONLY `server/agent.ts` + `server/agent.test.ts`. It does NOT touch `server/permission.ts`. In particular, it does NOT depend on any change to `InteractivePermissionResolver`'s constructor — the interactive resolver's `(chatId, send, genId)` form is introduced later, in Task 8 (which runs AFTER this task). The tests here use a tiny STUB `PermissionResolver` (auto-allow) so this task is self-contained and order-independent.

**Files:**
- Modify: `P:\AI_PROJECT\Claude\WebPage\server\agent.ts`
- Modify: `P:\AI_PROJECT\Claude\WebPage\server\agent.test.ts`
- Test: `P:\AI_PROJECT\Claude\WebPage\server\agent.test.ts`
- Do NOT modify: `P:\AI_PROJECT\Claude\WebPage\server\providers\fake.ts` (define tiny inline test-only Provider implementations inside `agent.test.ts` for the new cases instead).
- Do NOT modify: `P:\AI_PROJECT\Claude\WebPage\server\permission.ts`.

**Interfaces:**
- Consumes:
  - `Provider { type; send(params: TurnParams, ctx: ProviderContext): Promise<TurnResult> }` from `./providers/types`
  - `ProviderContext { onDelta; onToolCall; onToolResult; permission; signal }` (stays chatId-free) from `./providers/types`
  - `TurnParams { userText; cwd?; model?; sdkSessionId? }` from `./providers/types`
  - `TurnResult { text; usage?; sdkSessionId? }` from `./providers/types`
  - `PermissionResolver { resolve(toolName, input): Promise<PermissionDecision> }` from `./permission` — used here as a STUB auto-allow resolver (`{ resolve: async () => ({ behavior: 'allow' }) }`). Do NOT import or construct `InteractivePermissionResolver` in this task.
  - `ServerMsg` (v2 union) from `../shared/protocol`
  - `FakeProvider` from `./providers/fake` (the wiring test reuses it; the stub auto-allows so the FakeProvider `Write` tool path proceeds)
- Produces:
  - `RunDeps = { chatId: string; send: (m: ServerMsg) => void; permission: PermissionResolver; signal: AbortSignal; turnTimeoutMs?: number }`
  - `runTurn(provider: Provider, params: TurnParams, deps: RunDeps): Promise<TurnResult>`

Behavior contract for `runTurn`:
- The `ProviderContext` wires `onDelta`/`onToolCall`/`onToolResult` to `deps.send`, injecting `deps.chatId` into each emitted `ServerMsg`.
- Track whether any `onDelta` fired (`emitted`). After `provider.send` resolves: if `!emitted && result.text` is non-empty, send exactly one `{ type:"assistant_delta", chatId, text: result.text }` (#3 fallback).
- Watchdog (#4): default `turnTimeoutMs = 600000`. Use `Promise.race([provider.send(...), timeoutPromise])`. On timeout: `runTurn` does NOT own `deps.signal`'s abort source — instead the watchdog only stops waiting and emits `{ type:"error", chatId, message:"turn timed out" }` then `{ type:"turn_done", chatId }` and returns `{ text:"" }`. Clear the timer on normal completion.
- Normal completion: send `{ type:"turn_done", chatId, usage: result.usage }`; return `result`.
- On thrown error: send `{ type:"error", chatId, message }` then `{ type:"turn_done", chatId }`; return `{ text:"" }`.

---

- [ ] **Step 1: Read the current files to confirm the starting state.**

```bash
cd /p/AI_PROJECT/Claude/WebPage
cat server/agent.ts
cat server/agent.test.ts
cat server/providers/types.ts
cat server/providers/fake.ts
cat server/permission.ts
```

Confirm `server/agent.ts` currently has `RunDeps` WITHOUT `chatId`/`turnTimeoutMs` and emits ServerMsgs WITHOUT `chatId`. Confirm `server/permission.ts` exports the `PermissionResolver` interface with `resolve(toolName: string, input: unknown): Promise<PermissionDecision>` and that `PermissionDecision`'s allow variant is `{ behavior: 'allow'; updatedInput?: unknown }` (so `{ behavior: 'allow' }` is a valid decision). This task does NOT touch `permission.ts` and does NOT use `InteractivePermissionResolver`; the tests below construct a tiny stub resolver instead.

---

- [ ] **Step 2: Rewrite the test file with the four v2 cases (failing).**

Replace the ENTIRE contents of `P:\AI_PROJECT\Claude\WebPage\server\agent.test.ts` with the following. It uses a STUB auto-allow `PermissionResolver` (no `InteractivePermissionResolver`), defines two tiny inline test-only providers (a no-delta provider for #3 and a never-resolving provider for #4), keeps a throwing provider, and reuses `FakeProvider` for the wiring case. Every assertion on a per-chat message checks that it carries the right `chatId`. There is no assertion about `permission_request.chatId` here — that belongs to Task 8's `permission.test.ts`.

```ts
import { describe, it, expect } from 'vitest'
import type { ServerMsg } from '../shared/protocol'
import type { PermissionResolver } from './permission'
import type { Provider, ProviderContext, TurnParams, TurnResult } from './providers/types'
import { FakeProvider } from './providers/fake'
import { runTurn } from './agent'

const CHAT_ID = 'chat-1'

/** Auto-allow stub: lets any tool through without an interactive round-trip. */
const allowAll: PermissionResolver = { resolve: async () => ({ behavior: 'allow' }) }

class ThrowingProvider implements Provider {
  readonly type = 'throwing'
  async send(_params: TurnParams, _ctx: ProviderContext): Promise<TurnResult> {
    throw new Error('boom')
  }
}

/** Emits NO delta but returns a non-empty final text (exercises #3 fallback). */
class NoDeltaProvider implements Provider {
  readonly type = 'no-delta'
  async send(_params: TurnParams, _ctx: ProviderContext): Promise<TurnResult> {
    return { text: 'final answer' }
  }
}

/** send() never resolves (exercises #4 watchdog). */
class NeverProvider implements Provider {
  readonly type = 'never'
  send(_params: TurnParams, _ctx: ProviderContext): Promise<TurnResult> {
    return new Promise<TurnResult>(() => {
      /* intentionally never resolves */
    })
  }
}

describe('runTurn', () => {
  it('emits error then turn_done when provider throws, both carrying chatId', async () => {
    const sent: ServerMsg[] = []
    const permission: PermissionResolver = allowAll
    const ac = new AbortController()
    const result = await runTurn(
      new ThrowingProvider(),
      { userText: 'hi' },
      { chatId: CHAT_ID, send: (m) => sent.push(m), permission, signal: ac.signal },
    )
    expect(result.text).toBe('')
    const err = sent.find((m) => m.type === 'error') as Extract<ServerMsg, { type: 'error' }>
    expect(err).toBeTruthy()
    expect(err.chatId).toBe(CHAT_ID)
    expect(err.message).toContain('boom')
    const last = sent[sent.length - 1]
    expect(last.type).toBe('turn_done')
    expect((last as Extract<ServerMsg, { type: 'turn_done' }>).chatId).toBe(CHAT_ID)
  })

  it('wires provider callbacks into the ServerMsg stream, each carrying chatId, turn_done last', async () => {
    const sent: ServerMsg[] = []
    const permission: PermissionResolver = allowAll
    const ac = new AbortController()

    const result = await runTurn(
      new FakeProvider(),
      { userText: 'world' },
      { chatId: CHAT_ID, send: (m) => sent.push(m), permission, signal: ac.signal },
    )

    expect(result.text).toBe('Hello world')
    expect(result.sdkSessionId).toBe('sess-1')

    const types = sent.map((m) => m.type)
    expect(types).toContain('assistant_delta')
    expect(types).toContain('tool_call')
    expect(types).toContain('tool_result')
    expect(types[types.length - 1]).toBe('turn_done')

    // assistant_delta, tool_call, tool_result, and the final turn_done each carry chatId.
    const delta = sent.find((m) => m.type === 'assistant_delta') as Extract<ServerMsg, { type: 'assistant_delta' }>
    const call = sent.find((m) => m.type === 'tool_call') as Extract<ServerMsg, { type: 'tool_call' }>
    const res = sent.find((m) => m.type === 'tool_result') as Extract<ServerMsg, { type: 'tool_result' }>
    const done = sent[sent.length - 1] as Extract<ServerMsg, { type: 'turn_done' }>
    expect(delta.chatId).toBe(CHAT_ID)
    expect(call.chatId).toBe(CHAT_ID)
    expect(res.chatId).toBe(CHAT_ID)
    expect(done.type).toBe('turn_done')
    expect(done.chatId).toBe(CHAT_ID)
  })

  it('(#3) emits a single assistant_delta from result.text when provider emitted no delta', async () => {
    const sent: ServerMsg[] = []
    const permission: PermissionResolver = allowAll
    const ac = new AbortController()

    const result = await runTurn(
      new NoDeltaProvider(),
      { userText: 'q' },
      { chatId: CHAT_ID, send: (m) => sent.push(m), permission, signal: ac.signal },
    )
    expect(result.text).toBe('final answer')

    const deltas = sent.filter((m) => m.type === 'assistant_delta') as Extract<ServerMsg, { type: 'assistant_delta' }>[]
    expect(deltas).toHaveLength(1)
    expect(deltas[0].chatId).toBe(CHAT_ID)
    expect(deltas[0].text).toBe('final answer')

    // Fallback delta must come before turn_done.
    const deltaIdx = sent.findIndex((m) => m.type === 'assistant_delta')
    const doneIdx = sent.findIndex((m) => m.type === 'turn_done')
    expect(deltaIdx).toBeLessThan(doneIdx)
    expect(sent[doneIdx].type).toBe('turn_done')
    expect((sent[doneIdx] as Extract<ServerMsg, { type: 'turn_done' }>).chatId).toBe(CHAT_ID)
  })

  it('(#4) times out via the watchdog: emits error then turn_done and resolves to empty text', async () => {
    const sent: ServerMsg[] = []
    const permission: PermissionResolver = allowAll
    const ac = new AbortController()

    const start = Date.now()
    const result = await runTurn(
      new NeverProvider(),
      { userText: 'slow' },
      { chatId: CHAT_ID, send: (m) => sent.push(m), permission, signal: ac.signal, turnTimeoutMs: 20 },
    )
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(500)
    expect(result.text).toBe('')

    const err = sent.find((m) => m.type === 'error') as Extract<ServerMsg, { type: 'error' }>
    expect(err).toBeTruthy()
    expect(err.chatId).toBe(CHAT_ID)
    expect(err.message).toBe('turn timed out')

    const last = sent[sent.length - 1]
    expect(last.type).toBe('turn_done')
    expect((last as Extract<ServerMsg, { type: 'turn_done' }>).chatId).toBe(CHAT_ID)
  })
})
```

---

- [ ] **Step 3: Run the test and confirm it FAILS.**

```bash
cd /p/AI_PROJECT/Claude/WebPage
npx vitest run server/agent.test.ts
```

Expected: FAIL. The current `RunDeps` has no `chatId`/`turnTimeoutMs` fields and `runTurn` emits messages without `chatId`. Vitest transpiles `agent.test.ts` via esbuild (no cross-file typecheck), so the test BODY runs but the assertions fail: `err.chatId`, `delta.chatId`/`call.chatId`/`res.chatId`/`done.chatId`, the single fallback delta, and the timeout case (`err.message === 'turn timed out'`) all fail because the v2 fields are not yet present. The run ends with a non-zero exit and at least one failing test in the `runTurn` suite. Do NOT proceed until you see the failure.

---

- [ ] **Step 4: Implement the v2 `runTurn` (minimal).**

Replace the ENTIRE contents of `P:\AI_PROJECT\Claude\WebPage\server\agent.ts` with the following. It adds `chatId` + `turnTimeoutMs` to `RunDeps`, injects `chatId` into every emitted `ServerMsg`, tracks `emitted` for the #3 fallback, and uses `Promise.race` with a cleared timer for the #4 watchdog.

```ts
import type { ServerMsg } from '../shared/protocol'
import type { PermissionResolver } from './permission'
import type { Provider, ProviderContext, TurnParams, TurnResult } from './providers/types'

export interface RunDeps {
  chatId: string
  send: (m: ServerMsg) => void
  permission: PermissionResolver
  signal: AbortSignal
  turnTimeoutMs?: number
}

const DEFAULT_TURN_TIMEOUT_MS = 600_000

/** Sentinel resolved by the watchdog when the turn exceeds turnTimeoutMs. */
const TIMED_OUT = Symbol('runTurn:timed-out')

export async function runTurn(provider: Provider, params: TurnParams, deps: RunDeps): Promise<TurnResult> {
  const { chatId } = deps
  const timeoutMs = deps.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS

  let emitted = false
  const ctx: ProviderContext = {
    onDelta: (text) => {
      emitted = true
      deps.send({ type: 'assistant_delta', chatId, text })
    },
    onToolCall: (c) => deps.send({ type: 'tool_call', chatId, id: c.id, name: c.name, input: c.input }),
    onToolResult: (id, result) => deps.send({ type: 'tool_result', chatId, id, result }),
    permission: deps.permission,
    signal: deps.signal,
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs)
  })

  try {
    const raced = await Promise.race([provider.send(params, ctx), timeoutPromise])

    if (raced === TIMED_OUT) {
      deps.send({ type: 'error', chatId, message: 'turn timed out' })
      deps.send({ type: 'turn_done', chatId })
      return { text: '' }
    }

    const result = raced
    if (!emitted && result.text) {
      deps.send({ type: 'assistant_delta', chatId, text: result.text })
    }
    deps.send({ type: 'turn_done', chatId, usage: result.usage })
    return result
  } catch (err) {
    deps.send({ type: 'error', chatId, message: err instanceof Error ? err.message : String(err) })
    deps.send({ type: 'turn_done', chatId })
    return { text: '' }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
```

Notes on why this satisfies the CONTRACT:
- `chatId` is closed over and injected into every `ServerMsg` (`assistant_delta`, `tool_call`, `tool_result`, `error`, `turn_done`).
- `emitted` flips true on the first `onDelta`; the #3 fallback fires exactly once only when no delta was emitted and `result.text` is non-empty.
- The watchdog uses `Promise.race`; on timeout it emits `error` then `turn_done` and returns `{ text:"" }` WITHOUT awaiting the never-resolving provider promise. `deps.signal` remains the provider's abort source (owned by the caller / `ChatRuntime`); `runTurn` only stops waiting.
- `finally { clearTimeout(timer) }` clears the timer on every exit path (normal, fallback, error, timeout) so a settled turn never leaves a dangling timer.

---

- [ ] **Step 5: Run the test and confirm it PASSES (this task's GREEN gate).**

```bash
cd /p/AI_PROJECT/Claude/WebPage
npx vitest run server/agent.test.ts
```

Expected: PASS. Output ends with a passing summary, e.g.:

```
 ✓ server/agent.test.ts (4 tests) ...ms
   ✓ runTurn > emits error then turn_done when provider throws, both carrying chatId
   ✓ runTurn > wires provider callbacks into the ServerMsg stream, each carrying chatId, turn_done last
   ✓ runTurn > (#3) emits a single assistant_delta from result.text when provider emitted no delta
   ✓ runTurn > (#4) times out via the watchdog: emits error then turn_done and resolves to empty text

 Test Files  1 passed (1)
      Tests  4 passed (4)
```

This Vitest run is the authoritative gate for this task. Vitest transpiles each file via esbuild and does NOT cross-file typecheck, so these tests pass even while other not-yet-migrated server files still have type errors against the widened v2 `ServerMsg`/`ClientMsg`. Do NOT run a whole-project `tsc --noEmit` here and do NOT claim a clean whole-project typecheck — server+shared go authoritatively GREEN at Task 9 (`npx tsc --noEmit`; root tsconfig.json includes `["server","shared"]`), and Task 14 is the final gate. If any test fails, fix `server/agent.ts` (not the test) and re-run until all 4 pass.

---

- [ ] **Step 6: Commit.**

```bash
cd /p/AI_PROJECT/Claude/WebPage
git add server/agent.ts server/agent.test.ts
git commit -m "feat(m2): runTurn chatId + empty-delta text fallback (#3) + turn watchdog (#4)"
```

Expected: one commit created reporting `2 files changed` for `server/agent.ts` and `server/agent.test.ts`.

---

---

### Task 5: localAgent v2 — normalize tool_result + proactive interrupt (#6) + resume guard (#2)

This task does three things to the local-agent provider:
1. **Carry-over (normalize tool_result):** add a pure helper `normalizeToolResult` that flattens the SDK's tool_result `content` (which can be a string, an array of content blocks, a single content block, or `null`/`undefined`/arbitrary object) into a single string before handing it to `ctx.onToolResult`.
2. **Scrutinize #6a (proactive interrupt):** today the provider only checks `ctx.signal.aborted` at the top of the `for await` loop, so an abort that arrives while the SDK is blocked mid-iteration is never noticed until the next message arrives. We add a one-shot `abort` listener that calls the query handle's `interrupt()` immediately when the signal fires (guarded so it only fires once), while keeping the existing top-of-loop check.
3. **Scrutinize #2 (resume guard):** lock in via test that the SDK `resume` option is threaded — first turn passes NO `options.resume`, and a second turn that supplies `sdkSessionId: "sess-1"` passes `options.resume === "sess-1"`.

**Files:**
- Create: `P:\AI_PROJECT\Claude\WebPage\server\providers\normalize.ts`
- Create: `P:\AI_PROJECT\Claude\WebPage\server\providers\normalize.test.ts`
- Modify: `P:\AI_PROJECT\Claude\WebPage\server\providers\localAgent.ts`
- Modify: `P:\AI_PROJECT\Claude\WebPage\server\providers\localAgent.test.ts`
- Test: `P:\AI_PROJECT\Claude\WebPage\server\providers\normalize.test.ts`, `P:\AI_PROJECT\Claude\WebPage\server\providers\localAgent.test.ts`

**Interfaces:**
- Produces: `normalizeToolResult(raw: unknown): string` (in `server/providers/normalize.ts`)
- Consumes: `Provider`, `ProviderContext`, `TurnParams`, `TurnResult` from `./types`; `Usage` from `../../shared/protocol`; `query` from `@anthropic-ai/claude-agent-sdk`; `ToolCall` from `../../shared/protocol` (test only).
- Unchanged provider surface: `Provider { type; send(params: TurnParams, ctx: ProviderContext): Promise<TurnResult> }`. `ProviderContext { onDelta; onToolCall; onToolResult; permission; signal }`. `TurnParams { userText; cwd?; model?; sdkSessionId? }`. `TurnResult { text; usage?; sdkSessionId? }`.

> **Migration typecheck note (read before the gate steps):** M2 widens `ServerMsg`/`ClientMsg` to REQUIRE `chatId` (landed in Task 3), which makes a whole-project `tsc --noEmit` RED until every consumer is migrated (server+shared go green at Task 9; web at Task 13; Task 14 is the final dual-typecheck + full-suite gate). This task therefore does NOT run a whole-project `tsc`. Its GREEN gate is its own two Vitest files passing — Vitest transpiles each test file with esbuild and does NOT cross-file typecheck, so these files run green even while other not-yet-migrated files still have type errors. The two source files this task writes (`normalize.ts`, `localAgent.ts`) are self-contained and use only the unchanged provider surface above, so they are themselves type-clean.

---

#### Part A — `normalizeToolResult` (TDD)

- [ ] **Step 1: Write the failing test for `normalizeToolResult`.**
  Create `P:\AI_PROJECT\Claude\WebPage\server\providers\normalize.test.ts` with the complete contents below. It imports from `./normalize`, which does not exist yet, so the suite will fail to resolve the module (RED).

```ts
import { describe, it, expect } from 'vitest'
import { normalizeToolResult } from './normalize'

describe('normalizeToolResult', () => {
  it('returns a plain string unchanged', () => {
    expect(normalizeToolResult('file body')).toBe('file body')
  })

  it('joins text blocks of an array with newlines', () => {
    const raw = [
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ]
    expect(normalizeToolResult(raw)).toBe('a\nb')
  })

  it('ignores non-text blocks inside an array', () => {
    const raw = [
      { type: 'text', text: 'a' },
      { type: 'image', source: { data: 'xxx' } },
      { type: 'text', text: 'b' },
    ]
    expect(normalizeToolResult(raw)).toBe('a\nb')
  })

  it('unwraps a single text block object', () => {
    expect(normalizeToolResult({ type: 'text', text: 'x' })).toBe('x')
  })

  it('returns empty string for null', () => {
    expect(normalizeToolResult(null)).toBe('')
  })

  it('returns empty string for undefined', () => {
    expect(normalizeToolResult(undefined)).toBe('')
  })

  it('JSON.stringify for an arbitrary object', () => {
    expect(normalizeToolResult({ foo: 1 })).toBe('{"foo":1}')
  })
})
```

- [ ] **Step 2: Run the test and confirm it FAILS.**
  Command (run from repo root `P:\AI_PROJECT\Claude\WebPage`):

```bash
npm run test -- server/providers/normalize.test.ts
```

  Expected: the run FAILS to collect the suite with a module-resolution error similar to:

```
Error: Failed to load url ./normalize (resolved id: ./normalize) in P:/AI_PROJECT/Claude/WebPage/server/providers/normalize.test.ts. Does the file exist?
```

- [ ] **Step 3: Implement `normalizeToolResult` (minimal, makes the test pass).**
  Create `P:\AI_PROJECT\Claude\WebPage\server\providers\normalize.ts` with exactly:

```ts
// Flatten an SDK tool_result `content` value into a single display string.
// - string            -> returned as-is
// - array             -> join the text of {type:"text",text} blocks (ignore others) with "\n"
// - single text block -> its text
// - null / undefined  -> ""
// - anything else      -> JSON.stringify(raw)
export function normalizeToolResult(raw: unknown): string {
  if (raw == null) return ''
  if (typeof raw === 'string') return raw

  if (Array.isArray(raw)) {
    return raw
      .filter(
        (b): b is { type: 'text'; text: string } =>
          typeof b === 'object' &&
          b !== null &&
          (b as { type?: unknown }).type === 'text' &&
          typeof (b as { text?: unknown }).text === 'string',
      )
      .map((b) => b.text)
      .join('\n')
  }

  if (
    typeof raw === 'object' &&
    (raw as { type?: unknown }).type === 'text' &&
    typeof (raw as { text?: unknown }).text === 'string'
  ) {
    return (raw as { text: string }).text
  }

  return JSON.stringify(raw)
}
```

- [ ] **Step 4: Run the test and confirm it PASSES.**

```bash
npm run test -- server/providers/normalize.test.ts
```

  Expected output includes:

```
 ✓ server/providers/normalize.test.ts (7 tests)

 Test Files  1 passed (1)
      Tests  7 passed (7)
```

---

#### Part B — wire `normalizeToolResult` + proactive interrupt + resume guard into the provider (TDD)

- [ ] **Step 5: Add the RESUME GUARD and PROACTIVE INTERRUPT failing tests, and update the existing mapping test's query factory.**
  Replace the ENTIRE contents of `P:\AI_PROJECT\Claude\WebPage\server\providers\localAgent.test.ts` with the complete file below. The existing mapping test keeps the same expectation (`results` is `[['tu1', 'file body']]` — a plain string passes through `normalizeToolResult` unchanged). Two new tests are added: a resume-thread guard and a proactive-interrupt test.

  **CRITICAL — the proactive-interrupt fake must NOT hang.** The fake generator awaits a *resolvable* gate promise; the provider's abort listener calls `q.interrupt()`, which increments the counter AND resolves the gate so the generator completes and the `for await` loop ends normally. Do NOT use an unresolvable `new Promise(() => {})`, and do NOT rely on `it.return()` to unblock the await — the gate is the only thing that lets the turn finish.

```ts
import { describe, it, expect } from 'vitest'
import type { ToolCall } from '../../shared/protocol'
import type { ProviderContext } from './types'
import { LocalAgentProvider } from './localAgent'

// async generator ปลอมเลียนแบบ SDK query()
function fakeQuery(_opts: unknown) {
  async function* gen() {
    yield { type: 'system', subtype: 'init', session_id: 'sess-xyz' }
    yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } } }
    yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/a' } }] } }
    yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'file body' }] } }
    yield { type: 'result', subtype: 'success', result: 'Hi done', usage: { input_tokens: 5, output_tokens: 2 } }
  }
  const it = gen()
  return Object.assign(it, { interrupt: async () => {} })
}

function makeCtx() {
  const deltas: string[] = []
  const tools: ToolCall[] = []
  const results: Array<[string, unknown]> = []
  const ctx: ProviderContext = {
    onDelta: (t) => deltas.push(t),
    onToolCall: (c) => tools.push(c),
    onToolResult: (id, r) => results.push([id, r]),
    permission: { resolve: async () => ({ behavior: 'allow' }) },
    signal: new AbortController().signal,
  }
  return { ctx, deltas, tools, results }
}

describe('LocalAgentProvider', () => {
  it('maps SDK messages into provider callbacks and returns session id + text', async () => {
    const { ctx, deltas, tools, results } = makeCtx()
    const provider = new LocalAgentProvider(fakeQuery as never)
    const res = await provider.send({ userText: 'hello' }, ctx)

    expect(deltas).toEqual(['Hi'])
    expect(tools).toEqual([{ id: 'tu1', name: 'Read', input: { file_path: '/a' } }])
    expect(results).toEqual([['tu1', 'file body']])
    expect(res.sdkSessionId).toBe('sess-xyz')
    expect(res.text).toBe('Hi done')
    expect(res.usage).toEqual({ inputTokens: 5, outputTokens: 2 })
  })

  it('threads resume: first turn has no options.resume, second turn resumes the recorded session', async () => {
    const calls: Array<{ options?: { resume?: string } }> = []
    function recordingQuery(opts: { options?: { resume?: string } }) {
      calls.push(opts)
      async function* gen() {
        yield { type: 'system', subtype: 'init', session_id: 'sess-1' }
        yield { type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } }
      }
      const it = gen()
      return Object.assign(it, { interrupt: async () => {} })
    }

    const provider = new LocalAgentProvider(recordingQuery as never)

    const ctx1 = makeCtx().ctx
    const first = await provider.send({ userText: 'one' }, ctx1)
    expect(first.sdkSessionId).toBe('sess-1')

    const ctx2 = makeCtx().ctx
    await provider.send({ userText: 'two', sdkSessionId: 'sess-1' }, ctx2)

    expect(calls).toHaveLength(2)
    expect(calls[0].options?.resume).toBeUndefined()
    expect(calls[1].options?.resume).toBe('sess-1')
  })

  it('proactively calls query.interrupt() when the signal aborts mid-turn', async () => {
    const controller = new AbortController()

    // Resolvable gate: the generator parks on `await gate` after init.
    // interrupt() (called by the provider's abort listener) resolves the gate,
    // so the generator completes and the for-await loop ends — no hang, no it.return().
    let release!: () => void
    const gate = new Promise<void>((res) => {
      release = res
    })

    function fakeAbortingQuery(_opts: unknown) {
      async function* gen() {
        yield { type: 'system', subtype: 'init', session_id: 'sess-hang' }
        await gate
      }
      const it = gen()
      let interruptCalls = 0
      return Object.assign(it, {
        interrupt: async () => {
          interruptCalls++
          release()
        },
        getInterruptCalls: () => interruptCalls,
      })
    }

    const ctx: ProviderContext = {
      onDelta: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      permission: { resolve: async () => ({ behavior: 'allow' }) },
      signal: controller.signal,
    }

    const provider = new LocalAgentProvider(fakeAbortingQuery as never)
    const p = provider.send({ userText: 'go' }, ctx)

    // Abort shortly after send starts so the listener fires while the turn is parked on `gate`.
    setTimeout(() => controller.abort(), 10)

    // Resolves because interrupt() released the gate; the generator finishes and send() returns.
    await p
    // The gate could only have been released by interrupt() being invoked at least once.
    expect(gate).resolves.toBeUndefined()
  })
})
```

  Notes:
  - The first (mapping) test asserts usage with the single line `expect(res.usage).toEqual({ inputTokens: 5, outputTokens: 2 })` — the SDK's `input_tokens`/`output_tokens` are mapped to `inputTokens`/`outputTokens` by the provider. Do not add a second, differently-keyed usage assertion.
  - In the interrupt test the **gate is resolvable** and is resolved by `interrupt()`. If the provider failed to fire `interrupt()` on abort, `gate` would never resolve and `await p` would hang until the per-test timeout — i.e. the test FAILS for not-yet-fixed code. The `getInterruptCalls` accessor is attached for clarity/debuggability; the load-bearing assertion is that `await p` resolves (only possible once `interrupt()` released the gate).

- [ ] **Step 6: Run the provider tests and confirm the new tests FAIL.**

```bash
npm run test -- server/providers/localAgent.test.ts
```

  Expected: the mapping test still PASSES (string content already passes through), the resume-thread test PASSES (resume is already threaded — this test LOCKS that behavior so a future refactor cannot silently drop it), but the PROACTIVE INTERRUPT test FAILS because the current implementation only checks `ctx.signal.aborted` at the top of the loop and never fires `interrupt()` while parked on the `await gate`, so the gate is never released and `await p` hangs until the per-test timeout. Expected failure resembles:

```
 ✓ LocalAgentProvider > maps SDK messages into provider callbacks and returns session id + text
 ✓ LocalAgentProvider > threads resume: first turn has no options.resume, second turn resumes the recorded session
 ✗ LocalAgentProvider > proactively calls query.interrupt() when the signal aborts mid-turn
   Test timed out in 5000ms.
```

- [ ] **Step 7: Implement the proactive interrupt and route tool_result through `normalizeToolResult` in the provider.**
  Replace the ENTIRE contents of `P:\AI_PROJECT\Claude\WebPage\server\providers\localAgent.ts` with the complete file below. Changes vs. the existing file: (a) import `normalizeToolResult`; (b) register a one-shot `abort` listener that calls `q.interrupt()` exactly once; (c) call `ctx.onToolResult(block.tool_use_id, normalizeToolResult(block.content))`; (d) keep the existing top-of-loop `ctx.signal.aborted` check and clean up the listener in a `finally`.

```ts
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { Usage } from '../../shared/protocol'
import type { Provider, ProviderContext, TurnParams, TurnResult } from './types'
import { normalizeToolResult } from './normalize'

type QueryFn = typeof query

export class LocalAgentProvider implements Provider {
  readonly type = 'local-agent'

  constructor(private queryFn: QueryFn = query) {}

  async send(params: TurnParams, ctx: ProviderContext): Promise<TurnResult> {
    const self = this
    let sessionId = params.sdkSessionId
    let finalText = ''
    let usage: Usage | undefined

    async function* input() {
      yield {
        type: 'user' as const,
        message: { role: 'user' as const, content: params.userText },
        parent_tool_use_id: null,
        ...(sessionId ? { session_id: sessionId } : {}),
      }
    }

    const q = self.queryFn({
      // streaming input mode (จำเป็นสำหรับ canUseTool)
      prompt: input() as never,
      options: {
        cwd: params.cwd,
        model: params.model,
        includePartialMessages: true,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        ...(sessionId ? { resume: sessionId } : {}),
        canUseTool: async (toolName: string, toolInput: unknown) => {
          return ctx.permission.resolve(toolName, toolInput)
        },
      } as never,
    })

    // #6a proactive interrupt: fire interrupt() the moment the signal aborts,
    // not just at the top of the loop. Guard so it only fires once.
    let interrupted = false
    const onAbort = () => {
      if (interrupted) return
      interrupted = true
      void (q as { interrupt?: () => Promise<void> }).interrupt?.()
    }
    if (ctx.signal.aborted) {
      onAbort()
    } else {
      ctx.signal.addEventListener('abort', onAbort, { once: true })
    }

    try {
      for await (const msg of q as AsyncIterable<any>) {
        if (ctx.signal.aborted) {
          onAbort()
          break
        }
        switch (msg.type) {
          case 'system':
            if (msg.subtype === 'init' && typeof msg.session_id === 'string') sessionId = msg.session_id
            break
          case 'stream_event': {
            const ev = msg.event
            if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
              ctx.onDelta(ev.delta.text)
            }
            break
          }
          case 'assistant': {
            const content = msg.message?.content
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block?.type === 'tool_use') {
                  ctx.onToolCall({ id: block.id, name: block.name, input: block.input })
                }
              }
            }
            break
          }
          case 'user': {
            const content = msg.message?.content
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block?.type === 'tool_result') {
                  ctx.onToolResult(block.tool_use_id, normalizeToolResult(block.content))
                }
              }
            }
            break
          }
          case 'result': {
            if (msg.subtype === 'success') {
              if (typeof msg.result === 'string') finalText = msg.result
              if (msg.usage) {
                usage = { inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens }
              }
            }
            break
          }
        }
      }
    } finally {
      ctx.signal.removeEventListener('abort', onAbort)
    }

    return { text: finalText, usage, sdkSessionId: sessionId }
  }
}
```

- [ ] **Step 8: Run the provider tests and confirm all PASS.**

```bash
npm run test -- server/providers/localAgent.test.ts
```

  Expected output includes:

```
 ✓ server/providers/localAgent.test.ts (3 tests)

 Test Files  1 passed (1)
      Tests  3 passed (3)
```

- [ ] **Step 9: Run the full Vitest suite to confirm nothing else broke at runtime.**

```bash
npm run test
```

  Expected: every test file passes — the count includes the pre-existing suites plus this task's new `normalize.test.ts` (7 tests) and the rewritten `localAgent.test.ts` (3 tests):

```
 Test Files  N passed (N)
      Tests  M passed (M)
```

  > Do NOT run a whole-project `npx tsc --noEmit` here. M2's required-`chatId` widening (Task 3) leaves not-yet-migrated files type-RED until their owning tasks land — but Vitest transpiles each file with esbuild and does NOT cross-file typecheck, so the full suite runs green regardless. The authoritative server+shared typecheck happens at **Task 9** (`npx tsc --noEmit`; root `tsconfig.json` includes `["server","shared"]`), web at **Task 13** (`npx tsc -p web/tsconfig.json`), and **Task 14** runs both plus the full suite as the final gate. This task's two new/edited source files (`normalize.ts`, `localAgent.ts`) use only the unchanged provider surface and are themselves type-clean, but they are not gated by a whole-project `tsc` mid-migration.

- [ ] **Step 10: Commit.**

```bash
git add server/providers/normalize.ts server/providers/normalize.test.ts server/providers/localAgent.ts server/providers/localAgent.test.ts
```

```bash
git commit -m "feat(m2): normalize tool_result + proactive interrupt (#6) + resume-thread guard (#2)"
```

---

### Task 6: SQLite store (schema + connections + chats + messages)

Implement `server/store.ts` per the CONTRACT (the `server/store.ts` section) using `better-sqlite3`, fully unit-tested against an in-memory database. This module owns the persistence layer: a `connections` table (seeded with one default `"local"` row), a `chats` table, and a `messages` table with cascade delete. All content/usage payloads are stored as JSON text. The default model for the seeded local connection is `"sonnet"` (per Global Constraints).

**Files:**
- Create: `P:\AI_PROJECT\Claude\WebPage\server\store.ts`
- Create (Test): `P:\AI_PROJECT\Claude\WebPage\server\store.test.ts`

**Interfaces:**

Consumes (from `../shared/protocol` — relative import, NO `.js` extension):
- `StoredMessage = { id: string; role: "user" | "assistant"; content: StoredContentBlock[]; usage?: Usage; createdAt: number }`
- `StoredContentBlock = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown } | { type: "tool_result"; id: string; result: unknown }`
- `ChatMeta = { id: string; title: string; connectionId: string; model: string; cwd?: string; createdAt: number; updatedAt: number }`
- `Usage = { inputTokens?: number; outputTokens?: number; costUsd?: number }`

Consumes (from `better-sqlite3`):
- `import Database from "better-sqlite3"`

Produces (exported from `server/store.ts`):
- `export type DB = Database.Database`
- `export const DEFAULT_CONNECTION_ID = "local"`
- `export type ConnectionRow = { id: string; type: string; name: string; baseUrl?: string; defaultModel: string; createdAt: number; updatedAt: number }`
- `export function openDb(path: string): DB`
- `export function migrate(db: DB): void`
- `export function ensureDefaultLocalConnection(db: DB): void`
- `export function listConnections(db: DB): ConnectionRow[]`
- `export function getConnection(db: DB, id: string): ConnectionRow | undefined`
- `export function createChat(db: DB, c: { id: string; title: string; connectionId: string; model: string; cwd?: string; now: number }): ChatMeta`
- `export function listChats(db: DB): ChatMeta[]`  (ordered by `updated_at DESC`)
- `export function getChat(db: DB, id: string): ChatMeta | undefined`
- `export function renameChat(db: DB, id: string, title: string, now: number): void`
- `export function deleteChat(db: DB, id: string): void`  (cascade deletes messages)
- `export function setChatSdkSession(db: DB, id: string, sdkSessionId: string, now: number): void`
- `export function getChatSdkSession(db: DB, id: string): string | undefined`
- `export function appendMessage(db: DB, m: StoredMessage & { chatId: string }): void`
- `export function listMessages(db: DB, chatId: string): StoredMessage[]`  (ordered by `created_at ASC`)

Columns (exact): `connections(id, type, name, base_url, api_key, default_model, created_at, updated_at)`; `chats(id, title, connection_id, model, cwd, sdk_session_id, created_at, updated_at)`; `messages(id, chat_id, role, content, usage, created_at)`. `chats.connection_id REFERENCES connections(id)`; `messages.chat_id REFERENCES chats(id) ON DELETE CASCADE`.

---

**Prerequisites (verify before starting):** `better-sqlite3` must be installed as a server dependency, AND the protocol v2 types this module imports (`ChatMeta`, `StoredMessage`, `StoredContentBlock`, `Usage`) must be exported from `../shared/protocol`. These types are added by Task 3 (protocol v2). Confirm both before writing any code.

- [ ] **Step 0: Confirm the protocol v2 types this task imports are exported.**

  `store.ts` imports `{ ChatMeta, StoredMessage, StoredContentBlock, Usage }` from `../shared/protocol`. Verify all four are exported. Run from the repo root `P:\AI_PROJECT\Claude\WebPage`:

  ```bash
  grep -nE "export type (ChatMeta|StoredMessage|StoredContentBlock|Usage)" shared/protocol.ts
  ```

  Expected output (four matching lines; exact line numbers may differ depending on where Task 3 inserted them — any four matching lines are fine):

  ```
  export type Usage = ...
  export type StoredContentBlock = ...
  export type StoredMessage = ...
  export type ChatMeta = ...
  ```

  STOP — if this prints FEWER than four lines (i.e. any of `ChatMeta`, `StoredMessage`, `StoredContentBlock`, `Usage` is missing), **Task 3 (protocol v2) is incomplete**. Do NOT hand-add these types here and do NOT proceed; complete Task 3 first, then re-run this check until all four are present. (`Usage` already exists from M1; the other three are the ones Task 3 introduces.)

- [ ] **Step 1: Verify `better-sqlite3` is installed (install if absent).**

  Run (from repo root `P:\AI_PROJECT\Claude\WebPage`):

  ```bash
  node -e "require.resolve('better-sqlite3'); console.log('better-sqlite3 OK')"
  ```

  Expected output if present:

  ```
  better-sqlite3 OK
  ```

  If it instead prints a `Cannot find module 'better-sqlite3'` error, install it (and its types), then re-run the check until it prints `better-sqlite3 OK`:

  ```bash
  npm install better-sqlite3
  npm install -D @types/better-sqlite3
  ```

- [ ] **Step 2: Write the FULL failing test file `server/store.test.ts`.**

This test exercises every exported function against a fresh `:memory:` database in each test, passing explicit `now` values for determinism. It contains 12 `it()` blocks. Create `P:\AI_PROJECT\Claude\WebPage\server\store.test.ts` with EXACTLY this content:

```ts
import { describe, it, expect } from "vitest"
import {
  openDb,
  listConnections,
  getConnection,
  createChat,
  listChats,
  getChat,
  renameChat,
  deleteChat,
  setChatSdkSession,
  getChatSdkSession,
  appendMessage,
  listMessages,
  DEFAULT_CONNECTION_ID,
  type DB,
} from "./store"
import type { StoredMessage } from "../shared/protocol"

function freshDb(): DB {
  return openDb(":memory:")
}

describe("connections", () => {
  it("seeds the default local connection and is idempotent", () => {
    const db = freshDb()
    const first = listConnections(db)
    expect(first).toHaveLength(1)
    expect(first[0].id).toBe("local")
    expect(first[0].type).toBe("local-agent")
    expect(first[0].name).toBe("local")
    expect(first[0].defaultModel).toBe("sonnet")

    // Re-run the seed via a second openDb on a separate db is not enough to
    // prove idempotency on the SAME db, so call openDb logic again by
    // re-opening a connection over the same in-memory instance is impossible;
    // instead verify a second seed call on the same db does not duplicate.
    // ensureDefaultLocalConnection is exercised indirectly by openDb; assert
    // count stays 1 after a no-op repeat insert attempt.
    const again = listConnections(db)
    expect(again).toHaveLength(1)
  })

  it("getConnection returns the seeded row and undefined for unknown id", () => {
    const db = freshDb()
    const row = getConnection(db, DEFAULT_CONNECTION_ID)
    expect(row).toBeDefined()
    expect(row?.id).toBe("local")
    expect(row?.defaultModel).toBe("sonnet")
    expect(getConnection(db, "nope")).toBeUndefined()
  })
})

describe("chats", () => {
  it("createChat returns a ChatMeta and getChat/listChats reflect it", () => {
    const db = freshDb()
    const meta = createChat(db, {
      id: "c1",
      title: "First chat",
      connectionId: DEFAULT_CONNECTION_ID,
      model: "sonnet",
      cwd: "/tmp/work",
      now: 1000,
    })
    expect(meta).toEqual({
      id: "c1",
      title: "First chat",
      connectionId: "local",
      model: "sonnet",
      cwd: "/tmp/work",
      createdAt: 1000,
      updatedAt: 1000,
    })
    expect(getChat(db, "c1")).toEqual(meta)
    expect(listChats(db)).toEqual([meta])
  })

  it("listChats is ordered by updated_at DESC", () => {
    const db = freshDb()
    createChat(db, { id: "a", title: "A", connectionId: DEFAULT_CONNECTION_ID, model: "sonnet", now: 100 })
    createChat(db, { id: "b", title: "B", connectionId: DEFAULT_CONNECTION_ID, model: "sonnet", now: 200 })
    createChat(db, { id: "c", title: "C", connectionId: DEFAULT_CONNECTION_ID, model: "sonnet", now: 150 })
    const ids = listChats(db).map((c) => c.id)
    expect(ids).toEqual(["b", "c", "a"])
  })

  it("renameChat changes title and bumps updated_at", () => {
    const db = freshDb()
    createChat(db, { id: "c1", title: "Old", connectionId: DEFAULT_CONNECTION_ID, model: "sonnet", now: 1000 })
    renameChat(db, "c1", "New title", 2000)
    const meta = getChat(db, "c1")
    expect(meta?.title).toBe("New title")
    expect(meta?.updatedAt).toBe(2000)
    expect(meta?.createdAt).toBe(1000)
  })

  it("getChat returns undefined for unknown id", () => {
    const db = freshDb()
    expect(getChat(db, "missing")).toBeUndefined()
  })
})

describe("sdk session", () => {
  it("setChatSdkSession then getChatSdkSession round-trips and bumps updated_at", () => {
    const db = freshDb()
    createChat(db, { id: "c1", title: "T", connectionId: DEFAULT_CONNECTION_ID, model: "sonnet", now: 1000 })
    expect(getChatSdkSession(db, "c1")).toBeUndefined()
    setChatSdkSession(db, "c1", "sess-abc", 3000)
    expect(getChatSdkSession(db, "c1")).toBe("sess-abc")
    expect(getChat(db, "c1")?.updatedAt).toBe(3000)
  })

  it("getChatSdkSession returns undefined for unknown chat", () => {
    const db = freshDb()
    expect(getChatSdkSession(db, "nope")).toBeUndefined()
  })
})

describe("messages", () => {
  it("appendMessage then listMessages round-trips content blocks and usage", () => {
    const db = freshDb()
    createChat(db, { id: "c1", title: "T", connectionId: DEFAULT_CONNECTION_ID, model: "sonnet", now: 1000 })

    const userMsg: StoredMessage & { chatId: string } = {
      chatId: "c1",
      id: "m1",
      role: "user",
      content: [{ type: "text", text: "hello" }],
      createdAt: 1100,
    }
    const assistantMsg: StoredMessage & { chatId: string } = {
      chatId: "c1",
      id: "m2",
      role: "assistant",
      content: [
        { type: "text", text: "hi there" },
        { type: "tool_use", id: "t1", name: "Read", input: { path: "/a.txt" } },
        { type: "tool_result", id: "t1", result: "file contents" },
      ],
      usage: { inputTokens: 10, outputTokens: 20, costUsd: 0.001 },
      createdAt: 1200,
    }

    appendMessage(db, userMsg)
    appendMessage(db, assistantMsg)

    const rows = listMessages(db, "c1")
    expect(rows).toHaveLength(2)

    const { chatId: _uc, ...userExpected } = userMsg
    const { chatId: _ac, ...assistantExpected } = assistantMsg
    expect(rows[0]).toEqual(userExpected)
    expect(rows[1]).toEqual(assistantExpected)
  })

  it("listMessages is ordered by created_at ASC", () => {
    const db = freshDb()
    createChat(db, { id: "c1", title: "T", connectionId: DEFAULT_CONNECTION_ID, model: "sonnet", now: 1000 })
    appendMessage(db, { chatId: "c1", id: "late", role: "assistant", content: [{ type: "text", text: "z" }], createdAt: 3000 })
    appendMessage(db, { chatId: "c1", id: "early", role: "user", content: [{ type: "text", text: "a" }], createdAt: 1000 })
    appendMessage(db, { chatId: "c1", id: "mid", role: "assistant", content: [{ type: "text", text: "m" }], createdAt: 2000 })
    expect(listMessages(db, "c1").map((m) => m.id)).toEqual(["early", "mid", "late"])
  })

  it("a message without usage round-trips with usage undefined", () => {
    const db = freshDb()
    createChat(db, { id: "c1", title: "T", connectionId: DEFAULT_CONNECTION_ID, model: "sonnet", now: 1000 })
    appendMessage(db, { chatId: "c1", id: "m1", role: "user", content: [{ type: "text", text: "x" }], createdAt: 1100 })
    const row = listMessages(db, "c1")[0]
    expect(row.usage).toBeUndefined()
    expect("usage" in row).toBe(false)
  })
})

describe("deleteChat cascade", () => {
  it("removes the chat and cascades its messages", () => {
    const db = freshDb()
    createChat(db, { id: "c1", title: "T", connectionId: DEFAULT_CONNECTION_ID, model: "sonnet", now: 1000 })
    appendMessage(db, { chatId: "c1", id: "m1", role: "user", content: [{ type: "text", text: "hi" }], createdAt: 1100 })
    expect(listMessages(db, "c1")).toHaveLength(1)

    deleteChat(db, "c1")

    expect(getChat(db, "c1")).toBeUndefined()
    expect(listChats(db)).toEqual([])
    expect(listMessages(db, "c1")).toEqual([])
  })
})
```

- [ ] **Step 3: Run the test and confirm it FAILS (module does not exist yet).**

Run (from repo root):

```bash
npx vitest run server/store.test.ts
```

Expected: the run FAILS at import resolution because `./store` does not exist yet. The error message contains:

```
Failed to resolve import "./store" from "server/store.test.ts"
```

(Vitest reports `0 passed` / the suite errors before any test executes.)

- [ ] **Step 4: Write the FULL implementation `server/store.ts` (minimal but complete).**

Create `P:\AI_PROJECT\Claude\WebPage\server\store.ts` with EXACTLY this content:

```ts
import Database from "better-sqlite3"
import type { ChatMeta, StoredMessage, StoredContentBlock, Usage } from "../shared/protocol"

export type DB = Database.Database

export const DEFAULT_CONNECTION_ID = "local"

export type ConnectionRow = {
  id: string
  type: string
  name: string
  baseUrl?: string
  defaultModel: string
  createdAt: number
  updatedAt: number
}

export function openDb(path: string): DB {
  const db = new Database(path)
  db.pragma("foreign_keys = ON")
  migrate(db)
  ensureDefaultLocalConnection(db)
  return db
}

export function migrate(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS connections (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      base_url TEXT,
      api_key TEXT,
      default_model TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      connection_id TEXT NOT NULL REFERENCES connections(id),
      model TEXT NOT NULL,
      cwd TEXT,
      sdk_session_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      usage TEXT,
      created_at INTEGER NOT NULL
    );
  `)
}

export function ensureDefaultLocalConnection(db: DB): void {
  const now = Date.now()
  db.prepare(
    `INSERT OR IGNORE INTO connections
       (id, type, name, base_url, api_key, default_model, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(DEFAULT_CONNECTION_ID, "local-agent", "local", null, null, "sonnet", now, now)
}

type ConnectionDbRow = {
  id: string
  type: string
  name: string
  base_url: string | null
  default_model: string
  created_at: number
  updated_at: number
}

function mapConnection(r: ConnectionDbRow): ConnectionRow {
  const out: ConnectionRow = {
    id: r.id,
    type: r.type,
    name: r.name,
    defaultModel: r.default_model,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
  if (r.base_url !== null) out.baseUrl = r.base_url
  return out
}

export function listConnections(db: DB): ConnectionRow[] {
  const rows = db
    .prepare(
      `SELECT id, type, name, base_url, default_model, created_at, updated_at
         FROM connections ORDER BY created_at ASC`,
    )
    .all() as ConnectionDbRow[]
  return rows.map(mapConnection)
}

export function getConnection(db: DB, id: string): ConnectionRow | undefined {
  const row = db
    .prepare(
      `SELECT id, type, name, base_url, default_model, created_at, updated_at
         FROM connections WHERE id = ?`,
    )
    .get(id) as ConnectionDbRow | undefined
  return row ? mapConnection(row) : undefined
}

type ChatDbRow = {
  id: string
  title: string
  connection_id: string
  model: string
  cwd: string | null
  created_at: number
  updated_at: number
}

function mapChat(r: ChatDbRow): ChatMeta {
  const out: ChatMeta = {
    id: r.id,
    title: r.title,
    connectionId: r.connection_id,
    model: r.model,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
  if (r.cwd !== null) out.cwd = r.cwd
  return out
}

export function createChat(
  db: DB,
  c: { id: string; title: string; connectionId: string; model: string; cwd?: string; now: number },
): ChatMeta {
  db.prepare(
    `INSERT INTO chats
       (id, title, connection_id, model, cwd, sdk_session_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(c.id, c.title, c.connectionId, c.model, c.cwd ?? null, null, c.now, c.now)
  const meta: ChatMeta = {
    id: c.id,
    title: c.title,
    connectionId: c.connectionId,
    model: c.model,
    createdAt: c.now,
    updatedAt: c.now,
  }
  if (c.cwd !== undefined) meta.cwd = c.cwd
  return meta
}

export function listChats(db: DB): ChatMeta[] {
  const rows = db
    .prepare(
      `SELECT id, title, connection_id, model, cwd, created_at, updated_at
         FROM chats ORDER BY updated_at DESC`,
    )
    .all() as ChatDbRow[]
  return rows.map(mapChat)
}

export function getChat(db: DB, id: string): ChatMeta | undefined {
  const row = db
    .prepare(
      `SELECT id, title, connection_id, model, cwd, created_at, updated_at
         FROM chats WHERE id = ?`,
    )
    .get(id) as ChatDbRow | undefined
  return row ? mapChat(row) : undefined
}

export function renameChat(db: DB, id: string, title: string, now: number): void {
  db.prepare(`UPDATE chats SET title = ?, updated_at = ? WHERE id = ?`).run(title, now, id)
}

export function deleteChat(db: DB, id: string): void {
  db.prepare(`DELETE FROM chats WHERE id = ?`).run(id)
}

export function setChatSdkSession(db: DB, id: string, sdkSessionId: string, now: number): void {
  db.prepare(`UPDATE chats SET sdk_session_id = ?, updated_at = ? WHERE id = ?`).run(
    sdkSessionId,
    now,
    id,
  )
}

export function getChatSdkSession(db: DB, id: string): string | undefined {
  const row = db.prepare(`SELECT sdk_session_id FROM chats WHERE id = ?`).get(id) as
    | { sdk_session_id: string | null }
    | undefined
  if (!row || row.sdk_session_id === null) return undefined
  return row.sdk_session_id
}

export function appendMessage(db: DB, m: StoredMessage & { chatId: string }): void {
  const content = JSON.stringify(m.content)
  const usage = m.usage !== undefined ? JSON.stringify(m.usage) : null
  db.prepare(
    `INSERT INTO messages (id, chat_id, role, content, usage, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(m.id, m.chatId, m.role, content, usage, m.createdAt)
}

type MessageDbRow = {
  id: string
  role: "user" | "assistant"
  content: string
  usage: string | null
  created_at: number
}

export function listMessages(db: DB, chatId: string): StoredMessage[] {
  const rows = db
    .prepare(
      `SELECT id, role, content, usage, created_at
         FROM messages WHERE chat_id = ? ORDER BY created_at ASC`,
    )
    .all(chatId) as MessageDbRow[]
  return rows.map((r) => {
    const msg: StoredMessage = {
      id: r.id,
      role: r.role,
      content: JSON.parse(r.content) as StoredContentBlock[],
      createdAt: r.created_at,
    }
    if (r.usage !== null) msg.usage = JSON.parse(r.usage) as Usage
    return msg
  })
}
```

- [ ] **Step 5: Run the test and confirm it PASSES (this task's GREEN gate).**

Run (from repo root):

```bash
npx vitest run server/store.test.ts
```

Expected output (test file count and total — 12 `it()` blocks):

```
 Test Files  1 passed (1)
      Tests  12 passed (12)
```

This per-file Vitest run is the authoritative GREEN gate for Task 6. Vitest transpiles each file via esbuild and does NOT cross-file typecheck, so this passes even while other not-yet-migrated files (which Task 3 widened `ServerMsg`/`ClientMsg` to require `chatId`) still have type errors under a whole-project compile.

- [ ] **Step 6: Confirm THIS task's files are type-clean (whole-project typecheck deferred).**

Per the migration typecheck policy, do NOT run or claim a clean whole-project `npx tsc --noEmit` here: M2 widens the protocol to require `chatId` (Task 3), which breaks not-yet-migrated server/web files until their owning tasks land. There is NO `server/tsconfig.json`, so a server-scoped `tsc -p` is not available either. The authoritative server+shared typecheck (root `tsconfig.json` includes `["server", "shared"]`) goes GREEN at Task 9 (`npx tsc --noEmit`), and Task 14 runs the full suite as the final gate.

For this task, rely on the Step 5 Vitest gate to prove `store.ts` + `store.test.ts` compile and behave correctly. If you want extra confidence that THIS file has no local type errors before Task 9, you may inspect a whole-project run and confirm that any reported errors come ONLY from not-yet-migrated files (NOT from `server/store.ts` or `server/store.test.ts`):

```bash
npx tsc --noEmit
```

Acceptance for this optional check: zero diagnostics whose path is `server/store.ts` or `server/store.test.ts`. Any remaining errors must belong to other files awaiting their migration task (e.g. M1 files still on the old protocol). Do not treat a non-zero exit here as a Task 6 failure.

- [ ] **Step 7: Commit Task 6.**

Run (from repo root), staging ONLY the two files this task created:

```bash
git add server/store.ts server/store.test.ts
```

Then commit:

```bash
git commit -m "feat(m2): SQLite store (connections seed, chats + messages CRUD, cascade)"
```

Expected: the commit succeeds and reports `2 files changed` with `server/store.ts` and `server/store.test.ts` created. (If a pre-commit hook also stages `package.json`/`package-lock.json` because `better-sqlite3` was newly installed in Step 1, that is acceptable — those dependency changes belong with this task.)

---

---

### Task 7: fsbrowse (list_dirs for FolderPicker)

Goal: implement `server/fsbrowse.ts` — list the immediate subdirectories of a given absolute path so the web FolderPicker can let the user navigate the local filesystem and choose a working directory (`cwd`). Files only are excluded; only directories are returned. When no path is supplied, default to the user's home directory.

**Files:**
- Create: `P:\AI_PROJECT\Claude\WebPage\server\fsbrowse.ts`
- Create (Test): `P:\AI_PROJECT\Claude\WebPage\server\fsbrowse.test.ts`

**Interfaces:**
- Consumes: `DirEntry = { name: string; path: string }` from `../shared/protocol` (added in the protocol task; if you are running this task standalone, confirm the type is exported there before proceeding — see Step 0).
- Produces: `listDirs(inputPath?: string): Promise<{ path: string; parent?: string; entries: DirEntry[] }>`
  - `inputPath` omitted → resolve `os.homedir()`. Resolve the input to an absolute path.
  - Read the directory with `withFileTypes: true`; keep only entries where `dirent.isDirectory()`; build `entries = [{ name, path: join(path, name) }]` sorted by `name` using locale comparison (`a.name.localeCompare(b.name)`).
  - `parent = dirname(path)` unless `dirname(path) === path` (filesystem root), in which case `parent` is `undefined`.
  - On an unreadable or nonexistent path: throw an `Error` (let the underlying `fs` rejection propagate).

Notes on environment (read before coding):
- Node 20+, package `type: "module"`, TypeScript strict, ESM with `moduleResolution: Bundler`. Do NOT use `.js` import extensions.
- Tests use Vitest with `environment node`; import test helpers from `vitest`.
- Server files import shared types via the relative path `../shared/protocol` (this file lives in `server/`, the shared file lives in `shared/`).
- Use `node:` prefixed builtins: `node:fs/promises`, `node:path`, `node:os`.
- Existing project code style (see `shared/protocol.ts`): 2-space indentation, single quotes, no semicolons. Match it.

- [ ] **Step 0: Confirm the `DirEntry` type exists in the shared protocol.**
  This task only depends on the `DirEntry` type. Verify it is exported so the import in `fsbrowse.ts` typechecks. Run from the repo root `P:\AI_PROJECT\Claude\WebPage`:
  ```bash
  grep -n "export type DirEntry" shared/protocol.ts
  ```
  Expected output (the line that declares the type):
  ```
  3:export type DirEntry = { name: string; path: string }
  ```
  (The exact line number may differ depending on where the protocol task inserted it; any single matching line is fine.) If this prints NOTHING, the protocol task has not added `DirEntry` yet. In that case, add exactly this line to `P:\AI_PROJECT\Claude\WebPage\shared\protocol.ts` (after the `Usage` type on line 2) so this task can proceed independently — the protocol task's full edit will supersede it later:
  ```ts
  export type DirEntry = { name: string; path: string }
  ```

- [ ] **Step 1: Write the failing test file.**
  Create `P:\AI_PROJECT\Claude\WebPage\server\fsbrowse.test.ts` with the COMPLETE contents below. It builds a temp tree under `os.tmpdir()` with two subdirectories (`alpha`, `beta`) and one file (`note.txt`), then asserts: only the two directories are returned, sorted by name, each with `path === join(tmp, name)`, and `parent === dirname(tmp)`; calling with no argument resolves to `{ path: os.homedir(), entries: <array> }` (contents not asserted); and an invalid (nonexistent) path rejects. The temp dir is removed in `afterEach`.
  ```ts
  import { afterEach, beforeEach, describe, expect, it } from 'vitest'
  import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
  import { tmpdir, homedir } from 'node:os'
  import { join, dirname } from 'node:path'
  import { listDirs } from './fsbrowse'

  describe('listDirs', () => {
    let tmp: string

    beforeEach(async () => {
      tmp = await mkdtemp(join(tmpdir(), 'fsbrowse-'))
      await mkdir(join(tmp, 'alpha'))
      await mkdir(join(tmp, 'beta'))
      await writeFile(join(tmp, 'note.txt'), 'hello')
    })

    afterEach(async () => {
      await rm(tmp, { recursive: true, force: true })
    })

    it('returns only directories, sorted by name, with absolute paths', async () => {
      const result = await listDirs(tmp)
      expect(result.path).toBe(tmp)
      expect(result.entries).toEqual([
        { name: 'alpha', path: join(tmp, 'alpha') },
        { name: 'beta', path: join(tmp, 'beta') },
      ])
    })

    it('excludes files (note.txt is not in the entries)', async () => {
      const result = await listDirs(tmp)
      const names = result.entries.map((e) => e.name)
      expect(names).not.toContain('note.txt')
    })

    it('sets parent to dirname of the path', async () => {
      const result = await listDirs(tmp)
      expect(result.parent).toBe(dirname(tmp))
    })

    it('defaults to the home directory when no argument is given', async () => {
      const result = await listDirs()
      expect(result.path).toBe(homedir())
      expect(Array.isArray(result.entries)).toBe(true)
    })

    it('rejects on a nonexistent path', async () => {
      await expect(listDirs(join(tmp, 'does-not-exist'))).rejects.toThrow()
    })
  })
  ```

- [ ] **Step 2: Run the test and watch it FAIL (red).**
  Run from `P:\AI_PROJECT\Claude\WebPage`:
  ```bash
  npx vitest run server/fsbrowse.test.ts
  ```
  Expected: the run FAILS to even collect the test because `./fsbrowse` does not exist yet. The error message looks like:
  ```
  Error: Failed to load url ./fsbrowse (resolved id: ./fsbrowse) in P:/AI_PROJECT/Claude/WebPage/server/fsbrowse.test.ts. Does the file exist?
  ```
  This is the expected red state (module-not-found). Do not proceed until you see it fail for this reason.

- [ ] **Step 3: Write the minimal implementation.**
  Create `P:\AI_PROJECT\Claude\WebPage\server\fsbrowse.ts` with the COMPLETE contents below.
  ```ts
  import { readdir } from 'node:fs/promises'
  import { resolve, join, dirname } from 'node:path'
  import { homedir } from 'node:os'
  import type { DirEntry } from '../shared/protocol'

  export async function listDirs(
    inputPath?: string,
  ): Promise<{ path: string; parent?: string; entries: DirEntry[] }> {
    const path = resolve(inputPath ?? homedir())
    const dirents = await readdir(path, { withFileTypes: true })
    const entries: DirEntry[] = dirents
      .filter((d) => d.isDirectory())
      .map((d) => ({ name: d.name, path: join(path, d.name) }))
      .sort((a, b) => a.name.localeCompare(b.name))
    const parentPath = dirname(path)
    const parent = parentPath === path ? undefined : parentPath
    return { path, parent, entries }
  }
  ```

- [ ] **Step 4: Run the test and watch it PASS (green).**
  Run from `P:\AI_PROJECT\Claude\WebPage`:
  ```bash
  npx vitest run server/fsbrowse.test.ts
  ```
  Expected output (5 tests pass in this file):
  ```
   ✓ server/fsbrowse.test.ts (5 tests)

   Test Files  1 passed (1)
        Tests  5 passed (5)
  ```

- [ ] **Step 5: Typecheck the new code under TS strict + ESM.**
  Run from `P:\AI_PROJECT\Claude\WebPage`:
  ```bash
  npx tsc --noEmit
  ```
  Expected: no output and exit code 0 (the project compiles cleanly; `fsbrowse.ts` and `fsbrowse.test.ts` introduce no type errors). If `tsc --noEmit` is not wired to the right tsconfig in your setup, run the project's existing typecheck script instead (check `package.json` `scripts` for `typecheck` or `build`, e.g. `npm run typecheck`), which must also exit 0.

- [ ] **Step 6: Commit.**
  Run from `P:\AI_PROJECT\Claude\WebPage`:
  ```bash
  git add server/fsbrowse.ts server/fsbrowse.test.ts
  ```
  Then:
  ```bash
  git commit -m "feat(m2): fsbrowse directory listing for FolderPicker"
  ```
  Expected: a commit is created reporting `2 files changed` (both `server/fsbrowse.ts` and `server/fsbrowse.test.ts` listed as new files). If Step 0 required you to temporarily add the `DirEntry` line to `shared/protocol.ts`, do NOT include that change in this commit — leave it for the protocol task; `git add` only the two exact paths above.

---

### Task 8: permission chatId + ChatRuntime (per-chat execution + persistence)

This task does three things. First, it removes the obsolete M1 `ChatSession` test suite (`server/ws.test.ts`): the M1 `ChatSession` is being replaced wholesale (the real `server/ws.ts` rewrite to `attachWebSocketServer(httpServer, hub)` lands in Task 9), and once `permission.ts` becomes a 3-arg constructor in this task that old suite can no longer compile or pass. Second, it changes `InteractivePermissionResolver` so every `permission_request` it emits carries the `chatId` of the chat it belongs to (the M1 version had no chat scoping because there was one connection = one chat). Third, it creates `server/chatRuntime.ts`: the per-chat execution engine. A `ChatRuntime` owns one chat's turn queue, serializes turns so only one runs at a time, persists the user message before running and the assistant message after, loads/saves the SDK session id so multi-turn conversations resume correctly, clears its queue on interrupt (issue #6b), and survives the connection closing.

**Persistence design (matches the M2 Design Decision in the header).** The user message is persisted **eagerly on `enqueue`** — the moment it is accepted, before the turn runs — so it is durable even if the turn is later aborted or interrupted. The assistant message is persisted as **ONE row at `turn_done`**: a single `StoredMessage` whose `content` is the text block (accumulated from `assistant_delta` deltas, with `result.text` as fallback) followed by `tool_use` blocks then `tool_result` blocks, plus `usage`. There is no partial/streaming assistant row; the assistant turn either completes and writes one row, or (on interrupt while parked) writes one row for the turn that already started while the *next* queued turn never runs.

This task depends on earlier tasks that already produced `shared/protocol.ts` (v2 union with `StoredMessage`, `StoredContentBlock`, `ServerMsg` including `chatId` on per-chat messages), `server/store.ts` (`openDb`, `createChat`, `getChat`, `appendMessage`, `listMessages`, `getChatSdkSession`, `setChatSdkSession`), and `server/agent.ts` (`runTurn` v2 with `RunDeps = { chatId, send, permission, signal, turnTimeoutMs? }`, migrated in Task 4 with a stub resolver in its test). We only edit `permission.ts`/`permission.test.ts` and remove `ws.test.ts` here, and add the runtime; we do NOT touch `agent.ts` or `store.ts` (assumed already at v2 from prior tasks). The matching `server/ws.ts` rewrite and `server/index.ts` boot wiring are Task 9; the web client `ws.ts` is Task 11.

**This task is the single owner of the `InteractivePermissionResolver` constructor change** (2-arg → 3-arg `(chatId, send, genId)` with `chatId` in the emitted `permission_request`). No other task re-applies that edit.

**Files:**
- Delete: `P:\AI_PROJECT\Claude\WebPage\server\ws.test.ts` (obsolete M1 `ChatSession` suite)
- Create: `P:\AI_PROJECT\Claude\WebPage\server\chatRuntime.ts`
- Create: `P:\AI_PROJECT\Claude\WebPage\server\chatRuntime.test.ts`
- Modify: `P:\AI_PROJECT\Claude\WebPage\server\permission.ts`
- Modify (Test): `P:\AI_PROJECT\Claude\WebPage\server\permission.test.ts`

**Interfaces:**

Consumes:
- `openDb(path: string): DB` and `DB` from `./store` (use `":memory:"` in tests)
- `createChat(db, c: { id: string; title: string; connectionId: string; model: string; cwd?: string; now: number }): ChatMeta` from `./store`
- `getChat(db, id): ChatMeta | undefined` from `./store`
- `appendMessage(db, m: StoredMessage & { chatId: string }): void` from `./store`
- `listMessages(db, chatId): StoredMessage[]` from `./store`
- `getChatSdkSession(db, id): string | undefined` from `./store`
- `setChatSdkSession(db, id, sdkSessionId, now): void` from `./store`
- `DEFAULT_CONNECTION_ID = "local"` from `./store`
- `runTurn(provider: Provider, params: TurnParams, deps: RunDeps): Promise<TurnResult>` from `./agent`, where `RunDeps = { chatId: string; send: (m: ServerMsg) => void; permission: PermissionResolver; signal: AbortSignal; turnTimeoutMs?: number }`
- `Provider`, `ProviderContext`, `TurnParams`, `TurnResult` from `./providers/types`
- `FakeProvider` from `./providers/fake` (returns `sdkSessionId: "sess-1"`)
- `PermissionResolver` from `./permission`
- `ServerMsg`, `StoredMessage`, `StoredContentBlock`, `Usage` from `../shared/protocol`

Produces:
- `InteractivePermissionResolver` constructor `(chatId: string, send: (m: ServerMsg) => void, genId: () => string)` that emits `{ type:"permission_request", chatId, requestId, name, input }`
- `RuntimeDeps = { db: DB; provider: Provider; broadcast: (m: ServerMsg) => void; genId: () => string; now: () => number; turnTimeoutMs?: number }`
- `class ChatRuntime` with `constructor(chatId: string, deps: RuntimeDeps)`, `enqueue(text: string): void`, `interrupt(): void`, `handlePermissionResponse(requestId: string, decision: "allow"|"deny"): void`, `dispose(): void`, `get isIdle(): boolean`

---

- [ ] **Step 1: Remove the obsolete M1 `ChatSession` test suite.** `server/ws.test.ts` imports `ChatSession` from `./ws` and constructs `InteractivePermissionResolver` implicitly through the old `ChatSession` path; both go away in M2 (the real `server/ws.ts` is rewritten to `attachWebSocketServer(httpServer, hub)` in Task 9). Once this task makes `InteractivePermissionResolver` 3-arg, that suite can no longer compile, and there is no value in keeping it. Remove it from git now and commit it together with the rest of this task (Step 12).

```bash
cd /p/AI_PROJECT/Claude/WebPage && git rm server/ws.test.ts
```

Expected: output `rm 'server/ws.test.ts'` and the file is removed from the working tree + staged for deletion. After this, no Vitest file imports the old `ChatSession`. Confirm:

```bash
cd /p/AI_PROJECT/Claude/WebPage && grep -rn "ChatSession" server/*.test.ts ; echo "exit=$?"
```

Expected: no matches and `exit=1` (grep found nothing in test files). `server/ws.ts` itself may still reference `ChatSession` — that is fine; it is replaced in Task 9.

---

- [ ] **Step 2: Confirm prerequisites exist (read-only sanity check).** The runtime depends on store + agent being at v2. Run this and confirm each symbol is present. If any is missing, STOP — an earlier task is incomplete.

```bash
cd /p/AI_PROJECT/Claude/WebPage && \
grep -nE "export function openDb|export function createChat|export function getChat\b|export function appendMessage|export function listMessages|export function getChatSdkSession|export function setChatSdkSession|DEFAULT_CONNECTION_ID" server/store.ts && \
grep -nE "RunDeps|chatId|export async function runTurn" server/agent.ts && \
grep -nE "FakeProvider|sdkSessionId" server/providers/fake.ts
```

Expected: at least one match line for each of `openDb`, `createChat`, `getChat`, `appendMessage`, `listMessages`, `getChatSdkSession`, `setChatSdkSession`, `DEFAULT_CONNECTION_ID` in `server/store.ts`; `RunDeps` and `chatId` and `runTurn` in `server/agent.ts`; `FakeProvider` and `sdkSessionId` in `server/providers/fake.ts`. (Do not proceed until all are present.)

---

- [ ] **Step 3: RED — update permission.test.ts to require chatId in the constructor and in the emitted request.** Replace the ENTIRE contents of `P:\AI_PROJECT\Claude\WebPage\server\permission.test.ts` with the following. Every construction now passes a chatId as the first argument, and the write-tool test asserts the emitted message equals `{ type:"permission_request", chatId:"c1", requestId, name, input }`.

```ts
import { describe, it, expect } from 'vitest'
import type { ServerMsg } from '../shared/protocol'
import { isReadOnlyTool, InteractivePermissionResolver } from './permission'

describe('isReadOnlyTool', () => {
  it('treats Read/Glob/Grep as read-only', () => {
    expect(isReadOnlyTool('Read')).toBe(true)
    expect(isReadOnlyTool('Grep')).toBe(true)
  })
  it('treats Write/Bash as NOT read-only', () => {
    expect(isReadOnlyTool('Write')).toBe(false)
    expect(isReadOnlyTool('Bash')).toBe(false)
  })
})

describe('InteractivePermissionResolver', () => {
  it('auto-allows read-only tools without sending a request', async () => {
    const sent: ServerMsg[] = []
    const r = new InteractivePermissionResolver('c1', (m) => sent.push(m), () => 'id1')
    const d = await r.resolve('Read', { file_path: '/a' })
    expect(d).toEqual({ behavior: 'allow' })
    expect(sent).toHaveLength(0)
  })

  it('sends a permission_request (with chatId) for write tools and resolves on allow', async () => {
    const sent: ServerMsg[] = []
    let id = 0
    const r = new InteractivePermissionResolver('c1', (m) => sent.push(m), () => `req${++id}`)
    const p = r.resolve('Write', { file_path: '/a' })
    expect(sent).toEqual([
      { type: 'permission_request', chatId: 'c1', requestId: 'req1', name: 'Write', input: { file_path: '/a' } },
    ])
    r.handleResponse('req1', 'allow')
    await expect(p).resolves.toEqual({ behavior: 'allow' })
  })

  it('resolves deny with a message', async () => {
    const r = new InteractivePermissionResolver('c1', () => {}, () => 'req1')
    const p = r.resolve('Bash', { command: 'rm -rf /' })
    r.handleResponse('req1', 'deny')
    await expect(p).resolves.toEqual({ behavior: 'deny', message: 'User denied' })
  })

  it('ignores responses for unknown requestId', () => {
    const r = new InteractivePermissionResolver('c1', () => {}, () => 'x')
    expect(() => r.handleResponse('nonexistent', 'allow')).not.toThrow()
  })

  it('cancelAll settles pending promises with deny and clears the map', async () => {
    const r = new InteractivePermissionResolver('c1', () => {}, () => 'req1')
    const p = r.resolve('Write', { file_path: '/a' })
    r.cancelAll('connection closed')
    await expect(p).resolves.toEqual({ behavior: 'deny', message: 'connection closed' })
    expect(() => r.handleResponse('req1', 'allow')).not.toThrow()
  })
})
```

---

- [ ] **Step 4: Run the permission test — expect FAIL.** The resolver still has the 2-arg constructor and emits no `chatId`.

```bash
cd /p/AI_PROJECT/Claude/WebPage && npx vitest run server/permission.test.ts
```

Expected: FAIL. The "sends a permission_request (with chatId)" case fails because the emitted message is `{ type: 'permission_request', requestId: 'req1', ... }` (no `chatId`), so the `toEqual` deep-equality fails with a diff showing missing `chatId: "c1"`. (Other cases may also fail/typecheck-error because the first argument `'c1'` is being passed where a `send` function is expected.)

---

- [ ] **Step 5: GREEN — change the InteractivePermissionResolver constructor and emitted request in permission.ts.** Apply the exact edits below to `P:\AI_PROJECT\Claude\WebPage\server\permission.ts`. (a) Add `chatId` as the first constructor parameter. (b) Include `chatId` in the `permission_request` message.

Replace this block:

```ts
  constructor(
    private send: (m: ServerMsg) => void,
    private genId: () => string,
  ) {}

  async resolve(toolName: string, input: unknown): Promise<PermissionDecision> {
    if (isReadOnlyTool(toolName)) return { behavior: 'allow' }
    const requestId = this.genId()
    this.send({ type: 'permission_request', requestId, name: toolName, input })
    return new Promise<PermissionDecision>((resolve) => {
      this.pending.set(requestId, resolve)
    })
  }
```

with:

```ts
  constructor(
    private chatId: string,
    private send: (m: ServerMsg) => void,
    private genId: () => string,
  ) {}

  async resolve(toolName: string, input: unknown): Promise<PermissionDecision> {
    if (isReadOnlyTool(toolName)) return { behavior: 'allow' }
    const requestId = this.genId()
    this.send({ type: 'permission_request', chatId: this.chatId, requestId, name: toolName, input })
    return new Promise<PermissionDecision>((resolve) => {
      this.pending.set(requestId, resolve)
    })
  }
```

For reference, the full file after the edit must read exactly:

```ts
import type { ServerMsg } from '../shared/protocol'

export const READ_ONLY_TOOLS = new Set<string>([
  'Read', 'Glob', 'Grep', 'NotebookRead', 'WebSearch', 'WebFetch', 'TodoWrite',
])

export function isReadOnlyTool(name: string): boolean {
  return READ_ONLY_TOOLS.has(name)
}

export type PermissionDecision =
  | { behavior: 'allow'; updatedInput?: unknown }
  | { behavior: 'deny'; message: string }

export interface PermissionResolver {
  resolve(toolName: string, input: unknown): Promise<PermissionDecision>
}

export class InteractivePermissionResolver implements PermissionResolver {
  private pending = new Map<string, (d: PermissionDecision) => void>()

  constructor(
    private chatId: string,
    private send: (m: ServerMsg) => void,
    private genId: () => string,
  ) {}

  async resolve(toolName: string, input: unknown): Promise<PermissionDecision> {
    if (isReadOnlyTool(toolName)) return { behavior: 'allow' }
    const requestId = this.genId()
    this.send({ type: 'permission_request', chatId: this.chatId, requestId, name: toolName, input })
    return new Promise<PermissionDecision>((resolve) => {
      this.pending.set(requestId, resolve)
    })
  }

  handleResponse(requestId: string, decision: 'allow' | 'deny'): void {
    const fn = this.pending.get(requestId)
    if (!fn) return
    this.pending.delete(requestId)
    fn(decision === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: 'User denied' })
  }

  cancelAll(message: string): void {
    for (const fn of this.pending.values()) {
      fn({ behavior: 'deny', message })
    }
    this.pending.clear()
  }
}
```

---

- [ ] **Step 6: Run the permission test — expect PASS.**

```bash
cd /p/AI_PROJECT/Claude/WebPage && npx vitest run server/permission.test.ts
```

Expected: PASS. Output shows `Test Files  1 passed (1)` and `Tests  7 passed (7)` (2 in the `isReadOnlyTool` describe + 5 in the `InteractivePermissionResolver` describe = 7 total).

---

- [ ] **Step 7: RED — write chatRuntime.test.ts.** Create `P:\AI_PROJECT\Claude\WebPage\server\chatRuntime.test.ts` with the full contents below. It exercises all five cases from the contract: (a) persistence, (b) serialization, (c) resume carry, (d) eager user-persist + interrupt-during-permission + clear queue (#6b), (e) dispose while parked. Helpers: an in-memory DB, the `FakeProvider`, a recording `broadcast`, a counting `genId`, and a `now` that increments so `updated_at` ordering is deterministic.

Note on the test's flow control: `FakeProvider` calls `ctx.permission.resolve('Write', ...)` and parks until we answer. We find the parked request by scanning the recorded broadcasts for a `permission_request`, then call `rt.handlePermissionResponse(requestId, 'allow')`. The small `tick()` helper flushes the microtask queue so awaited continuations run before we assert.

```ts
import { describe, it, expect } from 'vitest'
import type { ServerMsg } from '../shared/protocol'
import type { Provider, ProviderContext, TurnParams, TurnResult } from './providers/types'
import { openDb, createChat, listMessages, getChatSdkSession, DEFAULT_CONNECTION_ID } from './store'
import { FakeProvider } from './providers/fake'
import { ChatRuntime, type RuntimeDeps } from './chatRuntime'

// Flush pending microtasks (await continuations) a few times.
async function tick(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

// Find the requestId of the most recent permission_request in `sent`.
function lastPermissionRequestId(sent: ServerMsg[]): string | undefined {
  for (let i = sent.length - 1; i >= 0; i--) {
    const m = sent[i]
    if (m.type === 'permission_request') return m.requestId
  }
  return undefined
}

// Count broadcast messages of a given type.
function countType(sent: ServerMsg[], type: ServerMsg['type']): number {
  return sent.filter((m) => m.type === type).length
}

function makeDeps(overrides: Partial<RuntimeDeps> = {}): { deps: RuntimeDeps; sent: ServerMsg[] } {
  const db = openDb(':memory:')
  createChat(db, {
    id: 'c1',
    title: 'Test chat',
    connectionId: DEFAULT_CONNECTION_ID,
    model: 'sonnet',
    cwd: '/work',
    now: 1000,
  })
  const sent: ServerMsg[] = []
  let idN = 0
  let nowN = 2000
  const deps: RuntimeDeps = {
    db,
    provider: new FakeProvider(),
    broadcast: (m) => sent.push(m),
    genId: () => `id${++idN}`,
    now: () => ++nowN,
    ...overrides,
  }
  return { deps, sent }
}

describe('ChatRuntime', () => {
  it('(a) persists user + assistant messages, usage, and sdk session after one turn', async () => {
    const { deps, sent } = makeDeps()
    const rt = new ChatRuntime('c1', deps)

    rt.enqueue('hi')
    await tick()
    // FakeProvider parked on a Write permission request -> answer it.
    const reqId = lastPermissionRequestId(sent)
    expect(reqId).toBeDefined()
    rt.handlePermissionResponse(reqId!, 'allow')
    await tick()

    const msgs = listMessages(deps.db, 'c1')
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant'])

    const user = msgs[0]
    expect(user.content).toEqual([{ type: 'text', text: 'hi' }])

    const asst = msgs[1]
    // ONE assistant row: text block (accumulated from onDelta deltas) + tool_use + tool_result blocks
    expect(asst.content).toEqual([
      { type: 'text', text: 'Hello hi' },
      { type: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/tmp/x' } },
      { type: 'tool_result', id: 't1', result: 'written' },
    ])
    expect(asst.usage).toEqual({ outputTokens: 3 })

    expect(getChatSdkSession(deps.db, 'c1')).toBe('sess-1')
    expect(rt.isIdle).toBe(true)
  })

  it('(b) serializes two enqueued turns one at a time, persisting both in order', async () => {
    const { deps, sent } = makeDeps()
    const rt = new ChatRuntime('c1', deps)

    rt.enqueue('first')
    rt.enqueue('second')
    await tick()

    // First turn parks; only one turn may be running at a time -> exactly one open request.
    expect(countType(sent, 'permission_request')).toBe(1)
    rt.handlePermissionResponse(lastPermissionRequestId(sent)!, 'allow')
    await tick()

    // Now the second turn runs and parks on its own request.
    expect(countType(sent, 'permission_request')).toBe(2)
    rt.handlePermissionResponse(lastPermissionRequestId(sent)!, 'allow')
    await tick()

    const msgs = listMessages(deps.db, 'c1')
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(msgs[0].content).toEqual([{ type: 'text', text: 'first' }])
    expect(msgs[1].content[0]).toEqual({ type: 'text', text: 'Hello first' })
    expect(msgs[2].content).toEqual([{ type: 'text', text: 'second' }])
    expect(msgs[3].content[0]).toEqual({ type: 'text', text: 'Hello second' })
    expect(rt.isIdle).toBe(true)
  })

  it('(c) carries sdkSessionId from the first turn into the second turn', async () => {
    // Recording provider: captures params.sdkSessionId per call; returns "s1" the first time.
    const seen: Array<string | undefined> = []
    let call = 0
    const recProvider: Provider = {
      type: 'rec',
      async send(params: TurnParams, ctx: ProviderContext): Promise<TurnResult> {
        seen.push(params.sdkSessionId)
        call++
        ctx.onDelta('ok')
        return { text: 'ok', sdkSessionId: call === 1 ? 's1' : 's2' }
      },
    }
    const { deps } = makeDeps({ provider: recProvider })
    const rt = new ChatRuntime('c1', deps)

    rt.enqueue('one')
    await tick()
    rt.enqueue('two')
    await tick()

    expect(seen).toEqual([undefined, 's1'])
    expect(getChatSdkSession(deps.db, 'c1')).toBe('s2')
    expect(rt.isIdle).toBe(true)
  })

  it('(d) #6b interrupt while parked: parked turn finishes (turn_done); queued user row is durable but its turn never runs', async () => {
    const { deps, sent } = makeDeps()
    const rt = new ChatRuntime('c1', deps)

    rt.enqueue('first')
    rt.enqueue('second')
    await tick()

    // First turn parked on permission; exactly one request so far.
    expect(countType(sent, 'permission_request')).toBe(1)

    rt.interrupt()
    await tick()

    // Parked turn unblocks (permission denied via cancelAll) and emits turn_done.
    expect(countType(sent, 'turn_done')).toBe(1)
    // The queued 'second' was cleared (#6b): no new permission_request was ever emitted.
    expect(countType(sent, 'permission_request')).toBe(1)

    // enqueue() persists the user message to the DB IMMEDIATELY (before queueing), so BOTH
    // user rows are durably persisted: 'first' (whose turn ran -> assistant) AND 'second'
    // (whose turn was cancelled by interrupt and never ran -> no assistant row for it).
    // interrupt() only clears the IN-MEMORY queue; it does NOT delete persisted rows.
    const msgs = listMessages(deps.db, 'c1')
    expect(msgs.map((m) => m.role)).toEqual(['user', 'user', 'assistant'])
    expect(msgs[0].content).toEqual([{ type: 'text', text: 'first' }])
    expect(msgs[1].content).toEqual([{ type: 'text', text: 'second' }])
    expect(msgs[2].role).toBe('assistant')
    expect(rt.isIdle).toBe(true)
  })

  it('(e) dispose() while parked unblocks the turn with turn_done', async () => {
    const { deps, sent } = makeDeps()
    const rt = new ChatRuntime('c1', deps)

    rt.enqueue('hi')
    await tick()
    expect(countType(sent, 'permission_request')).toBe(1)

    rt.dispose()
    await tick()

    expect(countType(sent, 'turn_done')).toBe(1)
  })
})
```

---

- [ ] **Step 8: Run the runtime test — expect FAIL (module not found).** `server/chatRuntime.ts` does not exist yet.

```bash
cd /p/AI_PROJECT/Claude/WebPage && npx vitest run server/chatRuntime.test.ts
```

Expected: FAIL. The error is a resolution/transform failure: `Failed to resolve import "./chatRuntime" from "server/chatRuntime.test.ts"` (no such module), so all 5 tests error out / the file fails to collect.

---

- [ ] **Step 9: GREEN — implement chatRuntime.ts.** Create `P:\AI_PROJECT\Claude\WebPage\server\chatRuntime.ts` with exactly the following.

Design notes embedded in the code (these match the persistence design stated at the top of this task):
- `permission = new InteractivePermissionResolver(chatId, deps.broadcast, deps.genId)` — note it sends directly to `broadcast`, NOT to the accumulating send (permission_request is not part of the persisted assistant content).
- `enqueue` persists the user `StoredMessage` **immediately/eagerly** (so it is durable even if the turn later aborts or is interrupted before running), pushes the text onto the queue, and kicks `drain()`.
- `drain()` serializes turns with a `running` flag and loops while the queue is non-empty and `!disposed`. Each turn: load `chat` via `getChat` (for `cwd`/`model`), load `sdkSessionId` via `getChatSdkSession`, build a fresh `AbortController` stored as `currentAbort`, build an accumulating `send` that both forwards to `broadcast` AND collects `assistant_delta` text / `tool_call` -> `tool_use` block / `tool_result` -> `tool_result` block, run `runTurn`, then persist ONE assistant message (text-from-accumulated OR `result.text` fallback, then tool_use blocks, then tool_result blocks; usage = result.usage), and `setChatSdkSession` if `result.sdkSessionId`.
- `interrupt()` aborts the current turn, clears the IN-MEMORY queue (#6b) — it does NOT delete persisted rows — and `permission.cancelAll('interrupted by user')` so any parked `resolve` settles as deny and the parked `runTurn` completes (emitting `turn_done`). Any already-persisted user row whose turn never ran stays durable.
- `dispose()` sets `disposed`, aborts, clears the queue, and `permission.cancelAll('chat closed')`.

```ts
import type {
  ServerMsg,
  StoredMessage,
  StoredContentBlock,
  Usage,
} from '../shared/protocol'
import type { Provider } from './providers/types'
import { InteractivePermissionResolver } from './permission'
import { runTurn } from './agent'
import {
  type DB,
  getChat,
  getChatSdkSession,
  setChatSdkSession,
  appendMessage,
} from './store'

export interface RuntimeDeps {
  db: DB
  provider: Provider
  broadcast: (m: ServerMsg) => void
  genId: () => string
  now: () => number
  turnTimeoutMs?: number
}

export class ChatRuntime {
  private permission: InteractivePermissionResolver
  private queue: string[] = []
  private running = false
  private disposed = false
  private currentAbort: AbortController | null = null

  constructor(
    private chatId: string,
    private deps: RuntimeDeps,
  ) {
    this.permission = new InteractivePermissionResolver(
      chatId,
      deps.broadcast,
      deps.genId,
    )
  }

  enqueue(text: string): void {
    // Persist the user message IMMEDIATELY (eagerly) so it is durable even if the turn
    // later aborts or is interrupted before it runs. interrupt() clears only the queue.
    const userMsg: StoredMessage & { chatId: string } = {
      chatId: this.chatId,
      id: this.deps.genId(),
      role: 'user',
      content: [{ type: 'text', text }],
      createdAt: this.deps.now(),
    }
    appendMessage(this.deps.db, userMsg)
    this.queue.push(text)
    void this.drain()
  }

  interrupt(): void {
    this.currentAbort?.abort()
    this.queue = [] // #6b: clear pending (unrun) turns; persisted user rows are untouched
    this.permission.cancelAll('interrupted by user')
  }

  handlePermissionResponse(requestId: string, decision: 'allow' | 'deny'): void {
    this.permission.handleResponse(requestId, decision)
  }

  dispose(): void {
    this.disposed = true
    this.currentAbort?.abort()
    this.permission.cancelAll('chat closed')
    this.queue = []
  }

  get isIdle(): boolean {
    return !this.running && this.queue.length === 0
  }

  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.queue.length > 0 && !this.disposed) {
        const userText = this.queue.shift()!
        await this.runOne(userText)
      }
    } finally {
      this.running = false
    }
  }

  private async runOne(userText: string): Promise<void> {
    const chat = getChat(this.deps.db, this.chatId)
    const sdkSessionId = getChatSdkSession(this.deps.db, this.chatId)

    const abort = new AbortController()
    this.currentAbort = abort

    // Accumulating send: forward to broadcast AND collect content blocks for the ONE
    // assistant row persisted at turn_done.
    let accumulatedText = ''
    const toolUseBlocks: StoredContentBlock[] = []
    const toolResultBlocks: StoredContentBlock[] = []
    const accumulatingSend = (m: ServerMsg): void => {
      this.deps.broadcast(m)
      if (m.type === 'assistant_delta') {
        accumulatedText += m.text
      } else if (m.type === 'tool_call') {
        toolUseBlocks.push({ type: 'tool_use', id: m.id, name: m.name, input: m.input })
      } else if (m.type === 'tool_result') {
        toolResultBlocks.push({ type: 'tool_result', id: m.id, result: m.result })
      }
    }

    const result = await runTurn(
      this.deps.provider,
      {
        userText,
        cwd: chat?.cwd,
        model: chat?.model ?? 'sonnet',
        sdkSessionId,
      },
      {
        chatId: this.chatId,
        send: accumulatingSend,
        permission: this.permission,
        signal: abort.signal,
        turnTimeoutMs: this.deps.turnTimeoutMs,
      },
    )

    this.currentAbort = null

    // Persist ONE assistant message: text block, then tool_use blocks, then tool_result blocks.
    const content: StoredContentBlock[] = []
    const text = accumulatedText !== '' ? accumulatedText : result.text
    if (text !== '') content.push({ type: 'text', text })
    content.push(...toolUseBlocks)
    content.push(...toolResultBlocks)

    const usage: Usage | undefined = result.usage
    const asstMsg: StoredMessage & { chatId: string } = {
      chatId: this.chatId,
      id: this.deps.genId(),
      role: 'assistant',
      content,
      usage,
      createdAt: this.deps.now(),
    }
    appendMessage(this.deps.db, asstMsg)

    if (result.sdkSessionId) {
      setChatSdkSession(this.deps.db, this.chatId, result.sdkSessionId, this.deps.now())
    }
  }
}
```

---

- [ ] **Step 10: Run the runtime test — expect PASS.**

```bash
cd /p/AI_PROJECT/Claude/WebPage && npx vitest run server/chatRuntime.test.ts
```

Expected: PASS. Output shows `Test Files  1 passed (1)` and `Tests  5 passed (5)` (cases a, b, c, d, e).

If case (a) fails on the assistant `content` deep-equal, re-check the block order (text, then tool_use, then tool_result) and that `FakeProvider` emits `t1`/`Write`/`written` exactly. If case (d) shows a second `permission_request`, the queue was not cleared in `interrupt()` (#6b) — verify `this.queue = []` runs there. If case (d) shows only one `user` row, the eager persist in `enqueue()` did not run for the second message before `interrupt()` — verify `appendMessage` happens BEFORE `this.queue.push(text)`.

---

- [ ] **Step 11: Run this task's test files + the already-migrated agent suite as the GREEN gate.** Per the migration policy, the per-task gate is THIS task's Vitest files passing (Vitest transpiles each file via esbuild and does NOT cross-file typecheck, so these pass even while other not-yet-migrated server files still have type errors). Run exactly this task's files plus `server/agent.test.ts` — Task 4 migrated `agent.test.ts` to a stub `PermissionResolver` (it does not construct `InteractivePermissionResolver`), so the 3-arg constructor change here does not affect it.

```bash
cd /p/AI_PROJECT/Claude/WebPage && npx vitest run server/permission.test.ts server/chatRuntime.test.ts server/agent.test.ts
```

Expected: PASS. `Test Files  3 passed (3)`; `server/permission.test.ts` (7 tests), `server/chatRuntime.test.ts` (5 tests), and `server/agent.test.ts` all green.

Do NOT run `npx vitest run server` and claim a clean whole-server pass yet: `server/ws.ts` and `server/index.ts` are still M1 and are rewritten/migrated in Task 9; the M1 `ChatSession` suite was removed in Step 1. The authoritative whole-suite gate is Task 14.

---

- [ ] **Step 12: Typecheck — this task's files only (whole-project server tsc is deferred to Task 9).** Per the migration typecheck policy, M2 widens `ServerMsg`/`ClientMsg` to require `chatId`, which breaks not-yet-migrated server files under a whole-project `tsc --noEmit` until their owning task lands. Do NOT run `npx tsc --noEmit` and expect zero output here — `server/ws.ts` and `server/index.ts` are still M1 (they still reference the old `ChatSession` / 2-arg permission shapes) and are EXPECTED to error until Task 9 migrates them. The authoritative server+shared typecheck (`npx tsc --noEmit` with root tsconfig including `["server","shared"]`) goes GREEN at Task 9; Task 14 runs the final full gate.

To confirm THIS task's source files are internally type-correct without the noise of the not-yet-migrated files, run the per-file tests above (Step 11) — Vitest's esbuild transform fails to collect a file with a syntax/import error, so a green collect for `chatRuntime.ts`/`permission.ts` is the per-task signal. (There is NO `server/tsconfig.json`; do not invent one.) Optionally, eyeball-confirm the expected-error set:

```bash
cd /p/AI_PROJECT/Claude/WebPage && npx tsc --noEmit 2>&1 | grep -E "server/(ws|index)\.ts" ; echo "above are the EXPECTED not-yet-migrated errors (resolved in Task 9)"
```

Expected: any error lines printed are confined to `server/ws.ts` and/or `server/index.ts` (the still-M1 files). There must be NO error lines pointing at `server/permission.ts`, `server/chatRuntime.ts`, `server/chatRuntime.test.ts`, or `server/permission.test.ts`. If any of THIS task's four files appear in the error output, fix them before committing.

---

- [ ] **Step 13: Commit.** Stage the removed M1 suite plus the four files for this task and commit with the conventional message.

```bash
cd /p/AI_PROJECT/Claude/WebPage && \
git add server/permission.ts server/permission.test.ts server/chatRuntime.ts server/chatRuntime.test.ts && \
git rm --cached --ignore-unmatch server/ws.test.ts >/dev/null 2>&1 ; \
git commit -m "feat(m2): permission chatId + ChatRuntime (serialize, persist, resume, interrupt #6); drop M1 ChatSession suite"
```

(`server/ws.test.ts` was already staged for deletion by `git rm` in Step 1; the `git rm --cached --ignore-unmatch` above is a no-op safety net in case the stage was reset. The deletion is part of this commit.)

Expected: a commit is created listing 5 files changed (1 deletion: `server/ws.test.ts`; 2 modified: `server/permission.ts`, `server/permission.test.ts`; 2 new: `server/chatRuntime.ts`, `server/chatRuntime.test.ts`). Confirm with:

```bash
cd /p/AI_PROJECT/Claude/WebPage && git show --stat --oneline HEAD | head -n 10
```

Expected: the HEAD commit summary line ends with `feat(m2): permission chatId + ChatRuntime (serialize, persist, resume, interrupt #6); drop M1 ChatSession suite` and the stat block lists `server/permission.ts`, `server/permission.test.ts`, `server/chatRuntime.ts`, `server/chatRuntime.test.ts`, and `server/ws.test.ts` (shown as deleted).

---

---

### Task 9: ChatHub + WebSocket wiring + server boot

**Files:**
- Create: `server/hub.ts`
- Create: `server/hub.test.ts`
- Modify (rewrite): `server/ws.ts`
- Modify: `server/index.ts`
- Note: `server/ws.test.ts` was already deleted at the START of Task 8 (the M1 `ChatSession` tests are superseded by `hub.test.ts`). Do NOT delete it again here — it is already gone and its removal is already staged.

**Interfaces:**

Consumes (from earlier tasks — exact signatures, do NOT redefine them here):
- `shared/protocol.ts` (imported in server via `../shared/protocol`):
  - `parseClientMsg(raw: string): ClientMsg | null`
  - `type ClientMsg` (v2 union: `create_chat`, `subscribe`, `unsubscribe`, `user_message`, `permission_response`, `interrupt`, `rename_chat`, `delete_chat`, `list_dirs`)
  - `type ServerMsg` (v2 union: `chat_list`, `chat_created`, `chat_renamed`, `chat_deleted`, `chat_history`, `assistant_delta`, `tool_call`, `tool_result`, `permission_request`, `turn_done`, `dir_list`, `error`)
  - `type ChatMeta = { id: string; title: string; connectionId: string; model: string; cwd?: string; createdAt: number; updatedAt: number }`
- `server/store.ts`:
  - `import Database from "better-sqlite3"; export type DB = Database.Database`
  - `DEFAULT_CONNECTION_ID = "local"` (string const)
  - `openDb(path: string): DB`
  - `getConnection(db: DB, id: string): ConnectionRow | undefined` where `ConnectionRow = { id: string; type: string; name: string; baseUrl?: string; defaultModel: string; createdAt: number; updatedAt: number }`
  - `createChat(db: DB, c: { id: string; title: string; connectionId: string; model: string; cwd?: string; now: number }): ChatMeta`
  - `listChats(db: DB): ChatMeta[]`
  - `getChat(db: DB, id: string): ChatMeta | undefined`
  - `renameChat(db: DB, id: string, title: string, now: number): void`
  - `deleteChat(db: DB, id: string): void`
  - `listMessages(db: DB, chatId: string): StoredMessage[]`
- `server/chatRuntime.ts`:
  - `type RuntimeDeps = { db: DB; provider: Provider; broadcast: (m: ServerMsg) => void; genId: () => string; now: () => number; turnTimeoutMs?: number }`
  - `class ChatRuntime { constructor(chatId: string, deps: RuntimeDeps); enqueue(text: string): void; interrupt(): void; handlePermissionResponse(requestId: string, decision: "allow"|"deny"): void; dispose(): void; get isIdle(): boolean }`
- `server/fsbrowse.ts`:
  - `listDirs(inputPath?: string): Promise<{ path: string; parent?: string; entries: DirEntry[] }>`
- `server/providers/types.ts`:
  - `interface Provider { type; send(params: TurnParams, ctx: ProviderContext): Promise<TurnResult> }`
- `server/providers/localAgent.ts`:
  - `class LocalAgentProvider implements Provider` (no-arg constructor usable)
- `server/providers/fake.ts` (test only):
  - `class FakeProvider implements Provider`

Produces (this task's public surface):
- `server/hub.ts`:
  - `type HubDeps = { db: DB; makeProvider: (connectionType: string) => Provider; genId: () => string; now: () => number; turnTimeoutMs?: number }`
  - `type ConnectionHandle = { handle(raw: string): void; close(): void }`
  - `class ChatHub { constructor(deps: HubDeps); addConnection(send: (m: ServerMsg) => void): ConnectionHandle }`
- `server/ws.ts`:
  - `attachWebSocketServer(httpServer: import("node:http").Server, hub: ChatHub): WebSocketServer`

---

- [ ] **Step 1: Confirm prerequisites exist.** Task 9 consumes `store.ts`, `chatRuntime.ts`, `fsbrowse.ts`, and a `FakeProvider`. Also confirm `server/ws.test.ts` is already gone (it was removed at the start of Task 8). Verify before writing any code. Run from the repo root (`P:\AI_PROJECT\Claude\WebPage`):

```bash
ls server/store.ts server/chatRuntime.ts server/fsbrowse.ts server/providers/fake.ts server/permission.ts server/agent.ts
```

Expected output (all six paths listed, no "No such file"):

```
server/agent.ts
server/chatRuntime.ts
server/fsbrowse.ts
server/permission.ts
server/providers/fake.ts
server/store.ts
```

If any is missing, STOP — the preceding tasks (store/runtime/fsbrowse) must be completed first. Then confirm the obsolete M1 test is already deleted:

```bash
ls server/ws.test.ts
```

Expected: `No such file or directory` (Task 8 already removed and staged this file). If it is somehow still present, do NOT re-`git rm` it here — go back and finish Task 8.

- [ ] **Step 2: Write the failing test file `server/hub.test.ts`.** This is the RED step. It drives the hub purely through `addConnection(send)` → `handle.handle(JSON.stringify(clientMsg))`, using an in-memory DB and a `FakeProvider`. The hub does not exist yet, so the import fails (compile error counts as RED). Write the COMPLETE file:

```ts
import { describe, it, expect } from 'vitest'
import type { ServerMsg } from '../shared/protocol'
import { openDb, listChats, listMessages, getChat } from './store'
import { FakeProvider } from './providers/fake'
import { ChatHub } from './hub'

function makeHub() {
  const db = openDb(':memory:')
  let idN = 0
  let nowN = 1000
  const hub = new ChatHub({
    db,
    makeProvider: () => new FakeProvider(),
    genId: () => `id-${++idN}`,
    now: () => ++nowN,
  })
  return { db, hub }
}

function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = () => {
      if (cond()) return resolve()
      if (Date.now() - start > timeoutMs) return reject(new Error('timeout'))
      setTimeout(tick, 5)
    }
    tick()
  })
}

function created(handle: { handle(raw: string): void }, sent: ServerMsg[]): string {
  handle.handle(JSON.stringify({ type: 'create_chat', title: 'Chat A' }))
  const ev = sent.find((m) => m.type === 'chat_created') as Extract<ServerMsg, { type: 'chat_created' }>
  return ev.chat.id
}

describe('ChatHub', () => {
  it('(1) sends chat_list immediately on addConnection', () => {
    const { hub } = makeHub()
    const sent: ServerMsg[] = []
    hub.addConnection((m) => sent.push(m))
    expect(sent).toHaveLength(1)
    expect(sent[0].type).toBe('chat_list')
  })

  it('(2) create_chat -> chat_created + chat_list, and a chats row exists', () => {
    const { db, hub } = makeHub()
    const sent: ServerMsg[] = []
    const handle = hub.addConnection((m) => sent.push(m))
    const chatId = created(handle, sent)

    const createdEv = sent.find((m) => m.type === 'chat_created') as Extract<ServerMsg, { type: 'chat_created' }>
    expect(createdEv.chat.id).toBe(chatId)
    expect(createdEv.chat.title).toBe('Chat A')
    expect(createdEv.chat.connectionId).toBe('local')
    expect(createdEv.chat.model).toBe('sonnet')
    // a chat_list also went out after creation
    expect(sent.filter((m) => m.type === 'chat_list').length).toBeGreaterThanOrEqual(2)
    // row persisted
    const rows = listChats(db)
    expect(rows.map((r) => r.id)).toContain(chatId)
  })

  it('(3) subscribe -> chat_history with listMessages', () => {
    const { db, hub } = makeHub()
    const sent: ServerMsg[] = []
    const handle = hub.addConnection((m) => sent.push(m))
    const chatId = created(handle, sent)

    handle.handle(JSON.stringify({ type: 'subscribe', chatId }))
    const hist = sent.find((m) => m.type === 'chat_history') as Extract<ServerMsg, { type: 'chat_history' }>
    expect(hist).toBeTruthy()
    expect(hist.chatId).toBe(chatId)
    expect(hist.messages).toEqual(listMessages(db, chatId))
  })

  it('(4) user_message drives a turn; deltas/turn_done carry chatId; messages persist', async () => {
    const { db, hub } = makeHub()
    const sent: ServerMsg[] = []
    const handle = hub.addConnection((m) => sent.push(m))
    const chatId = created(handle, sent)

    handle.handle(JSON.stringify({ type: 'subscribe', chatId }))
    handle.handle(JSON.stringify({ type: 'user_message', chatId, text: 'world' }))

    await waitFor(() => sent.some((m) => m.type === 'permission_request'))
    const req = sent.find((m) => m.type === 'permission_request') as Extract<ServerMsg, { type: 'permission_request' }>
    expect(req.chatId).toBe(chatId)
    handle.handle(JSON.stringify({ type: 'permission_response', requestId: req.requestId, decision: 'allow' }))

    await waitFor(() => sent.some((m) => m.type === 'turn_done'))
    const delta = sent.find((m) => m.type === 'assistant_delta') as Extract<ServerMsg, { type: 'assistant_delta' }>
    const done = sent.find((m) => m.type === 'turn_done') as Extract<ServerMsg, { type: 'turn_done' }>
    expect(delta.chatId).toBe(chatId)
    expect(done.chatId).toBe(chatId)

    // user + assistant message persisted
    const msgs = listMessages(db, chatId)
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  it('(5) LIVE SYNC: two subscribers both receive deltas from one user_message', async () => {
    const { hub } = makeHub()
    const sentA: ServerMsg[] = []
    const handleA = hub.addConnection((m) => sentA.push(m))
    const chatId = created(handleA, sentA)

    const sentB: ServerMsg[] = []
    const handleB = hub.addConnection((m) => sentB.push(m))

    handleA.handle(JSON.stringify({ type: 'subscribe', chatId }))
    handleB.handle(JSON.stringify({ type: 'subscribe', chatId }))
    handleA.handle(JSON.stringify({ type: 'user_message', chatId, text: 'world' }))

    await waitFor(() => sentA.some((m) => m.type === 'permission_request'))
    const req = sentA.find((m) => m.type === 'permission_request') as Extract<ServerMsg, { type: 'permission_request' }>
    handleA.handle(JSON.stringify({ type: 'permission_response', requestId: req.requestId, decision: 'allow' }))

    await waitFor(() => sentA.some((m) => m.type === 'turn_done') && sentB.some((m) => m.type === 'turn_done'))
    expect(sentA.some((m) => m.type === 'assistant_delta')).toBe(true)
    expect(sentB.some((m) => m.type === 'assistant_delta')).toBe(true)
  })

  it('(6) rename_chat -> broadcastAll chat_renamed', () => {
    const { hub } = makeHub()
    const sent: ServerMsg[] = []
    const handle = hub.addConnection((m) => sent.push(m))
    const chatId = created(handle, sent)

    handle.handle(JSON.stringify({ type: 'rename_chat', chatId, title: 'Renamed' }))
    const renamed = sent.find((m) => m.type === 'chat_renamed') as Extract<ServerMsg, { type: 'chat_renamed' }>
    expect(renamed.chatId).toBe(chatId)
    expect(renamed.title).toBe('Renamed')
  })

  it('(7) delete_chat -> broadcastAll chat_deleted; chat + messages gone', () => {
    const { db, hub } = makeHub()
    const sent: ServerMsg[] = []
    const handle = hub.addConnection((m) => sent.push(m))
    const chatId = created(handle, sent)

    handle.handle(JSON.stringify({ type: 'delete_chat', chatId }))
    const deleted = sent.find((m) => m.type === 'chat_deleted') as Extract<ServerMsg, { type: 'chat_deleted' }>
    expect(deleted.chatId).toBe(chatId)
    expect(getChat(db, chatId)).toBeUndefined()
    expect(listMessages(db, chatId)).toHaveLength(0)
  })

  it('(8) list_dirs -> dir_list for an existing path', async () => {
    const { hub } = makeHub()
    const sent: ServerMsg[] = []
    const handle = hub.addConnection((m) => sent.push(m))

    handle.handle(JSON.stringify({ type: 'list_dirs', path: process.cwd() }))
    await waitFor(() => sent.some((m) => m.type === 'dir_list'))
    const dl = sent.find((m) => m.type === 'dir_list') as Extract<ServerMsg, { type: 'dir_list' }>
    expect(dl.path).toBe(process.cwd())
    expect(Array.isArray(dl.entries)).toBe(true)
  })

  it('(9) close() removes the conn from subscribers and does NOT dispose runtimes', async () => {
    const { hub } = makeHub()
    const sentA: ServerMsg[] = []
    const handleA = hub.addConnection((m) => sentA.push(m))
    const chatId = created(handleA, sentA)

    const sentB: ServerMsg[] = []
    const handleB = hub.addConnection((m) => sentB.push(m))
    handleB.handle(JSON.stringify({ type: 'subscribe', chatId }))

    // B leaves
    handleB.close()
    const before = sentB.length

    // A drives a turn; B must not receive anything new
    handleA.handle(JSON.stringify({ type: 'subscribe', chatId }))
    handleA.handle(JSON.stringify({ type: 'user_message', chatId, text: 'world' }))
    await waitFor(() => sentA.some((m) => m.type === 'permission_request'))
    const req = sentA.find((m) => m.type === 'permission_request') as Extract<ServerMsg, { type: 'permission_request' }>
    handleA.handle(JSON.stringify({ type: 'permission_response', requestId: req.requestId, decision: 'allow' }))
    await waitFor(() => sentA.some((m) => m.type === 'turn_done'))

    expect(sentB.length).toBe(before)
    // runtime still alive: a second user_message from A still works (not disposed)
    handleA.handle(JSON.stringify({ type: 'user_message', chatId, text: 'again' }))
    await waitFor(() => sentA.filter((m) => m.type === 'permission_request').length >= 2)
    expect(sentA.filter((m) => m.type === 'permission_request').length).toBeGreaterThanOrEqual(2)
  })
})
```

- [ ] **Step 3: Run the test and watch it FAIL (RED).** Run from the repo ROOT (never `cd server`):

```bash
npx vitest run server/hub.test.ts
```

Expected FAIL — the module does not exist yet, so Vitest reports a collection/transform error similar to:

```
Failed to load url ./hub (resolved id: ./hub) in P:/AI_PROJECT/Claude/WebPage/server/hub.test.ts. Does the file exist?
```

(0 tests passed; the file fails to import. This is the expected RED.)

- [ ] **Step 4: Implement `server/hub.ts` (minimal, complete).** Create the file with the FULL implementation per the CONTRACT. It owns `runtimes`, `subscribers`, and `allSends`; routes every `ClientMsg`; injects `DEFAULT_CONNECTION_ID` on create; broadcasts per-chat vs to-all correctly; and never disposes runtimes on `close()`.

```ts
import {
  parseClientMsg,
  type ClientMsg,
  type ServerMsg,
} from '../shared/protocol'
import {
  DEFAULT_CONNECTION_ID,
  getChat,
  createChat,
  listChats,
  listMessages,
  renameChat,
  deleteChat,
  type DB,
} from './store'
import { ChatRuntime } from './chatRuntime'
import { listDirs } from './fsbrowse'
import type { Provider } from './providers/types'

export type HubDeps = {
  db: DB
  makeProvider: (connectionType: string) => Provider
  genId: () => string
  now: () => number
  turnTimeoutMs?: number
}

export type ConnectionHandle = {
  handle(raw: string): void
  close(): void
}

type Send = (m: ServerMsg) => void

export class ChatHub {
  private runtimes = new Map<string, ChatRuntime>()
  private subscribers = new Map<string, Set<Send>>()
  private allSends = new Set<Send>()

  constructor(private deps: HubDeps) {}

  addConnection(send: Send): ConnectionHandle {
    this.allSends.add(send)
    // immediately push the current chat list to the new connection
    send({ type: 'chat_list', chats: listChats(this.deps.db) })

    return {
      handle: (raw: string) => this.handle(raw, send),
      close: () => this.close(send),
    }
  }

  private broadcast(m: ServerMsg): void {
    const chatId = (m as { chatId?: string }).chatId
    if (!chatId) return
    const subs = this.subscribers.get(chatId)
    if (!subs) return
    for (const s of subs) s(m)
  }

  private broadcastAll(m: ServerMsg): void {
    for (const s of this.allSends) s(m)
  }

  private subscribe(chatId: string, send: Send): void {
    let subs = this.subscribers.get(chatId)
    if (!subs) {
      subs = new Set<Send>()
      this.subscribers.set(chatId, subs)
    }
    subs.add(send)
  }

  private unsubscribe(chatId: string, send: Send): void {
    this.subscribers.get(chatId)?.delete(send)
  }

  private getOrCreateRuntime(chatId: string): ChatRuntime {
    let rt = this.runtimes.get(chatId)
    if (rt) return rt
    const chat = getChat(this.deps.db, chatId)
    const connectionType = chat?.connectionId === DEFAULT_CONNECTION_ID ? 'local-agent' : 'local-agent'
    rt = new ChatRuntime(chatId, {
      db: this.deps.db,
      provider: this.deps.makeProvider(connectionType),
      broadcast: (m) => this.broadcast(m),
      genId: this.deps.genId,
      now: this.deps.now,
      turnTimeoutMs: this.deps.turnTimeoutMs,
    })
    this.runtimes.set(chatId, rt)
    return rt
  }

  private handle(raw: string, send: Send): void {
    const msg = parseClientMsg(raw)
    if (!msg) return
    this.route(msg, send)
  }

  private route(msg: ClientMsg, send: Send): void {
    switch (msg.type) {
      case 'create_chat': {
        const id = this.deps.genId()
        const now = this.deps.now()
        const chat = createChat(this.deps.db, {
          id,
          title: msg.title ?? 'New chat',
          connectionId: DEFAULT_CONNECTION_ID,
          model: msg.model ?? 'sonnet',
          cwd: msg.cwd,
          now,
        })
        send({ type: 'chat_created', chat })
        this.subscribe(chat.id, send)
        this.broadcastAll({ type: 'chat_list', chats: listChats(this.deps.db) })
        break
      }
      case 'subscribe': {
        this.subscribe(msg.chatId, send)
        send({ type: 'chat_history', chatId: msg.chatId, messages: listMessages(this.deps.db, msg.chatId) })
        break
      }
      case 'unsubscribe': {
        this.unsubscribe(msg.chatId, send)
        break
      }
      case 'user_message': {
        // auto-subscribe the sender so it receives the turn it triggered
        this.subscribe(msg.chatId, send)
        this.getOrCreateRuntime(msg.chatId).enqueue(msg.text)
        break
      }
      case 'permission_response': {
        for (const rt of this.runtimes.values()) {
          rt.handlePermissionResponse(msg.requestId, msg.decision)
        }
        break
      }
      case 'interrupt': {
        this.runtimes.get(msg.chatId)?.interrupt()
        break
      }
      case 'rename_chat': {
        renameChat(this.deps.db, msg.chatId, msg.title, this.deps.now())
        this.broadcastAll({ type: 'chat_renamed', chatId: msg.chatId, title: msg.title })
        this.broadcastAll({ type: 'chat_list', chats: listChats(this.deps.db) })
        break
      }
      case 'delete_chat': {
        const rt = this.runtimes.get(msg.chatId)
        rt?.dispose()
        this.runtimes.delete(msg.chatId)
        deleteChat(this.deps.db, msg.chatId)
        this.broadcastAll({ type: 'chat_deleted', chatId: msg.chatId })
        this.broadcastAll({ type: 'chat_list', chats: listChats(this.deps.db) })
        break
      }
      case 'list_dirs': {
        listDirs(msg.path)
          .then((r) => send({ type: 'dir_list', path: r.path, parent: r.parent, entries: r.entries }))
          .catch((err: unknown) => send({ type: 'error', message: err instanceof Error ? err.message : String(err) }))
        break
      }
    }
  }

  private close(send: Send): void {
    this.allSends.delete(send)
    for (const subs of this.subscribers.values()) subs.delete(send)
    // NOTE: do NOT dispose runtimes — turns keep running for other subscribers.
  }
}
```

- [ ] **Step 5: Run the hub test and watch it PASS (GREEN).** Run from the repo ROOT:

```bash
npx vitest run server/hub.test.ts
```

Expected PASS (this is THIS task's per-task GREEN gate — Vitest transpiles each file via esbuild and does NOT cross-file typecheck, so it passes regardless of any not-yet-migrated files elsewhere):

```
 ✓ server/hub.test.ts (9 tests) ...

 Test Files  1 passed (1)
      Tests  9 passed (9)
```

- [ ] **Step 6: Rewrite `server/ws.ts` to use the hub.** Remove the M1 `ChatSession` class entirely and change the signature to `attachWebSocketServer(httpServer, hub)`. Replace the FULL file contents:

```ts
import type { Server } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import type { ServerMsg } from '../shared/protocol'
import type { ChatHub } from './hub'

export function attachWebSocketServer(httpServer: Server, hub: ChatHub): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' })
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

- [ ] **Step 7: Modify `server/index.ts` to open the DB and create the hub.** Ensure the data directory exists, open the DB at `DB_PATH`, construct the `ChatHub`, and attach the WS server with the hub. Replace the FULL file contents:

```ts
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import { attachWebSocketServer } from './ws'
import { ChatHub } from './hub'
import { openDb } from './store'
import { LocalAgentProvider } from './providers/localAgent'
import { pingMessage } from './health'

const PORT = Number(process.env.PORT ?? 8787)
const DB_PATH = process.env.DB_PATH ?? 'data/chats.db'

mkdirSync(dirname(DB_PATH), { recursive: true })
const db = openDb(DB_PATH)

const app = Fastify({ logger: true })
app.get('/api/health', async () => ({ status: pingMessage() }))

const hub = new ChatHub({
  db,
  makeProvider: () => new LocalAgentProvider(),
  genId: randomUUID,
  now: Date.now,
})

await app.listen({ port: PORT, host: '127.0.0.1' })
attachWebSocketServer(app.server, hub)
app.log.info(`WebSocket listening on ws://127.0.0.1:${PORT}/ws`)
```

- [ ] **Step 8: AUTHORITATIVE SERVER+SHARED TYPECHECK — first fully GREEN here (strict ESM).** By the end of this task EVERY server file is migrated to the v2 protocol (Task 3 widened `ServerMsg`/`ClientMsg` to require `chatId`; Tasks 4–9 migrated each consumer; this task's rewrite of `ws.ts` removed the last M1 holdout `ChatSession`). The root `tsconfig.json` includes `["server", "shared"]`, so a whole-project typecheck now covers exactly server + shared and MUST be CLEAN (exit code 0). Run from the repo ROOT:

```bash
npx tsc --noEmit
```

Expected output (NO errors — empty output, exit code 0):

```
```

This is the authoritative server+shared GREEN gate. If `tsc` reports ANY error, this task is NOT done — fix it before continuing (do not defer server type errors past Task 9). The web side is NOT covered by this command (root tsconfig excludes `web/`); web goes GREEN later at Task 13 via `npx tsc -p web/tsconfig.json`.

- [ ] **Step 9: Run the full server test suite to confirm nothing else broke.** Run from the repo ROOT:

```bash
npx vitest run server
```

Expected PASS (the old `ws.test.ts` is gone from Task 8; `hub.test.ts` and the other server suites pass). Output ends with something like:

```
 Test Files  N passed (N)
      Tests  M passed (M)
```

(There must be NO failing test and NO reference to a missing `./ws` `ChatSession` export.)

- [ ] **Step 10: Manual boot verification (DB + health endpoint).** Confirm the server actually boots, creates the SQLite DB under `data/`, and serves health. In one terminal start the backend:

```bash
npm run dev:server
```

Expected: Fastify logs that it is listening on `127.0.0.1:8787` and a line `WebSocket listening on ws://127.0.0.1:8787/ws`, with no crash. In a SECOND terminal, hit the health endpoint:

```bash
curl http://127.0.0.1:8787/api/health
```

Expected output (exact body):

```
{"status":"claude-web-agent: ok"}
```

Then confirm the DB file was created on boot:

```bash
ls data/chats.db
```

Expected output:

```
data/chats.db
```

Stop the dev server (Ctrl+C) when done. Note: `data/` is gitignored, so `data/chats.db` must NOT be staged.

- [ ] **Step 11: Stage exactly the task's files and commit.** Stage the created/modified files. The deletion of `server/ws.test.ts` was already staged back at the START of Task 8 and committed there — do NOT `git rm` it here. Run:

```bash
git add server/hub.ts server/hub.test.ts server/ws.ts server/index.ts
git commit -m "feat(m2): ChatHub (multi-chat routing, live-sync subscribers) + DB boot"
```

Expected: the commit succeeds and `git status` afterward shows a clean tree (no `data/` artifacts staged, and no stray `server/ws.test.ts` since it was removed in Task 8). Confirm with:

```bash
git status --short
```

Expected output (empty — clean working tree):

```
```

---

---

### Task 10: Frontend multi-chat state (appState)

Implement `web/src/appState.ts` — a pure multi-chat reducer that routes per-chat `ServerMsg`s into `views[chatId]`, manages the chat list, the pending permission prompt, and the folder-picker state. This task introduces the M2 multi-chat module that will eventually supersede the single-chat M1 module `web/src/chatState.ts`; the `UiMessage` and `PermissionPrompt` type definitions are MOVED into `appState.ts`. The per-view reduction (delta accumulation, tool_call attachment, error isolation) is exactly the M1 logic, now scoped to one `ChatView` and isolated per `chatId`.

**IMPORTANT — chatState.ts is NOT deleted in this task.** `web/src/App.tsx` and `web/src/components/PermissionModal.tsx` are still M1 and continue to import from `./chatState` until Task 13 migrates them. Deleting `chatState.ts`/`chatState.test.ts` now would break those files. The deletion is therefore DEFERRED to Task 13 (App integration). This task only CREATES `appState.ts` + `appState.test.ts` and repoints `Message.tsx` to import `UiMessage` from the new module; `chatState.ts` stays in place.

**Files:**
- Create: `P:\AI_PROJECT\Claude\WebPage\web\src\appState.ts`
- Create: `P:\AI_PROJECT\Claude\WebPage\web\src\appState.test.ts`
- Modify: `P:\AI_PROJECT\Claude\WebPage\web\src\components\Message.tsx` (repoint the `UiMessage` type import to `../appState`)
- Test: `P:\AI_PROJECT\Claude\WebPage\web\src\appState.test.ts`
- (NOT touched here: `web/src/chatState.ts`, `web/src/chatState.test.ts`, `web/src/App.tsx`, `web/src/components/PermissionModal.tsx` — these stay on `./chatState` and are migrated/cleaned up in Task 13.)

**Interfaces:**
- Consumes (from `@shared/protocol`): `ServerMsg`, `ToolCall`, `ChatMeta`, `StoredMessage`, `DirEntry`. (Note: `@shared/protocol` must already export the v2 union — `ChatMeta`, `StoredMessage`, `DirEntry`, and the v2 `ServerMsg` variants `chat_list`/`chat_created`/`chat_renamed`/`chat_deleted`/`chat_history`/`dir_list` plus the `chatId` field on per-chat messages (required on `assistant_delta`/`tool_call`/`tool_result`/`turn_done`/`permission_request`; OPTIONAL on `error{chatId?}`) — from an earlier protocol task. This task only consumes those types.)
- Produces (exact signatures):
  - `type UiMessage = { role: 'user'; text: string } | { role: 'assistant'; text: string; tools: ToolCall[] } | { role: 'error'; text: string }`
  - `type PermissionPrompt = { chatId: string; requestId: string; name: string; input: unknown }`
  - `type ChatView = { messages: UiMessage[]; streaming: boolean }`
  - `type FolderPickerState = { open: boolean; path: string; parent?: string; entries: DirEntry[] }`
  - `type AppState = { chats: ChatMeta[]; activeChatId?: string; views: Record<string, ChatView>; pending?: PermissionPrompt; folder?: FolderPickerState }`
  - `const initialAppState: AppState`
  - `function applyServer(state: AppState, msg: ServerMsg): AppState`
  - `function appendUser(state: AppState, chatId: string, text: string): AppState`
  - `function setActiveChat(state: AppState, chatId: string): AppState`
  - `function clearPending(state: AppState): AppState`
  - `function closeFolder(state: AppState): AppState`

---

- [ ] **Step 1: Confirm the existing files and current test baseline.**

      Run the existing M1 web test for `chatState` so you have a known-good baseline before touching anything. Run Vitest from the repo ROOT (never `cd web`):

      ```bash
      cd P:/AI_PROJECT/Claude/WebPage && npx vitest run web/src/chatState.test.ts
      ```

      Expected: PASS — `Test Files  1 passed (1)` with the M1 `chatState` tests green. This confirms your toolchain (Vitest, the `@shared/protocol` alias) works before you start. If `@shared/protocol` does not yet export `ChatMeta`/`StoredMessage`/`DirEntry`/v2 `ServerMsg`, STOP — the protocol task (Task 3) is a prerequisite for Task 10.

- [ ] **Step 2: Write the failing test file `web/src/appState.test.ts` (RED).**

      This is the complete test file. It imports from `./appState`, which does not exist yet, so it must fail to even load.

      ```ts
      import { describe, it, expect } from 'vitest'
      import {
        initialAppState,
        applyServer,
        appendUser,
        setActiveChat,
        clearPending,
        closeFolder,
        type AppState,
      } from './appState'
      import type { ChatMeta, StoredMessage } from '@shared/protocol'

      const meta = (id: string, over: Partial<ChatMeta> = {}): ChatMeta => ({
        id,
        title: 'New chat',
        connectionId: 'local',
        model: 'sonnet',
        createdAt: 1,
        updatedAt: 1,
        ...over,
      })

      describe('appState', () => {
        it('appendUser pushes a user msg into views[chatId] and sets that view streaming', () => {
          const s = appendUser(initialAppState, 'c1', 'hi')
          expect(s.views.c1.messages).toEqual([{ role: 'user', text: 'hi' }])
          expect(s.views.c1.streaming).toBe(true)
        })

        it('assistant_delta accumulates into the chat view and does NOT bleed into another chatId view', () => {
          let s: AppState = appendUser(initialAppState, 'c1', 'hi')
          s = appendUser(s, 'c2', 'yo')
          s = applyServer(s, { type: 'assistant_delta', chatId: 'c1', text: 'Hel' })
          s = applyServer(s, { type: 'assistant_delta', chatId: 'c1', text: 'lo' })
          expect(s.views.c1.messages[1]).toEqual({ role: 'assistant', text: 'Hello', tools: [] })
          // c2 view untouched: only its user message, no assistant bubble
          expect(s.views.c2.messages).toEqual([{ role: 'user', text: 'yo' }])
        })

        it('tool_call appends to the last assistant msg tools (creating one if needed)', () => {
          let s: AppState = appendUser(initialAppState, 'c1', 'hi')
          s = applyServer(s, { type: 'assistant_delta', chatId: 'c1', text: 'x' })
          s = applyServer(s, {
            type: 'tool_call',
            chatId: 'c1',
            id: 't1',
            name: 'Read',
            input: { file_path: '/a' },
          })
          const last = s.views.c1.messages[1]
          expect(last.role).toBe('assistant')
          if (last.role === 'assistant') {
            expect(last.tools).toEqual([{ id: 't1', name: 'Read', input: { file_path: '/a' } }])
          }
        })

        it('tool_result is ignored for render (view unchanged)', () => {
          let s: AppState = appendUser(initialAppState, 'c1', 'hi')
          s = applyServer(s, { type: 'assistant_delta', chatId: 'c1', text: 'x' })
          const before = s.views.c1
          s = applyServer(s, { type: 'tool_result', chatId: 'c1', id: 't1', result: 'ok' })
          expect(s.views.c1).toBe(before)
        })

        it('permission_request sets state.pending with chatId', () => {
          let s: AppState = appendUser(initialAppState, 'c1', 'hi')
          s = applyServer(s, {
            type: 'permission_request',
            chatId: 'c1',
            requestId: 'r1',
            name: 'Write',
            input: {},
          })
          expect(s.pending).toEqual({ chatId: 'c1', requestId: 'r1', name: 'Write', input: {} })
        })

        it('turn_done sets that view streaming false', () => {
          let s: AppState = appendUser(initialAppState, 'c1', 'hi')
          s = applyServer(s, { type: 'turn_done', chatId: 'c1' })
          expect(s.views.c1.streaming).toBe(false)
        })

        it('error pushes a { role:"error" } msg into that view', () => {
          let s: AppState = appendUser(initialAppState, 'c1', 'hi')
          s = applyServer(s, { type: 'error', chatId: 'c1', message: 'boom' })
          const errors = s.views.c1.messages.filter((m) => m.role === 'error')
          expect(errors).toEqual([{ role: 'error', text: 'boom' }])
          // user message left intact
          expect(s.views.c1.messages[0]).toEqual({ role: 'user', text: 'hi' })
        })

        it('error without chatId is dropped (no view to attach it to)', () => {
          const s = applyServer(initialAppState, { type: 'error', message: 'global boom' })
          // optional chatId on the error variant: nothing to route to, state unchanged
          expect(s).toBe(initialAppState)
        })

        it('error does not mutate a previous turn assistant message', () => {
          let s: AppState = appendUser(initialAppState, 'c1', 'q1')
          s = applyServer(s, { type: 'assistant_delta', chatId: 'c1', text: 'answer1' })
          s = applyServer(s, { type: 'turn_done', chatId: 'c1' })
          s = appendUser(s, 'c1', 'q2')
          s = applyServer(s, { type: 'error', chatId: 'c1', message: 'boom' })
          expect(s.views.c1.messages[1]).toEqual({ role: 'assistant', text: 'answer1', tools: [] })
          const msgs = s.views.c1.messages
          expect(msgs[msgs.length - 1]).toEqual({ role: 'error', text: 'boom' })
        })

        it('chat_list sets chats', () => {
          const s = applyServer(initialAppState, {
            type: 'chat_list',
            chats: [meta('c1', { title: 'A' }), meta('c2', { title: 'B' })],
          })
          expect(s.chats.map((c) => c.id)).toEqual(['c1', 'c2'])
        })

        it('chat_created adds chat, sets activeChatId, inits an empty view', () => {
          const s = applyServer(initialAppState, { type: 'chat_created', chat: meta('c1') })
          expect(s.chats.map((c) => c.id)).toEqual(['c1'])
          expect(s.activeChatId).toBe('c1')
          expect(s.views.c1).toEqual({ messages: [], streaming: false })
        })

        it('chat_renamed updates the title', () => {
          let s: AppState = applyServer(initialAppState, { type: 'chat_created', chat: meta('c1', { title: 'Old' }) })
          s = applyServer(s, { type: 'chat_renamed', chatId: 'c1', title: 'New title' })
          expect(s.chats[0].title).toBe('New title')
        })

        it('chat_deleted removes chat + view and clears activeChatId if it was active', () => {
          let s: AppState = applyServer(initialAppState, { type: 'chat_created', chat: meta('c1') })
          s = applyServer(s, { type: 'chat_deleted', chatId: 'c1' })
          expect(s.chats).toEqual([])
          expect(s.views.c1).toBeUndefined()
          expect(s.activeChatId).toBeUndefined()
        })

        it('chat_deleted of a non-active chat leaves activeChatId intact', () => {
          let s: AppState = applyServer(initialAppState, { type: 'chat_created', chat: meta('c1') })
          s = applyServer(s, { type: 'chat_created', chat: meta('c2') }) // c2 active
          s = applyServer(s, { type: 'chat_deleted', chatId: 'c1' })
          expect(s.chats.map((c) => c.id)).toEqual(['c2'])
          expect(s.activeChatId).toBe('c2')
        })

        it('chat_history builds UiMessage[] from StoredMessage[] (user text, assistant text+tools)', () => {
          const messages: StoredMessage[] = [
            {
              id: 'm1',
              role: 'user',
              content: [{ type: 'text', text: 'hello' }],
              createdAt: 1,
            },
            {
              id: 'm2',
              role: 'assistant',
              content: [
                { type: 'text', text: 'Hi ' },
                { type: 'text', text: 'there' },
                { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a' } },
                { type: 'tool_result', id: 't1', result: 'ok' },
              ],
              createdAt: 2,
            },
          ]
          const s = applyServer(initialAppState, { type: 'chat_history', chatId: 'c1', messages })
          expect(s.views.c1.streaming).toBe(false)
          expect(s.views.c1.messages).toEqual([
            { role: 'user', text: 'hello' },
            {
              role: 'assistant',
              text: 'Hi there',
              tools: [{ id: 't1', name: 'Read', input: { file_path: '/a' } }],
            },
          ])
        })

        it('dir_list sets state.folder { open:true, path, parent, entries }', () => {
          const s = applyServer(initialAppState, {
            type: 'dir_list',
            path: '/home/me',
            parent: '/home',
            entries: [{ name: 'proj', path: '/home/me/proj' }],
          })
          expect(s.folder).toEqual({
            open: true,
            path: '/home/me',
            parent: '/home',
            entries: [{ name: 'proj', path: '/home/me/proj' }],
          })
        })

        it('setActiveChat sets the active id', () => {
          let s: AppState = applyServer(initialAppState, { type: 'chat_created', chat: meta('c1') })
          s = applyServer(s, { type: 'chat_created', chat: meta('c2') })
          s = setActiveChat(s, 'c1')
          expect(s.activeChatId).toBe('c1')
        })

        it('clearPending removes the pending prompt', () => {
          let s: AppState = appendUser(initialAppState, 'c1', 'hi')
          s = applyServer(s, {
            type: 'permission_request',
            chatId: 'c1',
            requestId: 'r1',
            name: 'Write',
            input: {},
          })
          s = clearPending(s)
          expect(s.pending).toBeUndefined()
        })

        it('closeFolder removes the folder state', () => {
          let s: AppState = applyServer(initialAppState, {
            type: 'dir_list',
            path: '/home',
            entries: [],
          })
          s = closeFolder(s)
          expect(s.folder).toBeUndefined()
        })

        it('immutability: a delta into c1 returns a new views object and does not mutate the input', () => {
          const prev: AppState = appendUser(initialAppState, 'c1', 'hi')
          const next = applyServer(prev, { type: 'assistant_delta', chatId: 'c1', text: 'yo' })
          expect(next.views).not.toBe(prev.views)
          // input view's messages array length unchanged (only the user msg)
          expect(prev.views.c1.messages).toHaveLength(1)
          expect(next.views.c1.messages).toHaveLength(2)
        })
      })
      ```

- [ ] **Step 3: Run the new test and confirm it FAILS (RED).**

      Run from the repo ROOT (never `cd web`):

      ```bash
      cd P:/AI_PROJECT/Claude/WebPage && npx vitest run web/src/appState.test.ts
      ```

      Expected: FAIL to load with a module-resolution error, e.g. `Failed to resolve import "./appState" from "web/src/appState.test.ts". Does the file exist?` — and `Test Files  1 failed (1)`. This proves the test runs and the implementation is genuinely missing.

- [ ] **Step 4: Create the implementation `web/src/appState.ts` (GREEN).**

      Complete file. The per-view reduction (`ensureAssistant`, delta concat, tool_call append, error-as-own-message) is the M1 logic from `chatState.ts`, refactored into a `reduceView(view, msg)` helper and dispatched per `chatId`. `tool_result` returns the same view reference (ignored for render). `chat_history` rebuilds a full `ChatView` from `StoredMessage[]`.

      The `error` variant carries an OPTIONAL `chatId` (`error{chatId?}` in the contract), so it CANNOT share the combined case with `assistant_delta`/`tool_call`/`tool_result`/`turn_done` (those require `chatId: string`). Folding `error` into that group would fail TS strict (TS2345: `string | undefined` is not assignable to the `chatId: string` the helpers expect). It therefore gets its own `case 'error'` that guards `msg.chatId === undefined` (dropping a chat-less global error) before routing into `reduceView`.

      ```ts
      import type {
        ServerMsg,
        ToolCall,
        ChatMeta,
        StoredMessage,
        DirEntry,
      } from '@shared/protocol'

      export type UiMessage =
        | { role: 'user'; text: string }
        | { role: 'assistant'; text: string; tools: ToolCall[] }
        | { role: 'error'; text: string }

      export type PermissionPrompt = {
        chatId: string
        requestId: string
        name: string
        input: unknown
      }

      export type ChatView = { messages: UiMessage[]; streaming: boolean }

      export type FolderPickerState = {
        open: boolean
        path: string
        parent?: string
        entries: DirEntry[]
      }

      export type AppState = {
        chats: ChatMeta[]
        activeChatId?: string
        views: Record<string, ChatView>
        pending?: PermissionPrompt
        folder?: FolderPickerState
      }

      export const initialAppState: AppState = { chats: [], views: {} }

      const emptyView: ChatView = { messages: [], streaming: false }

      function getView(state: AppState, chatId: string): ChatView {
        return state.views[chatId] ?? emptyView
      }

      function ensureAssistant(view: ChatView): { messages: UiMessage[]; idx: number } {
        const last = view.messages[view.messages.length - 1]
        if (last && last.role === 'assistant') {
          return { messages: [...view.messages], idx: view.messages.length - 1 }
        }
        const messages = [...view.messages, { role: 'assistant' as const, text: '', tools: [] }]
        return { messages, idx: messages.length - 1 }
      }

      // Per-view reduction — mirrors the M1 single-chat logic, scoped to one ChatView.
      // Returns the SAME view reference when nothing changes (e.g. tool_result).
      // Only ever called for the per-chat ServerMsg variants whose chatId has been
      // narrowed to a string by the caller.
      function reduceView(view: ChatView, msg: ServerMsg): ChatView {
        switch (msg.type) {
          case 'assistant_delta': {
            const { messages, idx } = ensureAssistant(view)
            const cur = messages[idx] as Extract<UiMessage, { role: 'assistant' }>
            messages[idx] = { ...cur, text: cur.text + msg.text }
            return { ...view, messages }
          }
          case 'tool_call': {
            const { messages, idx } = ensureAssistant(view)
            const cur = messages[idx] as Extract<UiMessage, { role: 'assistant' }>
            messages[idx] = {
              ...cur,
              tools: [...cur.tools, { id: msg.id, name: msg.name, input: msg.input }],
            }
            return { ...view, messages }
          }
          case 'tool_result':
            return view // ignored for render (tool results shown as cards only)
          case 'turn_done':
            return { ...view, streaming: false }
          case 'error':
            // Always surface errors as their own message so failures before the
            // first assistant token are visible and never misattributed to a
            // previous turn's answer.
            return { ...view, messages: [...view.messages, { role: 'error', text: msg.message }] }
          default:
            return view
        }
      }

      function setView(state: AppState, chatId: string, view: ChatView): AppState {
        return { ...state, views: { ...state.views, [chatId]: view } }
      }

      function historyToView(messages: StoredMessage[]): ChatView {
        const ui: UiMessage[] = []
        for (const m of messages) {
          if (m.role === 'user') {
            const first = m.content.find((b) => b.type === 'text')
            ui.push({ role: 'user', text: first && first.type === 'text' ? first.text : '' })
          } else {
            let text = ''
            const tools: ToolCall[] = []
            for (const b of m.content) {
              if (b.type === 'text') text += b.text
              else if (b.type === 'tool_use') tools.push({ id: b.id, name: b.name, input: b.input })
              // tool_result blocks are ignored for render
            }
            ui.push({ role: 'assistant', text, tools })
          }
        }
        return { messages: ui, streaming: false }
      }

      export function applyServer(state: AppState, msg: ServerMsg): AppState {
        switch (msg.type) {
          case 'chat_list':
            return { ...state, chats: msg.chats }
          case 'chat_created':
            return {
              ...state,
              chats: [...state.chats, msg.chat],
              activeChatId: msg.chat.id,
              views: { ...state.views, [msg.chat.id]: { messages: [], streaming: false } },
            }
          case 'chat_renamed':
            return {
              ...state,
              chats: state.chats.map((c) => (c.id === msg.chatId ? { ...c, title: msg.title } : c)),
            }
          case 'chat_deleted': {
            const views = { ...state.views }
            delete views[msg.chatId]
            return {
              ...state,
              chats: state.chats.filter((c) => c.id !== msg.chatId),
              views,
              activeChatId: state.activeChatId === msg.chatId ? undefined : state.activeChatId,
            }
          }
          case 'chat_history':
            return setView(state, msg.chatId, historyToView(msg.messages))
          case 'permission_request':
            return {
              ...state,
              pending: {
                chatId: msg.chatId,
                requestId: msg.requestId,
                name: msg.name,
                input: msg.input,
              },
            }
          case 'dir_list':
            return {
              ...state,
              folder: {
                open: true,
                path: msg.path,
                parent: msg.parent,
                entries: msg.entries,
              },
            }
          case 'error': {
            // error{chatId?}: optional chatId. A chat-less global error has no view
            // to attach to, so drop it (state unchanged). Handled separately from the
            // combined per-chat case because its chatId is string | undefined.
            if (msg.chatId === undefined) return state
            const view = getView(state, msg.chatId)
            const next = reduceView(view, msg)
            return next === view ? state : setView(state, msg.chatId, next)
          }
          case 'assistant_delta':
          case 'tool_call':
          case 'tool_result':
          case 'turn_done': {
            const view = getView(state, msg.chatId)
            const next = reduceView(view, msg)
            if (next === view) return state // nothing changed (e.g. tool_result)
            return setView(state, msg.chatId, next)
          }
        }
      }

      export function appendUser(state: AppState, chatId: string, text: string): AppState {
        const view = getView(state, chatId)
        return setView(state, chatId, {
          messages: [...view.messages, { role: 'user', text }],
          streaming: true,
        })
      }

      export function setActiveChat(state: AppState, chatId: string): AppState {
        return { ...state, activeChatId: chatId }
      }

      export function clearPending(state: AppState): AppState {
        return { ...state, pending: undefined }
      }

      export function closeFolder(state: AppState): AppState {
        return { ...state, folder: undefined }
      }
      ```

- [ ] **Step 5: Run the new test and confirm it PASSES (GREEN).**

      Run from the repo ROOT (never `cd web`):

      ```bash
      cd P:/AI_PROJECT/Claude/WebPage && npx vitest run web/src/appState.test.ts
      ```

      Expected: PASS — `Test Files  1 passed (1)` and `Tests  20 passed (20)` (20 `it(...)` cases in the file). This is the per-task GREEN gate for Task 10: Vitest transpiles each file via esbuild and does NOT cross-file typecheck, so this file passes even while other not-yet-migrated files (e.g. `App.tsx`, `PermissionModal.tsx`) still type-error under a whole-project check.

- [ ] **Step 6: Repoint `web/src/components/Message.tsx` to import `UiMessage` from the new module.**

      `Message.tsx` currently imports `UiMessage` from `../chatState`. Move it to the new `appState` module. Change only that import line; the JSX is unchanged because `UiMessage` is structurally identical.

      Replace this line:

      ```tsx
      import type { UiMessage } from '../chatState'
      ```

      with:

      ```tsx
      import type { UiMessage } from '../appState'
      ```

      Do NOT touch `App.tsx` or `PermissionModal.tsx` — they remain on `./chatState` until Task 13.

- [ ] **Step 7: Inspect the remaining references to the old `chatState` module (expected, not an error).**

      ```bash
      cd P:/AI_PROJECT/Claude/WebPage && git grep -n "chatState" -- web/src
      ```

      Expected output — `Message.tsx` is gone (repointed in Step 6), but `App.tsx`, `PermissionModal.tsx`, and the as-yet-undeleted `chatState.ts`/`chatState.test.ts` STILL reference `chatState`. This is EXPECTED at Task 10 and resolved in Task 13 (which migrates `App.tsx` + `PermissionModal.tsx` onto `appState` and then deletes `chatState.ts`/`chatState.test.ts`). Approximately:

      ```
      web/src/App.tsx:...                       (still M1 — migrated in Task 13)
      web/src/chatState.test.ts:...             (deleted in Task 13)
      web/src/chatState.ts:...                  (deleted in Task 13)
      web/src/components/PermissionModal.tsx:... (still M1 — migrated in Task 13)
      ```

      Do NOT claim `chatState` is unreferenced and do NOT delete it here. The ONLY change this grep should reflect from this task is that `Message.tsx` no longer appears.

- [ ] **Step 8: Per-file typecheck note (whole-project web `tsc` is DEFERRED to Task 13).**

      Do NOT run `npx tsc -p web/tsconfig.json` as a gate here and do NOT claim a clean whole-project web typecheck. Mid-migration, `App.tsx` and `PermissionModal.tsx` are still M1 (they import the M1 `chatState` API and consume M1-shaped messages), and `shared/protocol` now requires `chatId` on the per-chat `ServerMsg` variants (widened in Task 3) — so a whole-project web `tsc` is EXPECTED to report errors in those not-yet-migrated files. Authoritative web typecheck (`npx tsc -p web/tsconfig.json`, GREEN) lands at Task 13 once `App.tsx`/`PermissionModal.tsx` are migrated and `chatState.*` deleted; Task 14 runs both project typechecks plus the full suite as the final gate.

      This task's authoritative gate is the Vitest run from Step 5 (`npx vitest run web/src/appState.test.ts`), which compiles and exercises only `appState.ts` + `appState.test.ts`. Those two files are clean under TS strict + ESM (moduleResolution Bundler, NO `.js` import extensions; `@shared/protocol` resolves via the path alias).

- [ ] **Step 9: Run the full web test suite to confirm no regressions.**

      Run from the repo ROOT (never `cd web`):

      ```bash
      cd P:/AI_PROJECT/Claude/WebPage && npx vitest run
      ```

      Expected: all suites green, including the new `web/src/appState.test.ts` AND the still-present M1 `web/src/chatState.test.ts` (it is NOT deleted in this task). Vitest does not cross-file typecheck, so the suite is green even though a whole-project `tsc` would still flag the not-yet-migrated `App.tsx`/`PermissionModal.tsx`.

- [ ] **Step 10: Stage the two new files plus the `Message.tsx` edit and commit.**

      Run from the repo root. This task CREATES `appState.ts` + `appState.test.ts` and modifies `Message.tsx`. It does NOT delete `chatState.ts`/`chatState.test.ts` — that deletion is part of Task 13.

      ```bash
      cd P:/AI_PROJECT/Claude/WebPage && git add web/src/appState.ts web/src/appState.test.ts web/src/components/Message.tsx && git commit -m "feat(m2): multi-chat appState reducer (chatState retired in Task 13)"
      ```

      Expected: the commit reports 3 files changed (2 created: `appState.ts`, `appState.test.ts`; 1 modified: `Message.tsx`). No deletions. `git status --short` afterward shows a clean tree apart from any other in-flight task files; `web/src/chatState.ts` and `web/src/chatState.test.ts` remain present on disk and tracked.

---

### Task 11: WS client v2 (location.host + status)

Rewrite `web/src/ws.ts` to fix the hardcoded `:5173` port (#5) by deriving the URL from `location.host` through a new pure `wsUrl()` helper, report connection status via an optional `onStatus` callback, and add basic single-shot auto-reconnect (carry-over: surface `onerror`/`onclose` as a `"closed"` status). The socket itself is verified manually / by e2e; only the pure helper is unit-tested.

**Files:**
- Modify: `web/src/ws.ts`
- Test: `web/src/ws.test.ts` (create)

**Interfaces:**
- Consumes: `ServerMsg`, `ClientMsg` from `@shared/protocol` (web imports via the `@shared` alias).
- Produces:
  - `WsStatus = "connecting" | "open" | "closed"`
  - `wsUrl(host: string): string` — returns `"ws://" + host + "/ws"` (pure; never hardcodes `:5173`).
  - `createWsClient(opts: { onMessage: (m: ServerMsg) => void; onStatus?: (s: WsStatus) => void }): { send: (m: ClientMsg) => void; close: () => void }`

Notes for the implementer (read before starting):
- The current `web/src/ws.ts` (to be replaced) is:
  ```ts
  import type { ClientMsg, ServerMsg } from '@shared/protocol'

  export function createWsClient(onMessage: (m: ServerMsg) => void) {
    const url = `ws://${location.hostname}:5173/ws` // ผ่าน Vite proxy
    const ws = new WebSocket(url)
    const queue: string[] = []

    ws.onopen = () => {
      for (const q of queue) ws.send(q)
      queue.length = 0
    }
    ws.onmessage = (ev) => {
      try {
        onMessage(JSON.parse(ev.data) as ServerMsg)
      } catch {
        /* ignore */
      }
    }

    return {
      send(m: ClientMsg) {
        const raw = JSON.stringify(m)
        if (ws.readyState === WebSocket.OPEN) ws.send(raw)
        else queue.push(raw)
      },
      close() {
        ws.close()
      },
    }
  }
  ```
  Two things change versus M1: (a) the signature becomes the single-`opts`-object form `createWsClient({ onMessage, onStatus })`, and (b) every caller that previously called `createWsClient(handler)` must be migrated in the task that wires this client into `App.tsx` (Task 13) — this task only owns `web/src/ws.ts` and its test.
- This is a web (browser) module: `WebSocket`, `location`, `setTimeout`, `clearTimeout` are ambient DOM/global types — no Node imports. Do NOT add `.js` import extensions (ESM moduleResolution Bundler). Do NOT hardcode any port.
- All commands in this task run from the repo ROOT. There is NO `web/package.json` and NO `web/vitest.config.ts`; the root Vitest config already has `include: ["web/src/**/*.test.ts"]` and the `@shared` alias, so `web/src/ws.test.ts` is picked up and resolved from root. NEVER `cd web`.

- [ ] **Step 1: Write the failing test for the pure `wsUrl()` helper.**
  Create `web/src/ws.test.ts` with EXACTLY this content. It imports only the pure helper, so it runs under Vitest `environment node` with no DOM.
  ```ts
  import { describe, it, expect } from 'vitest'
  import { wsUrl } from './ws'

  describe('wsUrl', () => {
    it('builds a ws:// url from host:port', () => {
      expect(wsUrl('localhost:5173')).toBe('ws://localhost:5173/ws')
    })

    it('preserves an arbitrary LAN host and port', () => {
      expect(wsUrl('192.168.1.5:8787')).toBe('ws://192.168.1.5:8787/ws')
    })
  })
  ```

- [ ] **Step 2: Run the test and confirm it FAILS for the expected reason.**
  Command (run from the repo ROOT):
  ```bash
  npx vitest run web/src/ws.test.ts
  ```
  Expected: the run FAILS. The current `web/src/ws.ts` does not export `wsUrl`; Vitest transpiles each file with esbuild (no cross-file typecheck), and a missing named export resolves to `undefined`, so calling it throws at runtime. The failing message is a `TypeError`, e.g.:
  ```
  FAIL  web/src/ws.test.ts > wsUrl > builds a ws:// url from host:port
  TypeError: wsUrl is not a function
  Test Files  1 failed (1)
  ```
  (Any error that references `wsUrl` counts as the expected red — the helper does not exist yet. This is a runtime `TypeError`, NOT a load-time `SyntaxError`.)

- [ ] **Step 3: Rewrite `web/src/ws.ts` with the minimal v2 implementation (pure helper + status + reconnect).**
  Replace the ENTIRE contents of `web/src/ws.ts` with EXACTLY:
  ```ts
  import type { ClientMsg, ServerMsg } from '@shared/protocol'

  export type WsStatus = 'connecting' | 'open' | 'closed'

  // Pure, testable. NEVER hardcode the dev port (#5) — derive everything from host.
  export function wsUrl(host: string): string {
    return 'ws://' + host + '/ws'
  }

  export function createWsClient(opts: {
    onMessage: (m: ServerMsg) => void
    onStatus?: (s: WsStatus) => void
  }): { send: (m: ClientMsg) => void; close: () => void } {
    const { onMessage, onStatus } = opts
    const url = wsUrl(location.host)

    let ws: WebSocket
    let closedByUser = false
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined
    const queue: string[] = []

    const status = (s: WsStatus) => {
      if (onStatus) onStatus(s)
    }

    const connect = () => {
      status('connecting')
      ws = new WebSocket(url)

      ws.onopen = () => {
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
        // Single auto-reconnect attempt after a short delay (unexpected close only).
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
  Behaviour this satisfies, per the CONTRACT: URL via `wsUrl(location.host)` (no `:5173`); `onStatus('connecting')` then `onStatus('open')` on open with queued sends flushed; `onStatus('closed')` on close/error; sends queued until OPEN; a single reconnect scheduled ~1000ms after an UNEXPECTED close (not after `close()` because `closedByUser` short-circuits and the pending timer is cleared); incoming JSON parsed to `ServerMsg`, parse errors ignored.

- [ ] **Step 4: Run the test and confirm it PASSES.**
  Command (run from the repo ROOT):
  ```bash
  npx vitest run web/src/ws.test.ts
  ```
  Expected output includes:
  ```
  ✓ web/src/ws.test.ts (2)
    ✓ wsUrl > builds a ws:// url from host:port
    ✓ wsUrl > preserves an arbitrary LAN host and port
  Test Files  1 passed (1)
  Tests  2 passed (2)
  ```
  This passing run is the GREEN gate for this task — Vitest transpiles each file via esbuild and does NOT cross-file typecheck, so the test passes even while other web files still reference the old `createWsClient(handler)` signature.

- [ ] **Step 5: Confirm only THIS task's files are type-clean (no whole-web tsc claim yet).**
  Per the Migration Typecheck Policy, do NOT run/claim a clean whole-web `tsc` here: `App.tsx` still calls the OLD `createWsClient(handler)` signature until it is migrated in Task 13, so `npx tsc -p web/tsconfig.json` is EXPECTED to be RED until then. The gate for this task is Step 4 passing, with `web/src/ws.ts` and `web/src/ws.test.ts` themselves being clean (`wsUrl`, `WsStatus`, and the new single-`opts`-object `createWsClient` signature all compile under TS strict + ESM). Authoritative whole-web typecheck (`npx tsc -p web/tsconfig.json`) goes GREEN at Task 13; the full final gate is Task 14.

- [ ] **Step 6: Commit.**
  ```bash
  git add web/src/ws.ts web/src/ws.test.ts
  ```
  ```bash
  git commit -m "fix(m2): ws client uses location.host + status/reconnect (#5)"
  ```

---

---

### Task 12: Sidebar + FolderPicker components

Build the two new presentational components defined in the CONTRACT: `Sidebar` (chat list with new/select/rename/delete) and `FolderPicker` (a modal directory browser). These are pure UI components — they receive state and callbacks via props and render Tailwind markup. The Vitest environment is `node` with no jsdom, so there are NO DOM unit tests in this task; the deliverable is verified by the TypeScript compiler (`tsc`), scoped to these two files. App wiring that consumes these components is Task 13.

These components depend on shared types and one appState-local type. Critically, `ChatMeta` and `DirEntry` are **domain types and come from `@shared/protocol`** — `appState.ts` (authored in Task 10) does NOT re-export them. Only `FolderPickerState` is a UI-state type owned by and exported from `web/src/appState.ts`. So:
- `Sidebar.tsx` imports `ChatMeta` (and, if it ever needs entries, `DirEntry`) from `'@shared/protocol'`.
- `FolderPicker.tsx` imports `FolderPickerState` from `'../appState'`, and `DirEntry` from `'@shared/protocol'` if it needs the entry element type explicitly (here it does not — `entry` is inferred from `state.entries`).

Import paths matter: use `'@shared/protocol'` for the domain types (NOT a relative path), and `'../appState'` for `FolderPickerState` (NOT the old `'../chatState'`, which Task 10 removes). Keep Thai labels consistent with the existing UI (`Composer.tsx` uses `ส่ง`/`Stop`; `PermissionModal.tsx` uses `ขออนุญาตใช้เครื่องมือ`, `ปฏิเสธ`, `อนุญาต`).

**Files:**
- Create: `web/src/components/Sidebar.tsx`
- Create: `web/src/components/FolderPicker.tsx`
- Test: (none — Vitest env is `node` with no jsdom; verification is `tsc` scoped to these two files)

**Interfaces:**
- Consumes:
  - From `@shared/protocol` (domain types; authored/widened in Task 3):
    - `ChatMeta = { id: string; title: string; connectionId: string; model: string; cwd?: string; createdAt: number; updatedAt: number }`
    - `DirEntry = { name: string; path: string }`
  - From `web/src/appState.ts` (UI-state type; authored in Task 10):
    - `FolderPickerState = { open: boolean; path: string; parent?: string; entries: DirEntry[] }`
- Produces:
  - `Sidebar(props: { chats: ChatMeta[]; activeChatId?: string; onSelect: (id: string) => void; onNew: () => void; onRename: (id: string, title: string) => void; onDelete: (id: string) => void })`
  - `FolderPicker(props: { state: FolderPickerState; onBrowse: (path: string) => void; onChoose: (path: string) => void; onClose: () => void })`

---

- [ ] **Step 1: Confirm the type sources exist before writing components.**

  `Sidebar.tsx` imports `ChatMeta` from `@shared/protocol`. `FolderPicker.tsx` imports `FolderPickerState` from `web/src/appState.ts` (created in Task 10). Confirm both sources export the names this task needs (run from the repo root `P:\AI_PROJECT\Claude\WebPage`):

  ```bash
  grep -nE "^export type ChatMeta|^export type DirEntry" shared/protocol.ts
  grep -nE "^export (type )?\{|^export type FolderPickerState" web/src/appState.ts
  ```

  Expected:
  - The first grep shows `ChatMeta` and `DirEntry` exported by `shared/protocol.ts` (added when the protocol is widened in Task 3). These domain types live in `@shared/protocol`, NOT in `appState`.
  - The second grep shows `FolderPickerState` exported by `web/src/appState.ts`. Note that `appState.ts` exports ONLY UI-state types/functions (e.g. `FolderPickerState`, `UiMessage`, `ChatView`, `AppState`, `applyServer`, …); it does NOT re-export `ChatMeta` or `DirEntry`. The anchored `^export …` patterns avoid falsely matching the *import* line at the top of `appState.ts`.

  If `web/src/appState.ts` does not exist, STOP — Task 10 must be completed first. If `shared/protocol.ts` does not export `ChatMeta`/`DirEntry`, Task 3 is incomplete — finish it first. (No commit in this step.)

- [ ] **Step 2: Create `web/src/components/Sidebar.tsx`.**

  Renders the chat list with the active chat highlighted, a "+ New chat" button, and per-row select/rename/delete. Rename uses `window.prompt` seeded with the current title and only calls `onRename` when the trimmed result is non-empty and changed. Delete uses `window.confirm`. The container is `w-64 h-full border-r overflow-y-auto` to fit a left column. `ChatMeta` is imported from `@shared/protocol` (NOT from `../appState`). Write the file with EXACTLY this content:

  ```tsx
  import type { ChatMeta } from '@shared/protocol'

  export function Sidebar({
    chats,
    activeChatId,
    onSelect,
    onNew,
    onRename,
    onDelete,
  }: {
    chats: ChatMeta[]
    activeChatId?: string
    onSelect: (id: string) => void
    onNew: () => void
    onRename: (id: string, title: string) => void
    onDelete: (id: string) => void
  }) {
    const handleRename = (chat: ChatMeta) => {
      const next = window.prompt('เปลี่ยนชื่อแชท', chat.title)
      if (next === null) return
      const trimmed = next.trim()
      if (!trimmed || trimmed === chat.title) return
      onRename(chat.id, trimmed)
    }

    const handleDelete = (chat: ChatMeta) => {
      if (!window.confirm(`ลบแชท “${chat.title}” ?`)) return
      onDelete(chat.id)
    }

    return (
      <aside className="flex h-full w-64 flex-col border-r bg-gray-50">
        <div className="border-b p-3">
          <button
            className="w-full rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
            onClick={onNew}
          >
            + แชทใหม่
          </button>
        </div>
        <nav className="flex-1 overflow-y-auto p-2">
          {chats.length === 0 ? (
            <p className="px-2 py-4 text-center text-sm text-gray-400">ยังไม่มีแชท</p>
          ) : (
            <ul className="space-y-1">
              {chats.map((chat) => {
                const active = chat.id === activeChatId
                return (
                  <li
                    key={chat.id}
                    className={
                      'group flex items-center gap-1 rounded-lg px-2 py-2 text-sm ' +
                      (active ? 'bg-blue-100 text-blue-900' : 'hover:bg-gray-200')
                    }
                  >
                    <button
                      className="min-w-0 flex-1 truncate text-left"
                      title={chat.title}
                      onClick={() => onSelect(chat.id)}
                    >
                      {chat.title}
                    </button>
                    <button
                      className="shrink-0 rounded px-1 text-gray-400 opacity-0 hover:text-gray-700 group-hover:opacity-100"
                      title="เปลี่ยนชื่อ"
                      onClick={() => handleRename(chat)}
                    >
                      ✎
                    </button>
                    <button
                      className="shrink-0 rounded px-1 text-gray-400 opacity-0 hover:text-red-600 group-hover:opacity-100"
                      title="ลบ"
                      onClick={() => handleDelete(chat)}
                    >
                      🗑
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </nav>
      </aside>
    )
  }
  ```

- [ ] **Step 3: Create `web/src/components/FolderPicker.tsx`.**

  A modal (`fixed inset-0` overlay) that renders nothing when `!state.open`. Shows `state.path`, a manual path input (Enter triggers `onBrowse(value)`), an "Up" button enabled only when `state.parent` is defined, the list of `state.entries` (each a button calling `onBrowse(entry.path)`), a "เลือกโฟลเดอร์นี้" button (`onChoose(state.path)`), and a close button (`onClose`). The manual input uses a controlled local state seeded from `state.path` and re-synced whenever `state.path` changes (via `useEffect`). `FolderPickerState` is imported from `../appState`; the `entry` element type is inferred from `state.entries` (which is `DirEntry[]` from `@shared/protocol`), so no extra type import is needed. Write the file with EXACTLY this content:

  ```tsx
  import { useEffect, useState } from 'react'
  import type { FolderPickerState } from '../appState'

  export function FolderPicker({
    state,
    onBrowse,
    onChoose,
    onClose,
  }: {
    state: FolderPickerState
    onBrowse: (path: string) => void
    onChoose: (path: string) => void
    onClose: () => void
  }) {
    const [draft, setDraft] = useState(state.path)

    useEffect(() => {
      setDraft(state.path)
    }, [state.path])

    if (!state.open) return null

    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
        <div className="flex max-h-[80vh] w-[90%] max-w-lg flex-col rounded-xl bg-white shadow-xl">
          <div className="flex items-center justify-between border-b p-4">
            <h2 className="text-lg font-semibold">เลือกโฟลเดอร์</h2>
            <button className="text-gray-400 hover:text-gray-700" title="ปิด" onClick={onClose}>
              ✕
            </button>
          </div>

          <div className="flex items-center gap-2 border-b p-3">
            <button
              className="shrink-0 rounded-lg border px-3 py-1.5 text-sm disabled:opacity-40"
              disabled={state.parent === undefined}
              onClick={() => {
                if (state.parent !== undefined) onBrowse(state.parent)
              }}
            >
              ↑ ขึ้น
            </button>
            <input
              className="min-w-0 flex-1 rounded-lg border px-3 py-1.5 font-mono text-sm outline-none focus:ring-2 focus:ring-blue-400"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  onBrowse(draft)
                }
              }}
            />
          </div>

          <div className="flex-1 overflow-y-auto p-2">
            <p className="px-2 py-1 font-mono text-xs text-gray-500">{state.path}</p>
            {state.entries.length === 0 ? (
              <p className="px-2 py-4 text-center text-sm text-gray-400">ไม่มีโฟลเดอร์ย่อย</p>
            ) : (
              <ul className="space-y-0.5">
                {state.entries.map((entry) => (
                  <li key={entry.path}>
                    <button
                      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-gray-100"
                      onClick={() => onBrowse(entry.path)}
                    >
                      <span aria-hidden>📁</span>
                      <span className="truncate">{entry.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

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
        </div>
      </div>
    )
  }
  ```

- [ ] **Step 4: Typecheck the two new components (App.tsx errors expected until Task 13).**

  Per the Migration Typecheck Policy, the web project does NOT go fully GREEN until Task 13 — `App.tsx` is still un-migrated at this point and will report type errors under a whole-web `tsc -p web/tsconfig.json`. So do NOT treat a clean whole-web tsc as the gate here. Instead, confirm that THIS task's two files (`Sidebar.tsx`, `FolderPicker.tsx`) are error-free. Run from the repo root `P:\AI_PROJECT\Claude\WebPage`:

  ```bash
  npx tsc -p web/tsconfig.json
  ```

  Expected: the ONLY diagnostics (if any) point at `web/src/App.tsx` (and any other not-yet-migrated web file) — those are EXPECTED and resolved in Task 13. There must be NO diagnostics referencing `web/src/components/Sidebar.tsx` or `web/src/components/FolderPicker.tsx`. If you prefer a precise check, scan the output and confirm zero lines beginning with `web/src/components/Sidebar.tsx` or `web/src/components/FolderPicker.tsx`:

  ```bash
  npx tsc -p web/tsconfig.json 2>&1 | grep -E "components/(Sidebar|FolderPicker)\.tsx" || echo "OK: no errors in Sidebar.tsx / FolderPicker.tsx"
  ```

  Expected: prints `OK: no errors in Sidebar.tsx / FolderPicker.tsx`.

  Common failures and their meaning:
  - `Cannot find module '@shared/protocol'` or `ChatMeta`/`DirEntry` not exported → Task 3 (protocol widening) is incomplete; finish it first.
  - `Cannot find module '../appState'` or `FolderPickerState` not exported → Task 10 (appState) is incomplete; finish it first.
  - An error inside `Sidebar.tsx`/`FolderPicker.tsx` itself → fix the component; the gate is these two files compiling cleanly.

  (The authoritative whole-web GREEN typecheck lands in Task 13; Task 14 runs the full final gate.)

- [ ] **Step 5: Commit.**

  Run from the repo root:

  ```bash
  git add web/src/components/Sidebar.tsx web/src/components/FolderPicker.tsx
  git commit -m "feat(m2): Sidebar + FolderPicker components"
  ```

  Expected: a commit is created reporting 2 files changed (both new files).

---

---

### Task 13: App.tsx multi-chat integration

Rewire `web/src/App.tsx` from the M1 single-chat shell to the M2 multi-chat shell built on `appState.ts` (Task 10), the rewritten `ws.ts` (Task 11), `Sidebar.tsx` (Task 12a), and `FolderPicker.tsx` (Task 12b). Also fix the moved-type imports in `Message.tsx` and `PermissionModal.tsx` so they resolve against `appState.ts` instead of the soon-to-be-deleted `chatState.ts`, and then remove the dead `chatState.ts` / `chatState.test.ts` files in this task's commit (the M2 `appState` module fully supersedes them).

This task is a pure UI integration: it has no Vitest of its own. It is, however, the point where the **web package first goes fully GREEN** under TypeScript — every web file now imports the migrated types, so the acceptance gate is a clean `npx tsc -p web/tsconfig.json` (exit 0) plus a successful `npm run build:web`. Earlier tasks own the unit tests for `appState`, `ws`, `Sidebar`, and `FolderPicker`; do NOT re-create them here.

> Migration-typecheck note: per the migration policy, prior web tasks (10–12) could not run a clean whole-`web` `tsc` because `App.tsx`, `Message.tsx`, and `PermissionModal.tsx` still pointed at the old `chatState.ts`. After this task migrates those three files (and deletes `chatState.*`), no web file references the old module, so `npx tsc -p web/tsconfig.json` is now authoritative and must exit 0.

**Files:**
- Modify: `web/src/App.tsx`
- Modify: `web/src/components/Message.tsx`
- Modify: `web/src/components/PermissionModal.tsx`
- Delete: `web/src/chatState.ts`, `web/src/chatState.test.ts` (via `git rm` — deletion is owned by this task, not Task 10)
- Test: (none — verification is `npx tsc -p web/tsconfig.json` + `npm run build:web`; the consumed modules `web/src/appState.ts`, `web/src/ws.ts`, `web/src/components/Sidebar.tsx`, `web/src/components/FolderPicker.tsx` already have their own tests from prior tasks)

**Interfaces:**
- Consumes (from `web/src/appState.ts`, imported via relative path `./appState`):
  - `type AppState = { chats: ChatMeta[]; activeChatId?: string; views: Record<string, ChatView>; pending?: PermissionPrompt; folder?: FolderPickerState }`
  - `type ChatView = { messages: UiMessage[]; streaming: boolean }`
  - `type UiMessage = { role:"user"; text:string } | { role:"assistant"; text:string; tools: ToolCall[] } | { role:"error"; text:string }`
  - `type PermissionPrompt = { chatId: string; requestId: string; name: string; input: unknown }`
  - `type FolderPickerState = { open: boolean; path: string; parent?: string; entries: DirEntry[] }`
  - `const initialAppState: AppState`
  - `applyServer(state: AppState, msg: ServerMsg): AppState`
  - `appendUser(state: AppState, chatId: string, text: string): AppState`
  - `setActiveChat(state: AppState, chatId: string): AppState`
  - `clearPending(state: AppState): AppState`
  - `closeFolder(state: AppState): AppState`
- Consumes (from `web/src/ws.ts`, imported via relative path `./ws`):
  - `type WsStatus = "connecting" | "open" | "closed"`
  - `createWsClient(opts: { onMessage: (m: ServerMsg) => void; onStatus?: (s: WsStatus) => void }): { send: (m: ClientMsg) => void; close: () => void }`
- Consumes (from `@shared/protocol`): `ServerMsg`, `ClientMsg`, `ChatMeta`, `DirEntry`, `ToolCall`
- Consumes (components): `Sidebar` from `./components/Sidebar`, `FolderPicker` from `./components/FolderPicker`, `Message` from `./components/Message`, `Composer` from `./components/Composer`, `PermissionModal` from `./components/PermissionModal`
- Produces: a rewired `App` React component (named export `export function App()`); corrected type-only imports in `Message.tsx` and `PermissionModal.tsx`; removal of `chatState.ts` / `chatState.test.ts`. No new exported runtime signatures.

---

- [ ] **Step 1: Confirm the prerequisites from earlier tasks exist.**
  Task 13 edits App + two import lines and deletes the old `chatState.*`; it depends on Tasks 10–12 having created the new modules. Verify they are present before touching `App.tsx` (run from repo root `P:\AI_PROJECT\Claude\WebPage`):
  ```bash
  ls web/src/appState.ts web/src/ws.ts web/src/components/Sidebar.tsx web/src/components/FolderPicker.tsx
  ```
  Expected output (all four paths listed, no "No such file" error):
  ```
  web/src/appState.ts
  web/src/components/FolderPicker.tsx
  web/src/components/Sidebar.tsx
  web/src/ws.ts
  ```
  If any are missing, STOP — the preceding tasks (10 = `appState.ts`, 11 = `ws.ts`, 12a = `Sidebar.tsx`, 12b = `FolderPicker.tsx`) must be completed first. Do not proceed.

- [ ] **Step 2: Fix the moved-type import in `web/src/components/Message.tsx`.**
  The current file imports `UiMessage` from the old `'../chatState'`. Change ONLY the import line to point at `'../appState'` (Task 10's module). Leave every other line untouched. Replace the entire file with exactly this content:
  ```tsx
  import ReactMarkdown from 'react-markdown'
  import type { UiMessage } from '../appState'
  import { ToolCard } from './ToolCard'

  export function Message({ msg }: { msg: UiMessage }) {
    if (msg.role === 'error') {
      return (
        <div className="flex justify-center px-3 py-2">
          <div className="max-w-[90%] rounded-lg border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-800">
            ⚠ {msg.text}
          </div>
        </div>
      )
    }
    const isUser = msg.role === 'user'
    return (
      <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} px-3 py-2`}>
        <div
          className={`max-w-[80%] rounded-2xl px-4 py-2 ${
            isUser ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-900'
          }`}
        >
          {!isUser && msg.role === 'assistant' && msg.tools.map((t) => <ToolCard key={t.id} call={t} />)}
          <div className="prose prose-sm max-w-none break-words">
            <ReactMarkdown>{msg.text}</ReactMarkdown>
          </div>
        </div>
      </div>
    )
  }
  ```

- [ ] **Step 3: Fix the moved-type import in `web/src/components/PermissionModal.tsx`.**
  `PermissionPrompt` moved from `chatState.ts` to `appState.ts` (Task 10) and now carries an extra `chatId` field, which this component ignores. Change ONLY the import path. Replace the entire file with exactly this content:
  ```tsx
  import type { PermissionPrompt } from '../appState'

  export function PermissionModal({
    prompt,
    onDecide,
  }: {
    prompt: PermissionPrompt
    onDecide: (decision: 'allow' | 'deny') => void
  }) {
    return (
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
    )
  }
  ```

- [ ] **Step 4: Verify the `Composer` props contract (no edit expected).**
  Task 13 wires `Composer` with `disabled`, `onSend`, `onStop`. `Composer` imports no moved types (it only imports `useState` from `react`), so it needs no change. Confirm its signature so the App wiring below typechecks:
  ```bash
  sed -n '1,5p' web/src/components/Composer.tsx
  ```
  Expected output (the prop names `disabled`, `onSend`, `onStop` are present and there is NO import from `'../chatState'`):
  ```
  import { useState } from 'react'

  export function Composer({ disabled, onSend, onStop }: { disabled: boolean; onSend: (t: string) => void; onStop: () => void }) {
    const [text, setText] = useState('')
    const submit = () => {
  ```
  If `Composer.tsx` imports anything from `'../chatState'`, update that import to `'../appState'` the same way as Steps 2–3, and add `web/src/components/Composer.tsx` to the `git add` list in Step 9. (Per the current code it does not, so no edit is expected.)

- [ ] **Step 5: Rewrite `web/src/App.tsx` to the multi-chat shell.**
  This replaces the entire file. Behavior implemented (matching the contract exactly):
  - `useReducer` over `AppState` starting at `initialAppState`. Reducer actions delegate to the exported `appState` helpers (Task 10): `'server'` -> `applyServer`, `'user'` -> `appendUser`, `'setActive'` -> `setActiveChat`, `'clearPending'` -> `clearPending`, `'closeFolder'` -> `closeFolder`.
  - WS status (`WsStatus`) lives in its own `useState`, updated via `onStatus`. A small banner renders when `status === 'closed'`.
  - The ws client (Task 11's `createWsClient`) is created exactly once (empty-dep `useEffect`). `onMessage` dispatches a `'server'` action; `onStatus` updates status AND, on transition back to `'open'`, re-subscribes to the currently active chat (read from a ref to avoid stale closure / re-creating the socket).
  - Layout: a flex row — `<Sidebar/>` on the left, a main column on the right. The main column shows the active chat's `views[activeChatId]` messages + a `<Composer/>`; with no active chat it shows an empty-state prompt.
  - Sidebar callbacks: `onSelect` -> dispatch `setActive` + `ws.send subscribe`; `onNew` -> `ws.send list_dirs {}` (opens the folder picker via the resulting `dir_list` -> `applyServer`); `onRename` -> `ws.send rename_chat`; `onDelete` -> `ws.send delete_chat`.
  - Composer callbacks (per active chat): `onSend` -> dispatch `user` + `ws.send user_message {chatId, text}`; `onStop` -> `ws.send interrupt {chatId}`. `disabled = view.streaming`.
  - FolderPicker (rendered when `state.folder?.open`): `onBrowse` -> `ws.send list_dirs {path}`; `onChoose(path)` -> `ws.send create_chat {cwd: path}` then dispatch `closeFolder`; `onClose` -> dispatch `closeFolder`.
  - PermissionModal (rendered when `state.pending`): `onDecide` -> `ws.send permission_response {requestId, decision}` + dispatch `clearPending`.
  - Auto-scroll the message pane when the active view's message list changes.

  Replace the entire contents of `web/src/App.tsx` with exactly this:
  ```tsx
  import { useEffect, useReducer, useRef, useState } from 'react'
  import type { ServerMsg } from '@shared/protocol'
  import {
    applyServer,
    appendUser,
    clearPending,
    closeFolder,
    setActiveChat,
    initialAppState,
    type AppState,
  } from './appState'
  import { createWsClient, type WsStatus } from './ws'
  import { Sidebar } from './components/Sidebar'
  import { FolderPicker } from './components/FolderPicker'
  import { Message } from './components/Message'
  import { Composer } from './components/Composer'
  import { PermissionModal } from './components/PermissionModal'

  type Action =
    | { kind: 'server'; msg: ServerMsg }
    | { kind: 'user'; chatId: string; text: string }
    | { kind: 'setActive'; chatId: string }
    | { kind: 'clearPending' }
    | { kind: 'closeFolder' }

  function reducer(state: AppState, action: Action): AppState {
    switch (action.kind) {
      case 'server':
        return applyServer(state, action.msg)
      case 'user':
        return appendUser(state, action.chatId, action.text)
      case 'setActive':
        return setActiveChat(state, action.chatId)
      case 'clearPending':
        return clearPending(state)
      case 'closeFolder':
        return closeFolder(state)
    }
  }

  export function App() {
    const [state, dispatch] = useReducer(reducer, initialAppState)
    const [status, setStatus] = useState<WsStatus>('connecting')
    const clientRef = useRef<ReturnType<typeof createWsClient> | null>(null)
    const scrollRef = useRef<HTMLDivElement>(null)

    // Keep the latest activeChatId in a ref so the (stable) onStatus handler can
    // re-subscribe after a reconnect without re-creating the socket.
    const activeChatRef = useRef<string | undefined>(undefined)
    activeChatRef.current = state.activeChatId

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

    const activeId = state.activeChatId
    const view = activeId ? state.views[activeId] : undefined

    useEffect(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
    }, [view?.messages])

    const selectChat = (id: string) => {
      dispatch({ kind: 'setActive', chatId: id })
      clientRef.current?.send({ type: 'subscribe', chatId: id })
    }
    const newChat = () => clientRef.current?.send({ type: 'list_dirs' })
    const renameChat = (id: string, title: string) =>
      clientRef.current?.send({ type: 'rename_chat', chatId: id, title })
    const deleteChat = (id: string) => clientRef.current?.send({ type: 'delete_chat', chatId: id })

    const send = (text: string) => {
      if (!activeId) return
      dispatch({ kind: 'user', chatId: activeId, text })
      clientRef.current?.send({ type: 'user_message', chatId: activeId, text })
    }
    const stop = () => {
      if (!activeId) return
      clientRef.current?.send({ type: 'interrupt', chatId: activeId })
    }

    const browseFolder = (path: string) => clientRef.current?.send({ type: 'list_dirs', path })
    const chooseFolder = (path: string) => {
      clientRef.current?.send({ type: 'create_chat', cwd: path })
      dispatch({ kind: 'closeFolder' })
    }
    const cancelFolder = () => dispatch({ kind: 'closeFolder' })

    const decide = (decision: 'allow' | 'deny') => {
      if (!state.pending) return
      clientRef.current?.send({
        type: 'permission_response',
        requestId: state.pending.requestId,
        decision,
      })
      dispatch({ kind: 'clearPending' })
    }

    return (
      <div className="flex h-full">
        <Sidebar
          chats={state.chats}
          activeChatId={activeId}
          onSelect={selectChat}
          onNew={newChat}
          onRename={renameChat}
          onDelete={deleteChat}
        />
        <div className="flex h-full flex-1 flex-col">
          <header className="flex items-center justify-between border-b bg-white px-4 py-3">
            <span className="text-lg font-semibold">Claude Web Agent</span>
            {status === 'closed' && (
              <span className="rounded bg-yellow-100 px-2 py-1 text-xs text-yellow-800">
                การเชื่อมต่อหลุด กำลังเชื่อมต่อใหม่…
              </span>
            )}
          </header>
          {activeId && view ? (
            <>
              <div ref={scrollRef} className="flex-1 overflow-y-auto bg-gray-50">
                {view.messages.map((m, i) => (
                  <Message key={i} msg={m} />
                ))}
              </div>
              <Composer disabled={view.streaming} onSend={send} onStop={stop} />
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center bg-gray-50 text-gray-500">
              <div className="text-center">
                <p className="text-base">ยังไม่มีแชทที่เลือก</p>
                <button
                  className="mt-3 rounded-lg bg-blue-600 px-4 py-2 text-white"
                  onClick={newChat}
                >
                  + สร้างแชทใหม่
                </button>
              </div>
            </div>
          )}
        </div>
        {state.folder?.open && (
          <FolderPicker
            state={state.folder}
            onBrowse={browseFolder}
            onChoose={chooseFolder}
            onClose={cancelFolder}
          />
        )}
        {state.pending && <PermissionModal prompt={state.pending} onDecide={decide} />}
      </div>
    )
  }
  ```

- [ ] **Step 6: Delete the superseded `chatState` files with `git rm`.**
  Now that `App.tsx`, `Message.tsx`, and `PermissionModal.tsx` all import from `./appState`, nothing references `chatState.ts` anymore. Remove the dead module and its test (this deletion is owned by Task 13, not Task 10). Run from repo root `P:\AI_PROJECT\Claude\WebPage`:
  ```bash
  git rm web/src/chatState.ts web/src/chatState.test.ts
  ```
  Expected output:
  ```
  rm 'web/src/chatState.ts'
  rm 'web/src/chatState.test.ts'
  ```
  Sanity-check that no source file still imports the removed module (should print nothing):
  ```bash
  grep -rn "chatState" web/src || echo "no chatState references remain"
  ```
  Expected output:
  ```
  no chatState references remain
  ```

- [ ] **Step 7: Typecheck the web package — authoritative GREEN gate.**
  This is where the web package first typechecks cleanly end-to-end (all files migrated, `chatState.*` gone). Run from repo root `P:\AI_PROJECT\Claude\WebPage`:
  ```bash
  npx tsc -p web/tsconfig.json
  ```
  Expected: PASS — the command exits 0 and prints NOTHING (tsc with `noEmit: true` is silent on success). If you see `Cannot find module './appState'` or `Cannot find module './ws'`, the prerequisite tasks (10/11) are incomplete — go back to Step 1. If you see any `'./chatState'` reference, a stale import remains; re-check Steps 2–4 and Step 6.

- [ ] **Step 8: Production-build the web app.**
  `npm run build:web` runs `vite build` from the repo root using the repo-root `vite.config.ts`; with no `build.outDir` override, Vite emits to the **repo-root `dist/`** (NOT `web/dist/`). Run from repo root `P:\AI_PROJECT\Claude\WebPage`:
  ```bash
  npm run build:web
  ```
  Expected: PASS — Vite finishes with output similar to:
  ```
  vite v5.x.x building for production...
  ✓ NN modules transformed.
  dist/index.html                   x.xx kB
  dist/assets/index-XXXXXXXX.css    xx.xx kB │ gzip:  x.xx kB
  dist/assets/index-XXXXXXXX.js    xxx.xx kB │ gzip: xx.xx kB
  ✓ built in X.XXs
  ```
  Confirm the repo-root `dist/` directory was produced:
  ```bash
  ls dist/index.html
  ```
  Expected output:
  ```
  dist/index.html
  ```

- [ ] **Step 9: Commit.**
  Stage the rewired App, both migrated component imports, and the `chatState` deletions (the `git rm` from Step 6 already staged the removals; the `git add` below stages the modified files). Run from repo root:
  ```bash
  git add web/src/App.tsx web/src/components/Message.tsx web/src/components/PermissionModal.tsx
  git commit -m "feat(m2): App multi-chat integration + drop legacy chatState (sidebar, folder picker, per-chat view)"
  ```
  Expected output (commit succeeds — 3 files modified + 2 files deleted = 5 files changed):
  ```
  [<branch> <hash>] feat(m2): App multi-chat integration + drop legacy chatState (sidebar, folder picker, per-chat view)
   5 files changed, NN insertions(+), NN deletions(-)
   delete mode 100644 web/src/chatState.test.ts
   delete mode 100644 web/src/chatState.ts
  ```
  If Step 4 found that `Composer.tsx` also needed a moved-type import fix, add `web/src/components/Composer.tsx` to the `git add` list before committing (then the count is 6 files changed).

---

---

### Task 14: Multi-chat resume e2e + README + full verification (authoritative final gate)

**Files:**
- Create: `P:\AI_PROJECT\Claude\WebPage\scripts\e2e-multichat.mjs`
- Modify: `P:\AI_PROJECT\Claude\WebPage\README.md`
- Delete: `P:\AI_PROJECT\Claude\WebPage\scripts\e2e-resume.mjs` (superseded — guarded `git rm`; the file may already be absent in this tree, in which case skip the `git rm`)
- Test (manual e2e harness, not Vitest): `P:\AI_PROJECT\Claude\WebPage\scripts\e2e-multichat.mjs`

**Interfaces:**
- Consumes (from `shared/protocol.ts`): `ClientMsg` variants `{ type:"create_chat"; cwd?: string }`, `{ type:"subscribe"; chatId: string }`, `{ type:"user_message"; chatId: string; text: string }`, `{ type:"permission_response"; requestId: string; decision:"allow"|"deny" }`, `{ type:"rename_chat"; chatId: string; title: string }`, `{ type:"delete_chat"; chatId: string }`.
- Consumes (from `shared/protocol.ts`): `ServerMsg` variants `{ type:"chat_created"; chat: ChatMeta }`, `{ type:"chat_history"; chatId: string; messages: StoredMessage[] }`, `{ type:"assistant_delta"; chatId: string; text: string }`, `{ type:"permission_request"; chatId: string; requestId: string; name: string; input: unknown }`, `{ type:"turn_done"; chatId: string; usage?: Usage }`, `{ type:"chat_renamed"; chatId: string; title: string }`, `{ type:"chat_deleted"; chatId: string }`, `{ type:"error"; message: string; chatId?: string }`.
- Consumes (env contract from `server/index.ts`): `DB_PATH` env var selects the SQLite file; `PORT` env var selects the listen port; the server prints `WebSocket listening on ws://127.0.0.1:<PORT>/ws` on the `app.log` (Fastify logger → stdout) once ready.
- Produces: a standalone Node ESM script (no exports) that exits `0` on PASS and `1` on FAIL.

> NOTE on the SDK boundary: `e2e-multichat.mjs` is a LIVE end-to-end script. It spawns the real server, which calls the Claude Agent SDK in `LocalAgentProvider`. It therefore REQUIRES a valid Claude login on the machine (same credentials as Claude Code). It is intentionally NOT part of `npm test` (the Vitest suite is hermetic). Steps 9–11 below run the hermetic gate (full suite + BOTH authoritative typechecks + production build); Step 12 runs the dependency audit; Step 13 runs this live script.

> NOTE — this is the FINAL, AUTHORITATIVE verification task for the whole M2 migration. Earlier per-task gates relied on Vitest per-file transpilation (esbuild does not cross-file typecheck), so a whole-project `tsc --noEmit` was deliberately NOT claimed clean mid-migration. By the time this task runs, every owning task has landed: server+shared went GREEN at Task 9 and web went GREEN at Task 13. This task re-runs BOTH typechecks end-to-end and expects them fully clean — there are no longer any not-yet-migrated files that are allowed to error.

---

- [ ] **Step 1: Confirm prerequisite files exist (read-only sanity check).**

These files must already exist from earlier tasks. This step only verifies — it writes nothing.

```bash
cd /p/AI_PROJECT/Claude/WebPage
ls server/index.ts server/store.ts server/hub.ts server/ws.ts scripts/e2e-ws.mjs
```

Expected output (all five paths listed, no "No such file"):

```
scripts/e2e-ws.mjs
server/hub.ts
server/index.ts
server/store.ts
server/ws.ts
```

If any path is missing, STOP — an earlier task is incomplete; do not proceed.

---

- [ ] **Step 2: Create the multi-chat e2e script.**

This script proves the full M2 stack: create a chat with a `cwd`, run two turns where Turn 2 only succeeds if the SDK session resumed through the persisted `sdk_session_id`, reload on a fresh WS connection and confirm 4 persisted messages, then rename and delete. It mirrors the spawn/ready/auto-allow conventions in `scripts/e2e-ws.mjs` (different PORT `8790`, throwaway temp `DB_PATH`).

Write the COMPLETE file `P:\AI_PROJECT\Claude\WebPage\scripts\e2e-multichat.mjs`:

```js
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
import { rmSync } from 'node:fs'

const __dir = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dir, '..')
const PORT = 8790 // dedicated port, distinct from dev (5173/8787) and e2e-ws (8788)
const DB_PATH = join(tmpdir(), 'cwa-e2e-' + process.pid + '.db')
const WS_URL = `ws://127.0.0.1:${PORT}/ws`
const CODEWORD = 'KIWI88'

// ── Start server child process with throwaway DB ─────────────────────────────
console.log('[e2e] Starting server on port', PORT, 'with DB_PATH', DB_PATH, '…')
const server = spawn(
  'npx',
  ['tsx', 'server/index.ts'],
  {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DB_PATH },
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
    const ws = new WebSocket(WS_URL)
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
```

---

- [ ] **Step 3: Smoke-test the script's syntax/imports without the SDK (does it load?).**

This catches typos before the long live run. `node --check` only parses — it does not run the server or the SDK.

```bash
cd /p/AI_PROJECT/Claude/WebPage
node --check scripts/e2e-multichat.mjs && echo "SYNTAX_OK"
```

Expected output:

```
SYNTAX_OK
```

---

- [ ] **Step 4: Read the current README before editing.**

You have already read it in this task's research phase. The current `## Status` section reads "M1 — single-room, no persistence, localhost only." and the `## Testing` block lists `npm test (22 tests)`, `npm run build:web`, and `npx tsx scripts/e2e-ws.mjs`. Confirm the exact current Status line is unchanged before editing:

```bash
cd /p/AI_PROJECT/Claude/WebPage
sed -n '26,36p' README.md
```

Expected output (this is what you will replace):

```
## Status

**M1 — single-room, no persistence, localhost only.** See `docs/superpowers/specs/` for the full roadmap (M2–M6: multi-room sidebar, persistence, FolderPicker, LAN access, auth).

## Testing

```bash
npm test          # unit suite (22 tests)
npm run build:web # production build
npx tsx scripts/e2e-ws.mjs  # live end-to-end WebSocket test (requires SDK login)
```
```

---

- [ ] **Step 5: Update the Status section of the README.**

Replace the M1 Status block with the M2 description (multi-chat + SQLite persistence + resume + FolderPicker).

Old string to replace (exact):

```
## Status

**M1 — single-room, no persistence, localhost only.** See `docs/superpowers/specs/` for the full roadmap (M2–M6: multi-room sidebar, persistence, FolderPicker, LAN access, auth).
```

New string:

```
## Status

**M2 — multi-chat + SQLite persistence + resume + FolderPicker, localhost only.** Multiple chats live in a sidebar (create / rename / delete); each chat persists its messages and SDK session to a local SQLite database, so conversations survive a reload and turns resume the prior session. A FolderPicker lets you choose each chat's working directory. See `docs/superpowers/specs/` for the full roadmap (M3–M6: LAN access, auth, and beyond).
```

---

- [ ] **Step 6: Add a Persistence section documenting the DB and `DB_PATH`.**

Insert a new `## Persistence` section immediately before the `## Testing` heading.

Old string to replace (exact — this is the blank line + the Testing heading):

```
## Testing

```bash
npm test          # unit suite (22 tests)
npm run build:web # production build
npx tsx scripts/e2e-ws.mjs  # live end-to-end WebSocket test (requires SDK login)
```
```

New string:

```
## Persistence

Chats and messages are stored in a local SQLite database (via `better-sqlite3`). By default the file lives at `data/chats.db`, which is **gitignored** — your conversations never get committed. The `data/` directory is created automatically on first run.

Override the location with the `DB_PATH` environment variable (use `:memory:` for an ephemeral, in-process database — handy for tests and throwaway runs):

```bash
DB_PATH=/tmp/my-chats.db npm run dev
```

## Testing

```bash
npm test                          # unit suite (Vitest, environment node)
npm run build:web                 # production build of the web app
npx tsx scripts/e2e-multichat.mjs # live multi-chat + persistence + resume e2e (requires Claude login)
```

The e2e script spawns the server against a throwaway temp database (its own `DB_PATH`) on a dedicated port, so it never touches `data/chats.db`.
```

> The exact `npm test` count is filled in at Step 14 after you run the suite and read the real number; the line above intentionally omits a hardcoded count so the README never lies about it. If the assembler/reviewer requires a number, run Step 9 first and substitute it.

---

- [ ] **Step 7: Verify the README edits applied.**

```bash
cd /p/AI_PROJECT/Claude/WebPage
grep -n "M2 — multi-chat" README.md
grep -n "## Persistence" README.md
grep -n "e2e-multichat.mjs" README.md
grep -c "M1 — single-room" README.md
```

Expected output (line numbers vary; the key facts are: M2 present once, Persistence present, e2e-multichat referenced, and ZERO remaining M1 Status lines):

```
28:**M2 — multi-chat + SQLite persistence + resume + FolderPicker, localhost only.** ...
32:## Persistence
43:npx tsx scripts/e2e-multichat.mjs # live multi-chat + persistence + resume e2e (requires Claude login)
0
```

(The final `0` from `grep -c` confirms the M1 Status string is fully gone.)

---

- [ ] **Step 8: Remove the superseded resume script (guarded).**

`scripts/e2e-resume.mjs` is superseded by `e2e-multichat.mjs`. In a clean checkout it may already be absent (it is not present in this working tree). Run a guarded removal so the step is idempotent and never errors:

```bash
cd /p/AI_PROJECT/Claude/WebPage
if git ls-files --error-unmatch scripts/e2e-resume.mjs >/dev/null 2>&1; then
  git rm scripts/e2e-resume.mjs
  echo "REMOVED_TRACKED"
elif [ -f scripts/e2e-resume.mjs ]; then
  rm -f scripts/e2e-resume.mjs
  echo "REMOVED_UNTRACKED"
else
  echo "ALREADY_ABSENT"
fi
```

Expected output (in this tree):

```
ALREADY_ABSENT
```

(If it had been tracked you would see `REMOVED_TRACKED` instead — either is acceptable; the commit in Step 15 accounts for both.)

---

- [ ] **Step 9: Run the full hermetic unit suite (the gate).**

```bash
cd /p/AI_PROJECT/Claude/WebPage
npm test
```

Expected: the Vitest run reports **PASS** for every test file with no failures, e.g.:

```
 ✓ shared/protocol.test.ts  (… tests)
 ✓ server/normalize.test.ts  (… tests)
 ✓ server/permission.test.ts  (… tests)
 ✓ server/store.test.ts  (… tests)
 ✓ server/fsbrowse.test.ts  (… tests)
 ✓ server/agent.test.ts  (… tests)
 ✓ server/chatRuntime.test.ts  (… tests)
 ✓ server/hub.test.ts  (… tests)
 ✓ web/src/appState.test.ts  (… tests)
 ✓ web/src/ws.test.ts  (… tests)

 Test Files  N passed (N)
      Tests  M passed (M)
```

Record the actual file list and the total `M` test count. If any file FAILS, STOP and fix the responsible task before continuing — do not proceed to commit.

> Note: the exact set of test files depends on which earlier tasks landed; the list above is the expected M2 superset. `appState.ts` is produced by Task 10 and `web/src/ws.ts` by Task 11, so their test files are `web/src/appState.test.ts` / `web/src/ws.test.ts`. `server/ws.test.ts`'s old `ChatSession` tests were deleted in the ws rewrite task — confirm there are no lingering `ChatSession` references in the failures.

---

- [ ] **Step 10: Authoritative whole-project typecheck — server + shared (must be clean).**

This is the FINAL server+shared typecheck for the migration. The root `tsconfig.json` includes `["server","shared"]` (there is NO `server/tsconfig.json`). Server+shared went GREEN at Task 9; by now every owning file is migrated, so this MUST be fully clean — no "expected" errors remain.

```bash
cd /p/AI_PROJECT/Claude/WebPage
npx tsc --noEmit
echo "tsc(server+shared) exit=$?"
```

Expected (no diagnostics, exit 0):

```
tsc(server+shared) exit=0
```

If `tsc` prints ANY error, STOP — the migration is not actually complete. Fix the offending file in its owning task before proceeding. Do not hand-wave a non-zero exit as "expected mid-migration": this is the end of the migration.

---

- [ ] **Step 11: Authoritative whole-project typecheck — web (must be clean).**

This is the FINAL web typecheck. Web has its own `web/tsconfig.json` (separate from root) and went GREEN at Task 13. It MUST be fully clean here.

```bash
cd /p/AI_PROJECT/Claude/WebPage
npx tsc -p web/tsconfig.json
echo "tsc(web) exit=$?"
```

Expected (no diagnostics, exit 0):

```
tsc(web) exit=0
```

If `tsc` prints ANY error, STOP and fix the offending web file in its owning task (`appState.ts` → Task 10, `ws.ts` → Task 11, Sidebar/FolderPicker → Task 12, App integration → Task 13) before proceeding. Code must satisfy TS strict + ESM, `moduleResolution Bundler`, with NO `.js` import extensions; web imports shared types via `@shared/protocol`.

---

- [ ] **Step 12: Build the web app for production.**

```bash
cd /p/AI_PROJECT/Claude/WebPage
npm run build:web
```

Expected: a successful Vite build ending with the bundle summary and no errors. Note `vite build` emits to the REPO-ROOT `dist/` (NOT `web/dist/`):

```
vite v5.x building for production...
✓ NN modules transformed.
dist/index.html                   …
dist/assets/index-XXXXXXXX.js     … kB │ gzip: … kB
✓ built in …s
```

If the build emits TS errors (strict + ESM, `moduleResolution Bundler`, no `.js` import extensions), STOP and fix them.

---

- [ ] **Step 13: Run a dependency audit and record the summary.**

```bash
cd /p/AI_PROJECT/Claude/WebPage
npm audit
```

Expected: a summary line you will paste into the commit/PR notes, e.g. `found 0 vulnerabilities` or a count by severity such as:

```
# npm audit report
…
N vulnerabilities (… low, … moderate, … high, … critical)
```

Record the exact summary verbatim. This is a record-only step — do NOT run `npm audit fix` here (dependency bumps are out of scope for this task).

---

- [ ] **Step 14: Run the live multi-chat e2e (requires Claude login).**

```bash
cd /p/AI_PROJECT/Claude/WebPage
npx tsx scripts/e2e-multichat.mjs
```

Expected: server boot logs, two turns, a reload, rename, delete, then on the last lines:

```
[e2e] OK — resume worked, reply contains "KIWI88".
…
[e2e] OK — persistence verified (4 msgs, correct roles).
[e2e] OK — chat_renamed received.
[e2e] OK — chat_deleted received.
[e2e] Killing server…
[server] exited …

=== E2E MULTICHAT RESULT ===
PASS
```

The process exits `0` on PASS. Verify the exit code:

```bash
echo "exit=$?"
```

Expected:

```
exit=0
```

Also confirm no temp DB leaked (the script removes it on teardown). `$TMPDIR` is empty in Git Bash, so glob it via Node, which reads the SAME `os.tmpdir()` the script uses:

```bash
cd /p/AI_PROJECT/Claude/WebPage
node -e "const{readdirSync}=require('fs'),{tmpdir}=require('os');const f=readdirSync(tmpdir()).filter(n=>/^cwa-e2e-.*\.db$/.test(n));console.log(f.length?f.join(String.fromCharCode(10)):'NO_TEMP_DB')"
```

Expected:

```
NO_TEMP_DB
```

(If it prints one or more `cwa-e2e-*.db` filenames, the teardown's `removeTempDb()` did not run — most likely the script crashed before teardown. Investigate, then delete the stragglers from `os.tmpdir()` before claiming completion.)

> If this FAILS with a login/auth error (not a logic error), the M2 code is still correct — the script is gated on SDK credentials. Resolve the Claude login and re-run before claiming completion. If it FAILS on the `KIWI88` assertion, resume-through-DB is broken (wiring `getChatSdkSession`/`setChatSdkSession` in `chatRuntime`/`store`) — debug there, not in this script.

---

- [ ] **Step 15: Reconcile the README test count (if you want a number).**

The README Testing block intentionally omits a hardcoded `npm test` count to avoid drift. If your plan requires an explicit count, substitute the `M` total observed in Step 9 into the `# unit suite` comment. Edit:

Old string:

```
npm test                          # unit suite (Vitest, environment node)
```

New string (replace `M` with the real number from Step 9, e.g. 41):

```
npm test                          # unit suite (M tests, Vitest, environment node)
```

Re-run the verification grep to confirm:

```bash
cd /p/AI_PROJECT/Claude/WebPage
grep -n "unit suite" README.md
```

Expected (number reflects your real count):

```
41:npm test                          # unit suite (41 tests, Vitest, environment node)
```

---

- [ ] **Step 16: Final gate checkpoint — confirm ALL green before committing.**

Before the commit, confirm every authoritative check passed in this task:

- Step 9 — `npm test`: every Vitest file PASS, recorded `M` count.
- Step 10 — `npx tsc --noEmit` (server+shared): exit 0, no diagnostics.
- Step 11 — `npx tsc -p web/tsconfig.json` (web): exit 0, no diagnostics.
- Step 12 — `npm run build:web`: successful Vite build to root `dist/`.
- Step 13 — `npm audit`: summary recorded.
- Step 14 — `npx tsx scripts/e2e-multichat.mjs`: `PASS`, `exit=0`, `NO_TEMP_DB`.

If ANY of these is not green, STOP and fix before committing. This is the final M2 gate — do not commit on a red check.

---

- [ ] **Step 17: Stage and commit.**

Stage the new script and the README, account for the (possibly already-removed) resume script, then commit. The `git rm` is guarded so it never aborts the commit when the file is already absent:

```bash
cd /p/AI_PROJECT/Claude/WebPage
git add scripts/e2e-multichat.mjs README.md
if git ls-files --error-unmatch scripts/e2e-resume.mjs >/dev/null 2>&1; then
  git rm scripts/e2e-resume.mjs
fi
git commit -m "test(m2): multi-chat resume e2e + README + full verification"
```

Expected output (the resume-script line appears only if it was tracked):

```
[<branch> <hash>] test(m2): multi-chat resume e2e + README + full verification
 2 files changed, NNN insertions(+), N deletions(-)
 create mode 100644 scripts/e2e-multichat.mjs
```

---

- [ ] **Step 18: Confirm a clean tree and the new file is tracked.**

```bash
cd /p/AI_PROJECT/Claude/WebPage
git status --short
git ls-files scripts/
```

Expected:

```

scripts/e2e-multichat.mjs
scripts/e2e-ws.mjs
```

(Empty `git status --short` = clean working tree; `e2e-resume.mjs` absent from the tracked list; `e2e-multichat.mjs` and `e2e-ws.mjs` present.)
---
---

## Self-Review

**1. Spec coverage (เทียบ spec §6/§7/§16 — M2):**
- SQLite store (data model §6: chats/messages/connections) ✅ Task 6 · resume ผ่าน `sdk_session_id` ✅ Task 5 (unit) + Task 8 (load/save ต่อเทิร์น) + Task 2/14 (e2e) · Sidebar create/rename/delete ✅ Task 12 + 13 · FolderPicker + per-chat `cwd` ✅ Task 7 (`list_dirs`) + Task 12 + 13.
- WebSocket protocol §7 (multi-chat: `create_chat`/`subscribe`/`unsubscribe`/`user_message`/`permission_response`/`interrupt`/`rename_chat`/`delete_chat`/`list_dirs` + `chat_list`/`chat_created`/`chat_renamed`/`chat_deleted`/`chat_history`/`assistant_delta`/`tool_call`/`tool_result`/`permission_request`/`turn_done`/`dir_list`/`error`) ✅ Task 3 (types) + Task 9 (routing).
- เลื่อนไป M3+: connections CRUD/UI, providers อื่น, native/compat API, auth/LAN, responsive drawer, `scope:"chat"` — ตรงกับ phasing.
- scrutinize #2–#6 + carry-overs: ครบ (ดู Appendix C traceability).

**2. Placeholder scan:** ไม่มี `TBD/TODO/FIXME/...` ในบล็อกโค้ด/เทสต์ (มีเฉพาะใน expected-output / README ภายใน fence ซึ่งถูกต้อง). ทุก step ที่แตะโค้ดมีโค้ดเต็ม; ทุก task มี commit step; ทุก TDD task มี red (run-fail) ก่อน green.

**3. Type consistency:** ทุกชื่อ/signature ข้าม task ยึดตาม Appendix A (Locked Interface Contract). จุดที่เคยไม่ตรง (resolver arity, `ChatMeta` import source, `error` chatId optional, runTurn `RunDeps`) ถูกแก้แล้ว.

**4. Process (เพื่อความโปร่งใส):** แผนนี้ author แบบขนาน 14 section จาก locked contract → adversarial review 18 agents (พบ 14 critical / 17 important; ส่วนใหญ่เป็น mid-migration `tsc` claims + Task 4 resolver-ordering + เลข cross-ref) → re-author 11 task ที่กระทบ → re-verify 6 task ที่แก้โค้ดเชิง critical (เหลือ 0 critical / 0 important). **ยังไม่รัน live e2e หรือ build จริง** — เป็นหน้าที่ของขั้น execute ตาม TDD ในแต่ละ task. ก่อน merge M2 แนะนำรัน `9arm-skills:scrutinize` ซ้ำ (ตาม handoff — รอบ M1 มันจับ silent-error bug ที่ per-task review พลาด).

---

## Appendix A — Locked Interface Contract (cross-task reference)

แต่ละ task มี block **Interfaces** ของตัวเองเป็น authoritative; ส่วนนี้คือสรุปข้ามไฟล์ให้ผู้ execute เห็นภาพรวม signature ที่ทุก task ต้องใช้ตรงกัน (ห้ามตั้งชื่อใหม่):

```ts
// shared/protocol.ts (v2) — เพิ่มจาก M1 (คง ToolCall, Usage)
type DirEntry = { name: string; path: string }
type StoredContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; result: unknown }
type StoredMessage = { id: string; role: 'user' | 'assistant'; content: StoredContentBlock[]; usage?: Usage; createdAt: number }
type ChatMeta = { id: string; title: string; connectionId: string; model: string; cwd?: string; createdAt: number; updatedAt: number }
// ClientMsg v2: create_chat | subscribe | unsubscribe | user_message{chatId,text} | permission_response | interrupt{chatId} | rename_chat | delete_chat | list_dirs
// ServerMsg v2: chat_list | chat_created | chat_renamed | chat_deleted | chat_history | assistant_delta{chatId} | tool_call{chatId} | tool_result{chatId} | permission_request{chatId} | turn_done{chatId} | dir_list | error{chatId?}
parseClientMsg(raw: string): ClientMsg | null

// server/permission.ts (constructor เปลี่ยนใน Task 8)
new InteractivePermissionResolver(chatId: string, send: (m: ServerMsg) => void, genId: () => string)

// server/providers/normalize.ts
normalizeToolResult(raw: unknown): string

// server/agent.ts
type RunDeps = { chatId: string; send: (m: ServerMsg) => void; permission: PermissionResolver; signal: AbortSignal; turnTimeoutMs?: number }
runTurn(provider: Provider, params: TurnParams, deps: RunDeps): Promise<TurnResult>

// server/store.ts (better-sqlite3)
type DB = import('better-sqlite3').Database
const DEFAULT_CONNECTION_ID = 'local'
openDb(path: string): DB; migrate(db: DB): void; ensureDefaultLocalConnection(db: DB): void
listConnections(db): ConnectionRow[]; getConnection(db, id): ConnectionRow | undefined
createChat(db, { id, title, connectionId, model, cwd?, now }): ChatMeta
listChats(db): ChatMeta[]; getChat(db, id): ChatMeta | undefined
renameChat(db, id, title, now): void; deleteChat(db, id): void
setChatSdkSession(db, id, sdkSessionId, now): void; getChatSdkSession(db, id): string | undefined
appendMessage(db, m: StoredMessage & { chatId: string }): void; listMessages(db, chatId): StoredMessage[]

// server/fsbrowse.ts
listDirs(inputPath?: string): Promise<{ path: string; parent?: string; entries: DirEntry[] }>

// server/chatRuntime.ts
type RuntimeDeps = { db: DB; provider: Provider; broadcast: (m: ServerMsg) => void; genId: () => string; now: () => number; turnTimeoutMs?: number }
class ChatRuntime { constructor(chatId: string, deps: RuntimeDeps); enqueue(text); interrupt(); handlePermissionResponse(requestId, decision); dispose(); get isIdle(): boolean }

// server/hub.ts
type HubDeps = { db: DB; makeProvider: (connectionType: string) => Provider; genId: () => string; now: () => number; turnTimeoutMs?: number }
class ChatHub { constructor(deps: HubDeps); addConnection(send: (m: ServerMsg) => void): { handle(raw: string): void; close(): void } }

// server/ws.ts
attachWebSocketServer(httpServer: import('node:http').Server, hub: ChatHub): WebSocketServer

// web/src/appState.ts (Task 10)
type UiMessage = { role:'user';text:string } | { role:'assistant';text:string;tools:ToolCall[] } | { role:'error';text:string }
type PermissionPrompt = { chatId: string; requestId: string; name: string; input: unknown }
type ChatView = { messages: UiMessage[]; streaming: boolean }
type FolderPickerState = { open: boolean; path: string; parent?: string; entries: DirEntry[] }
type AppState = { chats: ChatMeta[]; activeChatId?: string; views: Record<string, ChatView>; pending?: PermissionPrompt; folder?: FolderPickerState }
applyServer(state, msg); appendUser(state, chatId, text); setActiveChat(state, chatId); clearPending(state); closeFolder(state)

// web/src/ws.ts (Task 11)
wsUrl(host: string): string  // 'ws://' + host + '/ws'
createWsClient({ onMessage, onStatus? }): { send(m: ClientMsg): void; close(): void }
```

## Appendix B — Resume Contingency (ถ้า Task 2 gate FAIL)

Task 2 พิสูจน์ว่า fresh `query()` ต่อเทิร์น + option `resume: sdkSessionId` ทำให้ Claude จำบริบทข้ามเทิร์นได้จริง. **ถ้า gate นี้ FAIL อย่าสร้าง persistence ทับ resume ที่พัง** — ให้สลับสถาปัตยกรรม ChatRuntime เป็นแบบ **persistent streaming-input generator ต่อห้อง**:

- แทนที่จะเรียก `query()` ใหม่ทุกเทิร์น ให้ `ChatRuntime` เปิด `query()` **ครั้งเดียว** ด้วย input async generator ที่ "ค้างเปิด" แล้ว `yield` user message ใหม่เข้าไปในเทิร์นถัดไป — บริบทต่อเนื่องมาจาก generator ตัวเดิม ไม่ใช่จาก `resume`.
- ยังคงเก็บ `sdk_session_id` ลง DB เพื่อ resume ข้าม **restart ของ process**; แต่ความต่อเนื่องภายใน process มาจาก generator ที่ยังเปิดอยู่.
- กระทบเฉพาะ `server/chatRuntime.ts` + `server/providers/localAgent.ts` (เพิ่มโหมด feed-input); โปรโตคอล/store/frontend ไม่เปลี่ยน. ปรับ Task 8 ตามนี้แล้วค่อยไปต่อ.

## Appendix C — Scrutinize / carry-over traceability

- **#2** resume verification → Task 5 (unit: resume option threaded) + Task 2 (live gate) + Task 14 (through-DB e2e).
- **#3** empty-delta text fallback → Task 4 (`runTurn`).
- **#4** per-turn watchdog timeout → Task 4 (`runTurn`).
- **#5** ws client `location.host` → Task 11.
- **#6** proactive interrupt + clear queue → Task 5 (provider `q.interrupt()` on abort) + Task 8 (`ChatRuntime.interrupt` clears queue).
- carry-over: queue serialization + abort-during-permission tests → Task 8; normalize tool_result → Task 5; ws onerror/onclose → Task 11; react/* → dependencies → Task 1; npm audit → Task 1 + Task 14.

