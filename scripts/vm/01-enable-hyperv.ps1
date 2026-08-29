# Run ONCE from an ELEVATED PowerShell, then reboot. Everything after the
# reboot (VM creation, Profile A+C prep, golden snapshot) is scripted and can
# be driven by the agent - this is the only step that needs a human + restart.
#
# Host checked 2026-08-26: Win11 Pro, 64 GB RAM, 139 GB free on C:,
# HypervisorPresent=true (VBS) - Hyper-V coexists with that.

#Requires -RunAsAdministrator
$feature = Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V -All -NoRestart
if ($feature.RestartNeeded) {
  Write-Host "Hyper-V staged. REBOOT to finish, then run 02-create-vm.ps1 (elevated)." -ForegroundColor Yellow
} else {
  Write-Host "Hyper-V enabled without restart - run 02-create-vm.ps1 (elevated)." -ForegroundColor Green
}
