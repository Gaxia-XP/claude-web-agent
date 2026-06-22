# Windows auto-start + quick-start guide — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Windows ops scripts so the Claude Web Agent server starts at logon (hidden, `0.0.0.0`, restart-on-failure) via Task Scheduler, plus an English `docs/QUICKSTART.md`.

**Architecture:** Pure ops layer — three PowerShell scripts + one doc + small README/.gitignore edits. No application-code changes. A launcher (`start-server.ps1`) is the single source of run behavior; an install script registers a Scheduled Task that runs the launcher; an uninstall script removes it.

**Tech Stack:** Windows PowerShell 5.1 cmdlets (`*-ScheduledTask*`, `*-NetFirewallRule`, `Get-NetTCPConnection`); Node 20+ / npm; existing `npm start` (`tsx server/index.ts`).

## Global Constraints

- No application-code changes; new files + README pointer + `.gitignore` only.
- Auto-start mechanism: **Task Scheduler**, trigger **AtLogOn**, **as the current user**, `-LogonType Interactive`, `-RunLevel Limited`. (local-agent needs the user's Claude login → never SYSTEM.)
- Bind `HOST=0.0.0.0`; leave `PORT` to the server default (8787) unless caller exports one.
- Task name constant: `ClaudeWebAgent`. Scripts are idempotent and `-NoProfile`-safe.
- Server resolves `web/dist` from `process.cwd()` → launcher MUST `Set-Location` to repo root.
- Hidden window → all server output appends to `logs/server.log` (gitignored).
- PowerShell gotcha: `$pid` is an automatic variable — use `$procId` for process-id loop vars.

---

### Task 1: Launcher `scripts/start-server.ps1`

**Files:**
- Create: `scripts/start-server.ps1`

**Interfaces:**
- Produces: a runnable launcher invoked as `powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File scripts\start-server.ps1`. Consumed by Task 2's action.

**Behavior:** resolve repo root from `$PSScriptRoot\..` + `Set-Location`; default `$env:HOST='0.0.0.0'` if unset; ensure `logs/`; write a timestamped start banner to `logs/server.log`; if `web\dist` missing run `npm run build:web`; then `& npm start *>> logs/server.log`. Resolve npm via `(Get-Command npm.cmd).Source` (fallback `npm`).

- [ ] **Step 1: Write the script** (full content)

```powershell
#requires -Version 5
# Launcher for the Claude Web Agent server — used by the ClaudeWebAgent scheduled task and runnable
# by hand. Resolves the repo root from this script's location, ensures a production web build, binds
# 0.0.0.0, and appends all output to logs/server.log (the task runs hidden, so the log is where you
# read the token / LAN URLs / errors).
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

if (-not $env:HOST) { $env:HOST = '0.0.0.0' }   # PORT left to the server default (8787) unless exported

$logDir = Join-Path $repo 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'server.log'

$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
"`n==== Claude Web Agent start $stamp (HOST=$($env:HOST) PORT=$($env:PORT)) ====" |
  Out-File -FilePath $log -Append -Encoding utf8

# npm is a .cmd shim on Windows; resolve it explicitly so a -NoProfile/non-interactive shell finds it.
$npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if (-not $npm) { $npm = (Get-Command npm -ErrorAction Stop).Source }

# Self-heal: build the SPA if web/dist is missing (fresh clone / after a clean).
if (-not (Test-Path (Join-Path $repo 'web\dist'))) {
  "web/dist missing -> building (npm run build:web)..." | Out-File -FilePath $log -Append -Encoding utf8
  & $npm run build:web *>> $log
}

# Foreground: keeps this (hidden) process alive so Task Scheduler shows the task as Running.
& $npm start *>> $log
```

- [ ] **Step 2: Syntax check**

Run: `powershell -NoProfile -Command "$null = [ScriptBlock]::Create((Get-Content -Raw scripts/start-server.ps1)); 'OK'"`
Expected: prints `OK` (no parse error).

- [ ] **Step 3: Smoke test** (foreground, manual)

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-server.ps1` in one shell; in another, after a few seconds: `curl -s localhost:8787/api/health` → `{"status":"..."}` and `logs/server.log` shows the start banner + `listening on`. Then Ctrl-C / kill; free the port if it lingers.

- [ ] **Step 4: Commit**

```bash
git add scripts/start-server.ps1
git commit -m "feat(autostart): add start-server.ps1 launcher (cwd, 0.0.0.0, build-if-missing, file log)"
```

---

### Task 2: Install/uninstall scripts

**Files:**
- Create: `scripts/install-autostart.ps1`
- Create: `scripts/uninstall-autostart.ps1`

**Interfaces:**
- Consumes: `scripts\start-server.ps1` (Task 1) as the task action target.
- Produces: a Scheduled Task `ClaudeWebAgent`; uninstall removes it + frees the port + removes the firewall rule.

- [ ] **Step 1: Write `install-autostart.ps1`** (full content)

```powershell
#requires -Version 5
# Registers the "ClaudeWebAgent" scheduled task: runs scripts/start-server.ps1 hidden at logon, as
# the current user, restarting on failure. Idempotent. Adds a firewall rule when run elevated.
$ErrorActionPreference = 'Stop'

$TaskName = 'ClaudeWebAgent'
$repo = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $repo 'scripts\start-server.ps1'
$port = if ($env:PORT) { [int]$env:PORT } else { 8787 }
if (-not (Test-Path $launcher)) { throw "launcher not found: $launcher" }

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcher`""
$trigger = New-ScheduledTaskTrigger -AtLogOn
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false   # idempotent: replace
}
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings `
  -Description 'Claude Web Agent — start the server at logon (LAN-bound, hidden).' | Out-Null
Write-Host "Registered '$TaskName' (logon, as $env:USERNAME, hidden, HOST=0.0.0.0, port $port)."

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
$fwName = "ClaudeWebAgent TCP $port"
if ($isAdmin) {
  if (-not (Get-NetFirewallRule -DisplayName $fwName -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName $fwName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port -Profile Private | Out-Null
    Write-Host "Added firewall rule '$fwName' (Private profile)."
  }
} else {
  Write-Host "`nNOTE: not elevated -- no firewall rule added. For LAN/phone access run once elevated:"
  Write-Host "  New-NetFirewallRule -DisplayName '$fwName' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port -Profile Private"
}
Write-Host "`nStart now : Start-ScheduledTask -TaskName $TaskName"
Write-Host "View log  : Get-Content -Wait -Tail 40 `"$repo\logs\server.log`""
Write-Host "Uninstall : powershell -ExecutionPolicy Bypass -File `"$repo\scripts\uninstall-autostart.ps1`""
```

- [ ] **Step 2: Write `uninstall-autostart.ps1`** (full content)

```powershell
#requires -Version 5
# Removes the "ClaudeWebAgent" scheduled task, frees a lingering listener on the port, and removes
# the firewall rule (when elevated).
$ErrorActionPreference = 'Stop'
$TaskName = 'ClaudeWebAgent'
$port = if ($env:PORT) { [int]$env:PORT } else { 8787 }

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed scheduled task '$TaskName'."
} else {
  Write-Host "Scheduled task '$TaskName' not found (nothing to remove)."
}

# The tsx child can outlive a task stop — free any listener still holding the port.
$conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
foreach ($procId in ($conns.OwningProcess | Sort-Object -Unique)) {
  try { Stop-Process -Id $procId -Force -ErrorAction Stop; Write-Host "Stopped lingering PID $procId on port $port." } catch {}
}

$fwName = "ClaudeWebAgent TCP $port"
if (Get-NetFirewallRule -DisplayName $fwName -ErrorAction SilentlyContinue) {
  try { Remove-NetFirewallRule -DisplayName $fwName -ErrorAction Stop; Write-Host "Removed firewall rule '$fwName'." }
  catch { Write-Host "Could not remove firewall rule '$fwName' (run elevated to remove it)." }
}
```

- [ ] **Step 3: Syntax check both** (`[ScriptBlock]::Create` on each, expect `OK`).

- [ ] **Step 4: Functional verify**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-autostart.ps1` → prints "Registered". `Get-ScheduledTask -TaskName ClaudeWebAgent` shows it. `Start-ScheduledTask -TaskName ClaudeWebAgent`; after a few seconds `curl -s localhost:8787/api/health` → `{status}` and `logs/server.log` shows the banner. Then `powershell -File scripts/uninstall-autostart.ps1` → task gone, port freed.

- [ ] **Step 5: Commit**

```bash
git add scripts/install-autostart.ps1 scripts/uninstall-autostart.ps1
git commit -m "feat(autostart): add install/uninstall scheduled-task scripts (logon, restart, firewall)"
```

---

### Task 3: Quick-start guide + wiring

**Files:**
- Create: `docs/QUICKSTART.md`
- Modify: `README.md` (one-line pointer near "Run")
- Modify: `.gitignore` (ensure `logs/` ignored)

- [ ] **Step 1: Write `docs/QUICKSTART.md`** — English. Sections: Prerequisites (Node 20+, Git, Claude login for local-agent) · First-time setup (`npm install`, `npm run build:web`) · Run once (`npm start`; read banner: token, LAN URLs, QR) · Enable auto-start (`install-autostart.ps1`; binds `0.0.0.0`, hidden at logon; firewall note) · Access from your phone (terminal QR / **in-app Settings QR** / open `http://<lan-ip>:8787` + paste token from `data/.token`) · Manage (`Get-ScheduledTask`/`Start`/`Stop`, log at `logs/server.log`, uninstall) · Update after `git pull` (rebuild + restart task) · Troubleshooting (port 8787 in use → `Get-NetTCPConnection -LocalPort 8787` + `taskkill`; Windows Firewall for LAN; token location). Use exact commands.

- [ ] **Step 2: README pointer** — add under the run area: `> **Windows quick-start (install + run at startup):** see [docs/QUICKSTART.md](docs/QUICKSTART.md).`

- [ ] **Step 3: `.gitignore`** — confirm/add a `logs/` entry (check existing file first; only add if missing).

- [ ] **Step 4: Commit**

```bash
git add docs/QUICKSTART.md README.md .gitignore
git commit -m "docs(autostart): add Windows QUICKSTART guide + README pointer + ignore logs/"
```

---

## Self-Review

**Spec coverage:** start-server.ps1 (Task 1), install/uninstall (Task 2), QUICKSTART + README + .gitignore (Task 3) — every spec component mapped. ✅
**Placeholder scan:** all script bodies are complete; QUICKSTART content is enumerated by section with exact commands (prose doc, not code-gen). ✅
**Type/name consistency:** task name `ClaudeWebAgent`, launcher path `scripts\start-server.ps1`, firewall name `ClaudeWebAgent TCP <port>`, log `logs/server.log` — consistent across all three scripts. `$procId` (not `$pid`) used. ✅

## Verification (whole feature)

Syntax-check all three `.ps1`; install → Start → `/api/health` 200 + banner in `logs/server.log` → uninstall (clean). Confirm `data/`, `logs/`, `web/dist` untracked.
