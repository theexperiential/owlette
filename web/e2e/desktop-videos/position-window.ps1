<#
.SYNOPSIS
  Size and centre one owlette-desktop.exe window so ffmpeg can film a fixed region.

.DESCRIPTION
  The Tauri window remembers its SIZE but never its POSITION
  (desktop/src-tauri/src/window_state.rs: "Size and maximised, never position"),
  and `center: true` in tauri.conf.json centres the *configured* 1060x640 before
  the stored layout resizes it. So a window pinned larger for a take keeps the
  small window's top-left and can hang off the bottom-right of the display.
  Nothing in the app's IPC surface moves a window, and CDP's Browser domain does
  not reach a WebView2 host, so this is the seam.

  Takes a WINDOW rect. The caller measures the resulting CLIENT rect over CDP and
  calls again with a correction if the borderless frame is inset: the client rect
  is what ffmpeg films, so it is the only measurement trusted.

  Nothing is restored afterwards; window position is not persisted state.
  The window is matched by process id, never by title. A title match could pick
  up the operator's own instance.

  ASCII ONLY, deliberately. `powershell.exe -File` on Windows PowerShell 5.1
  reads a BOM-less UTF-8 script as ANSI, and a single non-ASCII character (an em
  dash) is enough to mangle a string literal into a parse error.

.OUTPUTS
  One JSON object: { "window": {...}, "client": {...}, "workArea": {...} }.
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [Parameter(Mandatory = $true)][int]$Width,
  [Parameter(Mandatory = $true)][int]$Height
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms

if (-not ('Owlette.Win32' -as [type])) {
  Add-Type -Namespace Owlette -Name Win32 -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)]
public struct RECT { public int Left, Top, Right, Bottom; }

[DllImport("user32.dll", SetLastError = true)]
public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);

[DllImport("user32.dll", SetLastError = true)]
public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

[DllImport("user32.dll", SetLastError = true)]
public static extern bool GetClientRect(IntPtr hWnd, out RECT lpRect);

[DllImport("user32.dll", SetLastError = true)]
public static extern bool SetForegroundWindow(IntPtr hWnd);
'@
}

$process = Get-Process -Id $ProcessId
$handle = $process.MainWindowHandle
if ($handle -eq [IntPtr]::Zero) {
  # A window that exists but has not been shown yet reports a null handle.
  $process.Refresh()
  $handle = $process.MainWindowHandle
}
if ($handle -eq [IntPtr]::Zero) {
  throw "process $ProcessId has no main window yet - the app has not shown one"
}

$workArea = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
if ($Width -gt $workArea.Width -or $Height -gt $workArea.Height) {
  throw "a ${Width}x${Height} window does not fit the primary display's work area ($($workArea.Width)x$($workArea.Height)) - lower OWLETTE_DESKTOP_VIDEO_SIZE or film on a larger primary display"
}

$x = $workArea.X + [int][math]::Floor(($workArea.Width - $Width) / 2)
$y = $workArea.Y + [int][math]::Floor(($workArea.Height - $Height) / 2)

if (-not [Owlette.Win32]::MoveWindow($handle, $x, $y, $Width, $Height, $true)) {
  $code = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
  throw "MoveWindow failed for process $ProcessId (win32 error $code)"
}

# Frames land on top of whatever the operator left open; a background window
# would film their desktop instead.
[void][Owlette.Win32]::SetForegroundWindow($handle)

$windowRect = New-Object 'Owlette.Win32+RECT'
[void][Owlette.Win32]::GetWindowRect($handle, [ref]$windowRect)
$clientRect = New-Object 'Owlette.Win32+RECT'
[void][Owlette.Win32]::GetClientRect($handle, [ref]$clientRect)

@{
  window   = @{
    x      = $windowRect.Left
    y      = $windowRect.Top
    width  = $windowRect.Right - $windowRect.Left
    height = $windowRect.Bottom - $windowRect.Top
  }
  client   = @{
    width  = $clientRect.Right - $clientRect.Left
    height = $clientRect.Bottom - $clientRect.Top
  }
  workArea = @{
    x      = $workArea.X
    y      = $workArea.Y
    width  = $workArea.Width
    height = $workArea.Height
  }
} | ConvertTo-Json -Compress
