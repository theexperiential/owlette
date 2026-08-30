# Record the VM console window to an mp4. Run UNELEVATED (no Hyper-V calls).
#
# The console must be in FULL SCREEN on a 1920x1080 host, which is the only way
# to get the guest 1:1: windowed VMConnect adds a menu bar, toolbar and status
# bar, and a 1920x1080 guest is then scaled down to fit. This is the same
# problem the web harness solved by fullscreening the browser, and the same
# answer - remove the chrome rather than trying to compute around it.
#
# It must also be in BASIC session (12-basic-session.ps1): enhanced session is
# an RDP re-render rather than the guest's raw framebuffer.
#
# ASCII ONLY: PowerShell 5.1 decodes a .ps1 as the system ANSI codepage unless
# the file carries a UTF-8 BOM.

param(
  [string]$WindowTitle = "owlette-e2e on localhost - Virtual Machine Connection",
  [Parameter(Mandatory = $true)][string]$OutPath,
  [Parameter(Mandatory = $true)][int]$Seconds,
  [int]$Fps = 60
)

$ErrorActionPreference = 'Stop'

# Verify the geometry BEFORE recording, not after. A take that turns out to be
# 1920x1155 with a toolbar in it is a wasted run, and this whole project has
# already shipped one batch of footage nobody checked.
$probe = Join-Path $env:TEMP ("vmprobe-{0}.png" -f $PID)
# NO 2>&1 here. In PS 5.1 redirecting a native exe's stderr wraps each line in
# an ErrorRecord, and under EAP=Stop a harmless ffmpeg warning then aborts the
# script - which is exactly how one take was lost ("Couldn't get cursor info").
& ffmpeg -v error -f gdigrab -framerate 1 -draw_mouse 0 -i "title=$WindowTitle" -frames:v 1 -y $probe
if (-not (Test-Path $probe)) { throw "could not capture the window '$WindowTitle' - is the console open?" }
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile($probe)
$w = $img.Width; $h = $img.Height
$img.Dispose(); Remove-Item $probe -Force -ErrorAction SilentlyContinue
Write-Host "window is ${w}x${h}" -ForegroundColor Cyan
if ($w -ne 1920 -or $h -ne 1080) {
  throw ("expected 1920x1080, got ${w}x${h}. The console is not in full screen - " +
         "click the VM window and press Ctrl+Alt+Break, or View > Full Screen.")
}
Write-Host "geometry verified 1:1 with the guest." -ForegroundColor Green

# -draw_mouse 1 is REQUIRED, and the reason is not obvious: the guest's own
# cursor does not appear in a host-side capture at all (proven with a 1500px
# sweep that produced no arrow). What gets filmed is the HOST pointer, which
# VMConnect keeps glued to the guest's position AND reshapes to the guest's
# cursor - an I-beam over a text box, and so on. So the host pointer is the
# on-camera actor, and it must be drawn.

New-Item -ItemType Directory -Force (Split-Path $OutPath -Parent) | Out-Null
$tmp = "$OutPath.tmp.mp4"
if (Test-Path $tmp) { Remove-Item $tmp -Force }

# NVENC where available; the host has it and the guest console is just pixels.
$args = @(
  '-v', 'error', '-y',
  '-f', 'gdigrab', '-framerate', "$Fps", '-draw_mouse', '1',
  '-i', "title=$WindowTitle",
  '-t', "$Seconds",
  '-c:v', 'h264_nvenc', '-preset', 'p5', '-cq', '19',
  '-pix_fmt', 'yuv420p', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
  $tmp
)
Write-Host "recording ${Seconds}s at ${Fps}fps..." -ForegroundColor Cyan
& ffmpeg @args
if ($LASTEXITCODE -ne 0) {
  Write-Host "NVENC path failed; retrying with libx264" -ForegroundColor Yellow
  $args = @(
    '-v', 'error', '-y',
    '-f', 'gdigrab', '-framerate', "$Fps", '-draw_mouse', '1',
    '-i', "title=$WindowTitle",
    '-t', "$Seconds",
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
    '-pix_fmt', 'yuv420p',
    $tmp
  )
  & ffmpeg @args
  if ($LASTEXITCODE -ne 0) { throw "ffmpeg failed on both capture paths" }
}

if (Test-Path $OutPath) { Remove-Item $OutPath -Force }
Move-Item $tmp $OutPath
$probeOut = & ffprobe -v error -show_entries format=duration:stream=width,height,r_frame_rate -of default=noprint_wrappers=1 $OutPath
Write-Host ($probeOut -join '  ') -ForegroundColor Green
Write-Host "RECORDED $OutPath" -ForegroundColor Green
