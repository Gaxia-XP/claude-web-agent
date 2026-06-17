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

**M2 — multi-chat + SQLite persistence + resume + FolderPicker, localhost only.** Multiple chats live in a sidebar (create / rename / delete); each chat persists its messages and SDK session to a local SQLite database, so conversations survive a reload and turns resume the prior session. A FolderPicker lets you choose each chat's working directory. See `docs/superpowers/specs/` for the full roadmap (M3–M6: LAN access, auth, and beyond).

## Persistence

Chats and messages are stored in a local SQLite database (via `better-sqlite3`). By default the file lives at `data/chats.db`, which is **gitignored** — your conversations never get committed. The `data/` directory is created automatically on first run.

Override the location with the `DB_PATH` environment variable (use `:memory:` for an ephemeral, in-process database — handy for tests and throwaway runs):

```bash
DB_PATH=/tmp/my-chats.db npm run dev
```

## Testing

```bash
npm test                          # unit suite (96 tests, Vitest, environment node)
npm run build:web                 # production build of the web app
npx tsx scripts/e2e-multichat.mjs # live multi-chat + persistence + resume e2e (requires Claude login)
```

The e2e script spawns the server against a throwaway temp database (its own `DB_PATH`) on a dedicated port, so it never touches `data/chats.db`.
