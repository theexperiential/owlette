@echo off
setlocal enabledelayedexpansion

:: ============================================================================
:: Owlette Service Uninstallation Script
:: ============================================================================
:: Stops and deregisters the Owlette Windows service.
:: Run with administrator privileges.
::
:: 3.0.0: `owlette-host uninstall` replaces the nssm stop/remove pair. It waits
:: for the service to reach STOPPED before deregistering it, which is what gives
:: the agent time to flush `online: false` to Firestore - the old script's
:: fixed sleeps were working around `nssm stop` returning early.
:: ============================================================================

echo.
echo ========================================
echo Owlette Service Uninstallation
echo ========================================
echo.

:: Get the installation directory
cd /d "%~dp0.."
set "INSTALL_DIR=%CD%"
set "HOST_EXE=%INSTALL_DIR%\tools\owlette-host.exe"

:: ============================================================================
:: Check for administrator privileges
:: ============================================================================
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo ERROR: This script requires administrator privileges.
    echo Please run as administrator.
    echo.
    pause
    exit /b 1
)

:: ============================================================================
:: Stop and remove service
:: ============================================================================
if not exist "%HOST_EXE%" (
    echo Service host not found at "%HOST_EXE%".
    echo Nothing to uninstall from this directory.
    echo.
    pause
    exit /b 0
)

echo Stopping and deregistering the service...
"%HOST_EXE%" uninstall

if %errorLevel% equ 0 (
    echo.
    echo ========================================
    echo Service Uninstalled Successfully
    echo ========================================
    echo.
) else (
    echo ERROR: Failed to remove service
    echo Check the host log at: %ProgramData%\Owlette\logs\service_host.log
    pause
    exit /b 1
)

echo.
echo Note: Configuration and logs have been preserved.
echo To completely remove Owlette, delete the installation directory:
echo   %INSTALL_DIR%
echo.
pause
