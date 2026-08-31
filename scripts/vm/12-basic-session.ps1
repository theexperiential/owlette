# Force the VM console into BASIC session mode and reconnect. Run ELEVATED.
#
# WHY THIS EXISTS - the single most confusing failure in this whole setup:
#
# Msvm_Keyboard injection works during OOBE and then silently stops working once
# Windows is fully installed. Every call still returns 0. The cause is Enhanced
# Session Mode: for a Windows guest, VMConnect switches to an RDP-based session
# as soon as the guest's RDP stack is up, and in that mode keyboard input
# arrives over RDP - the SYNTHETIC keyboard is simply not the input path any
# more, so injected keys are accepted by the API and dropped on the floor.
#
# During OOBE there is no RDP service yet, so the console is in basic session
# and injection works. That is the entire difference, and nothing in the error
# surface hints at it.
#
# Basic session is also the better capture surface: it is the guest's raw
# framebuffer rather than an RDP re-render, so no remote-desktop scaling or
# colour handling sits between the guest and ffmpeg.
#
# ASCII ONLY: PowerShell 5.1 decodes a .ps1 as the system ANSI codepage unless
# the file carries a UTF-8 BOM.

#Requires -RunAsAdministrator
param(
  [string]$Name = "owlette-e2e",
  # Re-enable enhanced session mode instead (restores the host default).
  [switch]$Restore
)

$ErrorActionPreference = 'Stop'
$log = Join-Path $env:TEMP ("owlette-vm-session-{0}.log" -f $PID)
Start-Transcript -Path $log -Force | Out-Null
Write-Host "transcript: $log" -ForegroundColor Cyan

try {
  $want = [bool]$Restore
  $before = (Get-VMHost).EnableEnhancedSessionMode
  Write-Host "EnableEnhancedSessionMode: $before -> $want" -ForegroundColor Cyan
  Set-VMHost -EnableEnhancedSessionMode $want
  Write-Host "host setting applied." -ForegroundColor Green

  # VMConnect keeps its session type for the life of the connection, so an open
  # window must be closed and reopened to pick up the change.
  $procs = @(Get-CimInstance Win32_Process -Filter "Name='vmconnect.exe'")
  foreach ($p in $procs) {
    Write-Host "closing vmconnect PID $($p.ProcessId)" -ForegroundColor Yellow
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 2

  Start-Process vmconnect.exe -ArgumentList 'localhost', $Name
  Write-Host "reopened vmconnect in $(if ($want) { 'enhanced' } else { 'BASIC' }) session." -ForegroundColor Green
  Write-Host "SESSION OK" -ForegroundColor Green
}
catch {
  Write-Host "SESSION CHANGE FAILED: $($_.Exception.Message)" -ForegroundColor Red
  throw
}
finally {
  try { Stop-Transcript | Out-Null } catch { }
}
