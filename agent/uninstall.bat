@echo off
:: Check for admin rights and self-elevate if needed
net session >nul 2>&1
if errorlevel 1 (
    echo Requesting administrative privileges...
    powershell -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

setlocal
cd /d %~dp0

set "SYSTEM_PYTHON=%ProgramFiles%\Python311\python.exe"

:: Check for Python installation
if not exist "%SYSTEM_PYTHON%" (
    echo Python 3.11 is not installed. Cannot proceed with uninstallation.
    pause
    goto :eof
)

:: Stop the Owlette Windows service if it's running
echo Stopping the Owlette Windows service if it's running...
net stop OwletteService

:: Close the Owlette window if it's open
echo Closing the Owlette window if it's running...
taskkill /F /FI "WINDOWTITLE eq owlette"

:: Uninstall the Owlette Windows service
echo Uninstalling the Owlette Windows service...
cd %~dp0
cd src
"%SYSTEM_PYTHON%" owlette_service.py remove

:: Optional: Ask the user if they want to remove config and logs
set /p remove_data=Do you want to remove config and logs? (y/n):
if "%remove_data%"=="y" (
    echo Removing config and logs...
    cd %~dp0
    rmdir /s /q config 2>nul
    rmdir /s /q logs 2>nul
    rmdir /s /q tmp 2>nul
    echo Config, logs, and temporary files removed.
) else if "%remove_data%"=="n" (
    echo Skipping config and logs removal.
) else (
    echo Invalid choice. Skipping config and logs removal.
)

:: Done
echo Uninstallation complete!
endlocal
pause