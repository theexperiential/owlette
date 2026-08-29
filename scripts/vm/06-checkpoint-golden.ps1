# Take the golden-empty checkpoint. Run ELEVATED, with the guest SHUT DOWN.
#
# This snapshot is the reset mechanism for every installer take and every e2e
# run. Silent uninstall deliberately preserves user data, so uninstalling never
# returns the box to empty - only a revert does.
#
# ASCII ONLY: PowerShell 5.1 decodes a .ps1 as the system ANSI codepage unless
# the file carries a UTF-8 BOM.

#Requires -RunAsAdministrator
param(
  [string]$Name = "owlette-e2e",
  [string]$SnapshotName = "golden-empty",
  # Shut the guest down first if it is still running.
  [switch]$StopFirst
)

$ErrorActionPreference = 'Stop'
$log = Join-Path $env:TEMP ("owlette-vm-checkpoint-{0}.log" -f $PID)
Start-Transcript -Path $log -Force | Out-Null
Write-Host "transcript: $log" -ForegroundColor Cyan

try {
  $vm = Get-VM -Name $Name -ErrorAction Stop

  if ($vm.State -ne 'Off') {
    if (-not $StopFirst) {
      throw "VM is $($vm.State). Shut it down cleanly from inside the guest, or re-run with -StopFirst."
    }
    # Shut-Down (not TurnOff): a checkpoint of a hard-killed guest carries a
    # dirty filesystem, and every future run starts from it.
    Write-Host "requesting clean shutdown..." -ForegroundColor Cyan
    Stop-VM -VM $vm -Force
    $deadline = (Get-Date).AddMinutes(3)
    while ((Get-VM -Name $Name).State -ne 'Off' -and (Get-Date) -lt $deadline) {
      Start-Sleep -Seconds 3
    }
    if ((Get-VM -Name $Name).State -ne 'Off') { throw "guest did not shut down within 3 minutes" }
    Write-Host "guest is off." -ForegroundColor Green
  }

  $existing = Get-VMSnapshot -VMName $Name -Name $SnapshotName -ErrorAction SilentlyContinue
  if ($existing) {
    throw ("A snapshot named '$SnapshotName' already exists (created $($existing.CreationTime)). " +
           "Rename or remove it deliberately - overwriting the golden image silently is how a " +
           "polluted base gets baked in.")
  }

  Checkpoint-VM -VM $vm -SnapshotName $SnapshotName
  Write-Host "created checkpoint '$SnapshotName'." -ForegroundColor Green
  Get-VMSnapshot -VMName $Name | Select-Object Name, CreationTime, ParentSnapshotName |
    Format-Table -AutoSize | Out-String | Write-Host

  Write-Host "CHECKPOINT OK" -ForegroundColor Green
  Write-Host "Revert with: Restore-VMSnapshot -VMName $Name -Name $SnapshotName -Confirm:`$false" -ForegroundColor Yellow
}
catch {
  Write-Host "CHECKPOINT FAILED: $($_.Exception.Message)" -ForegroundColor Red
  throw
}
finally {
  try { Stop-Transcript | Out-Null } catch { }
}
