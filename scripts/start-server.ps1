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
# Redirect via cmd's byte-level append (node/vite emit UTF-8) instead of PowerShell's *>> operator,
# which re-encodes to UTF-16LE in 5.1 and would garble the log. $npm/$log are quoted (paths may
# contain spaces, e.g. "C:\Program Files\nodejs\npm.cmd").
if (-not (Test-Path (Join-Path $repo 'web\dist'))) {
  "web/dist missing -> building (npm run build:web)..." | Out-File -FilePath $log -Append -Encoding utf8
  & cmd /c "`"$npm`" run build:web >> `"$log`" 2>&1"
}

# Foreground: keeps this (hidden) process alive so Task Scheduler shows the task as Running.
& cmd /c "`"$npm`" start >> `"$log`" 2>&1"
