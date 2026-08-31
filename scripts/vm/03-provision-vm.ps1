# Grant this account Hyper-V management rights, then create the capture VM.
# Run ELEVATED, after 01-enable-hyperv.ps1 + reboot.
#
# The group membership is the point of this wrapper. Hyper-V cmdlets refuse a
# non-elevated caller who is not in "Hyper-V Administrators" -- Get-VM alone
# fails with "You do not have the required permission" -- and the installer
# shoot needs Get-VM, Checkpoint-VM, Start-VM and PowerShell Direct many times
# over. Without the group every one of those is a UAC prompt.
#
# ASCII ONLY: PowerShell 5.1 decodes a .ps1 as the system ANSI codepage unless
# the file carries a UTF-8 BOM, so a stray em-dash breaks the parse.

#Requires -RunAsAdministrator
param(
  [string]$IsoPath = "C:\Users\admin\Downloads\Win11_25H2_English_x64.iso",
  # Passed through: delete and rebuild an existing VM (recovers a broken vTPM).
  [switch]$Recreate
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# This runs in a SEPARATE elevated window, so a transcript is the only way the
# unelevated session can read the outcome. Two hard-won details:
#   - the path carries $PID, because a run that fails leaves its window open
#     (-NoExit) still holding the file, and an unelevated caller cannot kill an
#     elevated process to release it. A shared path means the NEXT run silently
#     fails to start its transcript and the reader sees stale output.
#   - Stop-Transcript lives in a finally, so a terminating error releases the
#     file instead of holding it for the life of the window.
$log = Join-Path $env:TEMP ("owlette-vm-provision-{0}.log" -f $PID)
Start-Transcript -Path $log -Force | Out-Null
Write-Host "transcript: $log" -ForegroundColor Cyan

try {
  # --- 1. Hyper-V management without a UAC prompt every time -----------------
  $account = "$env:USERDOMAIN\$env:USERNAME"
  $group = 'Hyper-V Administrators'
  $already = @(Get-LocalGroupMember -Group $group -ErrorAction SilentlyContinue |
               Where-Object { $_.Name -eq $account })
  if ($already.Count -gt 0) {
    Write-Host "$account is already in '$group'." -ForegroundColor Green
  } else {
    Add-LocalGroupMember -Group $group -Member $account
    Write-Host "Added $account to '$group'." -ForegroundColor Yellow
    Write-Host "This applies at your NEXT SIGN-IN, not immediately." -ForegroundColor Yellow
  }

  # --- 2. Create the VM ------------------------------------------------------
  if (-not (Test-Path $IsoPath)) { throw "ISO not found: $IsoPath" }
  & (Join-Path $here '02-create-vm.ps1') -IsoPath $IsoPath -Recreate:$Recreate
  Write-Host "PROVISION OK" -ForegroundColor Green
}
catch {
  Write-Host "PROVISION FAILED: $($_.Exception.Message)" -ForegroundColor Red
  throw
}
finally {
  try { Stop-Transcript | Out-Null } catch { }
}
