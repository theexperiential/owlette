@echo off
setlocal enabledelayedexpansion

:: ============================================================================
:: Owlette Service Installation Script
:: ============================================================================
:: Registers Owlette as a Windows service hosted by tools\owlette-host.exe.
:: Run with administrator privileges.
:: Usage: install.bat [--silent]  (--silent skips pauses for the installer)
::
:: 3.0.0: NSSM is gone. Every `nssm set` this script used to make - start type,
:: dependencies, LocalSystem, log files, restart policy, "do not kill the
:: process tree" - is now behaviour in owlette-host itself, so a machine's
:: registration is a property of the shipped binary rather than of whichever
:: batch file last ran. `owlette-host install` also performs the migration: it
:: stops and removes whatever OwletteService is already registered (an NSSM one
:: included) before creating its own. Config, tokens, logs and cache under
:: %ProgramData%\Owlette are never touched.
::
:: See agent/host/src/registration.rs.
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
set "HOST_EXE=%INSTALL_DIR%\tools\owlette-host.exe"

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
:: Step 3: Verify the service host is present
:: ============================================================================
echo [2/4] Checking the service host...
if not exist "%HOST_EXE%" (
    echo ERROR: Service host not found at:
    echo   %HOST_EXE%
    echo The installer package is incomplete - rebuild with build_installer_full.bat.
    if "%SILENT_MODE%"=="0" pause
    exit /b 1
)
echo Service host: %HOST_EXE%

:: ============================================================================
:: Step 4: Register the service
:: ============================================================================
:: `install` stops any existing OwletteService and waits for it to reach
:: STOPPED before removing it. That wait is what lets the running agent flush
:: `online: false` to Firestore and log agent_stopped - the old script's extra
:: sleep afterwards existed only because `nssm stop` returned before its child
:: had actually died. It doesn't here: STOPPED means the agent process is gone.
echo [3/4] Registering the Owlette service...
"%HOST_EXE%" install
if %errorLevel% neq 0 (
    echo ERROR: Failed to register the service
    echo Check the host log at: %DATA_DIR%\logs\service_host.log
    if "%SILENT_MODE%"=="0" pause
    exit /b 1
)

:: ============================================================================
:: Step 5: Start service
:: ============================================================================
echo [4/4] Starting service...
"%HOST_EXE%" start
if %errorLevel% neq 0 (
    echo ERROR: Failed to start service
    echo Check logs at: %DATA_DIR%\logs\
    if "%SILENT_MODE%"=="0" pause
    exit /b 1
)

"%HOST_EXE%" status

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
echo   - "%HOST_EXE%" start ^| stop ^| status
echo.
if "%SILENT_MODE%"=="0" pause
