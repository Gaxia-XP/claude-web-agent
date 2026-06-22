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
  -Description 'Claude Web Agent - start the server at logon (LAN-bound, hidden).' | Out-Null
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
