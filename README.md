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

## Compatibility API (`/v1`)

The server also exposes a **stateless** LLM-gateway surface that external harnesses (open-webui,
claude-cli, Claude Code, etc.) can point at. Base URL: `http://127.0.0.1:8787/v1`
(M5 is localhost-only; LAN bind + bearer token arrive in M6).

### Model-id grammar

Compat model ids encode both the connection and the permission policy:

| Model id | Connection | Policy |
| --- | --- | --- |
| `<connName>/<model>` | connection named `<connName>` | `readonly` — read-only tools auto-allowed, writes/commands denied |
| `<connName>-auto/<model>` | connection named `<connName>` | `auto` — all tools allowed (local-agent only; provider-API connections ignore it) |

The `<model>` segment after the first `/` is passed through to the provider unchanged, so it may
itself contain slashes (e.g. `openrouter/anthropic/claude-3.5-sonnet`).

`GET /v1/models` lists one id per connection (plus a `-auto` variant for `local-agent` connections).

### Endpoints

| Method | Path | Wire format | Notes |
| --- | --- | --- | --- |
| `GET` | `/v1/models` | OpenAI list | `{ object:'list', data:[{ id, object:'model', ... }] }` |
| `POST` | `/v1/chat/completions` | OpenAI chat | `{ model, messages, stream? }` → JSON or SSE + `[DONE]` |
| `POST` | `/v1/messages` | Anthropic messages | `{ model, messages, max_tokens?, stream? }` → JSON or SSE event sequence |

All three endpoints are **stateless** — the harness sends the full `messages[]` every call.
No DB persistence of compat turns, no live-sync to the WebSocket UI.

### open-webui setup

1. Add a new **OpenAI-compatible** connection in open-webui.
2. Set the **OpenAI API base URL** to `http://<host>:8787/v1`.
3. Enter any string as the API key (M5 ignores it).
4. Refresh the model list — you should see `local/sonnet`, `local-auto/sonnet`, and any other connections you have configured.
5. Pick a `local-auto/...` model to let the agent write and run tools autonomously.

### claude-cli / Claude Code setup

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787/v1
export ANTHROPIC_API_KEY=anything       # M5 ignores the token
# Claude Code / claude-cli will route POST /v1/messages through this server.
```

### Security warning

`-auto` models run the local-agent with **no permission prompts** — the agent may read, write,
and execute on your machine without confirmation. Only expose these model ids to trusted harnesses.
The server binds `127.0.0.1` in M5; do not reverse-proxy it to a network until M6 auth is in place.

### Limitations & behavior notes (M5)

- **Multi-turn:** the harness sends the full `messages[]` each call. For `anthropic-api` /
  `openai-compatible` connections the transcript replays natively. For `local-agent` (stateless here
  — no SDK session to resume), the prior transcript is folded into a single prompt so context is
  preserved; a single-turn request is sent unchanged.
- `system` messages are dropped (local-agent uses the `claude_code` preset; provider-API providers
  have no system channel). A body whose ONLY message is `system` is rejected with `400`.
- Non-text content is unsupported (text-only; array `content` is flattened to its text blocks).
- Intermediate `tool_use` / `tool_result` blocks are not surfaced on the wire — only the final
  assistant text is returned.
- **Streaming errors:** once the `200` headers are sent the status cannot change, so a provider error
  is surfaced as a terminal OpenAI `{"error":{…}}` frame (then `[DONE]`) / Anthropic `event: error` —
  distinct from a normal completion. Non-stream errors return HTTP `500`.
- Connection **names must be unique** and should not end in `-auto`: the model-id grammar reserves the
  `-auto` suffix for the auto-permission policy, so a connection literally named `x-auto` is
  unreachable as `x-auto/<model>` (it parses as the auto variant of `x`).
- No keep-alive ping yet — a long first-token gap on a slow local-agent turn could hit an intermediary
  idle timeout (M6). No auth, no persistence, no live-sync (M5).

## Status

**M5 — Compatibility API (`/v1`).** M1 established the baseline (local-agent streaming + tool use). M2 added multi-chat, SQLite persistence, resume, and FolderPicker. M3 added the full provider system: create / edit / delete connections from the Settings page, pick connection + model in the New Chat modal, and route each turn through the correct provider. M4 adds the native HTTP REST + SSE surface (see "Native HTTP API" above). M5 adds the OpenAI-compatible (`/v1/chat/completions`) and Anthropic-compatible (`/v1/messages`) gateway endpoints (see "Compatibility API" above). See `docs/superpowers/specs/` for the full roadmap (M6: LAN bind + auth).

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
npx tsx scripts/e2e-compat.mjs    # compat API (/v1/models + /v1/chat/completions + /v1/messages) e2e — no credentials required
npx tsx scripts/e2e-multichat.mjs # local-agent multi-chat + persistence + resume e2e (requires Claude login)
```

The e2e scripts boot the server against a throwaway temp database on a dedicated port, so they never touch `data/chats.db`.
