# Create the owlette capture/e2e VM (full-machine-e2e task 1.1).
# Run ELEVATED, after 01-enable-hyperv.ps1 + reboot. Normally invoked by
# 03-provision-vm.ps1, which also grants Hyper-V rights.
#
#   .\02-create-vm.ps1 -IsoPath C:\path\to\Win11.iso
#
# IDEMPOTENT ON PURPOSE. The first run of this script died at
# Connect-VMNetworkAdapter (see below) with the VM already created, leaving no
# way to resume: re-running would hit New-VM against an existing name. Every
# step now checks for its own result first, so this can be run repeatedly until
# it completes.
#
# Sizing: half the host's cores, 4-8 GB dynamic RAM, 80 GB dynamic disk - a
# Win11 guest idles ~12 GB on disk; the dynamic VHDX only grows as used.
#
# ASCII ONLY: PowerShell 5.1 decodes a .ps1 as the system ANSI codepage unless
# the file has a UTF-8 BOM, so a stray em-dash breaks the parse.

#Requires -RunAsAdministrator
param(
  [Parameter(Mandatory = $true)][string]$IsoPath,
  [string]$Name = "owlette-e2e",
  [string]$VmRoot = "C:\VMs",
  [string]$SwitchName = "Default Switch",
  # Delete an existing VM and its disk first. Needed to recover from a
  # half-built VM, and specifically from a vTPM whose key protector was
  # re-sealed by a repeat run (Start-VM then fails 0xC000A002).
  [switch]$Recreate
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path $IsoPath)) { throw "ISO not found: $IsoPath" }
New-Item -ItemType Directory -Force (Join-Path $VmRoot $Name) | Out-Null
$vhd = Join-Path $VmRoot "$Name\$Name.vhdx"

# --- the VM ------------------------------------------------------------------
$vm = Get-VM -Name $Name -ErrorAction SilentlyContinue
if ($vm -and $Recreate) {
  Write-Host "-Recreate: removing existing VM '$Name'." -ForegroundColor Yellow
  if ($vm.State -ne 'Off') { Stop-VM -VM $vm -TurnOff -Force }
  Remove-VM -VM $vm -Force
  $vm = $null
}
if ($vm) {
  Write-Host "VM '$Name' already exists - reconfiguring in place." -ForegroundColor Yellow
} else {
  if (Test-Path $vhd) {
    # An empty disk left behind by a run that failed after New-VHD but before
    # the VM registered. Worthless (a golden image is built from scratch), and
    # New-VM -NewVHDPath refuses to overwrite it.
    Write-Host "Removing orphaned VHDX from a failed run: $vhd" -ForegroundColor Yellow
    Remove-Item $vhd -Force
  }
  $vm = New-VM -Name $Name -Generation 2 -MemoryStartupBytes 4GB `
    -NewVHDPath $vhd -NewVHDSizeBytes 80GB -Path $VmRoot
  Write-Host "Created VM '$Name'." -ForegroundColor Green
}

Set-VM -VM $vm -ProcessorCount ([Math]::Max(4, [Environment]::ProcessorCount / 2)) `
  -DynamicMemory -MemoryMinimumBytes 4GB -MemoryMaximumBytes 8GB `
  -AutomaticCheckpointsEnabled $false -CheckpointType Standard

# --- Win11 guest requirements: Secure Boot (MS CA) + TPM ---------------------
Set-VMFirmware -VM $vm -EnableSecureBoot On -SecureBootTemplate MicrosoftWindows
# Seal the vTPM exactly ONCE. New-HgsKeyProtector mints a fresh protector on
# every call, so re-running this against an already-enabled vTPM replaces the
# protector its state is sealed to and the VM then refuses to start with
# "The computed authentication tag did not match the input authentication tag"
# (0xC000A002). Guarding on TpmEnabled is what makes this script re-runnable.
if (-not (Get-VMSecurity -VM $vm).TpmEnabled) {
  $guardianName = "$Name-guardian"
  if (-not (Get-HgsGuardian -Name $guardianName -ErrorAction SilentlyContinue)) {
    New-HgsGuardian -Name $guardianName -GenerateCertificates | Out-Null
  }
  $owner = Get-HgsGuardian -Name $guardianName
  Set-VMKeyProtector -VM $vm -KeyProtector (New-HgsKeyProtector -Owner $owner -AllowUntrustedRoot).RawData
  Enable-VMTPM -VM $vm
  Write-Host "vTPM sealed and enabled." -ForegroundColor Green
} else {
  Write-Host "vTPM already enabled - leaving its key protector alone." -ForegroundColor Green
}

# --- boot media --------------------------------------------------------------
$dvd = Get-VMDvdDrive -VM $vm | Select-Object -First 1
if (-not $dvd) {
  Add-VMDvdDrive -VM $vm -Path $IsoPath
  $dvd = Get-VMDvdDrive -VM $vm | Select-Object -First 1
} elseif ($dvd.Path -ne $IsoPath) {
  Set-VMDvdDrive -VMName $Name -Path $IsoPath
  $dvd = Get-VMDvdDrive -VM $vm | Select-Object -First 1
}
Set-VMFirmware -VM $vm -FirstBootDevice $dvd

# --- network -----------------------------------------------------------------
# Connect-VMNetworkAdapter is the one cmdlet here with NO -VM parameter: it
# takes -VMName / -VMNetworkAdapter, and passing -VM fails with "the parameter
# name 'VM' is ambiguous". That killed the first run of this script.
if (-not (Get-VMSwitch -Name $SwitchName -ErrorAction SilentlyContinue)) {
  $available = (Get-VMSwitch | Select-Object -Expand Name) -join ', '
  throw "Switch '$SwitchName' not found. Available: $available"
}
$nic = Get-VMNetworkAdapter -VM $vm | Select-Object -First 1
if ($nic.SwitchName -ne $SwitchName) {
  # Default Switch = NAT internet, isolated from the LAN - close enough to the
  # "isolated from anything that can reach prod" rule for dev; point -SwitchName
  # at a dedicated switch to make it stricter.
  Connect-VMNetworkAdapter -VMName $Name -SwitchName $SwitchName
}

# --- go ----------------------------------------------------------------------
if ($vm.State -ne 'Running') { Start-VM -VM $vm }
vmconnect.exe localhost $Name
Write-Host @"
VM '$Name' is booting from the ISO. Walk the ~10-minute Windows setup once:
  - press a key at "Press any key to boot from CD or DVD"
  - NO Microsoft account: choose 'domain join instead' / offline account
  - user 'e2e', any password you like
After the desktop appears:
  1. In the VM: set the display to 1920x1080, then run the repo's
     scripts\bootstrap-gui-automation.ps1 -Rig E2eRunner -Apply
     (Profile A+C prep; see docs\internal\gui-automation-machine-setup.md)
  2. Shut the VM down cleanly.
  3. Checkpoint-VM -Name $Name -SnapshotName golden-empty
The golden-empty snapshot IS task 1.1: every installer take and e2e run starts
from a revert to it.
"@ -ForegroundColor Yellow
