@echo off
setlocal enabledelayedexpansion

:: ============================================================================
:: Owlette Embedded Python Installer Builder
:: ============================================================================
:: This script automates the creation of the embedded Python installer package
:: Run this script to build a complete installer from scratch
:: ============================================================================

echo.
echo ========================================
echo Owlette Embedded Installer Builder
echo ========================================
echo.

cd /d "%~dp0"

:: ============================================================================
:: Step 0: Read and validate VERSION file
:: ============================================================================
echo [0/9] Reading VERSION file...

if not exist "VERSION" (
    echo ERROR: VERSION file not found!
    pause
    exit /b 1
)
:: echo DEBUG: VERSION file exists

:: Read version from VERSION file
set /p OWLETTE_VERSION=<VERSION
:: echo DEBUG: Read result: [%OWLETTE_VERSION%]

:: Remove spaces
set OWLETTE_VERSION=%OWLETTE_VERSION: =%
:: echo DEBUG: After trim: [%OWLETTE_VERSION%]

if "%OWLETTE_VERSION%"=="" (
    echo ERROR: VERSION is empty after reading!
    pause
    exit /b 1
)

echo Building Owlette version: %OWLETTE_VERSION%
echo.

:: ============================================================================
:: Step 1: Clean previous builds
:: ============================================================================
echo [1/9] Cleaning previous builds...
:: Keep downloads\ cache intact — only wipe the build output
if exist "build" (
    rmdir /s /q build 2>nul
)
mkdir build
mkdir build\installer_package
:: Persistent download cache (survives clean)
if not exist "downloads" mkdir downloads

:: ============================================================================
:: Step 2: Download Python 3.11 embedded
:: ============================================================================
echo [2/9] Downloading Python 3.11 embedded...
:: SHA256 hash for python-3.11.8-embed-amd64.zip
:: Verify at: https://www.python.org/downloads/release/python-3118/ (Files table)
:: IMPORTANT: Update this hash if changing Python version
set PYTHON_EXPECTED_HASH=6347068ca56bf4dd6319f7ef5695f5a03f1ade3e9aa2d6a095ab27faa77a1290
if not exist "downloads\python-embed.zip" (
    echo Downloading Python 3.11.8 embedded...
    curl -L -o downloads\python-embed.zip https://www.python.org/ftp/python/3.11.8/python-3.11.8-embed-amd64.zip
    if errorlevel 1 (
        echo ERROR: Failed to download Python
        pause
        exit /b 1
    )
)

:: Verify Python download integrity
echo Verifying Python download checksum...
for /f "skip=1 tokens=*" %%a in ('certutil -hashfile downloads\python-embed.zip SHA256') do (
    if not defined PYTHON_ACTUAL_HASH set "PYTHON_ACTUAL_HASH=%%a"
)
if /i not "%PYTHON_ACTUAL_HASH%"=="%PYTHON_EXPECTED_HASH%" (
    echo ERROR: Python checksum mismatch!
    echo Expected: %PYTHON_EXPECTED_HASH%
    echo Actual:   %PYTHON_ACTUAL_HASH%
    echo Download may be corrupted or tampered with.
    del downloads\python-embed.zip
    pause
    exit /b 1
)
echo Python checksum verified OK
set "PYTHON_ACTUAL_HASH="

:: Extract Python
echo Extracting Python...
powershell -Command "Expand-Archive -Path downloads\python-embed.zip -DestinationPath build\python -Force"

:: ============================================================================
:: Step 3: Configure Python import paths
:: ============================================================================
echo [3/9] Configuring Python import paths...
(
    echo python311.zip
    echo .
    echo Lib
    echo Lib\site-packages
    echo ..\agent\src
    echo.
    echo # Enable site.main^(^) for pip support
    echo import site
) > build\python\python311._pth

:: ============================================================================
:: Step 4: Install pip
:: ============================================================================
echo [4/9] Installing pip...
if not exist "downloads\get-pip.py" (
    curl -o downloads\get-pip.py https://bootstrap.pypa.io/get-pip.py
)
"%~dp0build\python\python.exe" "%~dp0downloads\get-pip.py"
if errorlevel 1 (
    echo ERROR: Failed to install pip
    pause
    exit /b 1
)
echo Pip installed successfully!

:: ============================================================================
:: Step 5: Install dependencies
:: ============================================================================
echo [5/9] Installing dependencies (this may take a few minutes)...
:: Install only from PyPI (no custom indexes) and verify TLS
"%~dp0build\python\python.exe" -m pip install --no-warn-script-location --ignore-installed --only-binary=:all: -r "%~dp0requirements.txt"
if errorlevel 1 (
    echo WARNING: Some packages may not have binary wheels, retrying with source builds...
    "%~dp0build\python\python.exe" -m pip install --no-warn-script-location --ignore-installed -r "%~dp0requirements.txt"
    if errorlevel 1 (
        echo ERROR: Failed to install dependencies
        pause
        exit /b 1
    )
)
:: Verify installed packages have no dependency conflicts
"%~dp0build\python\python.exe" -m pip check
if errorlevel 1 (
    echo WARNING: Dependency conflicts detected (non-fatal)
)
echo Dependencies installed successfully!

:: ============================================================================
:: Step 6: Copy tkinter from system Python 3.11
:: ============================================================================
echo [6/9] Copying tkinter from system Python...
if exist "C:\Program Files\Python311" (
    echo Copying tkinter module...
    xcopy /E /I /Y "C:\Program Files\Python311\Lib\tkinter" build\python\Lib\tkinter\ >nul

    echo Copying tkinter DLLs...
    copy /Y "C:\Program Files\Python311\DLLs\_tkinter.pyd" build\python\ >nul
    copy /Y "C:\Program Files\Python311\DLLs\tcl86t.dll" build\python\ >nul
    copy /Y "C:\Program Files\Python311\DLLs\tk86t.dll" build\python\ >nul

    echo Copying tcl directory...
    xcopy /E /I /Y "C:\Program Files\Python311\tcl" build\python\tcl\ >nul
) else (
    echo WARNING: Python 3.11 not found at C:\Program Files\Python311
    echo GUI will not work without tkinter
    pause
)

:: ============================================================================
:: Step 7: Acquire NSSM (cached download or local install fallback)
:: ============================================================================
echo [7/9] Acquiring NSSM...
mkdir build\tools 2>nul

:: SHA256 hash for nssm-2.24.zip (from nssm.cc)
:: IMPORTANT: Verify this hash manually on first build by downloading from nssm.cc
:: and computing: certutil -hashfile nssm-2.24.zip SHA256
:: Update this hash if changing NSSM version
set NSSM_EXPECTED_HASH=923c35e43bf18a672648abf67d9ded77da89b82baff52b94762a10f285e2db26

:: Use cached zip if present
if exist "downloads\nssm.zip" goto :verify_nssm

:: Try downloading
echo Downloading NSSM 2.24 from nssm.cc...
curl -L --max-time 30 -o downloads\nssm.zip https://nssm.cc/release/nssm-2.24.zip
if errorlevel 1 (
    echo WARNING: Download failed, trying local installation...
    del downloads\nssm.zip 2>nul
    goto :nssm_local
)
:: Reject HTML error pages (a real zip is hundreds of KB)
for %%F in (downloads\nssm.zip) do if %%~zF LSS 10240 (
    echo WARNING: Downloaded file too small ^(%%~zF bytes^) - server returned error page
    del downloads\nssm.zip
    goto :nssm_local
)

:verify_nssm
echo Verifying NSSM download checksum...
set "NSSM_ACTUAL_HASH="
for /f "skip=1 tokens=*" %%a in ('certutil -hashfile downloads\nssm.zip SHA256') do (
    if not defined NSSM_ACTUAL_HASH set "NSSM_ACTUAL_HASH=%%a"
)
if /i "%NSSM_ACTUAL_HASH%"=="%NSSM_EXPECTED_HASH%" (
    set "NSSM_ACTUAL_HASH="
    goto :extract_nssm
)
echo WARNING: NSSM download checksum mismatch ^(actual: %NSSM_ACTUAL_HASH%^)
echo          Falling back to local installation...
set "NSSM_ACTUAL_HASH="
del downloads\nssm.zip

:nssm_local
if exist "%ProgramData%\Owlette\tools\nssm.exe" (
    echo Using locally installed NSSM from %ProgramData%\Owlette\tools\nssm.exe
    copy /Y "%ProgramData%\Owlette\tools\nssm.exe" build\tools\ >nul
    echo NSSM acquired from local installation OK
    goto :nssm_done
)
echo ERROR: nssm.cc is unavailable and no local NSSM at %ProgramData%\Owlette\tools\nssm.exe
pause
exit /b 1

:extract_nssm
echo Extracting NSSM...
powershell -Command "Expand-Archive -Path downloads\nssm.zip -DestinationPath build\nssm -Force"
copy /Y build\nssm\nssm-2.24\win64\nssm.exe build\tools\ >nul

:nssm_done

:: ============================================================================
:: Step 8: Create installer package structure
:: ============================================================================
echo [8/9] Creating installer package...

:: Create directory structure
mkdir build\installer_package\python 2>nul
mkdir build\installer_package\agent\src 2>nul
mkdir build\installer_package\agent\icons 2>nul
mkdir build\installer_package\tools 2>nul
mkdir build\installer_package\scripts 2>nul

:: Note: config, logs, cache, tmp directories are now created in ProgramData by the installer

:: Copy Python runtime
echo Copying Python runtime...
xcopy /E /I /Y build\python\* build\installer_package\python\ >nul

:: Copy VERSION file (single source of truth for version management)
echo Copying VERSION file...
copy /Y VERSION build\installer_package\agent\ >nul

:: Copy agent source code
echo Copying agent source code...
xcopy /E /I /Y src\* build\installer_package\agent\src\ >nul

:: Copy Cortex constitution (Agent SDK loads via setting_sources=["project"])
if exist CLAUDE.md (
    echo Copying CLAUDE.md for Cortex...
    copy /Y CLAUDE.md build\installer_package\agent\ >nul
)

:: Note: Config template not needed - configure_site.py creates config in ProgramData during installation

:: Copy NSSM
echo Copying NSSM...
copy /Y build\tools\nssm.exe build\installer_package\tools\ >nul

:: Copy icons
if exist "icons" (
    echo Copying icons...
    xcopy /E /I /Y icons\* build\installer_package\agent\icons\ >nul
)

:: Copy installation scripts
echo Copying installation scripts...
copy /Y scripts\install.bat build\installer_package\scripts\ >nul
copy /Y scripts\uninstall.bat build\installer_package\scripts\ >nul
copy /Y scripts\launch_gui.bat build\installer_package\scripts\ >nul
copy /Y scripts\launch_tray.bat build\installer_package\scripts\ >nul

:: ============================================================================
:: Step 9: Optionally compile with Inno Setup
:: ============================================================================
echo.
echo [9/9] Checking for Inno Setup...

:: Check for Inno Setup
set "INNO_PATH=C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
if exist "%INNO_PATH%" (
    echo Found Inno Setup! Creating installer.exe...
    mkdir build\installer_output 2>nul
    "%INNO_PATH%" owlette_installer.iss

    if errorlevel 1 (
        echo WARNING: Inno Setup compilation failed
        echo You can manually compile by running:
        echo   "%INNO_PATH%" owlette_installer.iss
    ) else (
        echo.
        echo ========================================
        echo SUCCESS! Installer Created!
        echo ========================================
        echo.
        echo Output: build\installer_output\Owlette-Installer-v%OWLETTE_VERSION%.exe
        echo.
    )
) else (
    echo Inno Setup not found
    echo.
    echo ========================================
    echo Build Complete!
    echo ========================================
    echo.
    echo Installer package created at: build\installer_package\
    echo.
    echo To create installer.exe, install Inno Setup 6 from:
    echo   https://jrsoftware.org/isdl.php
    echo.
    echo Then run manually:
    echo   "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" owlette_installer.iss
    echo.
)

pause
