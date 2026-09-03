# Film the drag-and-drop "add process" demo in one take. Run ELEVATED.
#
# Used by TWO episodes:
#   ep05 b03 "or just drop it on the machine" (19.0s) - the drag, the drop
#       overlay, the confirm card, confirm, the process appears.
#   ep09 b04 second half - the same drop, filling the stretch its desktop
#       capture spends frozen on the + button (enforcedWaitSec 14.76).
#
# WHY THIS IS SHOT ON THE VM AT ALL: an OS file drop arrives in the app as a
# Tauri host event (useFileDrop listens to onDragDropEvent, not ondrop), which
# CDP cannot synthesize - so no Playwright path exists. But a real press-move-
# release driven on the HOST pointer lands in the guest as a genuine Explorer
# drag (see 17-shoot-b03-b04.ps1 for why the host pointer is the actor).
#
# PREREQUISITES
#   1. 21-push-desktop-build.ps1 -SeedDropFile has run: the guest app is the
#      current build and lobby-wall.bat sits on the guest desktop. (This script
#      re-seeds the file if it is missing, but does NOT push the app.)
#   2. The VM is running and its console (vmconnect) is open. Both are checked;
#      the console is launched if missing.
#
# THREE MODES - calibrate before you roll:
#   -Probe     seat the console, save one PNG frame, exit. Read the icon and
#              window positions off it.
#   -Rehearse  perform the whole drag WITHOUT recording, save a PNG of the
#              confirm card, then press Esc so nothing is added. Read the
#              confirm button position off it, pass as -ConfirmX/-ConfirmY.
#   (default)  the real take. Requires -ConfirmX/-ConfirmY from the rehearsal.
#
# The recording defaults to 30 fps ON PURPOSE: gdigrab cannot sustain 60 while
# grabbing a live VM console (03-b01/03-b03/09-b01 all claim 60 and contain
# 32-51 real fps). 30 is what the capture can actually hold.
#
# ASCII ONLY: PowerShell 5.1 decodes a .ps1 as the system ANSI codepage unless
# the file carries a UTF-8 BOM.

#Requires -RunAsAdministrator
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingPlainTextForPassword', 'CredFile',
  Justification = 'Path to a DPAPI-encrypted PSCredential file, not a credential.')]
param(
  [string]$Name = "owlette-e2e",
  [string]$CredFile = (Join-Path $env:LOCALAPPDATA 'owlette-vm\guest-e2e.cred'),
  [string]$OutPath = "C:\Users\admin\Documents\Git\Owlette\dev\video-tutorials\footage\native\05-b03-drag-drop.mp4",
  [switch]$Probe,
  [switch]$Rehearse,
  # Frame every step of the tray interaction (menu open, hover, after click)
  # without recording - for calibrating TrayX/Y and MenuOpenX/Y off real pixels.
  [switch]$TrayDebug,
  # Where probe/rehearsal frames land, for reading coordinates off.
  [string]$FrameDir = (Join-Path $env:TEMP 'owlette-dragdrop-frames'),

  # Opening the owlette window: a SECOND INSTANCE without --tray, launched in
  # the guest's interactive session via a scheduled task. The single-instance
  # plugin forwards it to the running app, which calls show_main_window
  # (lib.rs) - verified by tmp/gui.pid appearing. Pointer paths were tried
  # first and are NOT reliable here: tray clicks never reached the app's
  # handler (hover tooltips worked; gui.pid never appeared), on both the
  # right-click menu and the left-click open. -SkipOpen if the window is
  # already open on the guest.
  [switch]$SkipOpen,
  [int]$TrayX = 1732,
  [int]$TrayY = 1055,

  # The seeded lobby-wall.bat desktop icon (verify with -Probe).
  [int]$IconX = 37,
  [int]$IconY = 90,
  # Where inside the owlette window the file is dropped (verify with -Probe).
  [int]$DropX = 960,
  [int]$DropY = 540,
  # The confirm card's confirm button (measure with -Rehearse). -1 = not set.
  [int]$ConfirmX = -1,
  [int]$ConfirmY = -1,

  [int]$LeadIn = 4,
  [int]$Seconds = 50,
  [int]$Fps = 30,
  # Refuse to drive input unless the HOST has been untouched this long. A human
  # hand on the mouse mid-choreography wrecks the take AND wrecks their work -
  # a job once ran while the operator was at the machine (the cursor sat on a
  # SECONDARY monitor at negative X) and every click fought them. 0 disables.
  [int]$MinIdleSec = 30
)

$ErrorActionPreference = 'Stop'
try { Stop-Transcript | Out-Null } catch { }
$log = Join-Path $env:TEMP ("owlette-vm-dragdrop-{0}-{1}.log" -f $PID, (Get-Date -Format 'HHmmss'))
try { Start-Transcript -Path $log -Force | Out-Null; Write-Host "transcript: $log" -ForegroundColor Cyan }
catch { Write-Host "(transcript unavailable)" -ForegroundColor DarkGray }

$needed = @('SetCursorPos', 'GetCursorPos', 'mouse_event', 'SetForegroundWindow',
            'ShowWindow', 'GetWindowRect', 'SetWindowPos', 'EnumChildWindows',
            'IsWindowVisible', 'GetClassNameW', 'GetClientRect', 'ClientToScreen',
            'SetProcessDPIAware', 'keybd_event', 'GetForegroundWindow',
            'GetSystemMetrics', 'GetLastInputInfo')
$existing = ([System.Management.Automation.PSTypeName]'Drag22').Type
if ($existing) {
  $missing = @($needed | Where-Object { -not $existing.GetMethod($_) })
  if ($missing.Count) {
    throw ("a stale Drag22 type is loaded in this shell (missing: " + ($missing -join ', ') +
           "). Open a NEW elevated PowerShell and re-run.")
  }
}
else {
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Drag22 {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out PT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RC r);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int ht, uint flags);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumChildProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int max);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RC r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref PT p);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LII l);
  [StructLayout(LayoutKind.Sequential)] public struct LII { public uint cbSize; public uint dwTime; }
  public delegate bool EnumChildProc(IntPtr h, IntPtr p);
  [StructLayout(LayoutKind.Sequential)] public struct PT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RC { public int L, T, R, B; }
}
"@
}
[void][Drag22]::SetProcessDPIAware()

function Get-Rect22($h) {
  $r = New-Object Drag22+RC
  [void][Drag22]::GetWindowRect($h, [ref]$r)
  return $r
}

function Get-GuestSurface22($frame) {
  $kids = New-Object System.Collections.ArrayList
  $cb = [Drag22+EnumChildProc] { param($h, $p) [void]$kids.Add($h); return $true }
  [void][Drag22]::EnumChildWindows($frame, $cb, [IntPtr]::Zero)
  $fallback = $null
  foreach ($k in $kids) {
    if (-not [Drag22]::IsWindowVisible($k)) { continue }
    $r = Get-Rect22 $k
    if (($r.R - $r.L) -ne 1920 -or ($r.B - $r.T) -ne 1080) { continue }
    $cls = New-Object System.Text.StringBuilder 256
    [void][Drag22]::GetClassNameW($k, $cls, 256)
    if ($cls.ToString() -match 'OPWindowClass') { return $k }
    if (-not $fallback) { $fallback = $k }
  }
  return $fallback
}

function Set-GuestAtOrigin22($frame) {
  # Same two traps as 17-shoot-b03-b04.ps1: VMConnect clamps MoveWindow (use
  # SetWindowPos with SWP_NOSENDCHANGING) and the frame must be GROWN so its
  # client area contains the full 1920x1080 guest, or the capture edge shows
  # whatever is behind the window.
  $guest = Get-GuestSurface22 $frame
  if (-not $guest) { throw "could not find the 1920x1080 guest surface in the console window" }
  $FLAGS = 0x414   # SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOSENDCHANGING
  for ($try = 1; $try -le 5; $try++) {
    $f = Get-Rect22 $frame
    $g = Get-Rect22 $guest
    $cr = New-Object Drag22+RC
    [void][Drag22]::GetClientRect($frame, [ref]$cr)
    $clientW = $cr.R - $cr.L; $clientH = $cr.B - $cr.T
    $borderW = ($f.R - $f.L) - $clientW; $borderH = ($f.B - $f.T) - $clientH
    $origin = New-Object Drag22+PT
    $origin.X = 0; $origin.Y = 0
    [void][Drag22]::ClientToScreen($frame, [ref]$origin)
    $gx = $g.L - $origin.X; $gy = $g.T - $origin.Y
    $newW = [Math]::Max(($f.R - $f.L), 1920 + $gx + $borderW)
    $newH = [Math]::Max(($f.B - $f.T), 1080 + $gy + $borderH)
    $seated = ($g.L -eq 0 -and $g.T -eq 0)
    $fits = ($clientW -ge (1920 + $gx)) -and ($clientH -ge (1080 + $gy))
    if ($seated -and $fits) { break }
    [void][Drag22]::SetWindowPos($frame, [IntPtr]::Zero, ($f.L - $g.L), ($f.T - $g.T), $newW, $newH, $FLAGS)
    Start-Sleep -Milliseconds 700
  }
  $g = Get-Rect22 $guest
  if ($g.L -ne 0 -or $g.T -ne 0) {
    throw ("could not seat the guest surface at 0,0 (it is at $($g.L),$($g.T)); if access " +
           "denied, this shell is not elevated (vmconnect is, and UIPI refuses the move).")
  }
  [void][Drag22]::SetWindowPos($frame, ([IntPtr](-1)), 0, 0, 0, 0, 0x3)   # topmost
  [void][Drag22]::SetForegroundWindow($frame)
  Start-Sleep -Milliseconds 600
  return $guest
}

function Clear-Topmost22($frame) {
  [void][Drag22]::SetWindowPos($frame, ([IntPtr](-2)), 0, 0, 0, 0, 0x3)
}

function Set-ConsoleFocus22($frame) {
  # The console must be the ACTIVE window, not merely topmost, or the guest
  # never sees a click: hover tooltips appeared (hover needs no activation)
  # while every click died - eaten as the activation click (WM_MOUSEACTIVATE).
  # A background process is refused SetForegroundWindow outright; synthesizing
  # an Alt keystroke makes the shell grant it. Then one sacrificial click on
  # the guest wallpaper (away from icons and the app window) absorbs any
  # remaining activation-eat, so the NEXT click is the first real one.
  [Drag22]::keybd_event(0x12, 0, 0, [IntPtr]::Zero)      # ALT down
  [void][Drag22]::SetForegroundWindow($frame)
  [Drag22]::keybd_event(0x12, 0, 2, [IntPtr]::Zero)      # ALT up
  Start-Sleep -Milliseconds 400
  Move-Pointer22 300 700 10 20
  [Drag22]::mouse_event(0x02, 0, 0, 0, [IntPtr]::Zero)
  [Drag22]::mouse_event(0x04, 0, 0, 0, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 400
  if ([Drag22]::GetForegroundWindow() -ne $frame) {
    # Not a warning: driving input without the console foreground sends clicks
    # into whatever the OPERATOR is doing. Stop.
    throw ("the console could not take foreground - someone else is likely " +
           "using this machine. Not driving input over their work.")
  }
  Write-Host "  console is foreground; clicks will forward." -ForegroundColor DarkCyan
}

function Assert-HostIdle22 {
  if ($MinIdleSec -le 0) { return }
  $lii = New-Object Drag22+LII
  $lii.cbSize = [uint32][Runtime.InteropServices.Marshal]::SizeOf($lii)
  if ([Drag22]::GetLastInputInfo([ref]$lii)) {
    $idle = ([Environment]::TickCount - [int]$lii.dwTime) / 1000.0
    if ($idle -lt $MinIdleSec) {
      throw ("the host saw real input {0:N0}s ago (need {1}s of quiet) - someone " +
             "is at the machine. Re-run when they step away, or pass -MinIdleSec 0 " +
             "deliberately." -f $idle, $MinIdleSec)
    }
    Write-Host ("  host idle {0:N0}s - clear to drive." -f $idle) -ForegroundColor DarkCyan
  }
}

function Move-Pointer22([int]$x, [int]$y, [int]$steps = 30, [int]$ms = 33) {
  $p = New-Object Drag22+PT
  [void][Drag22]::GetCursorPos([ref]$p)
  for ($i = 1; $i -le $steps; $i++) {
    [void][Drag22]::SetCursorPos(
      [int]($p.X + ($x - $p.X) * $i / $steps),
      [int]($p.Y + ($y - $p.Y) * $i / $steps))
    Start-Sleep -Milliseconds $ms
  }
}

function Save-Frame22([string]$tag) {
  New-Item -ItemType Directory -Force $FrameDir | Out-Null
  $png = Join-Path $FrameDir ("{0}-{1}.png" -f $tag, (Get-Date -Format 'HHmmss'))
  & ffmpeg -v error -f gdigrab -framerate 1 -draw_mouse 1 -video_size 1920x1080 `
      -offset_x 0 -offset_y 0 -i desktop -frames:v 1 -y $png
  if (Test-Path $png) { Write-Host "frame: $png" -ForegroundColor Yellow }
  return $png
}

function Get-Keyboard22($vmName) {
  $sys = Get-WmiObject -Namespace 'root\virtualization\v2' -Class Msvm_ComputerSystem `
         -Filter "ElementName='$vmName'"
  $rel = $sys.GetRelated('Msvm_Keyboard') | Select-Object -First 1
  return [wmi]$rel.__PATH
}
function Send-GuestKey22($kb, [uint32]$vk) {
  $rv = $kb.InvokeMethod('TypeKey', @($vk))
  if ($rv -ne 0) { throw "TypeKey($vk) returned $rv" }
}

function Move-Injected22([int]$x, [int]$y, [int]$steps = 40, [int]$ms = 35) {
  # INJECTED absolute moves, not SetCursorPos. SetCursorPos repositions the
  # cursor without entering the input queue, and with a button held that
  # difference is fatal: the guest never sees a genuine press-move sequence,
  # Explorer's drag threshold never trips, and the "drag" silently becomes a
  # click. (Plain hovers are fine with SetCursorPos - tooltips proved that -
  # which is exactly what made this one expensive to find.)
  $w = [Drag22]::GetSystemMetrics(0)
  $h = [Drag22]::GetSystemMetrics(1)
  $p = New-Object Drag22+PT
  [void][Drag22]::GetCursorPos([ref]$p)
  for ($i = 1; $i -le $steps; $i++) {
    # Clamp to the primary display: a start position on a secondary monitor
    # (negative X) would otherwise blow the uint conversion.
    $cx = [math]::Min([math]::Max([int]($p.X + ($x - $p.X) * $i / $steps), 0), $w - 1)
    $cy = [math]::Min([math]::Max([int]($p.Y + ($y - $p.Y) * $i / $steps), 0), $h - 1)
    $nx = [uint32][math]::Round($cx * 65535 / ($w - 1))
    $ny = [uint32][math]::Round($cy * 65535 / ($h - 1))
    # MOUSEEVENTF_MOVE 0x1 | MOUSEEVENTF_ABSOLUTE 0x8000
    [Drag22]::mouse_event(0x8001, $nx, $ny, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds $ms
  }
}

function Invoke-Drag22([switch]$SnapMidDrag) {
  # The actual performance: glide to the icon, press, drag slowly onto the
  # window (the drop overlay lights while the payload is over it), hold so the
  # overlay reads on camera, release.
  Move-Pointer22 $IconX $IconY 30 33
  Start-Sleep -Milliseconds 800
  [Drag22]::mouse_event(0x02, 0, 0, 0, [IntPtr]::Zero)      # LEFTDOWN
  Start-Sleep -Milliseconds 350
  # A short jiggle first: OLE starts the drag on a movement threshold, and a
  # glide that begins instantly can read as a click-and-miss.
  Move-Injected22 ($IconX + 26) ($IconY + 12) 8 30
  Move-Injected22 $DropX $DropY 55 40                       # the slow carry
  if ($SnapMidDrag) { $null = Save-Frame22 'mid-drag' }
  Start-Sleep -Milliseconds 1800                            # overlay on screen
  [Drag22]::mouse_event(0x04, 0, 0, 0, [IntPtr]::Zero)      # LEFTUP = drop
}

$marks = [ordered]@{}
$sw = $null
function Mark22([string]$what) {
  if ($script:sw) {
    $script:marks[$what] = [math]::Round($script:sw.Elapsed.TotalSeconds, 2)
    Write-Host ("  [{0,6:N2}s] {1}" -f $script:sw.Elapsed.TotalSeconds, $what) -ForegroundColor DarkCyan
  }
}

try {
  # --- the VM and its console ------------------------------------------------
  $vm = Get-VM -Name $Name -ErrorAction Stop
  if ($vm.State -ne 'Running') {
    Write-Host "starting VM '$Name' (was $($vm.State))..." -ForegroundColor Cyan
    Start-VM -Name $Name
    $deadline = (Get-Date).AddMinutes(3)
    while ((Get-Date) -lt $deadline) {
      Start-Sleep -Seconds 5
      $vm = Get-VM -Name $Name
      if ($vm.Heartbeat -match 'Ok') { break }
    }
    if ($vm.Heartbeat -notmatch 'Ok') { throw "VM heartbeat is $($vm.Heartbeat) after 3 minutes" }
    Start-Sleep -Seconds 20   # give the desktop session a moment past heartbeat
  }

  $con = Get-Process vmconnect -ErrorAction SilentlyContinue |
         Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if (-not $con) {
    Write-Host "opening the VM console..." -ForegroundColor Cyan
    Start-Process vmconnect -ArgumentList @('localhost', $Name)
    Start-Sleep -Seconds 8
    $con = Get-Process vmconnect -ErrorAction SilentlyContinue |
           Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if (-not $con) { throw "vmconnect did not open a window" }
  }

  # The full-screen connection bar would cross the top of every frame.
  $tsc = 'HKCU:\Software\Microsoft\Terminal Server Client'
  if (Test-Path $tsc) {
    $pin = (Get-ItemProperty -Path $tsc -ErrorAction SilentlyContinue).PinConnectionBar
    if ($pin -ne 0) { Set-ItemProperty -Path $tsc -Name PinConnectionBar -Value 0 -Type DWord }
  }

  [void][Drag22]::ShowWindow($con.MainWindowHandle, 5)
  [void][Drag22]::SetForegroundWindow($con.MainWindowHandle)
  Start-Sleep -Seconds 2
  Assert-HostIdle22
  $null = Set-GuestAtOrigin22 $con.MainWindowHandle
  Write-Host "guest seated at 0,0." -ForegroundColor Green
  Set-ConsoleFocus22 $con.MainWindowHandle

  # --- guest prep: the drop file must exist ----------------------------------
  $cred = Import-Clixml -Path $CredFile
  $s = New-PSSession -VMName $Name -Credential $cred -ErrorAction Stop
  Invoke-Command -Session $s -ScriptBlock {
    $f = Join-Path ([Environment]::GetFolderPath('Desktop')) 'lobby-wall.bat'
    if (-not (Test-Path $f)) {
      Set-Content -Path $f -Encoding ASCII -Value @(
        '@echo off',
        'rem demo payload for the owlette drag-and-drop beat',
        'timeout /t 86400 > nul')
      "seeded $f"
    } else { "drop file present: $f" }
  } | ForEach-Object { Write-Host "  $_" }
  $appVer = Invoke-Command -Session $s -ScriptBlock {
    (Get-Item 'C:\ProgramData\Owlette\app\owlette-desktop.exe' -ErrorAction SilentlyContinue).VersionInfo.FileVersion
  }
  Remove-PSSession $s
  Write-Host "  guest app version: $appVer (push the current build with 21-push-desktop-build.ps1 if stale)"

  if ($Probe) {
    [void][Drag22]::SetCursorPos(960, 900)
    Start-Sleep -Milliseconds 800
    $null = Save-Frame22 'probe'
    Clear-Topmost22 $con.MainWindowHandle
    Write-Host "PROBE DONE - read the icon and window positions off the frame." -ForegroundColor Green
    return
  }

  if ($TrayDebug) {
    Write-Host "TRAY DEBUG - framing each step..." -ForegroundColor Cyan
    Move-Pointer22 $TrayX $TrayY 26 30
    Start-Sleep -Milliseconds 900
    $null = Save-Frame22 'traydebug-hover-icon'
    [Drag22]::mouse_event(0x02, 0, 0, 0, [IntPtr]::Zero)
    [Drag22]::mouse_event(0x04, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Seconds 4
    Move-Pointer22 960 900 12 30
    Start-Sleep -Milliseconds 500
    $null = Save-Frame22 'traydebug-after-click'
    Clear-Topmost22 $con.MainWindowHandle
    Write-Host "TRAY DEBUG DONE - read the frames in order." -ForegroundColor Green
    return
  }

  # --- open the owlette window (second instance, forwarded), unless told not to
  if (-not $SkipOpen) {
    Write-Host "opening the owlette window (second instance via scheduled task)..." -ForegroundColor Cyan
    $s2 = New-PSSession -VMName $Name -Credential $cred -ErrorAction Stop
    $opened = Invoke-Command -Session $s2 -ScriptBlock {
      $proc = Get-CimInstance Win32_Process -Filter "Name='owlette-desktop.exe'" | Select-Object -First 1
      if ($null -eq $proc) { return "NO-APP" }
      $owner = Invoke-CimMethod -InputObject $proc -MethodName GetOwner
      $action = New-ScheduledTaskAction -Execute 'C:\ProgramData\Owlette\app\owlette-desktop.exe'
      $principal = New-ScheduledTaskPrincipal -UserId "$($owner.Domain)\$($owner.User)" -LogonType Interactive
      Register-ScheduledTask -TaskName 'owlette-open-window' -Action $action -Principal $principal -Force | Out-Null
      Start-ScheduledTask -TaskName 'owlette-open-window'
      Start-Sleep -Seconds 6
      Unregister-ScheduledTask -TaskName 'owlette-open-window' -Confirm:$false
      if (Test-Path 'C:\ProgramData\Owlette\tmp\gui.pid') { "OPEN" } else { "NOT-OPEN" }
    }
    Remove-PSSession $s2
    if ($opened -ne "OPEN") { throw "could not open the owlette window in the guest ($opened)" }
    Write-Host "  window is open (gui.pid present)." -ForegroundColor Green
    Move-Pointer22 960 900 16 30                            # park off the window
    Start-Sleep -Milliseconds 800
  }

  if ($Rehearse) {
    Write-Host "REHEARSAL - dragging without recording..." -ForegroundColor Cyan
    Invoke-Drag22 -SnapMidDrag
    Start-Sleep -Seconds 3                                  # card settles
    $null = Save-Frame22 'rehearse-card'
    $kb = Get-Keyboard22 $Name
    Send-GuestKey22 $kb ([uint32]0x1B)                      # Esc - add nothing
    Start-Sleep -Seconds 1
    $null = Save-Frame22 'rehearse-after-esc'
    Clear-Topmost22 $con.MainWindowHandle
    Write-Host "REHEARSAL DONE - measure the confirm button off rehearse-card, pass -ConfirmX/-ConfirmY." -ForegroundColor Green
    Write-Host "If Esc did NOT close the card, close it by hand before the real take." -ForegroundColor Yellow
    return
  }

  if ($ConfirmX -lt 0 -or $ConfirmY -lt 0) {
    throw "no -ConfirmX/-ConfirmY. Run -Rehearse first and measure the confirm button off the saved frame."
  }

  # --- roll ------------------------------------------------------------------
  New-Item -ItemType Directory -Force (Split-Path $OutPath -Parent) | Out-Null
  $tmp = "$OutPath.tmp.mp4"
  if (Test-Path $tmp) { Remove-Item $tmp -Force }
  $ff = @(
    '-v', 'error', '-y',
    '-f', 'gdigrab', '-framerate', "$Fps", '-draw_mouse', '1',
    '-video_size', '1920x1080', '-offset_x', '0', '-offset_y', '0', '-i', 'desktop',
    '-t', "$Seconds",
    '-c:v', 'h264_nvenc', '-preset', 'p5', '-cq', '19',
    '-pix_fmt', 'yuv420p',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
    $tmp
  )
  $argStr = ($ff | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
  $ffErr = Join-Path $env:TEMP ("owlette-ffmpeg-{0}.err" -f $PID)
  [void][Drag22]::SetCursorPos(960, 900)

  Write-Host ("recording {0}s at {1}fps..." -f $Seconds, $Fps) -ForegroundColor Cyan
  $rec = Start-Process ffmpeg -ArgumentList $argStr -NoNewWindow -PassThru -RedirectStandardError $ffErr
  $sw = [Diagnostics.Stopwatch]::StartNew()
  Start-Sleep -Milliseconds 1500
  if ($rec.HasExited) {
    $why = if (Test-Path $ffErr) { (Get-Content $ffErr -Raw) } else { '(no stderr captured)' }
    throw ("ffmpeg exited immediately with code $($rec.ExitCode):`n$why")
  }
  if (-not (Test-Path $tmp)) { throw "ffmpeg is running but wrote no file" }
  Mark22 'recording started'

  Start-Sleep -Seconds $LeadIn
  Mark22 'drag begins (ep05 b03 opens on the resting desktop before this)'
  Invoke-Drag22
  Mark22 'dropped - confirm card up'

  Start-Sleep -Seconds 5                                    # card reading time
  Move-Pointer22 $ConfirmX $ConfirmY 20 33
  Start-Sleep -Milliseconds 700
  [Drag22]::mouse_event(0x02, 0, 0, 0, [IntPtr]::Zero)
  [Drag22]::mouse_event(0x04, 0, 0, 0, [IntPtr]::Zero)
  Mark22 'confirmed'
  Start-Sleep -Milliseconds 1200
  Move-Pointer22 960 820 18 33                              # off the list, let it read
  Mark22 'process row + toast on screen'

  $rec.WaitForExit()
  $sw.Stop()

  if (-not (Test-Path $tmp)) {
    $why = if (Test-Path $ffErr) { (Get-Content $ffErr -Raw) } else { '(no stderr captured)' }
    throw ("ffmpeg produced no file.`n$why")
  }
  if (Test-Path $OutPath) { Remove-Item $OutPath -Force }
  Move-Item $tmp $OutPath
  $probeOut = & ffprobe -v error -show_entries format=duration:stream=width,height,r_frame_rate,nb_frames `
                -of default=noprint_wrappers=1 $OutPath
  Write-Host ""
  Write-Host ($probeOut -join '  ') -ForegroundColor Green
  Write-Host ""
  Write-Host "OFFSETS (seconds into the take):" -ForegroundColor Yellow
  $marks.GetEnumerator() | ForEach-Object { Write-Host ("  {0,-58} {1}" -f $_.Key, $_.Value) }
  Write-Host ""
  Clear-Topmost22 $con.MainWindowHandle
  Write-Host "SHOOT OK -> $OutPath" -ForegroundColor Green
  Write-Host "Remember: the take added a real process to the guest - remove it in the app (or revert the VM) before any other shoot." -ForegroundColor Yellow
}
catch {
  Write-Host "SHOOT FAILED: $($_.Exception.Message)" -ForegroundColor Red
  throw
}
finally {
  try { Stop-Transcript | Out-Null } catch { }
}
