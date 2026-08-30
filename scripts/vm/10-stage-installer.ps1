# Stage the guest for episode 3's installer beats: revert to golden-empty, boot,
# and drop the installer on the desktop. Run ELEVATED.
#
# Reverting first is the point. Silent uninstall deliberately preserves user
# data, so a machine that has ever had Owlette on it is not an empty machine
# again - only a snapshot revert gets you back to the state b01 has to open on.
#
# Leaves the guest sitting at a clean desktop with Owlette-Installer-vX.Y.Z.exe
# on it, which IS beat b01.
#
# ASCII ONLY: PowerShell 5.1 decodes a .ps1 as the system ANSI codepage unless
# the file carries a UTF-8 BOM.

#Requires -RunAsAdministrator
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingPlainTextForPassword', 'CredFile',
  Justification = 'Path to a DPAPI-encrypted PSCredential file, not a credential.')]
param(
  [string]$Name = "owlette-e2e",
  [string]$Snapshot = "golden-empty",
  # Preferred: let the GUEST fetch the installer itself. Copy-Item -ToSession
  # cannot reliably land a 43 MB exe - Defender opens it for scanning the moment
  # the file is created and the stream then fails with "being used by another
  # process", on every retry. An in-guest download is also what a real operator
  # does (it is literally beat b02), and Defender scans it normally afterwards.
  [string]$DownloadUrl = "",
  # Fallback: push a local file over the VM bus.
  [string]$InstallerPath = "",
  # Filename to save as on the desktop (required with -DownloadUrl). This is on
  # camera in b01, so it must read like a real download.
  [string]$ExeName = "",
  # Verify what landed, if known.
  [string]$Sha256 = "",
  [string]$CredFile = (Join-Path $env:LOCALAPPDATA 'owlette-vm\guest-e2e.cred'),
  # Skip the revert (the guest is already clean and you just want the exe back).
  [switch]$NoRevert
)

$ErrorActionPreference = 'Stop'
$log = Join-Path $env:TEMP ("owlette-vm-stage-{0}.log" -f $PID)
Start-Transcript -Path $log -Force | Out-Null
Write-Host "transcript: $log" -ForegroundColor Cyan

try {
  if (-not $DownloadUrl -and -not $InstallerPath) { throw "pass -DownloadUrl (preferred) or -InstallerPath" }
  if ($InstallerPath -and -not (Test-Path $InstallerPath)) { throw "installer not found: $InstallerPath" }
  $exeName = if ($ExeName) { $ExeName }
             elseif ($InstallerPath) { Split-Path $InstallerPath -Leaf }
             else { throw "-ExeName is required with -DownloadUrl" }
  $vm = Get-VM -Name $Name -ErrorAction Stop

  if (-not $NoRevert) {
    $snap = Get-VMSnapshot -VMName $Name -Name $Snapshot -ErrorAction Stop
    if ($vm.State -ne 'Off') { Stop-VM -VM $vm -TurnOff -Force }   # discarded anyway
    Restore-VMSnapshot -VMSnapshot $snap -Confirm:$false
    Write-Host "reverted to '$Snapshot'." -ForegroundColor Green
  }

  if ((Get-VM -Name $Name).State -ne 'Running') { Start-VM -Name $Name }
  Write-Host "booting; waiting for PowerShell Direct..." -ForegroundColor Cyan

  $cred = Import-Clixml -Path $CredFile
  $session = $null
  $deadline = (Get-Date).AddMinutes(6)
  while (-not $session -and (Get-Date) -lt $deadline) {
    try { $session = New-PSSession -VMName $Name -Credential $cred -ErrorAction Stop }
    catch { Start-Sleep -Seconds 5 }
  }
  if (-not $session) { throw "PowerShell Direct did not come up within 6 minutes" }
  Write-Host "connected." -ForegroundColor Green

  $desktop = Invoke-Command -Session $session -ScriptBlock {
    [Environment]::GetFolderPath('Desktop')
  }
  if ($DownloadUrl) {
    Write-Host "downloading in-guest (43 MB)..." -ForegroundColor Cyan
    $dl = Invoke-Command -Session $session -ArgumentList $DownloadUrl, $exeName -ScriptBlock {
      param($url, $exe)
      $dest = Join-Path ([Environment]::GetFolderPath('Desktop')) $exe
      if (Test-Path $dest) { Remove-Item $dest -Force -ErrorAction SilentlyContinue }
      # BITS would be tidier but needs a service that may be idle on a fresh
      # image; Invoke-WebRequest with the progress bar off is fast enough and
      # has no dependency.
      $ProgressPreference = 'SilentlyContinue'
      Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing -TimeoutSec 600
      [PSCustomObject]@{
        Exists = Test-Path $dest
        Bytes  = if (Test-Path $dest) { (Get-Item $dest).Length } else { 0 }
        Sha    = if (Test-Path $dest) { (Get-FileHash $dest -Algorithm SHA256).Hash.ToLower() } else { '' }
      }
    }
    Write-Host "downloaded $($dl.Bytes) bytes" -ForegroundColor Green
    if ($Sha256 -and $dl.Sha -ne $Sha256.ToLower()) {
      throw "checksum mismatch in the guest: got $($dl.Sha), expected $($Sha256.ToLower())"
    }
    if ($Sha256) { Write-Host "checksum verified in the guest." -ForegroundColor Green }
  }
  else {
    Copy-Item -Path $InstallerPath -Destination $desktop -ToSession $session -Force -ErrorAction Stop
    Write-Host "copied $exeName -> $desktop" -ForegroundColor Green
  }

  $state = Invoke-Command -Session $session -ArgumentList $exeName -ScriptBlock {
    param($exe)
    $p = Join-Path ([Environment]::GetFolderPath('Desktop')) $exe
    # Clear Mark-of-the-Web. A copied-in installer can carry the zone marker and
    # SmartScreen would then interrupt the take with a "protected your PC"
    # dialog that is NOT what a customer downloading from owlette.app sees.
    if (Test-Path $p) { Unblock-File -LiteralPath $p -ErrorAction SilentlyContinue }
    [PSCustomObject]@{
      Hostname   = $env:COMPUTERNAME
      Screen     = (Get-CimInstance Win32_VideoController | Select-Object -First 1 -Expand VideoModeDescription)
      Installer  = Test-Path $p
      SizeMB     = if (Test-Path $p) { [math]::Round((Get-Item $p).Length / 1MB, 1) } else { 0 }
      Zone       = if (Test-Path "$p`:Zone.Identifier") { 'marked' } else { 'clean' }
      PawnIO     = [bool](Get-Service PawnIO -ErrorAction SilentlyContinue)
      OwletteSvc = [bool](Get-Service OwletteService -ErrorAction SilentlyContinue)
    }
  }
  Remove-PSSession $session

  Write-Host ""
  $state | Format-List | Out-String | Write-Host

  $problems = @()
  if (-not $state.Installer)  { $problems += "installer is not on the desktop" }
  if ($state.OwletteSvc)      { $problems += "Owlette is already installed - the revert did not take" }
  if ($state.PawnIO)          { $problems += "PawnIO present - b04 would have no driver caption" }
  if ($state.Screen -notmatch '1920 x 1080') { $problems += "display is '$($state.Screen)'" }

  if ($problems.Count) {
    Write-Host "NOT READY TO FILM:" -ForegroundColor Red
    $problems | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
  } else {
    Write-Host "STAGED - the guest is sitting on beat b01." -ForegroundColor Green
  }
}
catch {
  Write-Host "STAGING FAILED: $($_.Exception.Message)" -ForegroundColor Red
  throw
}
finally {
  try { Stop-Transcript | Out-Null } catch { }
}
