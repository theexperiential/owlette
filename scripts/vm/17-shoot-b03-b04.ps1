# Film episode 3's b03 and b04 in one take. Run ELEVATED.
#
#   b03 "running the installer" (14.759s) - the desktop, the double-click, the
#       UAC prompt, accepting it.
#   b04 "what it's installing"  (25.469s) - the progress screen, where the
#       status caption cycles through WebView2 / PawnIO / the Owlette service.
#
# WHY THE POINTER IS DRIVEN ON THE HOST
#
# The guest's own cursor is not present in a host-side capture. A 1500px sweep
# driven inside the guest produced no arrow anywhere along its path, while the
# guest reported its pointer parked at the left screen edge - because Hyper-V's
# absolute pointing device keeps the guest cursor glued to the HOST pointer and
# overrides anything SetCursorPos does inside the guest.
#
# So the host pointer is the actor. VMConnect keeps the guest's cursor on it and
# reshapes the host cursor to the guest's own (an I-beam over a text box), and
# gdigrab draws it with -draw_mouse 1. What lands on camera is authentic.
#
# This also replaces the scheduled-task machinery entirely: no /it task, no
# hidden PowerShell, and therefore no console window opening mid-frame.
#
# UAC IS ANSWERED BY KEYBOARD, deliberately. Alt+Y via Msvm_Keyboard reaches the
# guest's secure desktop, which host-forwarded input cannot be relied on to do.
# A mis-aimed pointer click there would hit "No" and destroy the take; the
# keyboard is unambiguous.
#
# WHY THE WINDOW IS MOVED RATHER THAN PUT INTO FULL SCREEN
#
# A snapshot revert drops the console out of full screen, and full screen could
# not be restored programmatically: Ctrl+Alt+Break in every scan-code form is
# swallowed by the RDP control and forwarded to the guest; there is no HMENU
# (WinForms MenuStrip); UI Automation exposes no menu items; a measured click on
# the View menu does not register; and there is no command-line switch or
# persisted setting.
#
# But full screen was never the actual requirement - a 1:1, chrome-free 1920x1080
# capture was. The guest surface is its own child window (OPWindowClass) that is
# ALREADY exactly 1920x1080 when windowed; it is merely surrounded by chrome, and
# the frame is bigger than the display so part of the guest sits off-screen where
# no screen capture can reach it.
#
# So the frame is moved until that child lands exactly on 0,0. The chrome falls
# off-screen, the guest fills the display, and the grab is pixel-exact. This also
# makes guest coordinates equal screen coordinates, which the pointer work relies
# on. Note MoveWindow needs elevation here: vmconnect runs elevated, and UIPI
# refuses window moves (and synthetic input) from a lower-integrity process.
#
# ASCII ONLY: PowerShell 5.1 decodes a .ps1 as the system ANSI codepage unless
# the file carries a UTF-8 BOM.

#Requires -RunAsAdministrator
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingPlainTextForPassword', 'CredFile',
  Justification = 'Path to a DPAPI-encrypted PSCredential file, not a credential.')]
param(
  [string]$Name = "owlette-e2e",
  [string]$CredFile = (Join-Path $env:LOCALAPPDATA 'owlette-vm\guest-e2e.cred'),
  [Parameter(Mandatory = $true)][string]$OutPath,
  # Staging. Omit -DownloadUrl to shoot whatever is already on the desktop.
  [string]$DownloadUrl = "",
  [string]$ExeName = "Owlette-Installer-v3.2.0.exe",
  [string]$Sha256 = "",
  [switch]$NoStage,
  # Desktop icon centre, in guest pixels.
  [int]$IconX = 37,
  [int]$IconY = 232,
  # Still desktop before the pointer moves. b03 opens on this.
  [int]$LeadIn = 8,
  # Total capture. Must cover b03 + the wizard transit + b04 with margin.
  [int]$Seconds = 140,
  [int]$Fps = 60
)

$ErrorActionPreference = 'Stop'
# A failed run can leave its transcript open (an error thrown before the try
# block skips the finally that would close it), and Start-Transcript then
# refuses - which killed a run at the very first line. Close any stragglers, use
# a per-run filename, and never let logging failure stop a shoot.
try { Stop-Transcript | Out-Null } catch { }
$log = Join-Path $env:TEMP ("owlette-vm-shoot-{0}-{1}.log" -f $PID, (Get-Date -Format 'HHmmss'))
try {
  Start-Transcript -Path $log -Force | Out-Null
  Write-Host "transcript: $log" -ForegroundColor Cyan
}
catch {
  Write-Host "(transcript unavailable: $($_.Exception.Message))" -ForegroundColor DarkGray
}

# Add-Type persists for the LIFE OF THE SHELL, and re-running this script in the
# same window then fails with "the type name already exists". Worse, a shell that
# ran an earlier revision holds a type missing the methods added since - so the
# guard checks for the methods too, and says plainly what to do about it.
$needed = @('SetCursorPos', 'GetCursorPos', 'mouse_event', 'SetForegroundWindow',
            'ShowWindow', 'GetWindowRect', 'MoveWindow', 'SetWindowPos',
            'EnumChildWindows', 'GetClientRect', 'ClientToScreen')
$existing = ([System.Management.Automation.PSTypeName]'InpV2').Type
if ($existing) {
  $missing = @($needed | Where-Object { -not $existing.GetMethod($_) })
  if ($missing.Count) {
    throw ("a stale InpV2 type is loaded in this shell (missing: " +
           ($missing -join ', ') + "). Open a NEW elevated PowerShell and re-run.")
  }
  Write-Host "reusing the InpV2 type already loaded in this shell." -ForegroundColor DarkGray
}
else {
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class InpV2 {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out PT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RC r);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool repaint);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int ht, uint flags);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumChildProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RC r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref PT p);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, System.Text.StringBuilder s, int max);
  public delegate bool EnumChildProc(IntPtr h, IntPtr p);
  [StructLayout(LayoutKind.Sequential)] public struct PT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RC { public int L, T, R, B; }
}
"@
}

function Get-Keyboard($vmName) {
  $sys = Get-WmiObject -Namespace 'root\virtualization\v2' -Class Msvm_ComputerSystem `
         -Filter "ElementName='$vmName'"
  # GetRelated() returns an object without method metadata; re-binding by path
  # is what makes InvokeMethod work.
  $rel = $sys.GetRelated('Msvm_Keyboard') | Select-Object -First 1
  return [wmi]$rel.__PATH
}
function Invoke-Kb($kb, [string]$m, $a) {
  $rv = if ($null -eq $a) { $kb.InvokeMethod($m, @()) } else { $kb.InvokeMethod($m, @($a)) }
  if ($rv -ne 0) { throw "$m returned $rv" }
}
function Move-Pointer([int]$x, [int]$y, [int]$steps = 30, [int]$ms = 33) {
  # Glide, never teleport: an instantly relocating cursor reads as a glitch
  # rather than as a person.
  $p = New-Object InpV2+PT
  [void][InpV2]::GetCursorPos([ref]$p)
  for ($i = 1; $i -le $steps; $i++) {
    [void][InpV2]::SetCursorPos(
      [int]($p.X + ($x - $p.X) * $i / $steps),
      [int]($p.Y + ($y - $p.Y) * $i / $steps))
    Start-Sleep -Milliseconds $ms
  }
}

function Get-ConsoleRect($handle) {
  $r = New-Object InpV2+RC
  [void][InpV2]::GetWindowRect($handle, [ref]$r)
  return $r
}

function Get-GuestSurface($frame) {
  # The guest renders into its own child window, already 1920x1080. Prefer the
  # DirectX painter by class; fall back to any visible child of that exact size.
  $kids = New-Object System.Collections.ArrayList
  $cb = [InpV2+EnumChildProc] { param($h, $p) [void]$kids.Add($h); return $true }
  [void][InpV2]::EnumChildWindows($frame, $cb, [IntPtr]::Zero)

  $fallback = $null
  foreach ($k in $kids) {
    if (-not [InpV2]::IsWindowVisible($k)) { continue }
    $r = Get-ConsoleRect $k
    if (($r.R - $r.L) -ne 1920 -or ($r.B - $r.T) -ne 1080) { continue }
    $cls = New-Object System.Text.StringBuilder 256
    [void][InpV2]::GetClassNameW($k, $cls, 256)
    if ($cls.ToString() -match 'OPWindowClass') { return $k }
    if (-not $fallback) { $fallback = $k }
  }
  return $fallback
}

function Set-GuestAtOrigin($frame) {
  # Seat the guest child exactly on 0,0 AND make sure the frame is big enough to
  # show all of it.
  #
  # Two separate traps here, both found the hard way:
  #
  # 1. Position. MoveWindow reports success and moves Y correctly, but X is
  #    pulled back to 0 - VMConnect clamps it in its own WM_WINDOWPOSCHANGING
  #    handler. SetWindowPos with SWP_NOSENDCHANGING skips that notification and
  #    lands it.
  #
  # 2. Size. The frame was 1925px wide, so its CLIENT area was only 1915px; the
  #    1920-wide guest child was clipped by its parent and the last 4 columns of
  #    the capture showed what was behind the window (YMAX 80 against 227 on a
  #    known-good take). The frame must therefore be sized so the client fully
  #    contains the guest, not merely positioned.
  $guest = Get-GuestSurface $frame
  if (-not $guest) { throw "could not find the 1920x1080 guest surface in the console window" }

  # SWP_NOZORDER 0x4 | SWP_NOACTIVATE 0x10 | SWP_NOSENDCHANGING 0x400
  $FLAGS = 0x414
  for ($try = 1; $try -le 5; $try++) {
    $f = Get-ConsoleRect $frame
    $g = Get-ConsoleRect $guest

    $cr = New-Object InpV2+RC
    [void][InpV2]::GetClientRect($frame, [ref]$cr)
    $clientW = $cr.R - $cr.L
    $clientH = $cr.B - $cr.T
    $borderW = ($f.R - $f.L) - $clientW
    $borderH = ($f.B - $f.T) - $clientH

    # Where the client area starts on screen, so the guest's offset inside it
    # can be measured rather than assumed.
    $origin = New-Object InpV2+PT
    $origin.X = 0; $origin.Y = 0
    [void][InpV2]::ClientToScreen($frame, [ref]$origin)
    $guestInClientX = $g.L - $origin.X
    $guestInClientY = $g.T - $origin.Y

    $needFrameW = 1920 + $guestInClientX + $borderW
    $needFrameH = 1080 + $guestInClientY + $borderH
    $newW = [Math]::Max(($f.R - $f.L), $needFrameW)
    $newH = [Math]::Max(($f.B - $f.T), $needFrameH)

    $seated = ($g.L -eq 0 -and $g.T -eq 0)
    $fits = ($clientW -ge (1920 + $guestInClientX)) -and ($clientH -ge (1080 + $guestInClientY))
    if ($seated -and $fits) { break }

    $targetX = $f.L - $g.L
    $targetY = $f.T - $g.T
    [void][InpV2]::SetWindowPos($frame, [IntPtr]::Zero, $targetX, $targetY, $newW, $newH, $FLAGS)
    Start-Sleep -Milliseconds 700

    $g2 = Get-ConsoleRect $guest
    Write-Host ("  seat {0}: frame -> {1},{2} {3}x{4} (client {5}x{6}, guest +{7},+{8}); guest now {9},{10}" -f `
      $try, $targetX, $targetY, $newW, $newH, $clientW, $clientH,
      $guestInClientX, $guestInClientY, $g2.L, $g2.T) -ForegroundColor DarkCyan
  }

  $g = Get-ConsoleRect $guest
  $cr = New-Object InpV2+RC
  [void][InpV2]::GetClientRect($frame, [ref]$cr)
  $origin = New-Object InpV2+PT
  $origin.X = 0; $origin.Y = 0
  [void][InpV2]::ClientToScreen($frame, [ref]$origin)
  $rightEdge = $origin.X + ($cr.R - $cr.L)
  $bottomEdge = $origin.Y + ($cr.B - $cr.T)

  if ($g.L -ne 0 -or $g.T -ne 0) {
    throw ("could not seat the guest surface at 0,0 (it is at $($g.L),$($g.T)). If the " +
           "error is access denied, this shell is not elevated - vmconnect runs elevated " +
           "and UIPI refuses window moves from a lower-integrity process.")
  }
  if ($rightEdge -lt 1920 -or $bottomEdge -lt 1080) {
    throw ("the console client area stops at $rightEdge,$bottomEdge - it would clip the " +
           "guest. The frame could not be grown enough to contain a full 1920x1080.")
  }
  Write-Host ("guest seated at 0,0; client reaches {0},{1} - no clipping." -f $rightEdge, $bottomEdge) -ForegroundColor Green

  # Topmost, so the host taskbar cannot overlay the bottom of the guest.
  # HWND_TOPMOST = -1; SWP_NOMOVE 0x2 | SWP_NOSIZE 0x1 = 0x3
  [void][InpV2]::SetWindowPos($frame, ([IntPtr](-1)), 0, 0, 0, 0, 0x3)
  [void][InpV2]::SetForegroundWindow($frame)
  Start-Sleep -Milliseconds 600
  return $guest
}

function Clear-Topmost($frame) {
  # HWND_NOTOPMOST = -2. Leave the console ordinary again afterwards.
  [void][InpV2]::SetWindowPos($frame, ([IntPtr](-2)), 0, 0, 0, 0, 0x3)
}

function Get-RegionYAVG([int]$x, [int]$y, [int]$w, [int]$h) {
  # One-frame grab of a screen region, reduced to its average luminance.
  # Used to detect when the installer wizard has actually painted, instead of
  # sleeping a fixed interval and hoping. (A fixed 4s wait fired Alt+A at 22.8s
  # when the wizard did not appear until ~30s, so the licence was never accepted
  # and the take stalled on the License Agreement page.)
  $png = Join-Path $env:TEMP ("wizprobe-{0}.png" -f $PID)
  & ffmpeg -v error -f gdigrab -framerate 1 -draw_mouse 0 `
      -video_size ("{0}x{1}" -f $w, $h) -offset_x $x -offset_y $y -i desktop `
      -frames:v 1 -y $png
  if (-not (Test-Path $png)) { return -1 }
  $raw = & ffmpeg -v error -i $png -vf "signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-" -f null -
  Remove-Item $png -Force -ErrorAction SilentlyContinue
  $txt = ($raw | Out-String)
  if ($txt -match 'YAVG=([\d.]+)') { return [double]$Matches[1] }
  return -1
}

$marks = [ordered]@{}
$sw = $null
function Mark([string]$what) {
  if ($sw) {
    $script:marks[$what] = [math]::Round($sw.Elapsed.TotalSeconds, 2)
    Write-Host ("  [{0,6:N2}s] {1}" -f $sw.Elapsed.TotalSeconds, $what) -ForegroundColor DarkCyan
  }
}

try {
  # --- stage ----------------------------------------------------------------
  if (-not $NoStage) {
    if (-not $DownloadUrl) { throw "pass -DownloadUrl, or -NoStage to shoot the current desktop" }
    Write-Host "staging (revert + boot + download)..." -ForegroundColor Cyan
    $stage = Join-Path $PSScriptRoot '10-stage-installer.ps1'
    & $stage -Name $Name -CredFile $CredFile -DownloadUrl $DownloadUrl -ExeName $ExeName -Sha256 $Sha256
    if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw "staging failed" }
  }

  # The console drops its session across a revert; give it a moment to repaint
  # before deciding the geometry is wrong.
  Start-Sleep -Seconds 5

  # --- raise the console and verify what we are about to film ---------------
  $con = Get-Process vmconnect -ErrorAction SilentlyContinue |
         Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if (-not $con) { throw "the VM console is not open" }
  [void][InpV2]::ShowWindow($con.MainWindowHandle, 5)
  [void][InpV2]::SetForegroundWindow($con.MainWindowHandle)
  Start-Sleep -Seconds 2

  # The full-screen connection bar would sit across the top of every frame.
  # VMConnect hosts the RDP control, so it honours PinConnectionBar: 0 means the
  # bar retracts instead of staying pinned. Set it explicitly rather than relying
  # on someone having unpinned it by hand on this machine.
  $tsc = 'HKCU:\Software\Microsoft\Terminal Server Client'
  if (Test-Path $tsc) {
    $pin = (Get-ItemProperty -Path $tsc -ErrorAction SilentlyContinue).PinConnectionBar
    if ($pin -ne 0) {
      Set-ItemProperty -Path $tsc -Name PinConnectionBar -Value 0 -Type DWord
      Write-Host "unpinned the connection bar (was $pin) - reconnect the console if it stays visible." -ForegroundColor Yellow
    }
  }

  $rc = Get-ConsoleRect $con.MainWindowHandle
  Write-Host ("console frame {0}x{1} at {2},{3}" -f ($rc.R - $rc.L), ($rc.B - $rc.T), $rc.L, $rc.T)
  $guest = Set-GuestAtOrigin $con.MainWindowHandle
  $gr = Get-ConsoleRect $guest
  if ($gr.L -ne 0 -or $gr.T -ne 0 -or ($gr.R - $gr.L) -ne 1920 -or ($gr.B - $gr.T) -ne 1080) {
    throw ("guest surface is $($gr.R - $gr.L)x$($gr.B - $gr.T) at $($gr.L),$($gr.T) - expected 1920x1080 at 0,0")
  }

  # Park the pointer mid-screen so the connection bar (if it ever shows)
  # retracts, and so the first frames do not open with the cursor in a corner.
  # Guest coordinates are screen coordinates now.
  [void][InpV2]::SetCursorPos(960, 540)
  Start-Sleep -Seconds 3

  # Geometry alone does not prove the guest is being shown: after a revert the
  # console can sit on a near-uniform 'connecting' screen. Check it has content.
  $probe = Join-Path $env:TEMP ("shootprobe-{0}.png" -f $PID)
  & ffmpeg -v error -f gdigrab -framerate 1 -draw_mouse 0 -video_size 1920x1080 -offset_x 0 -offset_y 0 -i desktop -frames:v 1 -y $probe
  # ffmpeg returns MULTIPLE lines, and -match against an array acts as a FILTER
  # rather than a capture - it returns the matching elements and never populates
  # $Matches, so reading $Matches[1] indexes into null. Flatten to one string
  # first. (No 2> redirect either: in PS 5.1 that wraps native stderr in
  # ErrorRecords, which under EAP=Stop aborts on a harmless warning.)
  $statsRaw = & ffmpeg -v error -i $probe -vf "signalstats,metadata=print:key=lavfi.signalstats.YMAX:file=-" -f null -
  $stats = ($statsRaw | Out-String)
  $ymax = 0
  if ($stats -match 'YMAX=(\d+)') { $ymax = [int]$Matches[1] }
  Remove-Item $probe -Force -ErrorAction SilentlyContinue
  Write-Host ("console content check: YMAX={0}" -f $ymax)
  if ($ymax -lt 60) { throw "the console looks blank (YMAX=$ymax) - is the guest still booting?" }

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
  # Start-Process joins -ArgumentList WITHOUT quoting, so the window title -
  # "title=owlette-e2e on localhost - Virtual Machine Connection" - was split on
  # its spaces and ffmpeg exited immediately. The whole take was then performed
  # into a recorder that was not running. Quote anything containing whitespace.
  $argStr = ($ff | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
  $ffErr = Join-Path $env:TEMP ("owlette-ffmpeg-{0}.err" -f $PID)

  Write-Host ("recording {0}s at {1}fps..." -f $Seconds, $Fps) -ForegroundColor Cyan
  $rec = Start-Process ffmpeg -ArgumentList $argStr -NoNewWindow -PassThru -RedirectStandardError $ffErr
  $sw = [Diagnostics.Stopwatch]::StartNew()
  Start-Sleep -Milliseconds 1500   # let the encoder actually open the stream

  # Fail NOW, not 115 seconds from now. A recorder that died on its arguments
  # costs a full performance - the pointer glide, the UAC prompt, the install -
  # before anyone finds out.
  if ($rec.HasExited) {
    $why = if (Test-Path $ffErr) { (Get-Content $ffErr -Raw) } else { '(no stderr captured)' }
    throw ("ffmpeg exited immediately with code $($rec.ExitCode):`n$why")
  }
  if (-not (Test-Path $tmp)) {
    $why = if (Test-Path $ffErr) { (Get-Content $ffErr -Raw) } else { '(no stderr captured)' }
    throw ("ffmpeg is running but wrote no file - check the window title.`n$why")
  }
  Mark 'recording started'

  # --- b03 -------------------------------------------------------------------
  Write-Host "b03: holding the desktop..." -ForegroundColor Cyan
  Start-Sleep -Seconds $LeadIn
  Mark 'pointer starts moving'

  Move-Pointer $IconX $IconY 34 33
  Start-Sleep -Milliseconds 700
  Mark 'pointer on the icon'

  # LEFTDOWN 0x02 / LEFTUP 0x04, twice inside the double-click interval.
  [InpV2]::mouse_event(0x02, 0, 0, 0, [IntPtr]::Zero); [InpV2]::mouse_event(0x04, 0, 0, 0, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 90
  [InpV2]::mouse_event(0x02, 0, 0, 0, [IntPtr]::Zero); [InpV2]::mouse_event(0x04, 0, 0, 0, [IntPtr]::Zero)
  Mark 'double-clicked'

  # Drift the pointer toward the middle so it is not sitting in the corner while
  # the prompt is on screen.
  Start-Sleep -Milliseconds 900
  Move-Pointer 860 600 22 30

  Write-Host "b03: waiting for UAC..." -ForegroundColor Cyan
  Start-Sleep -Seconds 5
  Mark 'UAC expected on screen'

  $kb = Get-Keyboard $Name
  Invoke-Kb $kb 'PressKey'   ([uint32]0x12)   # ALT
  Invoke-Kb $kb 'TypeKey'    ([uint32]0x59)   # Y
  Invoke-Kb $kb 'ReleaseKey' ([uint32]0x12)
  Mark 'UAC answered'

  # --- wizard transit (trimmed: between b03 and b04) -------------------------
  # WAIT FOR THE WIZARD, do not assume it. The installer took ~11s after UAC to
  # paint on one run and the keystrokes landed on an empty desktop, leaving the
  # take stuck on the License Agreement with Next greyed out.
  #
  # The wizard is a near-white dialog in the middle of the screen; the desktop
  # there is wallpaper. Average luminance separates them cleanly.
  $wizX = 780; $wizY = 400; $wizW = 360; $wizH = 180
  $seen = $false
  for ($i = 1; $i -le 30; $i++) {
    $avg = Get-RegionYAVG $wizX $wizY $wizW $wizH
    if ($avg -gt 170) { $seen = $true; break }
    Start-Sleep -Milliseconds 1200
  }
  if (-not $seen) { throw "the installer wizard never appeared - nothing to drive" }
  Start-Sleep -Milliseconds 900     # let it finish painting before typing
  Mark 'wizard visible'

  # Alt+A selects "I accept the agreement". Sent twice: re-selecting an already
  # selected radio is harmless, and a single keystroke arriving mid-paint is not.
  for ($i = 1; $i -le 2; $i++) {
    Invoke-Kb $kb 'PressKey'   ([uint32]0x12)
    Invoke-Kb $kb 'TypeKey'    ([uint32]0x41)
    Invoke-Kb $kb 'ReleaseKey' ([uint32]0x12)
    Start-Sleep -Milliseconds 1000
  }
  Mark 'licence accepted'

  # Press Next ONE AT A TIME, checking after each whether the install has begun.
  #
  # Pressing a fixed number of times overshoots: once the progress page is up the
  # default button is Cancel, so a surplus Enter raises "Exit Setup?" - which
  # happened twice in one take, and then a bad verification re-drove the wizard
  # and did it again.
  #
  # The check is C:\ProgramData\Owlette, which is where this installer extracts
  # to and appears early. The previous check looked for C:\Program Files\Owlette
  # (wrong root, so never true) and for OwletteService, which only exists once
  # the install has finished - far too late to gate the keystrokes on.
  $cred2 = Import-Clixml -Path $CredFile
  $check = $null
  try { $check = New-PSSession -VMName $Name -Credential $cred2 -ErrorAction Stop }
  catch { Write-Host "could not open a session to watch install progress: $($_.Exception.Message)" -ForegroundColor Yellow }

  $probe = {
    [PSCustomObject]@{
      Data = (Test-Path 'C:\ProgramData\Owlette')
      Svc  = [bool](Get-Service OwletteService -ErrorAction SilentlyContinue)
    }
  }

  # Baseline: a revert should leave neither behind, and if it did the detector
  # would read as "already started" and skip every Next.
  $base = if ($check) { Invoke-Command -Session $check -ScriptBlock $probe } else { $null }
  if ($base -and $base.Data) {
    Write-Host "C:\ProgramData\Owlette already exists - falling back to the service check" -ForegroundColor Yellow
  }

  function Test-InstallStarted($session, $baseline, $probeBlock) {
    if (-not $session) { return $false }
    $now = Invoke-Command -Session $session -ScriptBlock $probeBlock
    if ($baseline -and $baseline.Data) { return $now.Svc }
    return ($now.Data -or $now.Svc)
  }

  $started = $false
  for ($i = 1; $i -le 4; $i++) {
    if (Test-InstallStarted $check $base $probe) { $started = $true; break }
    Invoke-Kb $kb 'TypeKey' ([uint32]0x0D)    # Enter = Next, then Install
    Write-Host ("  wizard: Next ({0}/4)" -f $i) -ForegroundColor DarkCyan
    Start-Sleep -Milliseconds 2500
  }

  # Extraction can lag the click; wait it out rather than pressing anything more.
  if (-not $started) {
    for ($i = 1; $i -le 12; $i++) {
      if (Test-InstallStarted $check $base $probe) { $started = $true; break }
      Start-Sleep -Seconds 2
    }
  }
  if ($check) { Remove-PSSession $check }

  if ($started) { Mark 'install started (b04 opens about here)' }
  else {
    Mark 'install NOT confirmed - b04 may be unusable'
    Write-Host "the install never started; b04 will have no progress screen." -ForegroundColor Yellow
  }

  Write-Host "b04: letting the progress screen run..." -ForegroundColor Cyan
  $rec.WaitForExit()
  $sw.Stop()

  # --- verify ----------------------------------------------------------------
  if (-not (Test-Path $tmp)) {
    $why = if (Test-Path $ffErr) { (Get-Content $ffErr -Raw) } else { '(no stderr captured)' }
    throw ("ffmpeg produced no file.`n$why")
  }
  if (Test-Path $OutPath) { Remove-Item $OutPath -Force }
  Move-Item $tmp $OutPath

  $probeOut = & ffprobe -v error -show_entries format=duration:stream=width,height,r_frame_rate `
                -of default=noprint_wrappers=1 $OutPath
  Write-Host ""
  Write-Host ($probeOut -join '  ') -ForegroundColor Green
  Write-Host ""
  Write-Host "OFFSETS (seconds into the take):" -ForegroundColor Yellow
  $marks.GetEnumerator() | ForEach-Object { Write-Host ("  {0,-38} {1}" -f $_.Key, $_.Value) }
  Write-Host ""
  Clear-Topmost $con.MainWindowHandle
  Write-Host "SHOOT OK -> $OutPath" -ForegroundColor Green
}
catch {
  Write-Host "SHOOT FAILED: $($_.Exception.Message)" -ForegroundColor Red
  throw
}
finally {
  try { Stop-Transcript | Out-Null } catch { }
}
