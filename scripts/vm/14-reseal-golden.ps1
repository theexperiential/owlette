# Re-seal the golden image after changing it. Run ELEVATED.
#
# Needed because autologon was added AFTER golden-empty was first taken, and
# autologon is what makes a revert land on a usable desktop instead of a lock
# screen. Without it nothing can drive the guest unattended: PowerShell Direct
# still works, but the interactive desktop the installer beats must film does
# not exist until somebody signs in by hand.
#
# The golden image must be EMPTY: this removes the staged installer before
# snapshotting, because b01 opens on a clean desktop and 10-stage-installer.ps1
# puts the exe back after each revert.
#
# ASCII ONLY: PowerShell 5.1 decodes a .ps1 as the system ANSI codepage unless
# the file carries a UTF-8 BOM.

#Requires -RunAsAdministrator
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingPlainTextForPassword', 'CredFile',
  Justification = 'Path to a DPAPI-encrypted PSCredential file, not a credential.')]
param(
  [string]$Name = "owlette-e2e",
  [string]$Snapshot = "golden-empty",
  [string]$CredFile = (Join-Path $env:LOCALAPPDATA 'owlette-vm\guest-e2e.cred'),
  # Replace an existing snapshot of the same name.
  [switch]$Replace
)

$ErrorActionPreference = 'Stop'
$log = Join-Path $env:TEMP ("owlette-vm-reseal-{0}.log" -f $PID)
Start-Transcript -Path $log -Force | Out-Null
Write-Host "transcript: $log" -ForegroundColor Cyan

function Connect-Guest($vmName, $cred, [int]$minutes = 6) {
  $s = $null
  $deadline = (Get-Date).AddMinutes($minutes)
  while (-not $s -and (Get-Date) -lt $deadline) {
    try { $s = New-PSSession -VMName $vmName -Credential $cred -ErrorAction Stop }
    catch { Start-Sleep -Seconds 5 }
  }
  if (-not $s) { throw "PowerShell Direct did not come up within $minutes minutes" }
  return $s
}

try {
  $vm = Get-VM -Name $Name -ErrorAction Stop
  if ($vm.State -ne 'Running') { Start-VM -Name $Name }
  $cred = Import-Clixml -Path $CredFile

  # --- strip anything that must not be in the golden image -------------------
  $s = Connect-Guest $Name $cred
  $cleaned = Invoke-Command -Session $s -ScriptBlock {
    $desktop = [Environment]::GetFolderPath('Desktop')
    $removed = @()
    Get-ChildItem "$desktop\Owlette-Installer*.exe" -ErrorAction SilentlyContinue | ForEach-Object {
      $removed += $_.Name; Remove-Item $_.FullName -Force
    }
    Remove-Item 'C:\owlette-setup' -Recurse -Force -ErrorAction SilentlyContinue
    [PSCustomObject]@{
      Removed    = ($removed -join ', ')
      Installer  = [bool](Get-ChildItem "$desktop\Owlette-Installer*.exe" -ErrorAction SilentlyContinue)
      OwletteSvc = [bool](Get-Service OwletteService -ErrorAction SilentlyContinue)
      PawnIO     = [bool](Get-Service PawnIO -ErrorAction SilentlyContinue)
    }
  }
  Remove-PSSession $s
  Write-Host "cleaned: $($cleaned.Removed)" -ForegroundColor Green
  if ($cleaned.Installer)  { throw "installer still on the desktop" }
  if ($cleaned.OwletteSvc) { throw "Owlette is installed - this is not an empty machine" }
  if ($cleaned.PawnIO)     { throw "PawnIO is installed - b04 would have no caption to film" }

  # --- reboot and prove autologon actually lands on a desktop ---------------
  Write-Host "restarting to verify autologon..." -ForegroundColor Cyan
  Restart-VM -Name $Name -Force
  Start-Sleep -Seconds 20
  $s = Connect-Guest $Name $cred
  # ConsoleUser is the INTERACTIVE session. If autologon worked it is populated
  # without anyone touching the keyboard; empty means we are at a lock screen
  # and a revert would strand the shoot exactly as before.
  $who = Invoke-Command -Session $s -ScriptBlock {
    $deadline = (Get-Date).AddMinutes(3)
    while (-not (Get-CimInstance Win32_ComputerSystem).UserName -and (Get-Date) -lt $deadline) {
      Start-Sleep -Seconds 5
    }
    [PSCustomObject]@{
      ConsoleUser = (Get-CimInstance Win32_ComputerSystem).UserName
      Screen      = (Get-CimInstance Win32_VideoController | Select-Object -First 1 -Expand VideoModeDescription)
      Hostname    = $env:COMPUTERNAME
    }
  }
  Remove-PSSession $s
  $who | Format-List | Out-String | Write-Host
  if (-not $who.ConsoleUser) { throw "autologon did not sign in - the guest is still at a lock screen" }
  Write-Host "autologon verified: signed in as $($who.ConsoleUser)" -ForegroundColor Green

  # --- snapshot --------------------------------------------------------------
  Write-Host "shutting down cleanly..." -ForegroundColor Cyan
  Stop-VM -Name $Name -Force
  $deadline = (Get-Date).AddMinutes(3)
  while ((Get-VM -Name $Name).State -ne 'Off' -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 3 }
  if ((Get-VM -Name $Name).State -ne 'Off') { throw "guest did not shut down within 3 minutes" }

  $existing = Get-VMSnapshot -VMName $Name -Name $Snapshot -ErrorAction SilentlyContinue
  if ($existing) {
    if (-not $Replace) { throw "'$Snapshot' exists; pass -Replace to supersede it" }
    Remove-VMSnapshot -VMName $Name -Name $Snapshot -Confirm:$false
    Write-Host "removed the previous '$Snapshot'." -ForegroundColor Yellow
    Start-Sleep -Seconds 10   # let the merge settle before snapshotting again
  }
  Checkpoint-VM -Name $Name -SnapshotName $Snapshot
  Get-VMSnapshot -VMName $Name | Select-Object Name, CreationTime | Format-Table -AutoSize | Out-String | Write-Host
  Write-Host "RESEAL OK - '$Snapshot' now boots straight to a signed-in desktop." -ForegroundColor Green
}
catch {
  Write-Host "RESEAL FAILED: $($_.Exception.Message)" -ForegroundColor Red
  throw
}
finally {
  try { Stop-Transcript | Out-Null } catch { }
}
