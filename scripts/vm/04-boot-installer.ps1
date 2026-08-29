# Boot the VM off its ISO, catching the "Press any key to boot from CD or DVD"
# prompt programmatically. Run ELEVATED.
#
# Why WMI and not the VMConnect window: that prompt lives ~5 seconds and only
# takes input when the console window has focus. Driving the window needs UI
# automation, and VMConnect launched from an elevated shell runs elevated, so an
# unelevated automation process cannot touch it (UIPI). Msvm_Keyboard.TypeKey
# injects straight into the VM's virtual keyboard - no window, no focus, no race.
#
# This is also the mechanism the installer shoot uses to drive the wizard, so it
# is worth having working before the golden image exists.
#
# ASCII ONLY: PowerShell 5.1 decodes a .ps1 as the system ANSI codepage unless
# the file carries a UTF-8 BOM.

#Requires -RunAsAdministrator
param(
  [string]$Name = "owlette-e2e",
  [int]$SpamSeconds = 45
)

$ErrorActionPreference = 'Stop'
$log = Join-Path $env:TEMP ("owlette-vm-boot-{0}.log" -f $PID)
Start-Transcript -Path $log -Force | Out-Null
Write-Host "transcript: $log" -ForegroundColor Cyan

try {
  $vm = Get-VM -Name $Name -ErrorAction Stop
  Write-Host "VM state on entry: $($vm.State)" -ForegroundColor Cyan

  # Get the virtual keyboard BEFORE booting, so the spam can start the instant
  # firmware hands off. Msvm_ComputerSystem -> Msvm_Keyboard.
  $sys = Get-WmiObject -Namespace 'root\virtualization\v2' -Class Msvm_ComputerSystem `
         -Filter "ElementName='$Name'"
  if (-not $sys) { throw "no Msvm_ComputerSystem for '$Name'" }
  $kb = $sys.GetRelated('Msvm_Keyboard') | Select-Object -First 1
  if (-not $kb) { throw "no Msvm_Keyboard for '$Name' (is the VM off?)" }
  Write-Host "virtual keyboard acquired." -ForegroundColor Green

  if ($vm.State -eq 'Off') {
    Start-VM -VM $vm
    Write-Host "started." -ForegroundColor Green
  } else {
    Restart-VM -VM $vm -Force
    Write-Host "reset." -ForegroundColor Green
  }

  # Re-acquire: a reset can invalidate the old association.
  Start-Sleep -Seconds 2
  $sys = Get-WmiObject -Namespace 'root\virtualization\v2' -Class Msvm_ComputerSystem `
         -Filter "ElementName='$Name'"
  $kb = $sys.GetRelated('Msvm_Keyboard') | Select-Object -First 1

  # VK_SPACE. Hammer it across the whole firmware->bootmgr window; the prompt
  # can appear anywhere in there depending on how fast the ISO spins up.
  $deadline = (Get-Date).AddSeconds($SpamSeconds)
  $n = 0
  while ((Get-Date) -lt $deadline) {
    try { $kb.TypeKey(0x20) | Out-Null; $n++ } catch { }
    Start-Sleep -Milliseconds 300
  }
  Write-Host "sent $n keypresses over $SpamSeconds s." -ForegroundColor Green
  Write-Host "BOOT-KEYS OK" -ForegroundColor Green
}
catch {
  Write-Host "BOOT FAILED: $($_.Exception.Message)" -ForegroundColor Red
  throw
}
finally {
  try { Stop-Transcript | Out-Null } catch { }
}

# Opened last and OUTSIDE the transcript so the window is not holding the log.
vmconnect.exe localhost $Name
