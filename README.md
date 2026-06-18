# Claude Web Agent

Local web app for chatting with Claude across multiple providers — full agent mode (local-agent), Anthropic API (stateless chat), or any OpenAI-compatible endpoint (OpenRouter, Ollama, etc.).

## Prerequisites

- Node 20+
- For `local-agent` connections: Claude Agent SDK login on this machine (same credentials used by Claude Code)
- For `anthropic-api` connections: an Anthropic API key
- For `openai-compatible` connections: a base URL and (optionally) an API key for the endpoint

## Run (dev)

```bash
npm install
npm run dev
```

Open http://localhost:5173

## Providers

Three provider types are supported:

### `local-agent`
Runs the Claude Agent SDK in full agent mode on the server. Requires a Claude machine login (same credentials Claude Code uses). Supports tool use (Read, Glob, Grep, Bash, …) with streaming tokens and a per-chat working directory. Each chat can have its own `cwd` — choose it with the FolderPicker when creating the chat.

- **Read tools** (Read, Glob, Grep, …) are auto-allowed — no prompt
- **Write/run tools** (Write, Edit, Bash, …) show a permission modal before executing

### `anthropic-api`
Uses the `@anthropic-ai/sdk` directly (stateless chat, no tool use). Requires an API key stored server-side. Messages are reconstructed from the database on each turn — no SDK session state. Supported model IDs: `claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5`.

### `openai-compatible`
Sends SSE requests to any OpenAI-compatible endpoint (OpenRouter, Ollama, LM Studio, etc.). Requires a base URL (e.g. `https://openrouter.ai/api/v1`); the API key is optional for local endpoints. Enter the model ID used by that endpoint. Stateless — messages reconstructed from the database each turn.

## Settings

Open the **Settings** page (gear icon in the top bar) to manage connections:

- **Add a connection** — choose provider type, enter a name, base URL (if needed), API key (if needed), and default model.
- **Edit a connection** — update any field, including rotating the API key.
- **Delete a connection** — connections that have chats referencing them cannot be deleted. The built-in `local` connection cannot be deleted.
- **API key** — stored server-side only (see Security). The key is never echoed back to the browser after being saved.

## New Chat

Click **New Chat** to open the creation modal:

1. Pick a **connection** from the dropdown (all configured connections are listed).
2. Enter or confirm the **model ID** (pre-filled from the connection's default model).
3. For `local-agent` connections only: optionally pick a **working directory** with the FolderPicker.

## How it works

The browser connects over WebSocket to a local Fastify server (`ws://127.0.0.1:8787/ws`). Each turn is routed through the appropriate provider based on the chat's connection. Streamed text arrives as `assistant_delta` messages; for `local-agent`, tool calls and permission requests also flow back to the UI in real time.

## Native HTTP API (REST + SSE)

The same chat engine is reachable over REST on the localhost listener (`http://127.0.0.1:8787`,
proxied via Vite `/api` in dev). Turns sent here also broadcast to any WebSocket UI viewing the
same chat (live-sync).

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| GET | `/api/connections` | — | `{ connections }` (no api_key) |
| GET | `/api/chats` | — | `{ chats }` |
| POST | `/api/chats` | `{ connectionId?, model?, cwd?, title? }` | `201 { chatId }` |
| GET | `/api/chats/:id/messages` | — | `{ messages }` (404 if unknown) |
| POST | `/api/chats/:id/messages` | `{ text, stream?, permission? }` | non-stream `{ text, toolCalls, usage }`; stream → SSE |
| POST | `/api/query` | `{ text, connectionId?, model?, cwd?, stream?, permission? }` | one-off chat + turn |

- `permission`: `readonly` (default — read-only tools auto-allowed, writes/commands denied) or
  `auto` (all tools allowed). Applies to local-agent connections; chat-only providers ignore it.
- SSE events: `delta` `{text}`, `tool_call` `{id,name,input}`, `tool_result` `{id,result}`,
  `done` `{usage}`, `error` `{message}` (and a leading `chat` `{chatId}` for `/api/query`).
- **Auth:** M4 binds localhost only and does NOT enforce a bearer token yet. LAN bind
  (`0.0.0.0`) + `Authorization: Bearer <token>` arrive in M6 — do not expose this port to an
  untrusted network until then.

Example:
```bash
curl -s localhost:8787/api/connections
CHAT=$(curl -s -XPOST localhost:8787/api/chats -H 'content-type: application/json' -d '{}' | jq -r .chatId)
curl -s -XPOST localhost:8787/api/chats/$CHAT/messages -H 'content-type: application/json' -d '{"text":"hello"}'
```

## Status

**M4 — native HTTP API (REST + SSE).** M1 established the baseline (local-agent streaming + tool use). M2 added multi-chat, SQLite persistence, resume, and FolderPicker. M3 added the full provider system: create / edit / delete connections from the Settings page, pick connection + model in the New Chat modal, and route each turn through the correct provider. M4 adds the native HTTP REST + SSE surface (see "Native HTTP API" above). See `docs/superpowers/specs/` for the full roadmap (M5–M6: compat API, LAN/auth).

## Security

**Provider API keys** are stored in `data/chats.db` (gitignored), server-side only. They are never included in `connection_list` broadcasts, never sent to the browser after being saved, and never logged. This is enforced at the store layer — `listConnections` / `getConnection` return `ConnectionMeta` which omits `apiKey`; only `getConnectionWithSecret` (used internally by the hub to instantiate a provider) returns the key.

**`list_dirs` exposes the server's directory tree (names only).** This is acceptable because the server binds `127.0.0.1` (localhost only). Before any non-localhost bind — LAN access, reverse proxy, or public exposure — `list_dirs` MUST be bounded to an allowed set of roots and/or require authentication. (Tracked for M6.)

**LAN access and authentication** are out of scope until M6. Do not expose this server to a network without auth in place.

## Persistence

Chats and messages are stored in a local SQLite database (via `better-sqlite3`). By default the file lives at `data/chats.db`, which is **gitignored** — your conversations never get committed. The `data/` directory is created automatically on first run.

Override the location with the `DB_PATH` environment variable (use `:memory:` for an ephemeral, in-process database — handy for tests and throwaway runs):

```bash
DB_PATH=/tmp/my-chats.db npm run dev
```

## Testing

```bash
npm test                           # unit suite (Vitest, environment node)
npm run build:web                  # production build of the web app
npx tsx scripts/e2e-openai.mjs    # openai-compatible e2e — no credentials required
npx tsx scripts/e2e-rest.mjs      # native HTTP API (REST + SSE + live-sync) e2e — no credentials required
npx tsx scripts/e2e-multichat.mjs # local-agent multi-chat + persistence + resume e2e (requires Claude login)
```

The e2e scripts boot the server against a throwaway temp database on a dedicated port, so they never touch `data/chats.db`.
