# Pair the VM with a site, so the tray shows a real connected state.
# Run ELEVATED.
#
# Episode 9's b01 and b02 film the tray tooltip and the tray menu, and both
# render "status: connected to <site>". A silently installed machine is
# unpaired, so those rows have nothing to show until this runs.
#
# The pairing phrase is EPHEMERAL - configure_site.py requests it from the
# server and prints it; nothing persists it. So this starts the pairing helper
# in the guest, surfaces the phrase here, and waits while a human authorizes it
# in the dashboard. Authorizing cannot be done from this script: the production
# API key is installer-scoped and is refused on site/machine routes.
#
# The machine this creates is REAL - it appears in the fleet and sends metrics.
# Remove it from the dashboard and revert the VM when the beats are shot.
#
# ASCII ONLY: PowerShell 5.1 decodes a .ps1 as the system ANSI codepage unless
# the file carries a UTF-8 BOM.

#Requires -RunAsAdministrator
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingPlainTextForPassword', 'CredFile',
  Justification = 'Path to a DPAPI-encrypted PSCredential file, not a credential.')]
param(
  [string]$Name = "owlette-e2e",
  [string]$CredFile = (Join-Path $env:LOCALAPPDATA 'owlette-vm\guest-e2e.cred'),
  # How long to wait for someone to authorize the phrase in the dashboard.
  [int]$AuthorizeTimeoutSec = 600
)

$ErrorActionPreference = 'Stop'
try { Stop-Transcript | Out-Null } catch { }
$log = Join-Path $env:TEMP ("owlette-vm-pair-{0}-{1}.log" -f $PID, (Get-Date -Format 'HHmmss'))
try { Start-Transcript -Path $log -Force | Out-Null; Write-Host "transcript: $log" -ForegroundColor Cyan }
catch { Write-Host "(transcript unavailable)" -ForegroundColor DarkGray }

$PY   = 'C:\ProgramData\Owlette\python\python.exe'
$CFG  = 'C:\ProgramData\Owlette\agent\src\configure_site.py'
$OUT  = 'C:\owlette-setup\pair.jsonl'

try {
  $cred = Import-Clixml -Path $CredFile
  $session = New-PSSession -VMName $Name -Credential $cred -ErrorAction Stop

  $state = Invoke-Command -Session $session -ArgumentList $PY, $CFG -ScriptBlock {
    param($py, $cfg)
    $siteId = ''
    $conf = 'C:\ProgramData\Owlette\config\config.json'
    if (Test-Path $conf) {
      try { $siteId = (Get-Content $conf -Raw | ConvertFrom-Json).firebase.site_id } catch { }
    }
    [PSCustomObject]@{
      Python  = (Test-Path $py)
      Script  = (Test-Path $cfg)
      Service = "$((Get-Service OwletteService -ErrorAction SilentlyContinue).Status)"
      SiteId  = $siteId
    }
  }
  Write-Host ("python={0} helper={1} service={2} site_id='{3}'" -f `
    $state.Python, $state.Script, $state.Service, $state.SiteId)
  if (-not $state.Python -or -not $state.Script) { throw "owlette is not installed in the guest" }
  if ($state.SiteId) {
    Write-Host "this machine is ALREADY paired to '$($state.SiteId)' - nothing to do." -ForegroundColor Green
    Remove-PSSession $session
    return
  }

  # Start the helper detached, writing JSONL, so its phrase can be read here
  # while it keeps polling. --no-browser because there is no one at the guest's
  # desktop to use it, and the authorizing happens on the host anyway.
  Invoke-Command -Session $session -ArgumentList $PY, $CFG, $OUT -ScriptBlock {
    param($py, $cfg, $out)
    New-Item -ItemType Directory -Force 'C:\owlette-setup' | Out-Null
    Remove-Item $out -Force -ErrorAction SilentlyContinue
    Start-Process -FilePath $py `
      -ArgumentList @($cfg, '--json-progress', '--no-browser') `
      -RedirectStandardOutput $out -WindowStyle Hidden
  }
  Write-Host "pairing helper started; waiting for the phrase..." -ForegroundColor Cyan

  $phrase = $null
  $url = $null
  $deadline = (Get-Date).AddSeconds(90)
  while (-not $phrase -and (Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    $lines = Invoke-Command -Session $session -ArgumentList $OUT -ScriptBlock {
      param($out)
      if (Test-Path $out) { Get-Content $out -ErrorAction SilentlyContinue } else { @() }
    }
    foreach ($line in $lines) {
      if (-not $line) { continue }
      try { $ev = $line | ConvertFrom-Json } catch { continue }
      if ($ev.event -eq 'phrase') {
        $phrase = $ev.value.pairPhrase
        $url = $ev.value.pairingUrl
        if (-not $url) { $url = $ev.value.verificationUri }
      }
      elseif ($ev.event -eq 'error') { throw "pairing helper error: $($ev.value)" }
    }
  }
  if (-not $phrase) { throw "no pairing phrase within 90s - check $OUT in the guest" }

  Write-Host ""
  Write-Host "  ================================================" -ForegroundColor Yellow
  Write-Host ("   pairing phrase:  {0}" -f $phrase) -ForegroundColor Yellow
  Write-Host ("   authorize at:    {0}" -f $url) -ForegroundColor Yellow
  Write-Host "  ================================================" -ForegroundColor Yellow
  Write-Host ""
  Write-Host "Open that URL, pick the site, and authorize. Waiting..." -ForegroundColor Cyan

  $authorized = $false
  $siteId = ''
  $deadline = (Get-Date).AddSeconds($AuthorizeTimeoutSec)
  while (-not $authorized -and (Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 5
    $lines = Invoke-Command -Session $session -ArgumentList $OUT -ScriptBlock {
      param($out)
      if (Test-Path $out) { Get-Content $out -ErrorAction SilentlyContinue } else { @() }
    }
    foreach ($line in $lines) {
      if (-not $line) { continue }
      try { $ev = $line | ConvertFrom-Json } catch { continue }
      if ($ev.event -eq 'authorized') { $authorized = $true; $siteId = $ev.value.siteId }
      elseif ($ev.event -eq 'error') { throw "pairing failed: $($ev.value)" }
    }
  }
  if (-not $authorized) { throw "not authorized within $AuthorizeTimeoutSec s" }

  Write-Host ("authorized - bound to site '{0}'" -f $siteId) -ForegroundColor Green

  # The tray reads its rows from the running service, so confirm the service is
  # actually up and the config really carries the site before calling this done.
  Start-Sleep -Seconds 10
  $final = Invoke-Command -Session $session -ScriptBlock {
    $siteId = ''
    try { $siteId = (Get-Content 'C:\ProgramData\Owlette\config\config.json' -Raw | ConvertFrom-Json).firebase.site_id } catch { }
    [PSCustomObject]@{
      Service = "$((Get-Service OwletteService -ErrorAction SilentlyContinue).Status)"
      SiteId  = $siteId
      Tray    = [bool](Get-Process owlette-desktop -ErrorAction SilentlyContinue)
    }
  }
  Remove-PSSession $session

  Write-Host ""
  Write-Host ("service      : {0}" -f $final.Service)
  Write-Host ("site_id      : {0}" -f $final.SiteId)
  Write-Host ("tray running : {0}" -f $final.Tray)
  if ($final.Service -ne 'Running' -or -not $final.SiteId) {
    Write-Host "PAIR INCOMPLETE - the tray will not show a connected state." -ForegroundColor Red
    exit 1
  }
  Write-Host "PAIR OK - the tray can now be filmed for episode 9." -ForegroundColor Green
}
catch {
  Write-Host "PAIR FAILED: $($_.Exception.Message)" -ForegroundColor Red
  throw
}
finally {
  try { Stop-Transcript | Out-Null } catch { }
}
