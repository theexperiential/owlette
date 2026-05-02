@echo off
setlocal

echo.
echo ========================================
echo Owlette Quick Installer Builder
echo ========================================
echo.

cd /d "%~dp0"

echo [1/3] Reading VERSION file...

REM Read version from VERSION file using temporary file approach
if not exist "VERSION" (
    echo ERROR: VERSION file not found!
    pause
    exit /b 1
)

powershell -Command "(Get-Content VERSION -First 1).Trim()" > version.tmp 2>&1
if errorlevel 1 (
    echo ERROR: PowerShell failed to read VERSION file!
    pause
    exit /b 1
)

set /p OWLETTE_VERSION=<version.tmp
del version.tmp

if not defined OWLETTE_VERSION (
    echo ERROR: Could not read VERSION file!
    pause
    exit /b 1
)

echo Building version: %OWLETTE_VERSION%
echo.

echo [2/3] Checking prerequisites...

if not exist "build\python\python.exe" (
    echo.
    echo ERROR: Python runtime not found in build directory!
    echo You must run build_installer_full.bat first.
    echo.
    pause
    exit /b 1
)

echo Prerequisites OK!
echo.

echo [3/3] Copying updated files...
copy /Y VERSION build\installer_package\agent\ >nul 2>&1
xcopy /E /I /Y src\* build\installer_package\agent\src\ >nul
xcopy /E /I /Y icons\* build\installer_package\agent\icons\ >nul
copy /Y scripts\*.bat build\installer_package\scripts\ >nul
echo Files copied!
echo.

echo [4/4] Compiling installer...
set "INNO_PATH="
if defined ISCC (
    if exist "%ISCC%" set "INNO_PATH=%ISCC%"
)
if not defined INNO_PATH (
    for /f "delims=" %%i in ('where iscc.exe 2^>nul') do (
        if not defined INNO_PATH set "INNO_PATH=%%i"
    )
)
if not defined INNO_PATH (
    if exist "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" set "INNO_PATH=C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
)
if not defined INNO_PATH (
    echo ERROR: Inno Setup 6 not found. Set %%ISCC%% or install to default path.
    pause
    exit /b 1
)

echo Running Inno Setup compiler...
mkdir build\installer_output 2>nul
"%INNO_PATH%" owlette_installer.iss
if errorlevel 1 (
    echo ERROR: Inno Setup compilation failed
    pause
    exit /b 1
)
echo.
echo SUCCESS! Installer created: Owlette-Installer-v%OWLETTE_VERSION%.exe
echo.

echo Build complete!
pause
