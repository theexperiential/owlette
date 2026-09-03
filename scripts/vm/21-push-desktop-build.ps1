# Put the CURRENT desktop build into the guest, without reinstalling. Run ELEVATED.
#
# The VM carries whatever the last installer put there - 3.2.1 - while the
# desktop app has moved on (3.2.3 as of 2026-08-30). Filming the drop overlay
# and the "add process" confirm card against an older window would document a UI
# that no longer ships, which is exactly what invalidated episode 9's takes.
#
# This replaces ONLY app\owlette-desktop.exe. The service is stopped for the
# copy (it relaunches the app mid-push otherwise) and started again after; the
# agent and the pairing are untouched, so the guest keeps its site binding.
# That leaves the
# guest running a desktop app newer than its installed service, which is fine
# for filming and is the same thing the local dev loop does on the host.
#
# The app is stopped BY PID from tray.pid, never by image name - killing by name
# would take out any other process that happens to share it.
#
# ASCII ONLY: PowerShell 5.1 decodes a .ps1 as the system ANSI codepage unless
# the file carries a UTF-8 BOM.

#Requires -RunAsAdministrator
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingPlainTextForPassword', 'CredFile',
  Justification = 'Path to a DPAPI-encrypted PSCredential file, not a credential.')]
param(
  [string]$Name = "owlette-e2e",
  [string]$CredFile = (Join-Path $env:LOCALAPPDATA 'owlette-vm\guest-e2e.cred'),
  [string]$ExePath = "C:\Users\admin\Documents\Git\Owlette\desktop\src-tauri\target\release\owlette-desktop.exe",
  # A file for the drag-and-drop beat to drop. A .bat is honest here: the guest
  # has no TouchDesigner, so a .toe would resolve to nothing on the confirm card.
  [switch]$SeedDropFile
)

$ErrorActionPreference = 'Stop'
try { Stop-Transcript | Out-Null } catch { }
$log = Join-Path $env:TEMP ("owlette-vm-push-{0}-{1}.log" -f $PID, (Get-Date -Format 'HHmmss'))
try { Start-Transcript -Path $log -Force | Out-Null; Write-Host "transcript: $log" -ForegroundColor Cyan }
catch { Write-Host "(transcript unavailable)" -ForegroundColor DarkGray }

try {
  if (-not (Test-Path $ExePath)) { throw "no desktop build at $ExePath - run `npx tauri build --no-bundle` first" }
  $src = Get-Item $ExePath
  Write-Host ("host build: {0:N1} MB, {1}, version {2}" -f `
    ($src.Length / 1MB), $src.LastWriteTime.ToString('MM-dd HH:mm'), $src.VersionInfo.FileVersion)

  $cred = Import-Clixml -Path $CredFile
  $s = New-PSSession -VMName $Name -Credential $cred -ErrorAction Stop

  $before = Invoke-Command -Session $s -ScriptBlock {
    $exe = 'C:\ProgramData\Owlette\app\owlette-desktop.exe'
    [PSCustomObject]@{
      Exists  = Test-Path $exe
      Version = if (Test-Path $exe) { (Get-Item $exe).VersionInfo.FileVersion } else { '' }
      Size    = if (Test-Path $exe) { (Get-Item $exe).Length } else { 0 }
      TrayPid = (Get-Content 'C:\ProgramData\Owlette\tmp\tray.pid' -ErrorAction SilentlyContinue | Select-Object -First 1)
      Service = "$((Get-Service OwletteService -ErrorAction SilentlyContinue).Status)"
    }
  }
  Write-Host ("guest before: version {0}, {1:N1} MB, tray pid {2}, service {3}" -f `
    $before.Version, ($before.Size / 1MB), $before.TrayPid, $before.Service)

  # Stop the SERVICE first: it relaunches the app on its status check, and on
  # one run it won the race against the copy - the exe was locked again inside
  # the 3s settle and the push failed. With the service stopped, stop the app:
  # the tray.pid PID first, then any other process actually running THIS exe -
  # matched by executable path and killed by PID, never by image name. Verify
  # the exe is actually free before copying.
  Invoke-Command -Session $s -ScriptBlock {
    Stop-Service OwletteService -ErrorAction Stop
    "service stopped"
    $exe = 'C:\ProgramData\Owlette\app\owlette-desktop.exe'
    $p = Get-Content 'C:\ProgramData\Owlette\tmp\tray.pid' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($p) {
      try { Stop-Process -Id ([int]$p) -Force -ErrorAction Stop; "stopped tray pid $p" }
      catch { "tray pid $p was not running" }
    } else { "no tray.pid" }
    $others = Get-Process owlette-desktop -ErrorAction SilentlyContinue |
              Where-Object { $_.Path -eq $exe }
    foreach ($proc in $others) {
      try { Stop-Process -Id $proc.Id -Force -ErrorAction Stop; "stopped pid $($proc.Id) (running $exe)" }
      catch { "pid $($proc.Id) already gone" }
    }
    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $deadline) {
      $left = Get-Process owlette-desktop -ErrorAction SilentlyContinue |
              Where-Object { $_.Path -eq $exe }
      if ($null -eq $left) { break }
      Start-Sleep -Milliseconds 500
    }
    $left = Get-Process owlette-desktop -ErrorAction SilentlyContinue |
            Where-Object { $_.Path -eq $exe }
    if ($left) { throw "owlette-desktop is still running after 20s - not copying over a locked exe" }
    "exe unlocked"
  } | ForEach-Object { Write-Host "  $_" }

  Write-Host "copying the build over the VM bus..." -ForegroundColor Cyan
  Copy-Item -Path $ExePath -Destination 'C:\ProgramData\Owlette\app\owlette-desktop.exe' `
            -ToSession $s -Force -ErrorAction Stop

  if ($SeedDropFile) {
    Invoke-Command -Session $s -ScriptBlock {
      $desktop = [Environment]::GetFolderPath('Desktop')
      $f = Join-Path $desktop 'lobby-wall.bat'
      # Something a viewer would plausibly drop, and harmless if it ever runs.
      Set-Content -Path $f -Encoding ASCII -Value @(
        '@echo off',
        'rem demo payload for the owlette drag-and-drop beat',
        'timeout /t 86400 > nul'
      )
      "seeded $f"
    } | ForEach-Object { Write-Host "  $_" }
  }

  # Bring the service back; it relaunches the app on its next status check - no
  # need to start the app from session 0, where a GUI process would have no
  # desktop to appear on.
  Invoke-Command -Session $s -ScriptBlock {
    Start-Service OwletteService
    "service started"
  } | ForEach-Object { Write-Host "  $_" }
  Write-Host "waiting for the service to relaunch the app..." -ForegroundColor Cyan
  $after = $null
  $deadline = (Get-Date).AddMinutes(2)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 5
    $after = Invoke-Command -Session $s -ScriptBlock {
      $exe = 'C:\ProgramData\Owlette\app\owlette-desktop.exe'
      [PSCustomObject]@{
        Version = (Get-Item $exe).VersionInfo.FileVersion
        Size    = (Get-Item $exe).Length
        Running = [bool](Get-Process owlette-desktop -ErrorAction SilentlyContinue)
        Service = "$((Get-Service OwletteService -ErrorAction SilentlyContinue).Status)"
        SiteId  = try { (Get-Content 'C:\ProgramData\Owlette\config\config.json' -Raw | ConvertFrom-Json).firebase.site_id } catch { '' }
      }
    }
    if ($after.Running) { break }
  }
  Remove-PSSession $s

  Write-Host ""
  Write-Host ("guest after : version {0}, {1:N1} MB" -f $after.Version, ($after.Size / 1MB))
  Write-Host ("app running : {0}" -f $after.Running)
  Write-Host ("service     : {0}   site: {1}" -f $after.Service, $after.SiteId)
  if ($after.Size -ne $src.Length) {
    Write-Host "SIZE MISMATCH - the copy did not land intact" -ForegroundColor Red
    exit 1
  }
  if (-not $after.Running) {
    Write-Host "the app did not come back within 2 minutes - start it by hand in the guest" -ForegroundColor Yellow
    exit 1
  }
  Write-Host "PUSH OK - the guest is running the current desktop build." -ForegroundColor Green
}
catch {
  Write-Host "PUSH FAILED: $($_.Exception.Message)" -ForegroundColor Red
  throw
}
finally {
  try { Stop-Transcript | Out-Null } catch { }
}
