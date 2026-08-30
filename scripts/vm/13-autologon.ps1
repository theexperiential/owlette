# Configure autologon in the guest with Sysinternals Autologon. Run ELEVATED.
#
# WHY THIS IS NOT OPTIONAL for this image: the golden snapshot is taken with the
# guest shut down, so every revert boots to a LOCK SCREEN. Nothing can drive the
# machine from there - PowerShell Direct works, but the interactive desktop the
# installer beats have to film does not exist until someone signs in. Autologon
# is what makes a revert land on a usable desktop unattended, and it is a Profile
# C requirement for the same reason (unattended runs after reboot/revert).
#
# Sysinternals Autologon stores the password via the LSA, NOT as plaintext in
# HKLM\...\Winlogon\DefaultPassword, which is why the machine-setup doc mandates
# it over the registry recipe. This script verifies that afterwards.
#
# Get the tool: https://live.sysinternals.com/Autologon64.exe (Microsoft-signed;
# check the signature before copying it into a guest).
#
# ASCII ONLY: PowerShell 5.1 decodes a .ps1 as the system ANSI codepage unless
# the file carries a UTF-8 BOM.

#Requires -RunAsAdministrator
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingPlainTextForPassword', 'CredFile',
  Justification = 'Path to a DPAPI-encrypted PSCredential file, not a credential.')]
param(
  [string]$Name = "owlette-e2e",
  [Parameter(Mandatory = $true)][string]$AutologonExe,
  [string]$CredFile = (Join-Path $env:LOCALAPPDATA 'owlette-vm\guest-e2e.cred'),
  # Undo: clear autologon.
  [switch]$Disable
)

$ErrorActionPreference = 'Stop'
$log = Join-Path $env:TEMP ("owlette-vm-autologon-{0}.log" -f $PID)
Start-Transcript -Path $log -Force | Out-Null
Write-Host "transcript: $log" -ForegroundColor Cyan

try {
  if (-not (Test-Path $AutologonExe)) { throw "Autologon not found: $AutologonExe" }
  $sig = Get-AuthenticodeSignature $AutologonExe
  if ($sig.Status -ne 'Valid') { throw "Autologon signature is $($sig.Status) - refusing to copy it into the guest" }
  Write-Host "Autologon signature: Valid ($($sig.SignerCertificate.Subject.Split(',')[0]))" -ForegroundColor Green

  $vm = Get-VM -Name $Name -ErrorAction Stop
  if ($vm.State -ne 'Running') { throw "VM '$Name' is $($vm.State); start it first." }

  $cred = Import-Clixml -Path $CredFile
  $session = New-PSSession -VMName $Name -Credential $cred -ErrorAction Stop
  # Reaching here proves the stored credential is CORRECT - useful on its own
  # when the console is rejecting the same password (a guest Caps Lock state or
  # dropped keystroke looks identical to a wrong password).
  Write-Host "PowerShell Direct connected as '$($cred.UserName)' - stored credential verified." -ForegroundColor Green

  Invoke-Command -Session $session -ScriptBlock {
    New-Item -ItemType Directory -Force 'C:\owlette-setup' | Out-Null
  }
  Copy-Item -Path $AutologonExe -Destination 'C:\owlette-setup\' -ToSession $session -Force
  $exe = 'C:\owlette-setup\' + (Split-Path $AutologonExe -Leaf)

  $result = Invoke-Command -Session $session -ArgumentList $exe, $Disable.IsPresent -ScriptBlock {
    param($exe, $disable)
    $c = $using:cred
    $user = $c.UserName
    $host_ = $env:COMPUTERNAME

    if ($disable) {
      & $exe /accepteula /d 2>&1 | Out-Null
    } else {
      # Plaintext only on this argv, inside the guest, for the moment of the
      # call - Autologon hands it to the LSA and never writes it to the registry.
      $pw = $c.GetNetworkCredential().Password
      & $exe $user $host_ $pw /accepteula 2>&1 | Out-Null
    }

    $wl = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
    [PSCustomObject]@{
      AutoAdminLogon   = (Get-ItemProperty $wl -Name AutoAdminLogon   -ErrorAction SilentlyContinue).AutoAdminLogon
      DefaultUserName  = (Get-ItemProperty $wl -Name DefaultUserName  -ErrorAction SilentlyContinue).DefaultUserName
      # MUST be absent. If Autologon worked, the secret is in the LSA and this
      # value does not exist; its presence would mean a plaintext password is
      # sitting in the registry of an image we are about to snapshot.
      PlaintextPwInReg = [bool](Get-ItemProperty $wl -Name DefaultPassword -ErrorAction SilentlyContinue)
    }
  }
  Remove-PSSession $session

  Write-Host ""
  $result | Format-List | Out-String | Write-Host

  if ($result.PlaintextPwInReg) {
    throw "DefaultPassword is present in the registry - a plaintext password would be baked into the golden image. Clear it before snapshotting."
  }
  if (-not $Disable -and $result.AutoAdminLogon -ne '1') {
    throw "AutoAdminLogon is '$($result.AutoAdminLogon)', expected '1'"
  }

  Write-Host "AUTOLOGON OK - reboot and the guest should land on the desktop unattended." -ForegroundColor Green
}
catch {
  Write-Host "AUTOLOGON FAILED: $($_.Exception.Message)" -ForegroundColor Red
  throw
}
finally {
  try { Stop-Transcript | Out-Null } catch { }
}
