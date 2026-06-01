@echo off
:: ============================================================================
:: Owlette Tray Icon Launcher
:: ============================================================================
:: Launches the Owlette system tray icon.
::
:: This launcher backs the Start-menu "Owlette" shortcut — i.e. an explicit user
:: action to launch/resume owlette. It passes --resume so the tray will start
:: the service if it was stopped (e.g. after the user exited owlette). The
:: {userstartup} startup shortcut and the service launch the tray WITHOUT
:: --resume, so neither can trigger a service-start UAC prompt at boot/login.
:: ============================================================================

cd /d "%~dp0.."
set PYTHONPATH=%CD%\agent\src
start "" "%CD%\python\pythonw.exe" "%CD%\agent\src\owlette_tray.py" --resume
