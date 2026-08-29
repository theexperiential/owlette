# Prepare the freshly-installed guest over PowerShell Direct, then verify it is
# a valid base for the installer shoot. Run ELEVATED, after Windows setup.
#
# PowerShell Direct (Invoke-Command -VMName) runs over the VM bus: no guest
# networking, no IP, no WinRM configuration. It needs Hyper-V admin rights on
# the host and a local account in the guest.
#
# Credentials are collected with Get-Credential in THIS window and never
# printed, never written to the transcript, and never stored. Nothing here logs
# a password.
#
# ASCII ONLY: PowerShell 5.1 decodes a .ps1 as the system ANSI codepage unless
# the file carries a UTF-8 BOM.

#Requires -RunAsAdministrator
param(
  [string]$Name = "owlette-e2e",
  [string]$GuestUser = "e2e",
  # Repo root, so the guest gets the real bootstrap script rather than a copy
  # that can drift.
  [string]$RepoRoot = "C:\Users\admin\Documents\Git\Owlette",
  # Skip the long bootstrap run; just connect and report readiness.
  [switch]$VerifyOnly
)

$ErrorActionPreference = 'Stop'
$log = Join-Path $env:TEMP ("owlette-vm-prep-{0}.log" -f $PID)
Start-Transcript -Path $log -Force | Out-Null
Write-Host "transcript: $log" -ForegroundColor Cyan

try {
  $vm = Get-VM -Name $Name -ErrorAction Stop
  if ($vm.State -ne 'Running') { throw "VM '$Name' is $($vm.State); start it first." }

  Write-Host "Enter the GUEST password for '$GuestUser' (not logged)." -ForegroundColor Cyan
  $cred = Get-Credential -UserName $GuestUser -Message "owlette-e2e guest account"

  # The guest finishes OOBE well before it accepts PowerShell Direct; poll.
  Write-Host "waiting for PowerShell Direct..." -ForegroundColor Cyan
  $session = $null
  $deadline = (Get-Date).AddMinutes(5)
  while (-not $session -and (Get-Date) -lt $deadline) {
    try { $session = New-PSSession -VMName $Name -Credential $cred -ErrorAction Stop }
    catch { Start-Sleep -Seconds 5 }
  }
  if (-not $session) { throw "PowerShell Direct never came up. Is the guest at the desktop, and is the password right?" }
  Write-Host "connected." -ForegroundColor Green

  # --- readiness: this VM exists to be a machine that LACKS these ------------
  # Episode 3's b04 films the installer's progress captions, and those only
  # render while it installs WebView2 and PawnIO. A guest that already has
  # either one cannot produce the shot, so check BEFORE the golden snapshot -
  # after it is baked, this is expensive to discover.
  $state = Invoke-Command -Session $session -ScriptBlock {
    $webview = @(
      'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
      'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1
    [PSCustomObject]@{
      Caption      = (Get-CimInstance Win32_OperatingSystem).Caption
      Build        = (Get-CimInstance Win32_OperatingSystem).BuildNumber
      User         = $env:USERNAME
      Screen       = (Get-CimInstance Win32_VideoController |
                      Select-Object -First 1 -Expand VideoModeDescription)
      WebView2     = [bool]$webview
      PawnIO       = [bool](Get-Service PawnIO -ErrorAction SilentlyContinue)
      OwletteSvc   = [bool](Get-Service OwletteService -ErrorAction SilentlyContinue)
      PSVersion    = $PSVersionTable.PSVersion.ToString()
    }
  }

  Write-Host ""
  Write-Host "--- guest ---------------------------------------------" -ForegroundColor Cyan
  $state | Format-List | Out-String | Write-Host
  Write-Host "-------------------------------------------------------" -ForegroundColor Cyan

  $problems = @()
  if ($state.WebView2)   { $problems += "WebView2 is already installed - b04's captions will not appear." }
  if ($state.PawnIO)     { $problems += "PawnIO is already installed - b04's captions will not appear." }
  if ($state.OwletteSvc) { $problems += "Owlette is already installed - this is not an empty machine." }
  if ($state.Screen -notmatch '1920 x 1080') {
    $problems += "Display is '$($state.Screen)', not 1920 x 1080. Set it in the guest (Profile A pins resolution and the capture harness asserts it)."
  }

  if ($problems.Count) {
    Write-Host "NOT READY:" -ForegroundColor Red
    $problems | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
  } else {
    Write-Host "READY: empty Win11 guest at 1920x1080, no WebView2/PawnIO/Owlette." -ForegroundColor Green
  }

  # --- Profile A + C prep ----------------------------------------------------
  if (-not $VerifyOnly) {
    $src = Join-Path $RepoRoot 'scripts\bootstrap-gui-automation.ps1'
    if (-not (Test-Path $src)) { throw "bootstrap script not found: $src" }
    Invoke-Command -Session $session -ScriptBlock {
      New-Item -ItemType Directory -Force 'C:\owlette-setup' | Out-Null
    }
    Copy-Item -Path $src -Destination 'C:\owlette-setup\' -ToSession $session -Force
    Write-Host "copied bootstrap-gui-automation.ps1 into the guest." -ForegroundColor Green

    Write-Host "running Profile A+C prep in the guest (this takes a few minutes)..." -ForegroundColor Cyan
    $out = Invoke-Command -Session $session -ScriptBlock {
      & 'C:\owlette-setup\bootstrap-gui-automation.ps1' -Rig E2eRunner -Apply 2>&1 | Out-String
    }
    Write-Host $out
  }

  Remove-PSSession $session
  Write-Host "PREP OK" -ForegroundColor Green
  Write-Host "Next: shut the guest down cleanly, then run 06-checkpoint-golden.ps1" -ForegroundColor Yellow
}
catch {
  Write-Host "PREP FAILED: $($_.Exception.Message)" -ForegroundColor Red
  throw
}
finally {
  try { Stop-Transcript | Out-Null } catch { }
}
