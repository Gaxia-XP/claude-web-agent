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
