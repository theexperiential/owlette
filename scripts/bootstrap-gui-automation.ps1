<#
.SYNOPSIS
Validates (and optionally configures) a Windows machine for Owlette GUI automation.

.DESCRIPTION
Executable form of docs/internal/gui-automation-machine-setup.md. Validate-only by
default: every check maps to a line of that doc and the script exits 1 on any
failure, so it doubles as a preflight for automation runs; warnings are advisory
and do not gate. -Apply fixes the safe subset (power timeouts, screen-saver and
resume-logon registry, the pinned Python venv, and for CaptureRig the Defender
exclusion; the idle auto-lock policy value stays manual).
Unlike the sibling script, -Apply runs even when validation failed - fixing those
failures is its purpose - and the exit code still reflects the pre-apply
validation, so re-run without -Apply to verify. Items that are manual by design
(autologon, Windows Update deferral, DPI/resolution changes, snapshots, runner
registration) are printed as a to-do list at the end - this script never touches
UAC, credentials, or policy.

Sibling of bootstrap-windows.ps1 (general dev-box toolchain); this one is for the
two GUI-automation rigs: the video-capture machine and the e2e runner VM.

.PARAMETER Rig
Which rig profile to check (alias: -Profile). Common = the machine-setup doc's
Profile A only (default). CaptureRig adds Profile B checks (ffmpeg/OBS/Defender
exclusion, single monitor). E2eRunner adds Profile C checks (Node/Playwright,
autologon, Windows Update, GitHub runner not-a-service).

.PARAMETER Apply
Apply the safe-subset fixes after validation (power, screensaver, venv, and the
CaptureRig Defender exclusion). Runs even when validation failed; the exit code
still reflects validation, so re-run without -Apply afterwards to verify.

.PARAMETER VenvPath
Path of the pinned pywinauto venv. Defaults to the capture-native venv, the only
rig venv that exists today; the e2e harness can point this elsewhere later.

.EXAMPLE
.\scripts\bootstrap-gui-automation.ps1 -Rig CaptureRig

.EXAMPLE
.\scripts\bootstrap-gui-automation.ps1 -Rig E2eRunner -Apply
#>
param(
    [ValidateSet('Common', 'CaptureRig', 'E2eRunner')]
    [Alias('Profile')]
    [string]$Rig = 'Common',
    [switch]$Apply,
    [string]$VenvPath,
    [switch]$Detailed
)

$ErrorActionPreference = 'Stop'

$script:checks = 0
$script:passed = 0
$script:warned = 0
$script:failed = 0

$script:PassSymbol = [char]0x2713
$script:WarnSymbol = [char]0x26A0
$script:FailSymbol = [char]0x2717
$script:InfoSymbol = [char]0x2139

$repoRoot = Split-Path -Parent $PSScriptRoot

if ([string]::IsNullOrWhiteSpace($VenvPath)) {
    $VenvPath = Join-Path $repoRoot 'dev\video-tutorials\capture-native\.venv'
}

function Write-Pass {
    param([string]$Message)

    $script:passed++
    Write-Host "$script:PassSymbol $Message" -ForegroundColor Green
}

function Write-Warn {
    param([string]$Message)

    $script:warned++
    Write-Host "$script:WarnSymbol $Message" -ForegroundColor Yellow
}

function Write-Fail {
    param([string]$Message)

    $script:failed++
    Write-Host "$script:FailSymbol $Message" -ForegroundColor Red
}

function Write-Info {
    param([string]$Message)

    Write-Host "$script:InfoSymbol $Message" -ForegroundColor Cyan
}

function Write-Detail {
    param([string]$Message)

    if ($Detailed) {
        Write-Info $Message
    }
}

function Test-Command {
    param([string]$Name)

    return $null -ne (Get-Command -Name $Name -ErrorAction SilentlyContinue)
}

function Get-FirstLine {
    param([object[]]$Lines)

    $line = $Lines |
        Where-Object { $null -ne $_ } |
        ForEach-Object { $_.ToString().Trim() } |
        Where-Object { $_.Length -gt 0 } |
        Select-Object -First 1

    return $line
}

function Invoke-Native {
    param(
        [string]$FilePath,
        [string[]]$ArgumentList = @()
    )

    $previousErrorActionPreference = $ErrorActionPreference
    $hasNativePreference = Test-Path -LiteralPath 'Variable:\PSNativeCommandUseErrorActionPreference'
    $previousNativePreference = $null

    if ($hasNativePreference) {
        $previousNativePreference = $PSNativeCommandUseErrorActionPreference
    }

    try {
        $ErrorActionPreference = 'Continue'
        if ($hasNativePreference) {
            $PSNativeCommandUseErrorActionPreference = $false
        }

        $output = & $FilePath @ArgumentList 2>&1
        return [pscustomobject]@{
            Output = $output
            ExitCode = $LASTEXITCODE
        }
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
        if ($hasNativePreference) {
            $PSNativeCommandUseErrorActionPreference = $previousNativePreference
        }
    }
}

function Invoke-Check {
    param(
        [string]$Name,
        [ValidateSet('Fail', 'Warn', 'Info')]
        [string]$OnError = 'Fail',
        [scriptblock]$ScriptBlock
    )

    $script:checks++

    try {
        & $ScriptBlock
    }
    catch {
        $message = "$Name`: $($_.Exception.Message)"
        if ($OnError -eq 'Warn') {
            Write-Warn $message
        }
        elseif ($OnError -eq 'Info') {
            Write-Info $message
        }
        else {
            Write-Fail $message
        }
    }
}

function Complete-Script {
    Write-Host ''
    Write-Host "completed: $script:passed passed, $script:warned warnings, $script:failed failures across $script:checks checks."
    if ($script:failed -eq 0) {
        exit 0
    }

    exit 1
}

function Get-RegistryValue {
    param(
        [string]$Path,
        [string]$Name
    )

    $item = Get-ItemProperty -Path $Path -Name $Name -ErrorAction SilentlyContinue
    if ($null -eq $item) {
        return $null
    }

    return $item.$Name
}

function Get-AcPowerSettingIndex {
    param(
        [string]$SubGroup,
        [string]$Setting
    )

    $result = Invoke-Native -FilePath 'powercfg' -ArgumentList @('/query', 'SCHEME_CURRENT', $SubGroup, $Setting)
    if ($result.ExitCode -ne 0) {
        return $null
    }

    $match = $result.Output | Select-String -Pattern 'Current AC Power Setting Index:\s*0x([0-9A-Fa-f]+)' | Select-Object -First 1
    if ($null -eq $match) {
        return $null
    }

    return [Convert]::ToInt64($match.Matches[0].Groups[1].Value, 16)
}

function Get-VenvPython {
    $candidate = Join-Path $VenvPath 'Scripts\python.exe'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        return $candidate
    }

    return $null
}

function Get-VenvPackageVersion {
    param(
        [string]$VenvPython,
        [string]$Package
    )

    $result = Invoke-Native -FilePath $VenvPython -ArgumentList @('-m', 'pip', 'show', $Package)
    if ($result.ExitCode -ne 0) {
        return $null
    }

    $match = $result.Output | Select-String -Pattern '^Version:\s*(.+)$' | Select-Object -First 1
    if ($null -eq $match) {
        return $null
    }

    return $match.Matches[0].Groups[1].Value.Trim()
}

function Get-BasePython {
    # py launcher preferred (matches bootstrap-windows.ps1); plain python fallback.
    # Candidates are probed: the Microsoft Store app-execution alias stub lives in
    # WindowsApps and opens the Store instead of running, so it is rejected.
    $candidates = @()
    if (Test-Command 'py') { $candidates += 'py' }
    if (Test-Command 'python') { $candidates += 'python' }

    foreach ($candidate in $candidates) {
        $command = Get-Command -Name $candidate -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -ne $command -and $command.Source -like '*\WindowsApps\*') {
            continue
        }

        $probe = Invoke-Native -FilePath $candidate -ArgumentList @('--version')
        if ($probe.ExitCode -eq 0) {
            return @{ FilePath = $candidate; Version = (Get-FirstLine $probe.Output) }
        }
    }

    return $null
}

function Get-DcPowerSettingIndex {
    param(
        [string]$SubGroup,
        [string]$Setting
    )

    $result = Invoke-Native -FilePath 'powercfg' -ArgumentList @('/query', 'SCHEME_CURRENT', $SubGroup, $Setting)
    if ($result.ExitCode -ne 0) {
        return $null
    }

    $match = $result.Output | Select-String -Pattern 'Current DC Power Setting Index:\s*0x([0-9A-Fa-f]+)' | Select-Object -First 1
    if ($null -eq $match) {
        return $null
    }

    return [Convert]::ToInt64($match.Matches[0].Groups[1].Value, 16)
}

function Find-Ffmpeg {
    param([string]$Name)

    $command = Get-Command -Name $Name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $command) {
        return $command.Source
    }

    $fallbacks = @(
        "C:\ffmpeg\bin\$Name.exe",
        "C:\Program Files\ffmpeg\bin\$Name.exe"
    )

    foreach ($candidate in $fallbacks) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return $candidate
        }
    }

    return $null
}

$signature = @'
[DllImport("kernel32.dll")]
public static extern uint WTSGetActiveConsoleSessionId();
'@
Add-Type -MemberDefinition $signature -Name 'Kernel32' -Namespace 'OwletteGuiBootstrap'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]$identity
$script:isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

$desktopKey = 'HKCU:\Control Panel\Desktop'
$policySystemKey = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
$captureOutputPath = Join-Path $repoRoot 'dev\video-tutorials\capture-native\.output'

Write-Info "rig: $Rig | apply: $Apply | venv: $VenvPath"
Write-Host ''
Write-Host 'SESSION + PRIVILEGES' -ForegroundColor Cyan

Invoke-Check -Name 'Windows 11 Pro 64-bit' -OnError Fail -ScriptBlock {
    $os = Get-CimInstance Win32_OperatingSystem
    $is64 = $os.OSArchitecture -match '64'
    $versionOk = ([version]$os.Version).Major -ge 10

    if (-not ($is64 -and $versionOk)) {
        Write-Fail "Windows: $($os.Caption) $($os.OSArchitecture) - GUI automation rigs need 64-bit Windows 10+"
        return
    }

    if ($os.Caption -match 'Windows 11 Pro') {
        Write-Pass "Windows: $($os.Caption)"
    }
    else {
        Write-Warn "Windows: $($os.Caption) - the machine-setup doc specifies Windows 11 Pro; other editions are unvalidated"
    }
}

Invoke-Check -Name 'Interactive session' -OnError Fail -ScriptBlock {
    # WTSGetActiveConsoleSessionId alone is NOT enough: a Session-0 service still
    # sees the active console session. The process's own session is what matters.
    $consoleSession = [OwletteGuiBootstrap.Kernel32]::WTSGetActiveConsoleSessionId()
    $processSession = (Get-Process -Id $PID).SessionId

    if ($processSession -eq 0) {
        Write-Fail 'Interactive session: process is in Session 0 (service context) - no desktop, UIAutomation impossible; the runner must run as the logged-on user, never as a service'
    }
    elseif ($consoleSession -eq 0xFFFFFFFF) {
        Write-Fail 'Interactive session: no active console session (0xFFFFFFFF) - nobody is logged on at the console; unattended runs need autologon'
    }
    elseif ($processSession -ne $consoleSession) {
        Write-Warn "Interactive session: process session $processSession is not the console session $consoleSession (RDP?) - fine interactively, but unattended runs happen on the console; see the tscon guidance"
    }
    else {
        Write-Pass "Interactive session: console session $consoleSession, process attached to it"
    }
}

Invoke-Check -Name 'Admin rights' -OnError Warn -ScriptBlock {
    if ($script:isAdmin) {
        Write-Pass 'Admin rights: running as administrator'
    }
    else {
        Write-Warn 'Admin rights: not elevated; -Apply skips hibernate-off and Defender exclusion, and installer launches will raise UAC'
    }

    Write-Detail "Admin detail: identity $($identity.Name)"
}

Write-Host ''
Write-Host 'DISPLAY (pin it, then never touch it)' -ForegroundColor Cyan

Invoke-Check -Name 'DPI scaling 100%' -OnError Fail -ScriptBlock {
    $appliedDpi = Get-RegistryValue -Path 'HKCU:\Control Panel\Desktop\WindowMetrics' -Name 'AppliedDPI'

    if ($null -eq $appliedDpi -or [int]$appliedDpi -eq 96) {
        Write-Pass 'DPI scaling: 100% (96 DPI)'
    }
    else {
        $percent = [math]::Round(([int]$appliedDpi / 96) * 100)
        Write-Fail "DPI scaling: $percent% ($appliedDpi DPI) - set Settings > Display > Scale to 100%, then sign out/in (manual; template matching and geometry clicks break otherwise)"
    }
}

Invoke-Check -Name 'Primary resolution' -OnError Warn -ScriptBlock {
    Add-Type -AssemblyName System.Windows.Forms
    $primary = [System.Windows.Forms.Screen]::PrimaryScreen
    $bounds = $primary.Bounds
    $monitorCount = [System.Windows.Forms.Screen]::AllScreens.Count

    if ($bounds.Width -eq 1920 -and $bounds.Height -eq 1080) {
        Write-Pass "Primary resolution: 1920x1080 ($monitorCount monitor(s))"
    }
    else {
        Write-Warn "Primary resolution: $($bounds.Width)x$($bounds.Height) - the machine-setup doc recommends 1920x1080; whatever you pick, record it there and keep it fixed"
    }

    if ($Rig -eq 'CaptureRig' -and $monitorCount -gt 1) {
        Write-Warn "Monitors: $monitorCount attached - capture preflights assert a single primary monitor"
    }
}

Invoke-Check -Name 'Theme (record the choice)' -OnError Info -ScriptBlock {
    $appsLight = Get-RegistryValue -Path 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Themes\Personalize' -Name 'AppsUseLightTheme'
    $theme = 'light'
    if ($null -ne $appsLight -and [int]$appsLight -eq 0) {
        $theme = 'dark'
    }

    Write-Info "Theme: $theme - template crops are theme-sensitive; record the choice in the machine-setup doc and keep it fixed"
}

Write-Host ''
Write-Host 'POWER + LOCK (UIAutomation dies on a locked or blank screen)' -ForegroundColor Cyan

Invoke-Check -Name 'Monitor timeout (AC)' -OnError Fail -ScriptBlock {
    $index = Get-AcPowerSettingIndex -SubGroup 'SUB_VIDEO' -Setting 'VIDEOIDLE'

    if ($null -eq $index) {
        Write-Fail 'Monitor timeout (AC): could not query powercfg (localized Windows output?) - cannot prove the display stays awake'
    }
    elseif ($index -eq 0) {
        Write-Pass 'Monitor timeout (AC): never'
    }
    else {
        Write-Fail "Monitor timeout (AC): $([math]::Round($index / 60)) min - run with -Apply or: powercfg /change monitor-timeout-ac 0"
    }

    $dcIndex = Get-DcPowerSettingIndex -SubGroup 'SUB_VIDEO' -Setting 'VIDEOIDLE'
    if ($null -ne $dcIndex -and $dcIndex -ne 0) {
        Write-Warn "Monitor timeout (DC): $([math]::Round($dcIndex / 60)) min - a battery-powered rig blanks on DC; -Apply also sets the DC timeouts"
    }
}

Invoke-Check -Name 'Sleep timeout (AC)' -OnError Fail -ScriptBlock {
    $index = Get-AcPowerSettingIndex -SubGroup 'SUB_SLEEP' -Setting 'STANDBYIDLE'

    if ($null -eq $index) {
        Write-Fail 'Sleep timeout (AC): could not query powercfg (localized Windows output?) - cannot prove the machine stays awake'
    }
    elseif ($index -eq 0) {
        Write-Pass 'Sleep timeout (AC): never'
    }
    else {
        Write-Fail "Sleep timeout (AC): $([math]::Round($index / 60)) min - run with -Apply or: powercfg /change standby-timeout-ac 0"
    }

    $dcIndex = Get-DcPowerSettingIndex -SubGroup 'SUB_SLEEP' -Setting 'STANDBYIDLE'
    if ($null -ne $dcIndex -and $dcIndex -ne 0) {
        Write-Warn "Sleep timeout (DC): $([math]::Round($dcIndex / 60)) min - a battery-powered rig sleeps on DC; -Apply also sets the DC timeouts"
    }
}

Invoke-Check -Name 'Hibernate' -OnError Fail -ScriptBlock {
    $hibernateEnabled = Get-RegistryValue -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Power' -Name 'HibernateEnabled'

    if ($null -eq $hibernateEnabled -or [int]$hibernateEnabled -eq 0) {
        Write-Pass 'Hibernate: disabled'
    }
    else {
        Write-Fail 'Hibernate: enabled - run with -Apply (elevated) or: powercfg /hibernate off'
    }
}

Invoke-Check -Name 'Screen saver' -OnError Fail -ScriptBlock {
    $active = Get-RegistryValue -Path $desktopKey -Name 'ScreenSaveActive'
    $exe = Get-RegistryValue -Path $desktopKey -Name 'SCRNSAVE.EXE'
    $secure = Get-RegistryValue -Path $desktopKey -Name 'ScreenSaverIsSecure'

    $saverOff = ($null -eq $exe) -or ($null -ne $active -and "$active" -eq '0')
    $resumeLockOff = ($null -eq $secure) -or ("$secure" -eq '0')

    if ($saverOff -and $resumeLockOff) {
        Write-Pass 'Screen saver: off, no logon screen on resume'
    }
    elseif (-not $saverOff) {
        Write-Fail "Screen saver: active ($exe) - run with -Apply or disable in Settings > Lock screen > Screen saver"
    }
    else {
        Write-Fail 'Screen saver: "on resume, display logon screen" is checked - run with -Apply or uncheck it'
    }
}

Invoke-Check -Name 'Idle auto-lock policy' -OnError Fail -ScriptBlock {
    $inactivityTimeout = Get-RegistryValue -Path $policySystemKey -Name 'InactivityTimeoutSecs'

    if ($null -eq $inactivityTimeout -or [int]$inactivityTimeout -eq 0) {
        Write-Pass 'Idle auto-lock policy: not set'
    }
    else {
        Write-Fail "Idle auto-lock policy: machine locks after $inactivityTimeout s (InactivityTimeoutSecs) - remove the policy value (elevated, manual)"
    }
}

Write-Host ''
Write-Host 'UAC (leave it ON; launch automation elevated instead)' -ForegroundColor Cyan

Invoke-Check -Name 'UAC enabled' -OnError Fail -ScriptBlock {
    $enableLua = Get-RegistryValue -Path $policySystemKey -Name 'EnableLUA'

    if ($null -eq $enableLua -or [int]$enableLua -eq 1) {
        Write-Pass 'UAC: enabled (EnableLUA=1)'
    }
    else {
        Write-Fail 'UAC: DISABLED (EnableLUA=0) - re-enable it; a no-UAC image resembles no customer machine. Launch automation from an elevated shell instead.'
    }
}

Invoke-Check -Name 'UAC admin consent behavior' -OnError Info -ScriptBlock {
    $consent = Get-RegistryValue -Path $policySystemKey -Name 'ConsentPromptBehaviorAdmin'

    if ($null -ne $consent -and [int]$consent -eq 0) {
        Write-Warn 'UAC consent (admin): elevate-without-prompting (0) - documented last resort only; prefer launching pre-elevated'
    }
    else {
        $secureDesktop = Get-RegistryValue -Path $policySystemKey -Name 'PromptOnSecureDesktop'
        Write-Info "UAC consent (admin): ConsentPromptBehaviorAdmin=$consent, PromptOnSecureDesktop=$secureDesktop (defaults 5 and 1: consent prompt for non-Windows binaries, shown on the secure desktop)"
    }
}

Write-Host ''
Write-Host 'PYTHON GUI TOOLCHAIN (the verified pin set)' -ForegroundColor Cyan

Invoke-Check -Name 'Python launcher' -OnError Fail -ScriptBlock {
    $base = Get-BasePython
    if ($null -eq $base) {
        Write-Fail 'Python launcher: no working py or python on PATH (Microsoft Store alias stubs are rejected) - install Python 3.x'
        return
    }

    Write-Pass "Python launcher: $($base.FilePath) ($($base.Version))"
}

Invoke-Check -Name 'pywinauto venv' -OnError Fail -ScriptBlock {
    $venvPython = Get-VenvPython
    if ($null -eq $venvPython) {
        Write-Fail "pywinauto venv: missing at $VenvPath - run with -Apply to create it with the pinned packages"
        return
    }

    $health = Invoke-Native -FilePath $venvPython -ArgumentList @('-c', 'import sys')
    if ($health.ExitCode -ne 0) {
        Write-Fail "pywinauto venv: python.exe present at $VenvPath but broken (exit $($health.ExitCode)) - run with -Apply to recreate it"
        return
    }

    Write-Pass "pywinauto venv: present and healthy at $VenvPath"

    $pywin32Version = Get-VenvPackageVersion -VenvPython $venvPython -Package 'pywin32'
    if ($null -eq $pywin32Version) {
        Write-Fail 'pywin32: not installed in venv - run with -Apply'
    }
    elseif ($pywin32Version -eq '306') {
        Write-Pass 'pywin32: 306 (pinned - do NOT upgrade; 310+ fails DLL load on the embedded Py3.9/Win11 combo)'
    }
    else {
        Write-Fail "pywin32: $pywin32Version - must be exactly 306; fix with: & '$venvPython' -m pip install pywin32==306"
    }

    $pywinautoVersion = Get-VenvPackageVersion -VenvPython $venvPython -Package 'pywinauto'
    if ($null -eq $pywinautoVersion) {
        Write-Fail 'pywinauto: not installed in venv - run with -Apply'
    }
    elseif ($pywinautoVersion -eq '0.6.9') {
        Write-Pass 'pywinauto: 0.6.9'
    }
    else {
        Write-Warn "pywinauto: $pywinautoVersion - 0.6.9 is the verified pin"
    }

    $psutilVersion = Get-VenvPackageVersion -VenvPython $venvPython -Package 'psutil'
    if ($null -eq $psutilVersion) {
        Write-Warn 'psutil: not installed in venv - run with -Apply'
    }
    else {
        Write-Pass "psutil: $psutilVersion"
    }
}

Invoke-Check -Name 'UIA smoke test' -OnError Fail -ScriptBlock {
    $venvPython = Get-VenvPython
    if ($null -eq $venvPython) {
        Write-Warn 'UIA smoke test: skipped (no venv)'
        return
    }

    $code = "from pywinauto import Desktop; import sys; sys.stdout.write('UIACOUNT=' + str(len(Desktop(backend='uia').windows())))"
    $result = Invoke-Native -FilePath $venvPython -ArgumentList @('-c', $code)
    $countLine = $result.Output |
        Where-Object { $null -ne $_ } |
        ForEach-Object { $_.ToString().Trim() } |
        Where-Object { $_ -match '^UIACOUNT=(\d+)$' } |
        Select-Object -First 1

    $count = 0
    if ($countLine -match '^UIACOUNT=(\d+)$') {
        $count = [int]$Matches[1]
    }

    if ($result.ExitCode -eq 0 -and $count -gt 0) {
        Write-Pass "UIA smoke test: Desktop(backend='uia') sees $count top-level windows"
    }
    else {
        Write-Fail "UIA smoke test: failed (exit $($result.ExitCode)) - $(Get-FirstLine $result.Output)"
    }
}

if ($Rig -eq 'CaptureRig') {
    Write-Host ''
    Write-Host 'CAPTURE RIG (machine-setup doc Profile B)' -ForegroundColor Cyan

    Invoke-Check -Name 'Capture tooling (ffmpeg/OBS)' -OnError Fail -ScriptBlock {
        $ffmpegPath = Find-Ffmpeg -Name 'ffmpeg'
        $ffprobePath = Find-Ffmpeg -Name 'ffprobe'
        $obsPath = 'C:\Program Files\obs-studio\bin\64bit\obs64.exe'
        $hasObs = Test-Path -LiteralPath $obsPath -PathType Leaf

        if ($null -ne $ffmpegPath -and $null -ne $ffprobePath) {
            Write-Pass "Capture tooling: ffmpeg + ffprobe at $(Split-Path -Parent $ffmpegPath)"
            if ($hasObs) {
                Write-Detail "Capture tooling detail: OBS also present at $obsPath (manual option)"
            }
        }
        elseif ($null -ne $ffmpegPath) {
            Write-Warn 'Capture tooling: ffmpeg found but ffprobe missing - capture validation (duration/CFR checks) needs ffprobe'
        }
        elseif ($hasObs) {
            Write-Warn "Capture tooling: OBS only ($obsPath) - manual capture works, but scripted ffmpeg capture and validation are unavailable"
        }
        else {
            Write-Fail 'Capture tooling: neither ffmpeg (PATH, C:\ffmpeg\bin, Program Files) nor OBS found - install one (ffmpeg preferred)'
        }
    }

    Invoke-Check -Name 'Defender exclusion (.output)' -OnError Warn -ScriptBlock {
        $preference = Get-MpPreference -ErrorAction Stop
        $exclusions = @($preference.ExclusionPath)

        if ($exclusions -contains $captureOutputPath) {
            Write-Pass "Defender exclusion: $captureOutputPath excluded (real-time scanning throttles growing mp4s)"
        }
        else {
            Write-Warn "Defender exclusion: $captureOutputPath not excluded - run with -Apply (elevated) or: Add-MpPreference -ExclusionPath '$captureOutputPath'"
        }
    }
}

if ($Rig -eq 'E2eRunner') {
    Write-Host ''
    Write-Host 'E2E RUNNER (machine-setup doc Profile C)' -ForegroundColor Cyan

    Invoke-Check -Name 'Node.js + npm' -OnError Fail -ScriptBlock {
        if (-not (Test-Command 'node')) {
            Write-Fail 'Node.js: missing - needed for the Playwright dashboard-observation tier (see bootstrap-windows.ps1 for full web toolchain checks)'
            return
        }

        $nodeResult = Invoke-Native -FilePath 'node' -ArgumentList @('-v')
        if ($nodeResult.ExitCode -ne 0) {
            Write-Fail "Node.js: node -v failed (exit $($nodeResult.ExitCode))"
            return
        }

        Write-Pass "Node.js: $(Get-FirstLine $nodeResult.Output)"

        $npmResult = Invoke-Native -FilePath 'npm' -ArgumentList @('-v')
        if ($npmResult.ExitCode -eq 0) {
            Write-Pass "npm: $(Get-FirstLine $npmResult.Output)"
        }
        else {
            Write-Fail 'npm: missing or broken'
        }
    }

    Invoke-Check -Name 'Playwright + chromium' -OnError Fail -ScriptBlock {
        $playwrightCmd = Join-Path $repoRoot 'web\node_modules\.bin\playwright.cmd'
        $webPath = Join-Path $repoRoot 'web'

        if (-not (Test-Path -LiteralPath $playwrightCmd -PathType Leaf)) {
            Write-Fail "Playwright: not installed - run: Push-Location '$webPath'; npm ci --legacy-peer-deps; npx playwright install chromium; Pop-Location"
            return
        }

        Write-Pass 'Playwright: installed in web/node_modules'

        $chromium = @(Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'ms-playwright') -Filter 'chromium-*' -Directory -ErrorAction SilentlyContinue)
        if ($chromium.Count -gt 0) {
            Write-Pass "Playwright chromium: $($chromium[0].Name) installed"
        }
        else {
            Write-Fail "Playwright chromium: browser not installed - run: Push-Location '$webPath'; npx playwright install chromium; Pop-Location"
        }
    }

    Invoke-Check -Name 'curl' -OnError Fail -ScriptBlock {
        if (Test-Command 'curl.exe') {
            Write-Pass "curl: $((Get-Command curl.exe).Source) (controller API calls must use curl - Cloudflare 1010-blocks python urllib)"
        }
        else {
            Write-Fail 'curl: curl.exe not found (ships with Windows 10 1803+) - the e2e controller API calls depend on it'
        }
    }

    Invoke-Check -Name 'Autologon' -OnError Warn -ScriptBlock {
        $winlogonKey = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
        $autoAdmin = Get-RegistryValue -Path $winlogonKey -Name 'AutoAdminLogon'
        $plaintextPassword = Get-RegistryValue -Path $winlogonKey -Name 'DefaultPassword'

        if ($null -ne $plaintextPassword) {
            Write-Fail 'Autologon: DefaultPassword is stored in PLAINTEXT registry - remove it and use Sysinternals Autologon (stores via LSA)'
            return
        }

        if ($null -ne $autoAdmin -and "$autoAdmin" -eq '1') {
            Write-Pass 'Autologon: AutoAdminLogon flag set, no plaintext password (LSA secret not verifiable here - confirm with a reboot test)'
        }
        else {
            Write-Fail 'Autologon: not enabled - configure with Sysinternals Autologon (manual; required for unattended runs after reboot/revert)'
        }
    }

    Invoke-Check -Name 'Windows Update deferral' -OnError Warn -ScriptBlock {
        $noAutoUpdate = Get-RegistryValue -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU' -Name 'NoAutoUpdate'
        $pauseExpiry = Get-RegistryValue -Path 'HKLM:\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings' -Name 'PauseUpdatesExpiryTime'

        if ($null -ne $noAutoUpdate -and [int]$noAutoUpdate -eq 1) {
            Write-Pass 'Windows Update: auto-update disabled by policy'
        }
        elseif ($null -ne $pauseExpiry) {
            $expiry = $null
            try {
                $expiry = [datetime]::Parse("$pauseExpiry", [System.Globalization.CultureInfo]::InvariantCulture)
            }
            catch {
            }

            if ($null -ne $expiry -and $expiry -gt (Get-Date)) {
                Write-Warn "Windows Update: paused until $pauseExpiry - re-pause before it lapses (an unattended reboot mid-run is a flake factory)"
            }
            else {
                Write-Fail "Windows Update: pause expired or unparseable ($pauseExpiry) - re-pause it (Settings > Windows Update) or set the NoAutoUpdate policy"
            }
        }
        else {
            Write-Fail 'Windows Update: not deferred - pause/defer it (Settings > Windows Update, or NoAutoUpdate policy); an unattended mid-run reboot is a flake factory and updates drift pinned display settings'
        }
    }

    Invoke-Check -Name 'GitHub runner not a service' -OnError Fail -ScriptBlock {
        $runnerServices = @(Get-Service -Name 'actions.runner.*' -ErrorAction SilentlyContinue)

        if ($runnerServices.Count -gt 0) {
            Write-Fail "GitHub runner: installed as a Windows service ($($runnerServices[0].Name)) - it lives in Session 0 with no desktop; uninstall the service and start run.cmd at logon instead"
            return
        }

        $runnerDir = 'C:\actions-runner'
        if (Test-Path -LiteralPath $runnerDir -PathType Container) {
            Write-Pass "GitHub runner: present at $runnerDir, not a service - ensure run.cmd starts at logon (shell:startup or a logged-on-only scheduled task)"
        }
        else {
            Write-Info 'GitHub runner: not installed (registration is Wave 4 of the e2e plan)'
        }
    }
}

if ($Apply) {
    Write-Host ''
    Write-Host 'APPLY (safe subset)' -ForegroundColor Cyan

    Invoke-Check -Name 'Apply: power timeouts' -OnError Warn -ScriptBlock {
        $changes = @(
            @('/change', 'monitor-timeout-ac', '0'),
            @('/change', 'standby-timeout-ac', '0'),
            @('/change', 'hibernate-timeout-ac', '0'),
            @('/change', 'monitor-timeout-dc', '0'),
            @('/change', 'standby-timeout-dc', '0'),
            @('/change', 'hibernate-timeout-dc', '0')
        )

        $applyFailed = $false
        foreach ($argumentSet in $changes) {
            $result = Invoke-Native -FilePath 'powercfg' -ArgumentList $argumentSet
            if ($result.ExitCode -ne 0) {
                $applyFailed = $true
                Write-Warn "Apply: powercfg $($argumentSet -join ' ') failed (exit $($result.ExitCode))"
            }
        }

        if (-not $applyFailed) {
            Write-Pass 'Apply: monitor/sleep/hibernate timeouts (AC + DC) set to never'
        }
    }

    Invoke-Check -Name 'Apply: hibernate off' -OnError Warn -ScriptBlock {
        if (-not $script:isAdmin) {
            Write-Warn 'Apply: hibernate off skipped - requires elevation (powercfg /hibernate off)'
            return
        }

        $result = Invoke-Native -FilePath 'powercfg' -ArgumentList @('/hibernate', 'off')
        if ($result.ExitCode -eq 0) {
            Write-Pass 'Apply: hibernate disabled'
        }
        else {
            Write-Warn "Apply: powercfg /hibernate off failed (exit $($result.ExitCode))"
        }
    }

    Invoke-Check -Name 'Apply: screen saver off' -OnError Warn -ScriptBlock {
        Set-ItemProperty -Path $desktopKey -Name 'ScreenSaveActive' -Value '0'
        Set-ItemProperty -Path $desktopKey -Name 'ScreenSaverIsSecure' -Value '0'
        Write-Pass 'Apply: screen-saver registry values updated (ScreenSaveActive=0, ScreenSaverIsSecure=0) - sign out/in for the session to fully pick them up'
    }

    Invoke-Check -Name 'Apply: pywinauto venv' -OnError Warn -ScriptBlock {
        $base = Get-BasePython
        if ($null -eq $base) {
            Write-Warn 'Apply: venv skipped - no python on PATH'
            return
        }

        $venvPython = Get-VenvPython
        if ($null -ne $venvPython) {
            $health = Invoke-Native -FilePath $venvPython -ArgumentList @('-c', 'import sys')
            if ($health.ExitCode -ne 0) {
                Write-Info 'Apply: existing venv is broken - recreating'
                $venvPython = $null
            }
        }

        if ($null -eq $venvPython) {
            Write-Info "Apply: creating venv at $VenvPath"
            $createResult = Invoke-Native -FilePath $base.FilePath -ArgumentList @('-m', 'venv', '--clear', $VenvPath)
            if ($createResult.ExitCode -ne 0) {
                Write-Warn "Apply: venv creation failed (exit $($createResult.ExitCode))"
                return
            }

            $venvPython = Get-VenvPython
            if ($null -eq $venvPython) {
                Write-Warn "Apply: venv created but python.exe missing under $VenvPath\Scripts - investigate manually"
                return
            }
        }

        $requirements = Join-Path $repoRoot 'dev\video-tutorials\capture-native\requirements.txt'
        if (Test-Path -LiteralPath $requirements -PathType Leaf) {
            $installArgs = @('-m', 'pip', 'install', '-r', $requirements)
        }
        else {
            $installArgs = @('-m', 'pip', 'install', 'pywinauto==0.6.9', 'pywin32==306', 'psutil==7.2.2')
        }

        Write-Info "Apply: installing pinned packages into the venv (this can take a minute)"
        $installResult = Invoke-Native -FilePath $venvPython -ArgumentList $installArgs
        if ($installResult.ExitCode -eq 0) {
            Write-Pass 'Apply: venv packages installed (pywinauto 0.6.9, pywin32 306, psutil 7.2.2)'
        }
        else {
            Write-Warn "Apply: pip install failed (exit $($installResult.ExitCode)) - run manually: & '$venvPython' -m pip install -r '$requirements'"
        }
    }

    if ($Rig -eq 'CaptureRig') {
        Invoke-Check -Name 'Apply: Defender exclusion' -OnError Warn -ScriptBlock {
            if (-not $script:isAdmin) {
                Write-Warn 'Apply: Defender exclusion skipped - requires elevation'
                return
            }

            try {
                Add-MpPreference -ExclusionPath $captureOutputPath -ErrorAction Stop
                Write-Pass "Apply: Defender exclusion added for $captureOutputPath"
            }
            catch {
                Write-Warn "Apply: Add-MpPreference failed ($($_.Exception.Message)) - if Tamper Protection blocks it, add the exclusion manually in Windows Security"
            }
        }
    }

    Write-Info 'apply complete - re-run without -Apply to verify a clean pass.'
}

Write-Host ''
Write-Host 'MANUAL STEPS (never automated by design)' -ForegroundColor Cyan
Write-Host '  see docs/internal/gui-automation-machine-setup.md for the full recipe:'
Write-Host '  1. DPI / resolution / theme changes need a sign-out - set once, record in the machine-setup doc, never touch again.'
Write-Host '  2. RDP: never just disconnect (locks the desktop, kills UIAutomation) - reattach the session to console first; the runnable qwinsta + tscon snippet is in the machine-setup doc, RDP section'
Write-Host '  3. Unblock-File any downloaded installer EXE before launching it (Mark-of-the-Web / SmartScreen).'
if ($Rig -eq 'E2eRunner') {
    Write-Host '  4. Autologon via Sysinternals Autologon.exe (LSA-stored password; never plaintext registry, never in the image docs).'
    Write-Host '  5. Golden snapshots are taken host-side (empty baseline + paired N-1 for the upgrade leg) - see dev/active/full-machine-e2e/plan.md.'
    Write-Host '  6. GitHub runner registration (token) is Wave 4; install it to run interactively at logon, never as a service.'
    Write-Host '  7. Keep the VM network-isolated from anything that can reach prod; secrets live in the runner secret store.'
}

Complete-Script
