# SUPERSEDED by 17-shoot-b03-b04.ps1 for filming. Kept for the technique.
#
# This drives the guest's OWN cursor from inside the guest. That works - the
# double-click lands and the installer runs - but it CANNOT BE FILMED: the
# guest's cursor is not present in a host-side capture at all (a 1500px sweep
# produced no arrow anywhere along its path), so the take shows a UAC prompt
# appearing with nothing having visibly moved. 17 drives the HOST pointer
# instead, which VMConnect keeps glued to the guest's cursor and gdigrab draws.
#
# What is still worth having here: running something in the guest's INTERACTIVE
# session from an elevated host, which needs a scheduled task with /it started
# by its OWN time trigger - schtasks /run cannot launch an /it task from
# Session 0 ("Element not found", LastResult 267011). The fleet-e2e work will
# need exactly this to drive guests that no one is filming.
#
# Drive episode 3's b03/b04: double-click the installer, answer UAC, let the
# progress screen run. Run ELEVATED, with recording already started.
#
# TWO INPUT PATHS, because neither one alone can do this:
#
#   * The DOUBLE-CLICK needs a real cursor in the INTERACTIVE session. A
#     PowerShell Direct session is not interactive (Session 0), so SetCursorPos
#     there moves nothing the camera can see. The click is therefore run as a
#     scheduled task with /it, which executes in the logged-on user's session.
#     The narration says "double-click it", so a keyboard launch would
#     contradict what is being spoken.
#   * The UAC PROMPT is on the secure desktop, where no user-session process can
#     reach it - not even the scheduled task. Msvm_Keyboard sits below the OS
#     input stack and does reach it, which is why Alt+Y is injected from the
#     host.
#
# ASCII ONLY: PowerShell 5.1 decodes a .ps1 as the system ANSI codepage unless
# the file carries a UTF-8 BOM.

#Requires -RunAsAdministrator
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingPlainTextForPassword', 'CredFile',
  Justification = 'Path to a DPAPI-encrypted PSCredential file, not a credential.')]
param(
  [string]$Name = "owlette-e2e",
  [string]$CredFile = (Join-Path $env:LOCALAPPDATA 'owlette-vm\guest-e2e.cred'),
  # Desktop icon centre, in guest pixels.
  [int]$IconX = 37,
  [int]$IconY = 232,
  # Seconds to let the desktop sit before the cursor starts moving.
  [int]$LeadIn = 3,
  # Seconds to wait after the double-click before answering UAC.
  [int]$UacWait = 5,
  # After UAC, walk the Inno wizard through to the progress screen (beat b04).
  [switch]$DriveWizard,
  # Pause between wizard steps. Slow enough to read on camera; the pages
  # between b03 and b04 are not narrated, so they get trimmed either way.
  [int]$StepMs = 2600
)

$ErrorActionPreference = 'Stop'
$log = Join-Path $env:TEMP ("owlette-vm-drive-{0}.log" -f $PID)
Start-Transcript -Path $log -Force | Out-Null
Write-Host "transcript: $log" -ForegroundColor Cyan

$MOUSE = @'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Mo {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
}
"@
$tx = __X__; $ty = __Y__
# Start from the middle of the screen and glide, so the movement reads on
# camera. A teleporting cursor looks like a glitch, not like a person.
$sx = 960; $sy = 540
for ($i = 0; $i -le 30; $i++) {
  $x = [int]($sx + ($tx - $sx) * $i / 30)
  $y = [int]($sy + ($ty - $sy) * $i / 30)
  [Mo]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds 33
}
Start-Sleep -Milliseconds 600
# LEFTDOWN 0x02 / LEFTUP 0x04, twice inside the double-click interval.
[Mo]::mouse_event(0x02,0,0,0,[IntPtr]::Zero); [Mo]::mouse_event(0x04,0,0,0,[IntPtr]::Zero)
Start-Sleep -Milliseconds 90
[Mo]::mouse_event(0x02,0,0,0,[IntPtr]::Zero); [Mo]::mouse_event(0x04,0,0,0,[IntPtr]::Zero)
'@

function Get-Keyboard($vmName) {
  $sys = Get-WmiObject -Namespace 'root\virtualization\v2' -Class Msvm_ComputerSystem `
         -Filter "ElementName='$vmName'"
  $rel = $sys.GetRelated('Msvm_Keyboard') | Select-Object -First 1
  return [wmi]$rel.__PATH
}
function Invoke-Kb($kb, [string]$m, $a) {
  $rv = if ($null -eq $a) { $kb.InvokeMethod($m, @()) } else { $kb.InvokeMethod($m, @($a)) }
  if ($rv -ne 0) { throw "$m returned $rv" }
}

try {
  $cred = Import-Clixml -Path $CredFile
  $session = New-PSSession -VMName $Name -Credential $cred -ErrorAction Stop
  $script = $MOUSE.Replace('__X__', "$IconX").Replace('__Y__', "$IconY")

  $reg = Invoke-Command -Session $session -ArgumentList $script, $cred.UserName, $LeadIn -ScriptBlock {
    param($body, $user, $lead)
    New-Item -ItemType Directory -Force 'C:\owlette-setup' | Out-Null
    Set-Content -Path 'C:\owlette-setup\click.ps1' -Value $body -Encoding ASCII

    Unregister-ScheduledTask -TaskName OwlClick -Confirm:$false -ErrorAction SilentlyContinue

    # The task must be STARTED BY ITS OWN TRIGGER, not by schtasks /run.
    # A /it task cannot be launched from Session 0 - the scheduler answers
    # "ERROR: Element not found" because it cannot reach the interactive
    # session element from there (LastResult 267011, never ran). A time trigger
    # fires inside the session itself and works.
    #
    # LogonType Interactive also means NO password is needed: it runs in the
    # already-logged-on session rather than creating a new logon.
    # -WindowStyle Hidden is NOT cosmetic: without it the task opens a Windows
    # Terminal window in the middle of the frame. It did exactly that on the
    # first take, at 23.1s, on top of the desktop b03 is meant to show.
    $action    = New-ScheduledTaskAction -Execute 'powershell.exe' `
                   -Argument '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File C:\owlette-setup\click.ps1'
    $fireAt    = (Get-Date).AddSeconds($lead)
    $trigger   = New-ScheduledTaskTrigger -Once -At $fireAt
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName OwlClick -Action $action -Trigger $trigger `
      -Principal $principal -Force | Out-Null
    return [PSCustomObject]@{ GuestNow = (Get-Date).ToString('HH:mm:ss'); FiresAt = $fireAt.ToString('HH:mm:ss') }
  }
  Write-Host "click task armed: guest clock $($reg.GuestNow), fires $($reg.FiresAt)" -ForegroundColor Green

  Write-Host "waiting for the trigger (${LeadIn}s)..." -ForegroundColor Cyan
  Start-Sleep -Seconds ($LeadIn + 3)

  # Task result codes, and the two that are NOT failures:
  #   0      completed
  #   267009 (0x41301) STILL RUNNING - the mouse glide takes ~2s plus PowerShell
  #          startup, so an early check sees this. Treating it as an error
  #          aborted a take where the double-click had in fact worked.
  #   267011 (0x41303) has never run - that IS the failure.
  $ran = $null
  $deadline = (Get-Date).AddSeconds(30)
  do {
    $ran = Invoke-Command -Session $session -ScriptBlock {
      $i = Get-ScheduledTaskInfo -TaskName OwlClick
      [PSCustomObject]@{ LastRunTime = $i.LastRunTime; LastResult = $i.LastTaskResult }
    }
    if ($ran.LastResult -ne 267009) { break }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)

  Write-Host "task last run: $($ran.LastRunTime)  result: $($ran.LastResult)" -ForegroundColor Green
  if ($ran.LastResult -eq 267011) {
    throw "the click task never ran - the double-click did not happen"
  }
  if ($ran.LastResult -notin @(0, 267009)) {
    throw "the click task failed with result $($ran.LastResult)"
  }

  Write-Host "waiting ${UacWait}s for the UAC prompt..." -ForegroundColor Cyan
  Start-Sleep -Seconds $UacWait

  # Alt+Y is the accelerator for Yes. Injected from the host because the secure
  # desktop is unreachable from inside the guest's user session.
  $kb = Get-Keyboard $Name
  Invoke-Kb $kb 'PressKey'   ([uint32]0x12)   # ALT
  Invoke-Kb $kb 'TypeKey'    ([uint32]0x59)   # Y
  Invoke-Kb $kb 'ReleaseKey' ([uint32]0x12)
  Write-Host "UAC answered (Alt+Y)." -ForegroundColor Green

  if ($DriveWizard) {
    # The Inno wizard between UAC and the progress screen. These pages are not
    # narrated (b03 ends on "click yes", b04 opens on the progress screen), so
    # they land in b03's trimmed tail and only need to be traversed, not
    # performed.
    #
    # Keyboard, not mouse: the accelerators are exact, whereas clicking would
    # need per-page coordinates that shift with the wizard's page set.
    Start-Sleep -Seconds 4                      # let the wizard paint
    Write-Host "wizard: accepting the licence (Alt+A)" -ForegroundColor Cyan
    Invoke-Kb $kb 'PressKey'   ([uint32]0x12)   # ALT
    Invoke-Kb $kb 'TypeKey'    ([uint32]0x41)   # A -> "I accept the agreement"
    Invoke-Kb $kb 'ReleaseKey' ([uint32]0x12)
    Start-Sleep -Milliseconds $StepMs

    # Enter is the default button on every remaining page: Next, Next, ...,
    # then Install on the Ready page. Extra presses on a page that has already
    # advanced are harmless.
    for ($i = 1; $i -le 4; $i++) {
      Invoke-Kb $kb 'TypeKey' ([uint32]0x0D)
      Write-Host "wizard: Enter ($i/4)" -ForegroundColor Cyan
      Start-Sleep -Milliseconds $StepMs
    }
    Write-Host "wizard driven - the progress screen is beat b04." -ForegroundColor Green
  }

  Invoke-Command -Session $session -ScriptBlock {
    Unregister-ScheduledTask -TaskName OwlClick -Confirm:$false -ErrorAction SilentlyContinue
    Remove-Item 'C:\owlette-setup\click.ps1' -Force -ErrorAction SilentlyContinue
  }
  Remove-PSSession $session
  Write-Host "DRIVE OK - the installer should be running." -ForegroundColor Green
}
catch {
  Write-Host "DRIVE FAILED: $($_.Exception.Message)" -ForegroundColor Red
  throw
}
finally {
  try { Stop-Transcript | Out-Null } catch { }
}
