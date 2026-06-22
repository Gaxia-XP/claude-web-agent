# Windows auto-start + quick-start guide — design

**Date:** 2026-06-23 · **Status:** approved (brainstorming) · **Branch:** `feat/win-autostart` (off master `117507f`)

## Goal

One command makes the Claude Web Agent server start automatically at Windows logon — hidden window,
LAN-bound (`0.0.0.0`), restarting on failure — plus an English quick-start guide that walks a user
from a fresh clone to "running + reachable from my phone." No application-code changes; new ops
scripts and docs only.

## Decisions (from brainstorming)

- **Mechanism:** Windows **Task Scheduler**, trigger **AtLogOn**, running **as the current user**
  ("run only when logged on"). Rationale: `local-agent` uses the user's Claude login (per Windows
  profile), so the server must run in the user's session — a SYSTEM-level service would have no
  Claude credentials. Task Scheduler also gives a hidden window, restart-on-failure, and
  enable/disable without extra software.
- **Bind:** `HOST=0.0.0.0` (LAN/phone reachable; token-guarded). Overridable.
- **Guide language:** English (matches README/docs).

## Components (4 new files, no app-code changes)

### 1. `scripts/start-server.ps1` — the launcher Task Scheduler runs

- Resolve repo root from `$PSScriptRoot\..` and `Set-Location` there, so the server's
  `process.cwd()`-relative `web/dist` lookup (server/index.ts:40) resolves correctly.
- `$env:HOST = '0.0.0.0'` (unless already set); honor an existing `$env:PORT` (default 8787 left to
  the server).
- Self-heal build: if `web/dist` is missing, run `npm run build:web` before starting; otherwise skip.
- Ensure `logs/` exists; append the server's combined stdout+stderr to `logs/server.log` with a
  startup timestamp banner. (The Task window is hidden, so the log is the only place to read the
  token / LAN URLs / errors.)
- Exec `npm start` in the foreground of this (hidden) process so the task stays "Running".
- Robustness: call npm via the resolved `npm.cmd`; `-NoProfile`-safe (no profile assumptions).

### 2. `scripts/install-autostart.ps1` — register the Scheduled Task

- Task name: `ClaudeWebAgent` (constant; idempotent — unregister any same-name task first).
- **Trigger:** `New-ScheduledTaskTrigger -AtLogOn` (current user).
- **Action:** `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File <repo>\scripts\start-server.ps1`.
- **Principal:** current user, `-LogonType Interactive`, `-RunLevel Limited` (no admin needed for an
  8787 listener).
- **Settings:** `-RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)`,
  `-StartWhenAvailable`, `-ExecutionTimeLimit 0` (unlimited),
  `-MultipleInstances IgnoreNew` (never start a parallel copy).
- **Firewall:** if the process is elevated, add an inbound `New-NetFirewallRule` for the TCP port so
  LAN/phone works without the interactive firewall prompt (which never appears under a hidden boot
  launch). If not elevated, print the exact elevated one-liner instead of failing.
- Print: how to start it now (`Start-ScheduledTask -TaskName ClaudeWebAgent`), where the log is, and
  the uninstall command.

### 3. `scripts/uninstall-autostart.ps1` — remove the Scheduled Task

- `Unregister-ScheduledTask -TaskName ClaudeWebAgent -Confirm:$false` (no-op + clear message if
  absent).
- Offer to stop a still-running instance and free the port (the known lingering-tsx-child gotcha:
  find the listener on the port → `taskkill /T /F`).
- If elevated and the firewall rule exists, remove it.

### 4. `docs/QUICKSTART.md` (English) + a short README pointer

Sections: Prerequisites (Node 20+, Git, Claude login for local-agent) → First-time setup
(`npm install`, `npm run build:web`) → Run once manually (`npm start`, read the banner: token, LAN
URLs, QR) → Enable auto-start (`install-autostart.ps1`; note it binds `0.0.0.0` and runs hidden at
logon) → Access from your phone (terminal QR / **in-app Settings QR** / open `http://<lan-ip>:8787`
and paste the token from `data/.token`) → Manage it (status via `Get-ScheduledTask`, logs at
`logs/server.log`, stop/start/restart, uninstall) → Update after `git pull` (`npm install` if deps
changed, `npm run build:web`, then restart the task) → Troubleshooting (port 8787 in use; Windows
Firewall for LAN; token location; where logs live). Add a one-line link to QUICKSTART from README's
"Run" area.

## Out of scope (YAGNI)

Windows Service / winsw / nssm; pm2; Linux/macOS launchers (systemd/launchd); automated `git pull` /
self-update; log rotation; a tray icon / GUI.

## Verification

- `Get-Command`/syntax sanity on the three `.ps1` (no parse errors); they are non-interactive and
  `-NoProfile`-safe.
- Install on this machine → `Start-ScheduledTask` → confirm: the port is LISTENING, `logs/server.log`
  shows the startup banner, and `GET /api/health` returns `{status}`. Then run the uninstall script
  to leave the machine clean (unless the user wants it kept enabled).
- `data/`, `logs/`, `web/dist` stay gitignored; the token is never written to a tracked file.

## Files touched

- New: `scripts/start-server.ps1`, `scripts/install-autostart.ps1`, `scripts/uninstall-autostart.ps1`,
  `docs/QUICKSTART.md`.
- Edit: `README.md` (one-line pointer to QUICKSTART), `.gitignore` (ensure `logs/` ignored).
