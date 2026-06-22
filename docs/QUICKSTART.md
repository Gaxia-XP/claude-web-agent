# Quick Start (Windows)

Get the Claude Web Agent running on your PC, reachable from your phone, and (optionally) starting
automatically every time you log in.

> The app itself is cross-platform (`npm start`), but the auto-start scripts below are **Windows-only**
> (Task Scheduler / PowerShell).

## 1. Prerequisites

- **Node.js 20+** — check with `node --version`
- **Git** (to clone and pull updates)
- For **local-agent** chats (full agent mode): a **Claude login on this machine** — the same
  credentials Claude Code uses. The server runs as *you*, so it uses your login.
- (Optional) An Anthropic API key, or any OpenAI-compatible endpoint, for the other provider types.

## 2. First-time setup

```powershell
git clone https://github.com/Gaxia-XP/claude-web-agent.git
cd claude-web-agent
npm install
npm run build:web      # builds the SPA into web/dist (served by the server)
```

## 3. Run it once (manually)

```powershell
npm start
```

The startup banner prints:

- the **bearer token** (also saved to `data\.token`),
- the **LAN URLs** (e.g. `http://192.168.1.2:8787`),
- a **QR code** that opens the app on your phone and auto-logs-in.

Open `http://localhost:8787` in your browser, or scan the QR with your phone (same Wi-Fi). Press
`Ctrl+C` to stop.

## 4. Start automatically at logon

Register a Scheduled Task that launches the server **hidden** every time you log in, bound to
`0.0.0.0` (LAN), and restarts it if it crashes:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
```

- Runs as **you** (so local-agent has your Claude login); no admin needed for the listener itself.
- The window is hidden — all output (token, URLs, errors) goes to **`logs\server.log`**.
- **Firewall (for phone access):** run the installer **once in an elevated PowerShell**
  (*Run as administrator*) so it can add an inbound rule for port 8787 — or run the one-liner the
  script prints. Without the rule, Windows Firewall may silently block LAN access (the interactive
  prompt never appears under a hidden launch).

Start it immediately instead of waiting for the next logon:

```powershell
Start-ScheduledTask -TaskName ClaudeWebAgent
```

## 5. Connect your phone

The auto-start window is hidden, so use any of these:

- **In-app QR** — open `http://localhost:8787` on the PC → **Settings** (gear icon) → scan the QR
  with your phone. It points at a LAN IP and embeds the token (auto-login). If you have several IPs
  (e.g. a VPN/virtual adapter), use the IP selector buttons to pick a reachable one.
- **Token URL** — on the phone, open `http://<lan-ip>:8787` and paste the token from `data\.token`.

Find your token and LAN IP anytime:

```powershell
Get-Content data\.token
(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -like '192.168.*' -or $_.IPAddress -like '10.*' }).IPAddress
```

## 6. Manage the auto-start

```powershell
Get-ScheduledTask -TaskName ClaudeWebAgent            # is it registered?
Get-Content -Wait -Tail 40 logs\server.log           # follow the live log
Stop-ScheduledTask  -TaskName ClaudeWebAgent          # stop the running server
Start-ScheduledTask -TaskName ClaudeWebAgent          # (re)start it
powershell -ExecutionPolicy Bypass -File scripts\uninstall-autostart.ps1   # remove auto-start
```

## 7. Update after `git pull`

```powershell
git pull
npm install            # only if dependencies changed
npm run build:web      # rebuild the SPA
Stop-ScheduledTask  -TaskName ClaudeWebAgent
# Stop-ScheduledTask kills the task's PowerShell host, but the tsx/node child can keep holding
# port 8787 — free any lingering listener so the restart doesn't hit EADDRINUSE (use your PORT if custom):
Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
Start-ScheduledTask -TaskName ClaudeWebAgent
```

## 8. Troubleshooting

- **Port 8787 already in use** (`EADDRINUSE`): a previous run may have lingered. Find and stop it:
  ```powershell
  Get-NetTCPConnection -LocalPort 8787 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
  ```
  (The uninstall script does this for you.)
- **Phone can't connect:** confirm the firewall rule exists (step 4), the phone is on the same Wi-Fi,
  and you used the LAN IP — not `localhost`. The in-app Settings QR warns when it would point at
  `localhost`.
- **Blank page / nothing loads:** make sure `npm run build:web` has run (the server serves
  `web/dist`); the launcher rebuilds it automatically if it's missing.
- **Where's the token?** `data\.token` (generated on first run, reused afterwards). Never commit it —
  `data\` is gitignored.
- **Change the port:** set `PORT` before installing (`$env:PORT = 9000`), then re-run the install
  script; pass the same `PORT` when running the uninstall script.

See **[README.md](../README.md) → "Security / Run"** for the full environment-variable reference, the
compat `/v1` API, and tunnel (cloudflared / ngrok) access.
