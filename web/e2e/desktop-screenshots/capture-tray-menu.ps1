<#
.SYNOPSIS
  Screenshot the owlette tray icon's right-click menu.

.DESCRIPTION
  The tray menu is a native Win32 popup (`#32768`), not part of the webview, so
  CDP cannot see it and Playwright cannot drive it. UI Automation can: find the
  notification-area button whose tooltip starts "owlette v", right-click it, wait
  for the popup, and have the window render itself with `PrintWindow`.

  Everything about the menu's *contents* comes from the running app — which, when
  this is invoked by the screenshot pipeline, is the capture instance with a
  scratch data root and a generic COMPUTERNAME. Nothing here has to sanitise
  anything.

  The pointer is put back where it was, and the menu is dismissed with Escape,
  whatever happens. No new dependency: UIAutomationClient and System.Drawing ship
  with the .NET Framework that Windows PowerShell already runs on.

.PARAMETER Out
  Absolute path of the PNG to write.

.PARAMETER ExpectHostname
  The `hostname:` line the wanted icon's tooltip carries — the capture instance's
  generic COMPUTERNAME. The notification area keeps a dead icon's button around
  until the shell next pings its owner, so right after the real tray was replaced
  there can be two owlette buttons and only one of them opens a menu. Preferring
  the matching tooltip picks the live one; the retry below covers the rest.

.NOTES
  Requires the owlette icon to be *visible* on the taskbar rather than tucked into
  the hidden-icons overflow — the overflow is a XAML island that has to be opened
  before its buttons exist. If the icon cannot be found the script exits 1 and
  says so, rather than leaving a stale screenshot in place.
#>
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$ExpectHostname = ''
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

Add-Type @'
using System;
using System.Runtime.InteropServices;
public class OwletteTrayShot {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  /// Render the whole window, including the parts DWM composites.
  public const uint PW_RENDERFULLCONTENT = 2;
  public const uint RIGHT_DOWN = 0x0008;
  public const uint RIGHT_UP = 0x0010;
  public static void RightClick() {
    mouse_event(RIGHT_DOWN, 0, 0, 0, IntPtr.Zero);
    System.Threading.Thread.Sleep(70);
    mouse_event(RIGHT_UP, 0, 0, 0, IntPtr.Zero);
  }
}
'@

$root = [System.Windows.Automation.AutomationElement]::RootElement

$buttonCondition = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Button)

$menuCondition = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ClassNameProperty, '#32768')

function Get-TaskbarWindow {
  $trayCondition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ClassNameProperty, 'Shell_TrayWnd')
  $tray = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $trayCondition)
  if (-not $tray) {
    Write-Error 'no Shell_TrayWnd — is this an interactive desktop session?'
    exit 1
  }
  return $tray
}

<#
  Every owlette button currently reachable, the one whose tooltip names the
  expected machine first.

  Both the taskbar and the hidden-icons flyout are searched. The flyout only
  exists as a window while it is open, which is why opening it is a separate
  step the caller takes when the taskbar alone came up empty.

  A button can outlive the process that put it there — the shell prunes a dead
  icon lazily — so "found" is not "will open a menu"; the caller tries each.
#>
function Get-OwletteIcons {
  $preferred = @()
  $others = @()
  $script:lastSeenNames = @()

  $containers = @(Get-TaskbarWindow)
  foreach ($window in $root.FindAll(
      [System.Windows.Automation.TreeScope]::Children,
      [System.Windows.Automation.Condition]::TrueCondition)) {
    try { $className = $window.Current.ClassName } catch { continue }
    if ($className -match 'Overflow') { $containers += $window }
  }

  foreach ($container in $containers) {
    foreach ($button in $container.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants, $buttonCondition)) {
      try { $name = $button.Current.Name } catch { continue }
      if ($name -notlike '*owlette v*') { continue }
      $script:lastSeenNames += $name -replace "`r?`n", ' | '
      if ($ExpectHostname -and $name -like "*hostname: $ExpectHostname*") { $preferred += $button }
      else { $others += $button }
    }
  }

  return @($preferred) + @($others)
}

<# Open the hidden-icons flyout, so its buttons exist to be found. #>
function Open-Overflow {
  foreach ($button in (Get-TaskbarWindow).FindAll(
      [System.Windows.Automation.TreeScope]::Descendants, $buttonCondition)) {
    try { $name = $button.Current.Name } catch { continue }
    if ($name -notlike '*Hidden Icons*') { continue }
    try {
      $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    } catch {
      return $false
    }
    Start-Sleep -Milliseconds 700
    return $true
  }
  return $false
}

$savedCursor = New-Object OwletteTrayShot+POINT
[void][OwletteTrayShot]::GetCursorPos([ref]$savedCursor)

try {
  # The icon is destroyed and recreated when the tray app is replaced, and the
  # shell can take a few seconds to publish the new button — so discovery gets a
  # deadline rather than a fixed number of tries.
  $menu = $null
  $seenAny = $false
  $overflowOpened = $false
  $started = Get-Date
  $discoveryDeadline = $started.AddSeconds(25)
  while (-not $menu -and (Get-Date) -lt $discoveryDeadline) {
    $icons = Get-OwletteIcons
    if ($icons) { $seenAny = $true }

    foreach ($icon in $icons) {
      try { $bounds = $icon.Current.BoundingRectangle } catch { continue }
      [void][OwletteTrayShot]::SetCursorPos(
        [int]($bounds.X + $bounds.Width / 2), [int]($bounds.Y + $bounds.Height / 2))
      Start-Sleep -Milliseconds 300
      [OwletteTrayShot]::RightClick()

      # Give the popup time to appear before looking for it, and look
      # infrequently once we do. A tight UIA poll against the desktop root while
      # the menu is being created reliably stops it from appearing at all —
      # measured: polling every 150 ms never found a menu for an icon that a
      # single lookup 1.2 s after the same click found every time. A button left
      # behind by a killed instance simply never produces one.
      Start-Sleep -Milliseconds 1200
      $deadline = (Get-Date).AddSeconds(3)
      while ((Get-Date) -lt $deadline) {
        $menu = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $menuCondition)
        if ($menu) { break }
        Start-Sleep -Milliseconds 600
      }
      if ($menu) { break }

      # Whatever that click did open — a flyout, nothing — must not still be up
      # when the next candidate is clicked.
      [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
      Start-Sleep -Milliseconds 200
    }
    if ($menu) { break }

    # Give the shell a few seconds to replace a button left by the instance we
    # took over from before assuming the live icon is somewhere else. Then look
    # in the hidden-icons flyout: Windows starts a *new* process's icon there,
    # and a tray app that was just replaced is a new process.
    if (-not $overflowOpened -and ((Get-Date) - $started).TotalSeconds -ge 8) {
      $overflowOpened = Open-Overflow
    }
    Start-Sleep -Milliseconds 500
  }

  if (-not $menu) {
    if ($seenAny) {
      Write-Error ('the owlette tray icon is there but never opened a menu. Buttons seen: ' +
        ($script:lastSeenNames -join ' // '))
      exit 2
    }
    Write-Error ('no owlette icon in the notification area — is the desktop app running? ' +
      'If its icon is in the hidden-icons overflow and the flyout will not open, turn the icon ' +
      'on under taskbar settings > other system tray icons and run this again.')
    exit 1
  }

  $handle = [IntPtr]$menu.Current.NativeWindowHandle

  # Windows shows the popup, measures it, and may move it before the fade
  # settles. Wait for the rectangle to stop changing rather than guessing.
  $rect = New-Object OwletteTrayShot+RECT
  $previous = ''
  $deadline = (Get-Date).AddSeconds(5)
  while ((Get-Date) -lt $deadline) {
    [void][OwletteTrayShot]::GetWindowRect($handle, [ref]$rect)
    $current = "$($rect.L),$($rect.T),$($rect.R),$($rect.B)"
    if ($current -eq $previous) { break }
    $previous = $current
    Start-Sleep -Milliseconds 150
  }

  $width = $rect.R - $rect.L
  $height = $rect.B - $rect.T
  if ($width -le 0 -or $height -le 0) {
    Write-Error "the tray menu reported an empty rectangle ($width x $height)"
    exit 2
  }

  $directory = Split-Path -Parent $Out
  if ($directory -and -not (Test-Path $directory)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
  }

  # `PrintWindow`, not `CopyFromScreen`.
  #
  # Reading the screen means reading whatever the compositor happens to be
  # showing in that rectangle, and for this popup that is not reliably the
  # popup: measured over six consecutive grabs, a screen capture produced three
  # different images — one of them the menu ghosted over an offset copy of
  # itself, which looks exactly like a corrupt screenshot. `PrintWindow` asks the
  # window to render itself into our DC instead, and returned the same bytes all
  # six times. `PW_RENDERFULLCONTENT` (2) is what makes it work for a
  # DWM-composited window.
  #
  # The two-identical-captures rule is kept anyway: it costs 250 ms and it is the
  # only thing standing between a mid-animation frame and the documentation.
  $captureFrame = {
    $bitmap = New-Object System.Drawing.Bitmap($width, $height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $hdc = $graphics.GetHdc()
    $rendered = [OwletteTrayShot]::PrintWindow($handle, $hdc, [OwletteTrayShot]::PW_RENDERFULLCONTENT)
    $graphics.ReleaseHdc($hdc)
    $graphics.Dispose()
    if (-not $rendered) {
      $bitmap.Dispose()
      throw 'the tray menu refused to render itself (PrintWindow failed)'
    }
    $bitmap
  }

  $sha = [System.Security.Cryptography.SHA256]::Create()
  $captured = $null
  $capturedBitmap = $null
  $lastDigest = ''
  try {
    for ($attempt = 0; $attempt -lt 6; $attempt++) {
      $bitmap = & $captureFrame
      $stream = New-Object System.IO.MemoryStream
      try {
        $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        $bytes = $stream.ToArray()
      } finally {
        $stream.Dispose()
      }

      $digest = [BitConverter]::ToString($sha.ComputeHash($bytes))
      if ($digest -eq $lastDigest) {
        $captured = $bytes
        $capturedBitmap = $bitmap
        break
      }
      $lastDigest = $digest
      $bitmap.Dispose()
      Start-Sleep -Milliseconds 250
    }

    if (-not $captured) {
      Write-Error 'the tray menu never held still long enough to photograph'
      exit 2
    }

    # A window that renders black or blank still returns success from
    # PrintWindow on some compositors. A menu has text on it; a handful of
    # distinct colours in a grid sample is the cheapest proof of that.
    $sampled = @{}
    for ($y = 0; $y -lt $height; $y += 8) {
      for ($x = 0; $x -lt $width; $x += 8) {
        $sampled[$capturedBitmap.GetPixel($x, $y).ToArgb()] = $true
      }
    }
    if ($sampled.Count -lt 3) {
      Write-Error "the tray menu rendered blank ($($sampled.Count) distinct colours)"
      exit 2
    }
  } finally {
    if ($capturedBitmap) { $capturedBitmap.Dispose() }
    $sha.Dispose()
  }

  [System.IO.File]::WriteAllBytes($Out, $captured)
  Write-Output "wrote $Out ($width x $height)"
} finally {
  [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
  Start-Sleep -Milliseconds 300
  [void][OwletteTrayShot]::SetCursorPos($savedCursor.X, $savedCursor.Y)
}
