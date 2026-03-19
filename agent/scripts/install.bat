@echo off
setlocal enabledelayedexpansion

:: ============================================================================
:: Owlette Service Installation Script
:: ============================================================================
:: This script installs Owlette as a Windows service using NSSM
:: Run with administrator privileges
:: Usage: install.bat [--silent]  (--silent skips pauses for installer)
:: ============================================================================

:: Check for silent mode (when run from Inno Setup installer)
set "SILENT_MODE=0"
if /i "%~1"=="--silent" set "SILENT_MODE=1"

echo.
echo ========================================
echo Owlette Service Installation
echo ========================================
echo.

:: Get the installation directory (where this script is located)
cd /d "%~dp0.."
set "INSTALL_DIR=%CD%"

echo Installation directory: %INSTALL_DIR%
echo.

:: ============================================================================
:: Step 1: Check for administrator privileges
:: ============================================================================
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo ERROR: This script requires administrator privileges.
    echo Please run as administrator.
    echo.
    if "%SILENT_MODE%"=="0" pause
    exit /b 1
)

:: ============================================================================
:: Step 2: Create ProgramData directories for config and logs
:: ============================================================================
echo [1/4] Creating ProgramData directories...
set "DATA_DIR=%ProgramData%\Owlette"

if not exist "%DATA_DIR%" mkdir "%DATA_DIR%"
if not exist "%DATA_DIR%\config" mkdir "%DATA_DIR%\config"
if not exist "%DATA_DIR%\logs" mkdir "%DATA_DIR%\logs"
if not exist "%DATA_DIR%\cache" mkdir "%DATA_DIR%\cache"
if not exist "%DATA_DIR%\tmp" mkdir "%DATA_DIR%\tmp"

echo ProgramData directories created at: %DATA_DIR%

:: Note: Config file will be created by configure_site.py during first run or OAuth setup

:: ============================================================================
:: Step 3: Stop and remove existing service (if any)
:: ============================================================================
echo [2/4] Checking for existing service...
"%INSTALL_DIR%\tools\nssm.exe" status OwletteService >nul 2>&1
if %errorLevel% equ 0 (
    echo Stopping existing service...
    "%INSTALL_DIR%\tools\nssm.exe" stop OwletteService

    :: Wait up to 10 seconds for service to stop gracefully
    :: This allows the service to cleanly set online=false in Firestore
    echo Waiting for service to stop gracefully...
    set WAIT_COUNT=0
    :WAIT_LOOP
    "%INSTALL_DIR%\tools\nssm.exe" status OwletteService | findstr /C:"SERVICE_STOPPED" >nul 2>&1
    if !errorLevel! equ 0 goto SERVICE_STOPPED

    timeout /t 1 /nobreak >nul
    set /a WAIT_COUNT+=1
    if !WAIT_COUNT! lss 10 goto WAIT_LOOP

    :: If service didn't stop after 10 seconds, force stop
    echo Service did not stop gracefully, forcing...
    "%INSTALL_DIR%\tools\nssm.exe" stop OwletteService
    timeout /t 1 /nobreak >nul

    :SERVICE_STOPPED
    echo Service stopped successfully

    :: SAFETY MARGIN: Wait additional 3 seconds after service stops
    :: This ensures Firestore has fully processed the online=false write
    :: and the web dashboard will show machine as offline
    echo Waiting for Firestore sync to complete...
    timeout /t 3 /nobreak >nul

    echo Removing existing service...
    "%INSTALL_DIR%\tools\nssm.exe" remove OwletteService confirm

    :: SAFETY MARGIN: Wait 2 seconds after removing service
    :: This prevents any race conditions between old/new service
    echo Preparing to install new service...
    timeout /t 2 /nobreak >nul
)

:: ============================================================================
:: Step 4: Install service with NSSM
:: ============================================================================
echo [3/4] Installing Owlette service...

:: Install service with application and script
"%INSTALL_DIR%\tools\nssm.exe" install OwletteService "%INSTALL_DIR%\python\python.exe" "%INSTALL_DIR%\agent\src\owlette_runner.py"

if %errorLevel% neq 0 (
    echo ERROR: Failed to install service
    if "%SILENT_MODE%"=="0" pause
    exit /b 1
)

:: Configure service
echo Configuring service...
"%INSTALL_DIR%\tools\nssm.exe" set OwletteService AppDirectory "%INSTALL_DIR%\agent\src"
"%INSTALL_DIR%\tools\nssm.exe" set OwletteService DisplayName "Owlette Service"
"%INSTALL_DIR%\tools\nssm.exe" set OwletteService Description "Owlette process monitoring and management service"
"%INSTALL_DIR%\tools\nssm.exe" set OwletteService Start SERVICE_AUTO_START

:: Enable delayed auto-start — gives Windows time to fully initialise the desktop,
:: network adapters and user sessions before Owlette starts.  This is a separate
:: registry flag on top of SERVICE_AUTO_START.
reg add "HKLM\SYSTEM\CurrentControlSet\Services\OwletteService" /v DelayedAutostart /t REG_DWORD /d 1 /f >nul 2>&1
"%INSTALL_DIR%\tools\nssm.exe" set OwletteService AppNoConsole 1

:: Run service as LocalSystem for elevated privileges (needed for silent installer execution)
:: OAuth tokens are stored in C:\ProgramData\Owlette\.tokens.enc (accessible by SYSTEM)
echo Configuring service to run as LocalSystem...
"%INSTALL_DIR%\tools\nssm.exe" set OwletteService ObjectName "LocalSystem"

"%INSTALL_DIR%\tools\nssm.exe" set OwletteService AppStdout "%DATA_DIR%\logs\service_stdout.log"
"%INSTALL_DIR%\tools\nssm.exe" set OwletteService AppStderr "%DATA_DIR%\logs\service_stderr.log"
"%INSTALL_DIR%\tools\nssm.exe" set OwletteService AppRotateFiles 1
"%INSTALL_DIR%\tools\nssm.exe" set OwletteService AppRotateOnline 1
"%INSTALL_DIR%\tools\nssm.exe" set OwletteService AppRotateSeconds 86400
"%INSTALL_DIR%\tools\nssm.exe" set OwletteService AppRotateBytes 10485760

:: Set service dependencies (wait for network)
"%INSTALL_DIR%\tools\nssm.exe" set OwletteService DependOnService Tcpip Dnscache

:: Configure restart behavior
:: - Exit code 0 (clean exit) -> Don't restart (user intentionally stopped it)
:: - Default (crashes/errors) -> Restart (auto-recovery)
"%INSTALL_DIR%\tools\nssm.exe" set OwletteService AppExit Default Restart
"%INSTALL_DIR%\tools\nssm.exe" set OwletteService AppExit 0 Exit

:: Don't kill child processes on service stop.
:: Managed processes (TouchDesigner, etc.) are launched via a helper script that
:: breaks the parent-child chain, but this is a safety net to ensure they survive
:: service restarts and upgrades.
:: Note: AppKillProcessTree is not exposed via nssm set CLI, must use reg add.
reg add "HKLM\SYSTEM\CurrentControlSet\Services\OwletteService\Parameters" /v AppKillProcessTree /t REG_DWORD /d 0 /f >nul 2>&1

:: ============================================================================
:: Step 5: Start service
:: ============================================================================
echo [4/4] Starting service...
"%INSTALL_DIR%\tools\nssm.exe" start OwletteService

if %errorLevel% neq 0 (
    echo ERROR: Failed to start service
    echo Check logs at: %DATA_DIR%\logs\
    if "%SILENT_MODE%"=="0" pause
    exit /b 1
)

:: Wait a moment and check status
timeout /t 3 /nobreak >nul
"%INSTALL_DIR%\tools\nssm.exe" status OwletteService

echo.
echo ========================================
echo Installation Complete!
echo ========================================
echo.
echo Service: OwletteService
echo Status: Running
echo Config: %DATA_DIR%\config\
echo Logs: %DATA_DIR%\logs\
echo.
echo You can manage the service from:
echo   - Services.msc (Windows Services)
echo   - Task Manager ^> Services tab
echo.
if "%SILENT_MODE%"=="0" pause
