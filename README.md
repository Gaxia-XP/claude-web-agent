# Claude Web Agent

Local web app for chatting with Claude (local-agent via Claude Agent SDK) as a full agent — streaming tokens, tool use, and permission controls in the browser.

## Prerequisites

- Node 20+
- Claude Agent SDK login on this machine (same credentials used by Claude Code)

## Run (dev)

```bash
npm install
npm run dev
```

Open http://localhost:5173

- **Read tools** (Read, Glob, Grep, …) are auto-allowed — no prompt
- **Write/run tools** (Write, Edit, Bash, …) show a permission modal before executing

## How it works

The browser connects over WebSocket to a local Fastify server (`ws://127.0.0.1:8787/ws`). The server runs each turn through `LocalAgentProvider`, which calls the Claude Agent SDK in streaming-input mode. Streamed text arrives as `assistant_delta` messages; tool calls and permission requests flow back to the UI in real time.

## Status

**M1 — single-room, no persistence, localhost only.** See `docs/superpowers/specs/` for the full roadmap (M2–M6: multi-room sidebar, persistence, FolderPicker, LAN access, auth).

## Testing

```bash
npm test          # unit suite (22 tests)
npm run build:web # production build
npx tsx scripts/e2e-ws.mjs  # live end-to-end WebSocket test (requires SDK login)
```
