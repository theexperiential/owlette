# Send keystrokes into a running guest over Msvm_Keyboard. Run ELEVATED.
#
# This is the general-purpose input tool for driving a guest that has no
# automation agent in it - the sign-in screen, the installer wizard, and the UAC
# prompt. It reaches ALL of them, including the secure desktop, because the
# synthetic keyboard sits below the OS input stack: unlike a UI-automation
# process it is not blocked by UIPI or by the secure desktop.
#
#   .\11-send-keys.ps1 -Text 'e2e' -Enter          # sign in
#   .\11-send-keys.ps1 -Keys 0x1B                  # Esc
#   .\11-send-keys.ps1 -Combo 'shift+f10'          # a modified key
#
# Correctness notes that cost several attempts to learn:
#   * GetRelated() returns an object with NO method metadata, so a direct
#     $kb.TypeKey() yields a raw object rather than a status code and an
#     "is it 0?" test reads absence-of-error as success. Rehydrate with
#     [wmi]$path and use InvokeMethod, which returns a real uint32.
#   * A console in mark/selection mode (title starts "Select ") swallows every
#     keystroke while the API still reports success. -ClearMark sends Esc first.
#
# ASCII ONLY: PowerShell 5.1 decodes a .ps1 as the system ANSI codepage unless
# the file carries a UTF-8 BOM.

#Requires -RunAsAdministrator
param(
  [string]$Name = "owlette-e2e",
  # Literal text to type in ONE TypeText call. Fast, but the guest can drop
  # characters - which on a password field looks exactly like a wrong password.
  [string]$Text = "",
  # Literal text typed one virtual-key at a time with a delay between each.
  # Slower and far more reliable; use it for anything that must be exact.
  [string]$SlowText = "",
  [int]$KeyDelayMs = 140,
  # Virtual-key codes to press in order, e.g. 0x1B (Esc), 0x0D (Enter).
  [int[]]$Keys = @(),
  # "ctrl+alt+del", "shift+f10", "alt+y" - modifiers held around the last key.
  [string]$Combo = "",
  # Press Enter after the text/keys.
  [switch]$Enter,
  # Send Esc first, in case a console is in mark mode.
  [switch]$ClearMark,
  # Seconds to wait before sending anything (let a screen settle).
  [int]$DelayBefore = 0
)

$ErrorActionPreference = 'Stop'
# Transcript, because this runs in a separate elevated window: without one there
# is no way to tell "the keys were rejected" from "the script never ran", and
# guessing between those two wasted several rounds already.
$log = Join-Path $env:TEMP ("owlette-vm-keys-{0}.log" -f $PID)
Start-Transcript -Path $log -Force | Out-Null
Write-Host "transcript: $log" -ForegroundColor Cyan

$VK = @{
  'ctrl' = 0x11; 'control' = 0x11; 'alt' = 0x12; 'shift' = 0x10
  'enter' = 0x0D; 'return' = 0x0D; 'esc' = 0x1B; 'escape' = 0x1B
  'tab' = 0x09; 'space' = 0x20; 'del' = 0x2E; 'delete' = 0x2E
  'up' = 0x26; 'down' = 0x28; 'left' = 0x25; 'right' = 0x27
  'home' = 0x24; 'end' = 0x23; 'win' = 0x5B
  'f1' = 0x70; 'f2' = 0x71; 'f3' = 0x72; 'f4' = 0x73; 'f5' = 0x74; 'f6' = 0x75
  'f7' = 0x76; 'f8' = 0x77; 'f9' = 0x78; 'f10' = 0x79; 'f11' = 0x7A; 'f12' = 0x7B
}

function Get-Keyboard($vmName) {
  $sys = Get-WmiObject -Namespace 'root\virtualization\v2' -Class Msvm_ComputerSystem `
         -Filter "ElementName='$vmName'"
  if (-not $sys) { throw "no Msvm_ComputerSystem for '$vmName'" }
  $rel = $sys.GetRelated('Msvm_Keyboard') | Select-Object -First 1
  if (-not $rel) { throw "no Msvm_Keyboard for '$vmName' (is it running?)" }
  return [wmi]$rel.__PATH
}

function Invoke-Kb($kb, [string]$method, $arg) {
  $rv = if ($null -eq $arg) { $kb.InvokeMethod($method, @()) } else { $kb.InvokeMethod($method, @($arg)) }
  if ($rv -ne 0) { throw "$method returned $rv" }
}

$kb = Get-Keyboard $Name
if ($DelayBefore -gt 0) { Start-Sleep -Seconds $DelayBefore }
if ($ClearMark) { Invoke-Kb $kb 'TypeKey' ([uint32]0x1B); Start-Sleep -Milliseconds 400 }

if ($Combo) {
  $parts = $Combo.ToLower() -split '\+' | ForEach-Object { $_.Trim() }
  $mods = @($parts[0..($parts.Count - 2)])
  $final = $parts[-1]
  $finalVk = if ($VK.ContainsKey($final)) { $VK[$final] }
             elseif ($final.Length -eq 1) { [int][char]$final.ToUpper() }
             else { throw "unknown key '$final'" }
  foreach ($m in $mods) {
    if (-not $VK.ContainsKey($m)) { throw "unknown modifier '$m'" }
    Invoke-Kb $kb 'PressKey' ([uint32]$VK[$m])
  }
  Invoke-Kb $kb 'TypeKey' ([uint32]$finalVk)
  foreach ($m in $mods) { Invoke-Kb $kb 'ReleaseKey' ([uint32]$VK[$m]) }
  Write-Host "sent combo: $Combo" -ForegroundColor Green
}

# Keys BEFORE text, so a single call can dismiss a dialog and then type into
# what it reveals.
foreach ($k in $Keys) {
  Invoke-Kb $kb 'TypeKey' ([uint32]$k)
  Start-Sleep -Milliseconds $KeyDelayMs
}
if ($Keys.Count) { Write-Host "sent $($Keys.Count) key(s)" -ForegroundColor Green }

if ($Text) {
  Invoke-Kb $kb 'TypeText' ([string]$Text)
  Write-Host "sent text ($($Text.Length) chars, one TypeText call)" -ForegroundColor Green
}

if ($SlowText) {
  foreach ($ch in $SlowText.ToCharArray()) {
    $shift = $false
    if     ($ch -cmatch '^[a-z]$') { $code = [int][char]([string]$ch).ToUpper() }
    elseif ($ch -cmatch '^[A-Z]$') { $code = [int][char]$ch; $shift = $true }
    elseif ($ch -match  '^[0-9]$') { $code = [int][char]$ch }
    elseif ($ch -eq ' ')           { $code = 0x20 }
    elseif ($ch -eq '.')           { $code = 0xBE }
    elseif ($ch -eq '-')           { $code = 0xBD }
    elseif ($ch -eq '_')           { $code = 0xBD; $shift = $true }
    elseif ($ch -eq '\')           { $code = 0xDC }
    elseif ($ch -eq '/')           { $code = 0xBF }
    elseif ($ch -eq ':')           { $code = 0xBA; $shift = $true }
    elseif ($ch -eq '!')           { $code = 0x31; $shift = $true }
    elseif ($ch -eq '@')           { $code = 0x32; $shift = $true }
    else { throw "no virtual-key mapping for '$ch' - add it to -SlowText" }

    if ($shift) { Invoke-Kb $kb 'PressKey' ([uint32]0x10) }
    Invoke-Kb $kb 'TypeKey' ([uint32]$code)
    if ($shift) { Invoke-Kb $kb 'ReleaseKey' ([uint32]0x10) }
    Start-Sleep -Milliseconds $KeyDelayMs
  }
  Write-Host "sent slow text ($($SlowText.Length) chars, key by key)" -ForegroundColor Green
}

if ($Enter) {
  Start-Sleep -Milliseconds 300
  Invoke-Kb $kb 'TypeKey' ([uint32]0x0D)
  Write-Host "sent Enter" -ForegroundColor Green
}
Write-Host "KEYS OK" -ForegroundColor Green
try { Stop-Transcript | Out-Null } catch { }
