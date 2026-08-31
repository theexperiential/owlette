# Get past Windows 11's forced-Microsoft-account OOBE screen and onto a LOCAL
# account. Run ELEVATED while the guest sits on "Unlock your Microsoft
# experience" (or any OOBE screen past the network step).
#
# Windows 11 24H2 removed the visible "offline account" path. Two escapes
# remain, and which you need depends on the build:
#
#   -Method LocalOnly  (default)  `start ms-cxh:localonly` opens a local-account
#                                 dialog immediately. No reboot, keeps network.
#                                 Patched in recent 25H2 INSIDER builds
#                                 (26220.6772+); present on retail 26200.
#   -Method BypassNro             Sets the OOBE BypassNRO flag and reboots.
#                                 Works on every current build, but ONLY while
#                                 the machine is offline - so this disconnects
#                                 the vNIC first. Reconnect before pairing.
#
# Typed through Msvm_Keyboard, not the VMConnect window: a window launched from
# an elevated shell cannot be automated by a lower-integrity process (UIPI), and
# key injection needs no focus.
#
# THREE THINGS THAT MADE EARLIER VERSIONS SILENTLY DO NOTHING, all of which
# reported success:
#   1. GetRelated() returns an association object with no method metadata. A
#      direct $kb.TypeKey() on it yields a raw object, not a status code, and
#      code that checks "is it 0?" reads absence-of-error as success. Rehydrate
#      with [wmi]$path and call InvokeMethod, which returns a real uint32.
#   2. A console in MARK/selection mode (title starts "Select ") swallows every
#      keystroke while the API still returns 0. Send Esc first.
#   3. Naming a helper `RV` shadows PowerShell's built-in alias for
#      Remove-Variable, so the helper never runs. Do not name anything RV.
#
# ASCII ONLY: PowerShell 5.1 decodes a .ps1 as the system ANSI codepage unless
# the file carries a UTF-8 BOM.

#Requires -RunAsAdministrator
param(
  [string]$Name = "owlette-e2e",
  [ValidateSet('LocalOnly','BypassNro')]
  [string]$Method = 'LocalOnly',
  # A command prompt is already open in the guest.
  [switch]$SkipShiftF10
)

$ErrorActionPreference = 'Stop'
$log = Join-Path $env:TEMP ("owlette-vm-oobe-{0}.log" -f $PID)
Start-Transcript -Path $log -Force | Out-Null
Write-Host "transcript: $log" -ForegroundColor Cyan

$VK_SHIFT  = 0x10
$VK_F10    = 0x79
$VK_RETURN = 0x0D
$VK_ESCAPE = 0x1B

function Get-Keyboard($vmName) {
  $sys = Get-WmiObject -Namespace 'root\virtualization\v2' -Class Msvm_ComputerSystem `
         -Filter "ElementName='$vmName'"
  if (-not $sys) { throw "no Msvm_ComputerSystem for '$vmName'" }
  $rel = $sys.GetRelated('Msvm_Keyboard') | Select-Object -First 1
  if (-not $rel) { throw "no Msvm_Keyboard for '$vmName'" }
  return [wmi]$rel.__PATH
}

function Invoke-Key($kb, [string]$method, [int]$code) {
  $rv = $kb.InvokeMethod($method, @([uint32]$code))
  if ($rv -ne 0) { throw "$method(0x$('{0:X2}' -f $code)) returned $rv" }
}

function Send-Line($kb, [string]$text) {
  $rv = $kb.InvokeMethod('TypeText', @([string]$text))
  if ($rv -ne 0) { throw "TypeText returned $rv" }
  Start-Sleep -Milliseconds 400
  Invoke-Key $kb 'TypeKey' $VK_RETURN
  Write-Host "  typed: $text" -ForegroundColor DarkGray
}

try {
  $vm = Get-VM -Name $Name -ErrorAction Stop
  if ($vm.State -ne 'Running') { throw "VM '$Name' is $($vm.State); it must be running in OOBE." }

  if ($Method -eq 'BypassNro') {
    $nic = Get-VMNetworkAdapter -VM $vm | Select-Object -First 1
    if ($nic.SwitchName) {
      Disconnect-VMNetworkAdapter -VMName $Name
      Write-Host "vNIC disconnected (was '$($nic.SwitchName)') - BypassNRO only applies offline." -ForegroundColor Green
    } else {
      Write-Host "vNIC already disconnected." -ForegroundColor Green
    }
  }

  $kb = Get-Keyboard $Name
  Write-Host "keyboard rehydrated." -ForegroundColor Green

  if (-not $SkipShiftF10) {
    Write-Host "sending Shift+F10..." -ForegroundColor Cyan
    Invoke-Key $kb 'PressKey'   $VK_SHIFT
    Invoke-Key $kb 'TypeKey'    $VK_F10
    Invoke-Key $kb 'ReleaseKey' $VK_SHIFT
    Start-Sleep -Seconds 3
  }

  # Leave mark/selection mode if the console is in it, or everything below is
  # accepted by the API and dropped by the console.
  Invoke-Key $kb 'TypeKey' $VK_ESCAPE
  Start-Sleep -Milliseconds 500

  if ($Method -eq 'LocalOnly') {
    Write-Host "typing the local-account shortcut..." -ForegroundColor Cyan
    Send-Line $kb 'start ms-cxh:localonly'
    Write-Host "LOCALONLY SENT" -ForegroundColor Green
    Write-Host "Screenshot the guest: a 'Create a user for this PC' dialog should have opened." -ForegroundColor Yellow
    Write-Host "If not, this build patched it - re-run with -Method BypassNro -SkipShiftF10." -ForegroundColor Yellow
  }
  else {
    Write-Host "setting BypassNRO and rebooting..." -ForegroundColor Cyan
    Send-Line $kb 'reg add HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\OOBE /v BypassNRO /t REG_DWORD /d 1 /f'
    Start-Sleep -Seconds 2
    Send-Line $kb 'shutdown /r /t 0'
    Write-Host "BYPASSNRO SENT" -ForegroundColor Green
    Write-Host @"
Rebooting into OOBE with BypassNRO set and no network. Walk:
  "Let's connect you to a network" -> I don't have internet
                                   -> Continue with limited setup
  then create the LOCAL account: user 'e2e'
Reconnect the vNIC before pairing:
  Connect-VMNetworkAdapter -VMName $Name -SwitchName 'Default Switch'
"@ -ForegroundColor Yellow
  }
}
catch {
  Write-Host "OOBE BYPASS FAILED: $($_.Exception.Message)" -ForegroundColor Red
  throw
}
finally {
  try { Stop-Transcript | Out-Null } catch { }
}
