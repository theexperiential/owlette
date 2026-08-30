# Film episode 9's b01 and b02 in one take. Run ELEVATED.
#
#   b01 "the amber eye in the tray" (24.268s) - the taskbar, hover the owlette
#       icon, hold on the tooltip.
#   b02 "the tray menu"             (24.999s) - right-click it; the header rows
#       then the items, ending on exit.
#
# EXIT IS HOVERED, NEVER CLICKED. The beat's own note says so: clicking it stops
# the service and raises a UAC prompt, both of which would be in the shot.
#
# The tooltip is re-triggered rather than held. Windows hides a tray tooltip
# after a few seconds and will not bring it back while the pointer stays on the
# same icon, so the pointer steps off onto the desktop and back - which reads as
# someone moving the mouse, and keeps a tooltip on screen for most of the beat.
#
# Coordinates are MEASURED, not estimated (capture the tooltip and the open
# menu, then read them off the frame). Estimating them is what put a right-click on
# the wallpaper and opened the desktop context menu instead.
#
# ASCII ONLY: PowerShell 5.1 decodes a .ps1 as the system ANSI codepage unless
# the file carries a UTF-8 BOM.

#Requires -RunAsAdministrator
param(
  [string]$Name = "owlette-e2e",
  [Parameter(Mandatory = $true)][string]$OutPath,
  # The owlette tray icon, and a resting spot on the desktop just above the
  # taskbar used to break the hover so the tooltip can re-fire.
  [int]$IconX = 1732,
  [int]$IconY = 1055,
  [int]$OffX = 1732,
  [int]$OffY = 985,
  # Tray menu: the items sit at these screen rows once it is open.
  [int]$MenuX = 1790,
  [int]$OpenY = 975,
  [int]$RestartY = 997,
  [int]$LoginY = 1019,
  [int]$ExitY = 1040,
  [int]$Seconds = 75,
  [int]$Fps = 60
)

$ErrorActionPreference = 'Stop'
try { Stop-Transcript | Out-Null } catch { }
$log = Join-Path $env:TEMP ("owlette-vm-ep09-{0}-{1}.log" -f $PID, (Get-Date -Format 'HHmmss'))
try { Start-Transcript -Path $log -Force | Out-Null; Write-Host "transcript: $log" -ForegroundColor Cyan }
catch { Write-Host "(transcript unavailable)" -ForegroundColor DarkGray }

$needed = @('SetCursorPos', 'GetCursorPos', 'mouse_event', 'SetForegroundWindow',
            'ShowWindow', 'GetWindowRect', 'SetWindowPos', 'EnumChildWindows',
            'IsWindowVisible', 'GetClassNameW', 'GetClientRect', 'ClientToScreen',
            'SetProcessDPIAware', 'keybd_event')
$existing = ([System.Management.Automation.PSTypeName]'Tray09').Type
if ($existing) {
  $missing = @($needed | Where-Object { -not $existing.GetMethod($_) })
  if ($missing.Count) {
    throw ("a stale Tray09 type is loaded in this shell (missing: " + ($missing -join ', ') +
           "). Open a NEW elevated PowerShell and re-run.")
  }
}
else {
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Tray09 {
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
  public delegate bool EnumChildProc(IntPtr h, IntPtr p);
  [StructLayout(LayoutKind.Sequential)] public struct PT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RC { public int L, T, R, B; }
}
"@
}

# BEFORE any coordinate is touched. A DPI-unaware process gets virtualized
# coordinates: SetCursorPos and GetCursorPos agree with each other while the
# pointer physically lands elsewhere - which put a tray right-click ~25px off
# and opened the desktop context menu instead of owlette's.
[void][Tray09]::SetProcessDPIAware()

function Get-Rect09($h) {
  $r = New-Object Tray09+RC
  [void][Tray09]::GetWindowRect($h, [ref]$r)
  return $r
}

function Get-GuestSurface09($frame) {
  $kids = New-Object System.Collections.ArrayList
  $cb = [Tray09+EnumChildProc] { param($h, $p) [void]$kids.Add($h); return $true }
  [void][Tray09]::EnumChildWindows($frame, $cb, [IntPtr]::Zero)
  $fallback = $null
  foreach ($k in $kids) {
    if (-not [Tray09]::IsWindowVisible($k)) { continue }
    $r = Get-Rect09 $k
    if (($r.R - $r.L) -ne 1920 -or ($r.B - $r.T) -ne 1080) { continue }
    $cls = New-Object System.Text.StringBuilder 256
    [void][Tray09]::GetClassNameW($k, $cls, 256)
    if ($cls.ToString() -match 'OPWindowClass') { return $k }
    if (-not $fallback) { $fallback = $k }
  }
  return $fallback
}

function Set-GuestAtOrigin09($frame) {
  # Same technique as 17-shoot-b03-b04.ps1: VMConnect cannot be put into full
  # screen programmatically, so the frame is moved until the guest child sits on
  # 0,0 and sized so the client area is not clipping it. SWP_NOSENDCHANGING is
  # required - VMConnect clamps the position in its own WM_WINDOWPOSCHANGING.
  $guest = Get-GuestSurface09 $frame
  if (-not $guest) { throw "could not find the 1920x1080 guest surface" }
  $FLAGS = 0x414
  for ($try = 1; $try -le 5; $try++) {
    $f = Get-Rect09 $frame
    $g = Get-Rect09 $guest
    $cr = New-Object Tray09+RC
    [void][Tray09]::GetClientRect($frame, [ref]$cr)
    $clientW = $cr.R - $cr.L; $clientH = $cr.B - $cr.T
    $borderW = ($f.R - $f.L) - $clientW; $borderH = ($f.B - $f.T) - $clientH
    $origin = New-Object Tray09+PT
    $origin.X = 0; $origin.Y = 0
    [void][Tray09]::ClientToScreen($frame, [ref]$origin)
    $gx = $g.L - $origin.X; $gy = $g.T - $origin.Y
    $seated = ($g.L -eq 0 -and $g.T -eq 0)
    $fits = ($clientW -ge (1920 + $gx)) -and ($clientH -ge (1080 + $gy))
    if ($seated -and $fits) { break }
    [void][Tray09]::SetWindowPos($frame, [IntPtr]::Zero, ($f.L - $g.L), ($f.T - $g.T),
      [Math]::Max(($f.R - $f.L), (1920 + $gx + $borderW)),
      [Math]::Max(($f.B - $f.T), (1080 + $gy + $borderH)), $FLAGS)
    Start-Sleep -Milliseconds 700
  }
  $g = Get-Rect09 $guest
  if ($g.L -ne 0 -or $g.T -ne 0) {
    throw "could not seat the guest at 0,0 (it is at $($g.L),$($g.T)) - is this shell elevated?"
  }
  [void][Tray09]::SetWindowPos($frame, ([IntPtr](-1)), 0, 0, 0, 0, 0x3)   # topmost
  [void][Tray09]::SetForegroundWindow($frame)
  Start-Sleep -Milliseconds 600
  return $guest
}

function Move-Pointer09([int]$x, [int]$y, [int]$steps = 26, [int]$ms = 30) {
  $p = New-Object Tray09+PT
  [void][Tray09]::GetCursorPos([ref]$p)
  for ($i = 1; $i -le $steps; $i++) {
    [void][Tray09]::SetCursorPos(
      [int]($p.X + ($x - $p.X) * $i / $steps),
      [int]($p.Y + ($y - $p.Y) * $i / $steps))
    Start-Sleep -Milliseconds $ms
  }
}

$marks = [ordered]@{}
$sw = $null
function Mark09([string]$what) {
  if ($sw) {
    $script:marks[$what] = [math]::Round($sw.Elapsed.TotalSeconds, 2)
    Write-Host ("  [{0,6:N2}s] {1}" -f $sw.Elapsed.TotalSeconds, $what) -ForegroundColor DarkCyan
  }
}

try {
  $con = Get-Process vmconnect -ErrorAction SilentlyContinue |
         Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if (-not $con) { throw "the VM console is not open" }
  [void][Tray09]::ShowWindow($con.MainWindowHandle, 5)
  [void][Tray09]::SetForegroundWindow($con.MainWindowHandle)
  Start-Sleep -Seconds 1
  [void](Set-GuestAtOrigin09 $con.MainWindowHandle)
  Write-Host "guest seated at 0,0." -ForegroundColor Green

  # Park mid-screen and make sure no menu is left open from a previous run.
  [void][Tray09]::SetCursorPos(900, 520)
  [Tray09]::keybd_event(0x1B, 0, 0, [IntPtr]::Zero)
  [Tray09]::keybd_event(0x1B, 0, 2, [IntPtr]::Zero)
  Start-Sleep -Seconds 2

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
  # Start-Process does not quote -ArgumentList; quote anything with whitespace.
  $argStr = ($ff | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
  $ffErr = Join-Path $env:TEMP ("owlette-ep09-ffmpeg-{0}.err" -f $PID)

  Write-Host ("recording {0}s at {1}fps..." -f $Seconds, $Fps) -ForegroundColor Cyan
  $rec = Start-Process ffmpeg -ArgumentList $argStr -NoNewWindow -PassThru -RedirectStandardError $ffErr
  $sw = [Diagnostics.Stopwatch]::StartNew()
  Start-Sleep -Milliseconds 1500
  if ($rec.HasExited -or -not (Test-Path $tmp)) {
    $why = if (Test-Path $ffErr) { Get-Content $ffErr -Raw } else { '(no stderr)' }
    throw "ffmpeg is not recording:`n$why"
  }
  Mark09 'recording started'

  # --- b01: the amber eye ----------------------------------------------------
  Start-Sleep -Seconds 4
  Mark09 'b01 in (desktop settled)'
  Move-Pointer09 $IconX $IconY 30 33
  Mark09 'pointer on the tray icon'
  Start-Sleep -Seconds 5                       # tooltip appears and is read

  # Re-fire the tooltip twice: it times out, and will not return while the
  # pointer stays put.
  for ($i = 1; $i -le 2; $i++) {
    Move-Pointer09 $OffX $OffY 8 25
    Start-Sleep -Milliseconds 700
    Move-Pointer09 $IconX $IconY 8 25
    Start-Sleep -Seconds 5
  }
  Mark09 'b01 out'

  # --- b02: the tray menu ----------------------------------------------------
  Start-Sleep -Seconds 1
  [Tray09]::mouse_event(0x08, 0, 0, 0, [IntPtr]::Zero)   # RIGHTDOWN
  [Tray09]::mouse_event(0x10, 0, 0, 0, [IntPtr]::Zero)   # RIGHTUP
  Start-Sleep -Milliseconds 900
  Mark09 'b02 in (menu open)'

  Start-Sleep -Seconds 5                       # the four header rows get read
  Move-Pointer09 $MenuX $OpenY 14 30
  Start-Sleep -Seconds 4
  Move-Pointer09 $MenuX $RestartY 8 30
  Start-Sleep -Seconds 4
  Move-Pointer09 $MenuX $LoginY 8 30
  Start-Sleep -Seconds 4
  Move-Pointer09 $MenuX $ExitY 8 30
  Mark09 'hovering exit (NOT clicked)'
  Start-Sleep -Seconds 6
  Mark09 'b02 out'

  $rec.WaitForExit()
  $sw.Stop()

  # Leave the guest tidy: close the menu without activating anything.
  [Tray09]::keybd_event(0x1B, 0, 0, [IntPtr]::Zero)
  [Tray09]::keybd_event(0x1B, 0, 2, [IntPtr]::Zero)
  [void][Tray09]::SetWindowPos($con.MainWindowHandle, ([IntPtr](-2)), 0, 0, 0, 0, 0x3)

  if (-not (Test-Path $tmp)) {
    $why = if (Test-Path $ffErr) { Get-Content $ffErr -Raw } else { '(no stderr)' }
    throw "ffmpeg produced no file.`n$why"
  }
  if (Test-Path $OutPath) { Remove-Item $OutPath -Force }
  Move-Item $tmp $OutPath

  $probe = & ffprobe -v error -show_entries format=duration:stream=width,height,r_frame_rate `
             -of default=noprint_wrappers=1 $OutPath
  Write-Host ""
  Write-Host ($probe -join '  ') -ForegroundColor Green
  Write-Host ""
  Write-Host "OFFSETS (seconds into the take):" -ForegroundColor Yellow
  $marks.GetEnumerator() | ForEach-Object { Write-Host ("  {0,-32} {1}" -f $_.Key, $_.Value) }
  Write-Host ""
  Write-Host "SHOOT OK -> $OutPath" -ForegroundColor Green
}
catch {
  Write-Host "SHOOT FAILED: $($_.Exception.Message)" -ForegroundColor Red
  throw
}
finally {
  try { Stop-Transcript | Out-Null } catch { }
}
