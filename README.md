# Claude Web Agent

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Local web app for chatting with Claude across multiple providers — full agent mode (local-agent), Anthropic API (stateless chat), or any OpenAI-compatible endpoint (OpenRouter, Ollama, etc.).

> **New here?** **Windows:** see **[docs/QUICKSTART.md](docs/QUICKSTART.md)** for a guided setup (install, run, phone access, and auto-start at logon). **Linux/macOS:** jump to [Prerequisites](#prerequisites) and [Run (dev)](#run-dev) below — `npm install && npm run build:web && npm start` is all you need.

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
  # Claude Code / claude-cli will route POST /v1/messages through this server.
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

> Dev also requires the bearer token (M6). Grab it from the `dev:server` startup banner
> or `data/.token`, then either paste it into the Login screen or open
> `http://localhost:5173/#token=$(cat data/.token)` to auto-login. See "Security / Run" above.

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

- **Add a connection** — choose provider type (`anthropic-api` or `openai-compatible`), enter a name, base URL (if needed), API key (if needed), and default model. The built-in `local` (local-agent) connection is created automatically on first run and cannot be added or duplicated from Settings — `local-agent` is not offered in the type chooser, so there is always exactly one local-agent connection.
- **Edit a connection** — update the name, base URL, default model, or rotate the API key. The provider type is fixed once the connection is created.
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
| GET | `/api/lan-urls` | — | `{ urls }` — LAN base URLs (`http://<ip>:<port>`) for the in-page Settings QR; token-guarded; `[]` when no LAN interface is found |
| GET | `/api/health` | — | `{ status }` — liveness; the **only** `/api/*` route that does not require the token |

- `permission`: `readonly` (default — read-only tools auto-allowed, writes/commands denied) or
  `auto` (all tools allowed). Applies to local-agent connections; chat-only providers ignore it.
- SSE events: `delta` `{text}`, `tool_call` `{id,name,input}`, `tool_result` `{id,result}`,
  `done` `{usage}`, `error` `{message}` (and a leading `chat` `{chatId}` for `/api/query`).
- **Auth:** every `/api/*` route (except `GET /api/health`) requires the bearer token —
  `Authorization: Bearer <token>` or `x-api-key: <token>` (see "Security / Run" above).

Example (every `/api/*` call carries the bearer token):
```bash
TOKEN=$(cat data/.token)
curl -s localhost:8787/api/connections -H "Authorization: Bearer $TOKEN"
CHAT=$(curl -s -XPOST localhost:8787/api/chats -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{}' | jq -r .chatId)
curl -s -XPOST localhost:8787/api/chats/$CHAT/messages -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"text":"hello"}'
```

## Compatibility API (`/v1`)

The server also exposes a **stateless** LLM-gateway surface that external harnesses (open-webui,
claude-cli, Claude Code, etc.) can point at. Base URL: `http://<host>:<port>/v1`
(LAN-bound by default; every `/v1/*` call requires the bearer token — see "Security / Run").

### Model-id grammar

Compat model ids encode both the connection and the permission policy:

| Model id | Connection | Policy |
| --- | --- | --- |
| `<connName>/<model>` | connection named `<connName>` | `readonly` — read-only tools auto-allowed, writes/commands denied |
| `<connName>-auto/<model>` | connection named `<connName>` | `auto` — all tools allowed (local-agent only; provider-API connections ignore it) |
| `<model>` (no `/`) | default `local-agent` connection (seeded `local`, else the first local-agent connection) | `readonly` |

The `<model>` segment after the first `/` is passed through to the provider unchanged, so it may
itself contain slashes (e.g. `openrouter/anthropic/claude-3.5-sonnet`).

A **bare** model id with no `/` (e.g. `sonnet`, `claude-opus-4-7`) is also accepted, for lenient
clients (LMSA, OpenAI SDKs) that send just a model name. It routes to the **default `local-agent`
connection** — the seeded `local` connection if present, otherwise the first local-agent connection
created — with the **`readonly`** policy, passing the bare string through as the model. It is not
advertised by `GET /v1/models`. An id that *contains* a `/` but fails to parse (e.g. `/x`, `local/`)
is malformed and returns `404` — it is **not** treated as a bare name; a bare id also returns `404`
if no local-agent connection exists.

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
3. Enter the bearer token (from `data/.token` / the startup banner) as the API key.
4. Refresh the model list — you should see `local/sonnet`, `local-auto/sonnet`, and any other connections you have configured.
5. Pick a `local-auto/...` model to let the agent write and run tools autonomously.

### claude-cli / Claude Code setup

```bash
export ANTHROPIC_BASE_URL=http://<host>:<port>
export ANTHROPIC_API_KEY=<token>        # sent as x-api-key; the server checks it
# Claude Code / claude-cli will route POST /v1/messages through this server.
```

### Security warning

`-auto` models run the local-agent with **no permission prompts** — the agent may read, write,
and execute on your machine without confirmation. Only expose these model ids to trusted harnesses.
All `/v1/*` calls require the bearer token; still, only enable `-auto` ids on trusted networks.

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
  idle timeout (deferred). Compat turns have no persistence and no live-sync to the WebSocket UI.

## Status

**M6 — auth + mobile.** M1 established the baseline (local-agent streaming + tool use). M2 added multi-chat, SQLite persistence, resume, and FolderPicker. M3 added the full provider system: create / edit / delete connections from the Settings page, pick connection + model in the New Chat modal, and route each turn through the correct provider. M4 added the native HTTP REST + SSE surface (see "Native HTTP API" above). M5 added the OpenAI-compatible (`/v1/chat/completions`) and Anthropic-compatible (`/v1/messages`) gateway endpoints (see "Compatibility API" above). M6 adds LAN bind (`0.0.0.0`), bearer-token auth on all `/api/*` and `/v1/*` routes, a Login screen with QR auto-login, and a responsive mobile layout (see "Security / Run" above). See `docs/superpowers/specs/` for the full roadmap.

**Post-M6 (public release).** The project is now public and **MIT-licensed** (see [LICENSE](LICENSE)). Added a Windows **auto-start** option (`scripts/install-autostart.ps1` / `uninstall-autostart.ps1` / `start-server.ps1`; see [docs/QUICKSTART.md](docs/QUICKSTART.md)) plus runtime hardening: compat non-streaming abort handling, a `local-agent` API-error guard, lenient **bare** compat model ids (a model id with no `/` routes to the default `local-agent` connection with the `readonly` policy), and a token-guarded `GET /api/lan-urls` endpoint behind the in-page QR. Test suite: 348 passing.

## Security

**Provider API keys** are stored in `data/chats.db` (gitignored), server-side only. They are never included in `connection_list` broadcasts, never sent to the browser after being saved, and never logged. This is enforced at the store layer — `listConnections` / `getConnection` return `ConnectionMeta` which omits `apiKey`; only `getConnectionWithSecret` (used internally by the hub to instantiate a provider) returns the key.

**`list_dirs` exposes the server's directory tree (names only).** The server LAN-binds (`0.0.0.0`) by default, but `list_dirs` runs over the WebSocket, which now requires the bearer token (subprotocol `['bearer', <token>]`) — so an unauthenticated LAN peer cannot reach it. It is still names-only and not scoped to a root set; treat exposure beyond a trusted network (e.g. a public tunnel) as sensitive.

**LAN access and authentication** ship in M6: the server binds `0.0.0.0` and every `/api/*` (except `GET /api/health`), `/v1/*`, and WebSocket connection is gated by the bearer token in `data/.token`. Do not expose the server publicly without the token in place (the QR / `#token=` flow is the supported way to share it). For remote access, prefer a tunnel (cloudflared / ngrok) over raw port-forwarding.

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

## License

[MIT](LICENSE) © 2026 Gaxia-XP.
