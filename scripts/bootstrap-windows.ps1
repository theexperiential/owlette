<#
.SYNOPSIS
Validates the Windows toolchain needed by Owlette.

.DESCRIPTION
Reports required and optional Windows development tools, their detected versions,
and where to fix gaps. This script is read-mostly and does not install system
dependencies or modify PATH. The optional -InstallWebDeps switch runs npm ci
and Playwright browser setup in the repo's web directory after required checks
pass.

.EXAMPLE
.\scripts\bootstrap-windows.ps1 -Detailed

.EXAMPLE
.\scripts\bootstrap-windows.ps1 -InstallWebDeps
#>
param(
    [switch]$InstallWebDeps,
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

function Test-Command {
    param([string]$Name)

    return $null -ne (Get-Command -Name $Name -ErrorAction SilentlyContinue)
}

function Get-NodeMajor {
    if (-not (Test-Command 'node')) {
        return $null
    }

    $nodeVersion = Get-FirstLine (& node -v 2>&1)
    if ($nodeVersion -match '^v?(\d+)') {
        return [int]$Matches[1]
    }

    return $null
}

function Write-Detail {
    param([string]$Message)

    if ($Detailed) {
        Write-Info $Message
    }
}

function Get-CommandSource {
    param([string]$Name)

    $command = Get-Command -Name $Name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $command) {
        return $null
    }

    if ($command.Source) {
        return $command.Source
    }

    return $command.Path
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

function ConvertTo-Version {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return $null
    }

    $clean = $Value.Trim()
    if ($clean -match '^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?') {
        $major = $Matches[1]
        $minor = '0'
        $patch = '0'

        if ($Matches[2]) {
            $minor = $Matches[2]
        }

        if ($Matches[3]) {
            $patch = $Matches[3]
        }

        return [version]"$major.$minor.$patch"
    }

    return $null
}

function Get-NvmrcMajor {
    $nvmrcPath = Join-Path $repoRoot '.nvmrc'
    if (-not (Test-Path -LiteralPath $nvmrcPath -PathType Leaf)) {
        return $null
    }

    $nvmrcVersion = (Get-Content -LiteralPath $nvmrcPath -TotalCount 1).Trim()
    if ($nvmrcVersion -match '^v?(\d+)') {
        return [int]$Matches[1]
    }

    return $null
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
    Write-Host "completed: $script:passed passed, $script:warned warnings, $script:failed failures (out of $script:checks)."
    if ($script:failed -eq 0) {
        exit 0
    }

    exit 1
}

Write-Host 'CORE' -ForegroundColor Cyan

Invoke-Check -Name 'Windows 10+ 64-bit' -OnError Fail -ScriptBlock {
    $caption = $null
    $architecture = $null
    $versionText = $null
    $source = 'Win32_OperatingSystem'

    try {
        $os = Get-CimInstance Win32_OperatingSystem
        $caption = $os.Caption
        $architecture = $os.OSArchitecture
        $versionText = $os.Version
    }
    catch {
        $versionText = [System.Environment]::OSVersion.Version.ToString()
        $caption = 'Windows'
        if ([System.Environment]::Is64BitOperatingSystem) {
            $architecture = '64-bit'
        }
        else {
            $architecture = '32-bit'
        }
        $source = "System.Environment fallback; CIM unavailable: $($_.Exception.Message)"
    }

    $version = [version]$versionText
    $isWindows10Plus = $version.Major -ge 10
    $is64Bit = $architecture -match '64'

    if ($isWindows10Plus -and $is64Bit) {
        Write-Pass "Windows 10+ 64-bit: $caption"
    }
    else {
        Write-Fail "Windows 10+ 64-bit: found $caption $architecture"
    }

    Write-Detail "Windows detail: version $versionText; architecture $architecture; source $source"
}

Invoke-Check -Name 'Admin rights' -OnError Warn -ScriptBlock {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]$identity
    $isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

    if ($isAdmin) {
        Write-Pass "Admin rights: running as administrator"
    }
    else {
        Write-Warn "Admin rights: not running as administrator; some downstream operations need it"
    }

    Write-Detail "Admin detail: identity $($identity.Name)"
}

Invoke-Check -Name 'Git' -OnError Fail -ScriptBlock {
    if (-not (Test-Command 'git')) {
        Write-Fail 'Git: missing; install Git for Windows from https://git-scm.com/download/win'
        return
    }

    $gitResult = Invoke-Native -FilePath 'git' -ArgumentList @('--version')
    $gitVersion = Get-FirstLine $gitResult.Output
    $gitPath = Get-CommandSource 'git'
    Write-Pass "Git: $gitVersion"
    Write-Detail "Git detail: version $gitVersion; path $gitPath"
}

Write-Host ''
Write-Host 'WEB DEV' -ForegroundColor Cyan

Invoke-Check -Name 'Node.js' -OnError Fail -ScriptBlock {
    $expectedMajor = Get-NvmrcMajor
    $minimumMajor = 20

    if ($null -ne $expectedMajor -and $expectedMajor -gt $minimumMajor) {
        $minimumMajor = $expectedMajor
    }

    if (-not (Test-Command 'node')) {
        Write-Fail "Node.js: missing; install Node.js $minimumMajor.x or newer"
        return
    }

    $nodeResult = Invoke-Native -FilePath 'node' -ArgumentList @('-v')
    $nodeVersion = Get-FirstLine $nodeResult.Output
    $nodeMajor = Get-NodeMajor
    $nodePath = Get-CommandSource 'node'

    if ($null -ne $nodeMajor -and $nodeMajor -ge $minimumMajor) {
        Write-Pass "Node.js: $nodeVersion"
    }
    else {
        Write-Fail "Node.js: $nodeVersion found; install Node.js $minimumMajor.x or newer"
    }

    if ($null -ne $expectedMajor) {
        Write-Detail "Node.js detail: version $nodeVersion; path $nodePath; .nvmrc major $expectedMajor"
    }
    else {
        Write-Detail "Node.js detail: version $nodeVersion; path $nodePath; .nvmrc not found or unreadable"
    }
}

Invoke-Check -Name 'npm' -OnError Fail -ScriptBlock {
    if (-not (Test-Command 'npm')) {
        Write-Fail 'npm: missing; install npm 10.0.0 or newer with Node.js'
        return
    }

    $npmResult = Invoke-Native -FilePath 'npm' -ArgumentList @('-v')
    $npmVersionText = Get-FirstLine $npmResult.Output
    $npmVersion = ConvertTo-Version $npmVersionText
    $npmPath = Get-CommandSource 'npm'

    if ($null -ne $npmVersion -and $npmVersion -ge [version]'10.0.0') {
        Write-Pass "npm: $npmVersionText"
    }
    else {
        Write-Warn "npm: $npmVersionText found; install npm 10.0.0 or newer"
    }

    Write-Detail "npm detail: version $npmVersionText; path $npmPath"
}

Invoke-Check -Name '.nvmrc and package.json engines' -OnError Info -ScriptBlock {
    $nvmrcPath = Join-Path $repoRoot '.nvmrc'
    $packageJsonPath = Join-Path $repoRoot 'package.json'
    $hasNvmrc = Test-Path -LiteralPath $nvmrcPath -PathType Leaf
    $hasEngines = $false

    if (Test-Path -LiteralPath $packageJsonPath -PathType Leaf) {
        $packageJson = Get-Content -LiteralPath $packageJsonPath -Raw
        $hasEngines = $packageJson.Contains('engines')
    }

    Write-Info ".nvmrc and package.json engines: .nvmrc present=$hasNvmrc; package.json engines present=$hasEngines"
    Write-Detail "repo metadata detail: .nvmrc path $nvmrcPath; package.json path $packageJsonPath"
}

Write-Host ''
Write-Host 'AGENT DEV' -ForegroundColor Cyan

Invoke-Check -Name 'Python 3.11' -OnError Fail -ScriptBlock {
    if (-not (Test-Command 'py')) {
        Write-Fail 'Python 3.11: py launcher missing; install Python 3.11 for agent builds'
        return
    }

    $pythonResult = Invoke-Native -FilePath 'py' -ArgumentList @('-3.11', '--version')
    $pythonVersion = Get-FirstLine $pythonResult.Output

    if ($pythonResult.ExitCode -eq 0 -and $pythonVersion -match 'Python 3\.11') {
        Write-Pass "Python 3.11: $pythonVersion"
        $pythonPathResult = Invoke-Native -FilePath 'py' -ArgumentList @('-3.11', '-c', 'import sys; print(sys.executable)')
        $pythonPath = Get-FirstLine $pythonPathResult.Output
        Write-Detail "Python 3.11 detail: version $pythonVersion; path $pythonPath"
    }
    else {
        Write-Fail 'Python 3.11: missing; install Python 3.11 for agent builds'
        Write-Detail "Python 3.11 detail: py output $pythonVersion"
    }
}

Invoke-Check -Name 'Python 3.11 tkinter' -OnError Warn -ScriptBlock {
    if (-not (Test-Command 'py')) {
        Write-Warn 'Python 3.11 tkinter: py launcher missing; GUI build degrades gracefully but warns'
        return
    }

    $tkResult = Invoke-Native -FilePath 'py' -ArgumentList @('-3.11', '-c', 'import tkinter; print(tkinter.TkVersion)')
    $tkVersion = Get-FirstLine $tkResult.Output

    if ($tkResult.ExitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace($tkVersion)) {
        Write-Pass "Python 3.11 tkinter: Tk $tkVersion"
    }
    else {
        Write-Warn 'Python 3.11 tkinter: not importable; GUI build degrades gracefully but warns'
    }

    Write-Detail "Python 3.11 tkinter detail: Tk version $tkVersion"
}

Write-Host ''
Write-Host 'INSTALLER BUILD' -ForegroundColor Cyan

Invoke-Check -Name 'Inno Setup 6' -OnError Warn -ScriptBlock {
    $isccPath = $null
    $isccSource = $null

    if (-not [string]::IsNullOrWhiteSpace($env:ISCC)) {
        $candidate = $env:ISCC.Trim('"')
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            $isccPath = (Resolve-Path -LiteralPath $candidate).Path
            $isccSource = '%ISCC%'
        }
    }

    if ($null -eq $isccPath) {
        $pathCommand = Get-Command -Name 'iscc.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -ne $pathCommand) {
            $isccPath = $pathCommand.Source
            $isccSource = 'PATH'
        }
    }

    if ($null -eq $isccPath) {
        $defaultPath = 'C:\Program Files (x86)\Inno Setup 6\ISCC.exe'
        if (Test-Path -LiteralPath $defaultPath -PathType Leaf) {
            $isccPath = $defaultPath
            $isccSource = 'default install path'
        }
    }

    if ($null -eq $isccPath) {
        Write-Warn 'Inno Setup 6: missing; install Inno Setup 6 to build Windows installers'
        return
    }

    $isccVersion = (Get-Item -LiteralPath $isccPath).VersionInfo.ProductVersion
    Write-Pass "Inno Setup 6: found via $isccSource"
    Write-Detail "Inno Setup 6 detail: version $isccVersion; path $isccPath"
}

Invoke-Check -Name 'NSSM' -OnError Info -ScriptBlock {
    $programData = $env:ProgramData
    if ([string]::IsNullOrWhiteSpace($programData)) {
        $programData = 'C:\ProgramData'
    }

    $nssmPath = Join-Path $programData 'Owlette\tools\nssm.exe'

    if (Test-Path -LiteralPath $nssmPath -PathType Leaf) {
        Write-Info "NSSM: present at $nssmPath"
    }
    else {
        Write-Info "NSSM: not found at $nssmPath; build script downloads it if missing"
    }
}

Write-Host ''
Write-Host 'E2E TESTS' -ForegroundColor Cyan

Invoke-Check -Name 'JDK 21' -OnError Warn -ScriptBlock {
    if (-not (Test-Command 'java')) {
        Write-Warn 'JDK 21: java missing; install JDK 21 for full e2e tests'
        return
    }

    $javaResult = Invoke-Native -FilePath 'java' -ArgumentList @('-version')
    $javaOutput = $javaResult.Output
    $javaPath = Get-CommandSource 'java'
    $javaVersionLine = Get-FirstLine $javaOutput
    $match = $javaOutput | Select-String -Pattern 'version "(\d+)' | Select-Object -First 1

    if ($null -ne $match) {
        $javaMajor = [int]$match.Matches[0].Groups[1].Value
        if ($javaMajor -ge 21) {
            Write-Pass "JDK 21: $javaVersionLine"
        }
        else {
            Write-Warn "JDK 21: $javaVersionLine found; install JDK 21 for full e2e tests"
        }
    }
    else {
        Write-Warn "JDK 21: unable to parse java version; install JDK 21 for full e2e tests"
    }

    Write-Detail "JDK 21 detail: version $javaVersionLine; path $javaPath"
}

Invoke-Check -Name 'firebase-tools 13.x' -OnError Warn -ScriptBlock {
    $firebaseVersion = $null
    $firebasePath = $null
    $source = $null

    if (Test-Command 'firebase') {
        $firebaseResult = Invoke-Native -FilePath 'firebase' -ArgumentList @('--version')
        if ($firebaseResult.ExitCode -eq 0) {
            $firebaseVersion = Get-FirstLine $firebaseResult.Output
            $firebasePath = Get-CommandSource 'firebase'
            $source = 'firebase'
        }
    }

    if ($null -eq $firebaseVersion -and (Test-Command 'npx')) {
        $npxResult = Invoke-Native -FilePath 'npx' -ArgumentList @('--no-install', 'firebase', '--version')
        if ($npxResult.ExitCode -eq 0) {
            $firebaseVersion = Get-FirstLine $npxResult.Output
            $firebasePath = Get-CommandSource 'npx'
            $source = 'npx --no-install firebase'
        }
    }

    if ($null -eq $firebaseVersion) {
        Write-Warn 'firebase-tools 13.x: missing; install firebase-tools 13.x for full e2e tests'
        return
    }

    $firebaseParsedVersion = ConvertTo-Version $firebaseVersion
    if ($null -ne $firebaseParsedVersion -and $firebaseParsedVersion.Major -eq 13) {
        Write-Pass "firebase-tools 13.x: $firebaseVersion"
    }
    else {
        Write-Warn "firebase-tools 13.x: $firebaseVersion found; install firebase-tools 13.x for full e2e tests"
    }

    Write-Detail "firebase-tools detail: version $firebaseVersion; path $firebasePath; source $source"
}

if ($InstallWebDeps) {
    if ($script:failed -ne 0) {
        Write-Info 'web dependencies: skipped because required checks failed'
        Complete-Script
    }

    $webPath = Join-Path $repoRoot 'web'
    if (-not (Test-Path -LiteralPath $webPath -PathType Container)) {
        Write-Fail "web dependencies: /web directory not found at $webPath"
        Complete-Script
    }

    Push-Location -LiteralPath $webPath
    $webInstallFailed = $false
    try {
        Write-Info 'web dependencies: running npm ci --legacy-peer-deps'
        & npm ci --legacy-peer-deps
        if ($LASTEXITCODE -ne 0) {
            Write-Fail 'web dependencies: npm ci --legacy-peer-deps failed'
            $webInstallFailed = $true
        }

        if (-not $webInstallFailed) {
            Write-Info 'web dependencies: running npx playwright install --with-deps chromium'
            & npx playwright install --with-deps chromium
            if ($LASTEXITCODE -ne 0) {
                Write-Fail 'web dependencies: npx playwright install --with-deps chromium failed'
                $webInstallFailed = $true
            }
        }
    }
    finally {
        Pop-Location
    }

    if ($webInstallFailed) {
        Complete-Script
    }
}
else {
    Write-Host 'tip: run with -InstallWebDeps to install web dev dependencies after fixing any failures.' -ForegroundColor Cyan
}

Complete-Script
