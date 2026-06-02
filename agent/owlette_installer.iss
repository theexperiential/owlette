; Owlette Installer Script for Inno Setup
; ============================================================================
; This script creates a professional Windows installer for Owlette
; Requires: Inno Setup 6.x (https://jrsoftware.org/isinfo.php)
; ============================================================================
;
; AUTHENTICATION:
; ---------------
; This installer uses device code / QR pairing authentication.
; The agent displays a 3-word pairing phrase and QR code. The user
; authorizes from their phone, the dashboard, or via /ADD= for bulk deploy.
; Tokens are encrypted in C:\ProgramData\Owlette\.tokens.enc.
;
; PAIRING FLOW:
; -------------
; Method 1 (QR Code - interactive):
;   1. Installer runs configure_site.py (displays QR code + pairing phrase)
;   2. User scans QR with phone → owlette.app/add → selects site → authorizes
;   3. Agent polls for authorization, receives tokens
;
; Method 2 (Dashboard - manual):
;   1. Installer displays pairing phrase (e.g., "silver-compass-drift")
;   2. User enters phrase on dashboard → "+" button → "Enter Code"
;
; Method 3 (Silent - bulk deploy):
;   1. Admin generates phrase on dashboard → "+" button → "Generate Code"
;   2. Run: Owlette-Installer.exe /ADD=silver-compass-drift /SILENT
;
; SECURITY:
; ---------
; - No browser login required on target machine
; - Pairing phrases: 3 words, 10-minute expiry, single-use
; - Tokens can be revoked via web dashboard
; - Access token: 1 hour expiry (auto-refreshes)
; - Refresh token: never expires (admin-revocable, stored encrypted)
;
; BUILD PARAMETERS:
; -----------------
; /SERVER=prod  → Uses owlette.app (production) — DEFAULT when /SERVER is omitted
; /SERVER=dev   → Uses dev.owlette.app (development)
;
; Example:
;   Owlette-Installer-v2.0.0.exe /SERVER=prod
; ============================================================================

; VERSION MANAGEMENT
; ------------------
; Version is read from VERSION file at build time (passed via /DMyAppVersion=X.X.X)
; If not provided, defaults to reading from VERSION file via ReadIni workaround
; To bump version: Edit agent/VERSION file and rebuild
; Build script (build_embedded_installer.bat) validates VERSION file exists and passes it here

#ifndef MyAppVersion
  #define MyAppVersion GetEnv("OWLETTE_VERSION")
  #if MyAppVersion == ""
    ; fallback should match /VERSION - bump on every release
    #define MyAppVersion "2.11.0"
    #pragma message "WARNING: Using fallback version 2.11.0 - VERSION file not found or OWLETTE_VERSION not set"
  #endif
#endif

#define MyAppName "Owlette"
#define MyAppPublisher "The Experiential Company"
#define MyAppURL "https://owlette.app"
#define MyAppRepoURL "https://github.com/theexperiential/owlette"
#define MyAppExeName "pythonw.exe"

[Setup]
; NOTE: The value of AppId uniquely identifies this application.
; Do not use the same AppId value in installers for other applications.
AppId={{A7B8C9D0-E1F2-4A5B-8C9D-0E1F2A3B4C5D}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={commonappdata}\{#MyAppName}
DefaultGroupName={#MyAppName}
AllowNoIcons=yes
LicenseFile=..\LICENSE
OutputDir=build\installer_output
OutputBaseFilename=Owlette-Installer-v{#MyAppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
PrivilegesRequiredOverridesAllowed=commandline
CloseApplications=force
RestartApplications=no
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
UninstallDisplayIcon={app}\agent\icons\normal.png
SetupIconFile=icons\normal.ico
SetupLogging=yes
DisableProgramGroupPage=yes
; Silent mode enhancements - prevent ALL prompts when run as SYSTEM
AlwaysShowDirOnReadyPage=no
DisableWelcomePage=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Messages]
FinishedLabel=Setup has finished installing [name] on your computer.%n%nThe Owlette service and tray icon will start automatically within a few moments. Look for the Owlette icon (a dot in a circle) in your taskbar—it may be hidden under the overflow menu (^).

[Tasks]
; Desktop icons removed - tray icon auto-starts on login via startup folder

[Files]
; Python runtime
Source: "build\installer_package\python\*"; DestDir: "{app}\python"; Flags: ignoreversion recursesubdirs createallsubdirs

; Agent source code
Source: "build\installer_package\agent\*"; DestDir: "{app}\agent"; Flags: ignoreversion recursesubdirs createallsubdirs

; Tools (NSSM)
Source: "build\installer_package\tools\*"; DestDir: "{app}\tools"; Flags: ignoreversion

; Scripts
Source: "build\installer_package\scripts\*"; DestDir: "{app}\scripts"; Flags: ignoreversion

; README, documentation, and Cortex constitution
Source: "README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "CLAUDE.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\LICENSE"; DestDir: "{app}"; Flags: ignoreversion

[Dirs]
; Create ProgramData directories (proper location for Windows service data)
Name: "{commonappdata}\Owlette"; Permissions: users-modify
Name: "{commonappdata}\Owlette\config"; Permissions: users-modify
Name: "{commonappdata}\Owlette\logs"; Permissions: users-modify
Name: "{commonappdata}\Owlette\cache"; Permissions: users-modify
Name: "{commonappdata}\Owlette\tmp"; Permissions: users-modify

[InstallDelete]
; Clean up shortcuts from earlier versions that have since been renamed, so an
; upgrade doesn't leave a confusing duplicate in the Start menu. The single
; Start-menu tray entry is now "{group}\Owlette" (it was "Owlette Tray Icon"),
; and the user clicks it to launch/resume owlette. Runs before [Icons] are
; (re)created, so the canonical "Owlette" shortcut below is unaffected.
Type: files; Name: "{group}\Owlette Tray Icon.lnk"
; Also remove the legacy DESKTOP tray shortcut left by installs that opted into
; the long-removed "desktopicon" task (it pointed at launch_tray.bat). Exact
; name, no wildcard — a harmless no-op when absent, and it can't touch a
; user-created desktop shortcut of any other name.
Type: files; Name: "{autodesktop}\Owlette Tray Icon.lnk"

[Icons]
; Start Menu shortcuts (now pointing to ProgramData for user data)
Name: "{group}\Owlette Configuration"; Filename: "{app}\scripts\launch_gui.bat"; IconFilename: "{app}\agent\icons\normal.png"; WorkingDir: "{app}"
Name: "{group}\Owlette"; Filename: "{app}\scripts\launch_tray.bat"; IconFilename: "{app}\agent\icons\normal.png"; WorkingDir: "{app}"
Name: "{group}\View Logs"; Filename: "{commonappdata}\Owlette\logs"; IconFilename: "{sys}\shell32.dll"; IconIndex: 4
Name: "{group}\Edit Configuration"; Filename: "{commonappdata}\Owlette\config\config.json"; IconFilename: "{sys}\shell32.dll"; IconIndex: 70
Name: "{group}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"

; Startup shortcut — launches pythonw.exe directly (no batch file hop) for faster tray appearance.
; owlette_tray.py has its own sys.path setup so PYTHONPATH is not required.
Name: "{userstartup}\Owlette Tray"; Filename: "{app}\python\pythonw.exe"; Parameters: """{app}\agent\src\owlette_tray.py"""; IconFilename: "{app}\agent\icons\normal.ico"; WorkingDir: "{app}"

[Run]
; Step 0: Add Windows Defender exclusions for WinRing0 driver used by LibreHardwareMonitor
; WinRing0 is flagged as VulnerableDriver:WinNT/Winring0 but is required for CPU/GPU temperature monitoring
; LibreHardwareMonitorLib.dll (inside WinTmp) extracts and loads WinRing0x64.sys as a kernel driver at runtime,
; so we need BOTH path exclusions (for the DLL) and process exclusions (for Python loading the driver)
Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -Command ""Add-MpPreference -ExclusionPath '{app}\python\Lib\site-packages\WinTmp' -ErrorAction SilentlyContinue; Add-MpPreference -ExclusionProcess '{app}\python\python.exe' -ErrorAction SilentlyContinue; Add-MpPreference -ExclusionProcess '{app}\python\pythonw.exe' -ErrorAction SilentlyContinue"""; StatusMsg: "Configuring Windows Defender exclusion..."; Flags: runhidden waituntilterminated

; Steps 1-2 (pairing + service install) are handled in [Code] CurStepChanged()
; to support exit code checking and conditional execution.
; See RunPairingAndInstallService() below.

; Note: Tray icon launches automatically on login via startup folder (see [Icons] section above)
; No need to launch it here - it will start on next login or can be launched manually from Start Menu

[UninstallRun]
; Stop and remove the Windows service before uninstalling
Filename: "{app}\tools\nssm.exe"; Parameters: "stop OwletteService"; Flags: runhidden waituntilterminated
Filename: "{app}\tools\nssm.exe"; Parameters: "remove OwletteService confirm"; Flags: runhidden waituntilterminated
; Remove Windows Defender exclusions
Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -Command ""Remove-MpPreference -ExclusionPath '{app}\python\Lib\site-packages\WinTmp' -ErrorAction SilentlyContinue; Remove-MpPreference -ExclusionProcess '{app}\python\python.exe' -ErrorAction SilentlyContinue; Remove-MpPreference -ExclusionProcess '{app}\python\pythonw.exe' -ErrorAction SilentlyContinue"""; Flags: runhidden waituntilterminated

[Code]

var
  ServiceWasStopped: Boolean;
  InstallSucceeded: Boolean;
  PairingSucceeded: Boolean;

function GetConfigureArgs(Param: String): String;
var
  ServerParam: String;
  AddPhrase: String;
  ApiUrl: String;
begin
  // Determine API base URL from /SERVER= parameter
  ServerParam := ExpandConstant('{param:SERVER|prod}');
  if ServerParam = 'dev' then
    ApiUrl := 'https://dev.owlette.app/api'
  else
    ApiUrl := 'https://owlette.app/api';

  Result := '--url "' + ApiUrl + '"';

  // Check for /ADD= parameter (pre-authorized pairing phrase for silent install)
  AddPhrase := ExpandConstant('{param:ADD|}');
  if AddPhrase <> '' then
    Result := Result + ' --add "' + AddPhrase + '"';

  Log('Configure args: ' + Result);
end;

// Legacy function kept for backward compatibility
function GetServerEnvironment(Param: String): String;
var
  ServerParam: String;
begin
  ServerParam := ExpandConstant('{param:SERVER|prod}');
  if ServerParam = 'dev' then
    Result := 'https://dev.owlette.app/setup'
  else
    Result := 'https://owlette.app/setup';
  Log('Server environment: ' + ServerParam + ' -> ' + Result);
end;

function ShouldConfigureSite(): Boolean;
var
  ConfigPath: String;
  ConfigContent: AnsiString;
  AddPhrase: String;
  ServerParam: String;
  RequestedEnv: String;
  ConfigIsDev: Boolean;
  ConfigIsProd: Boolean;
begin
  // An explicit /ADD= pairing phrase means the operator is deliberately
  // (re)pairing this machine now (bulk deploy or site/server switch). Always
  // run pairing — never silently skip an explicit pairing request.
  AddPhrase := ExpandConstant('{param:ADD|}');
  if AddPhrase <> '' then
  begin
    Log('ADD phrase supplied - running OAuth (explicit pairing)');
    Result := True;
    Exit;
  end;

  // Skip OAuth only if config has a valid firebase section with a site_id.
  // A config.json can exist WITHOUT firebase (e.g., service created a default,
  // or a previous install failed mid-OAuth). In those cases, OAuth must still run.
  ConfigPath := ExpandConstant('{commonappdata}\Owlette\config\config.json');

  if not FileExists(ConfigPath) then
  begin
    Log('No config found - running OAuth (fresh install)');
    Result := True;
    Exit;
  end;

  if not LoadStringFromFile(ConfigPath, ConfigContent) then
  begin
    Log('Config exists but unreadable - running OAuth');
    Result := True;
    Exit;
  end;

  // Check for a populated site_id in the firebase section.
  // A valid config has a NON-EMPTY "site_id" and "enabled": true. The
  // `"site_id": ""` exclusion guards against a default/half-written config
  // (enabled flag flipped but no site bound yet) being treated as paired.
  if not ((Pos('"site_id"', ConfigContent) > 0) and
          (Pos('"site_id": ""', ConfigContent) = 0) and
          (Pos('"enabled": true', ConfigContent) > 0)) then
  begin
    Log('Config exists but firebase section missing/incomplete - running OAuth');
    Result := True;
    Exit;
  end;

  // Valid config exists — normally an upgrade, so skip OAuth. BUT if the
  // operator EXPLICITLY passed /SERVER= for a different environment than the
  // one this config is bound to, that's a server switch and we must re-pair.
  // Empty default lets us distinguish "explicitly passed" from "defaulted".
  ServerParam := ExpandConstant('{param:SERVER|}');
  if ServerParam <> '' then
  begin
    if ServerParam = 'dev' then
      RequestedEnv := 'development'
    else
      RequestedEnv := 'production';

    ConfigIsDev := Pos('"environment": "development"', ConfigContent) > 0;
    ConfigIsProd := Pos('"environment": "production"', ConfigContent) > 0;

    if ((RequestedEnv = 'development') and ConfigIsProd) or
       ((RequestedEnv = 'production') and ConfigIsDev) then
    begin
      Log('Requested server (' + RequestedEnv + ') differs from config environment - running OAuth (server switch)');
      Result := True;
      Exit;
    end;

    // /SERVER= was explicitly requested but the config has no recognizable
    // "environment" field (e.g. an old config predating that field). We cannot
    // confirm the current server matches the request, so re-pair rather than
    // silently leave the agent on an unknown/unintended server.
    if (not ConfigIsDev) and (not ConfigIsProd) then
    begin
      Log('Requested server (' + RequestedEnv + ') but config environment is undeterminable - running OAuth');
      Result := True;
      Exit;
    end;
  end;

  Log('Config has valid firebase section - skipping OAuth (upgrade)');
  Result := False;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
  PythonExe: String;
  ConfigArgs: String;
  InstallBat: String;
begin
  if CurStep = ssPostInstall then
  begin
    InstallSucceeded := True;
    PairingSucceeded := True;  // Assume success (upgrade scenario skips pairing)

    // Step 1: Run pairing flow (if needed)
    if ShouldConfigureSite() then
    begin
      PythonExe := ExpandConstant('{app}\python\python.exe');
      ConfigArgs := '"' + ExpandConstant('{app}\agent\src\configure_site.py') + '" ' + GetConfigureArgs('');

      Log('Running pairing: ' + PythonExe + ' ' + ConfigArgs);
      WizardForm.StatusLabel.Caption := 'Pairing with Owlette...';

      Exec(PythonExe, ConfigArgs, '', SW_SHOW, ewWaitUntilTerminated, ResultCode);
      Log('Pairing exit code: ' + IntToStr(ResultCode));

      if ResultCode <> 0 then
      begin
        PairingSucceeded := False;
        Log('Pairing failed - skipping service install');
        MsgBox('Agent pairing was not completed. The Owlette service will not start until you run the pairing flow again.' + #13#10 + #13#10 + 'You can re-pair by running:' + #13#10 + ExpandConstant('{app}\python\python.exe {app}\agent\src\configure_site.py'), mbInformation, MB_OK);
      end;
    end;

    // Step 2: Install service (only if pairing succeeded or was skipped)
    if PairingSucceeded then
    begin
      InstallBat := ExpandConstant('{app}\scripts\install.bat');
      WizardForm.StatusLabel.Caption := 'Installing Owlette service...';
      Log('Installing service: ' + InstallBat);
      Exec(InstallBat, '--silent', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
      Log('Service install exit code: ' + IntToStr(ResultCode));
    end;

    Log('Owlette installation completed' + ' (pairing: ' + IntToStr(Ord(PairingSucceeded)) + ')');
    Log('User data stored in: ' + ExpandConstant('{commonappdata}\Owlette'));
  end;
end;

procedure DeinitializeSetup();
var
  ResultCode: Integer;
begin
  // If we stopped the service during an upgrade but installation failed or was
  // cancelled, restart it so the user isn't left with a dead service.
  if ServiceWasStopped and (not InstallSucceeded) then
  begin
    Log('Installation did not complete - restarting OwletteService...');
    Exec('net', 'start OwletteService', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Log('Service restart returned with code: ' + IntToStr(ResultCode));
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: String;
  InstallDir: String;
  ResultCode: Integer;
begin
  if CurUninstallStep = usUninstall then
  begin
    // Log uninstallation
    Log('Uninstalling Owlette...');
  end
  else if CurUninstallStep = usPostUninstall then
  begin
    // FIX: {app} and {commonappdata}\Owlette are the SAME directory (C:\ProgramData\Owlette).
    // Previously, DelTree wiped the entire {app} dir, destroying config, tokens, and logs
    // even during silent upgrades. Now we selectively remove only installed component dirs
    // and always preserve user data (config/, logs/, cache/, tmp/, .tokens.enc).
    InstallDir := ExpandConstant('{app}');
    DataDir := ExpandConstant('{commonappdata}\Owlette');

    if DirExists(InstallDir) then
    begin
      // Remove only installed component directories (not user data)
      Log('Cleaning installed components from: ' + InstallDir);
      DelTree(InstallDir + '\python', True, True, True);
      DelTree(InstallDir + '\agent', True, True, True);
      DelTree(InstallDir + '\tools', True, True, True);
      DelTree(InstallDir + '\scripts', True, True, True);
      // Remove installed doc files (but not user data files)
      DeleteFile(InstallDir + '\README.md');
      DeleteFile(InstallDir + '\LICENSE');
      Log('Installed components removed (user data preserved)');
    end;

    // Ask user if they want to also remove configuration and user data
    // In silent mode (upgrades), always preserve data
    if DirExists(DataDir) then
    begin
      if not UninstallSilent() and
         (MsgBox('Do you want to remove all Owlette configuration and data files?' + #13#10#13#10 +
                 'This includes:' + #13#10 +
                 '  • Configuration (config.json)' + #13#10 +
                 '  • Authentication tokens' + #13#10 +
                 '  • Log files' + #13#10 +
                 '  • Cache files' + #13#10#13#10 +
                 'Choose "No" to keep your settings for future installations.',
                 mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES) then
      begin
        Log('User chose to remove all data');
        if DelTree(DataDir, True, True, True) then
          Log('Removed all data from: ' + DataDir)
        else
          Log('Failed to remove some data from: ' + DataDir);
      end
      else
      begin
        if UninstallSilent() then
          Log('Silent uninstall - preserving user data for upgrade')
        else
          Log('User chose to preserve data');
      end;
    end;
  end;
end;

function InitializeSetup(): Boolean;
var
  ResultCode: Integer;
  UninstallString: String;
  LibCryptoPath: String;
begin
  Result := True;

  // Check if running as admin
  if not IsAdmin then
  begin
    Log('ERROR: Not running as administrator');
    if not WizardSilent() then
      MsgBox('This installer requires administrator privileges to install the Windows service.' + #13#10 +
             'Please right-click the installer and select "Run as administrator".',
             mbError, MB_OK);
    Result := False;
    Exit;
  end;

  // UPGRADE STRATEGY: Overwrite in place — never run the old uninstaller.
  //
  // Previous versions ran the old uninstaller during upgrades, which wiped the entire
  // install directory (C:\ProgramData\Owlette), destroying config.json, .tokens.enc,
  // and logs. A backup/restore dance was attempted but failed due to Inno Setup event
  // ordering (ssPostInstall fires AFTER [Run] entries, not before).
  //
  // The fix: just stop the service, kill processes, and let Inno Setup overwrite files.
  // Config, tokens, and logs live in subdirectories that [Files] entries don't touch,
  // so they survive naturally. install.bat (in [Run]) handles service re-registration.
  if RegQueryStringValue(HKEY_LOCAL_MACHINE, 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{A7B8C9D0-E1F2-4A5B-8C9D-0E1F2A3B4C5D}_is1', 'UninstallString', UninstallString) then
  begin
    Log('Existing installation detected - upgrading in place (no uninstall)');

    if not WizardSilent() then
    begin
      if MsgBox('An existing Owlette installation was detected.' + #13#10#13#10 +
                'The installer will upgrade in place, preserving your configuration and authentication.' + #13#10#13#10 +
                'Click OK to continue or Cancel to exit.',
                mbConfirmation, MB_OKCANCEL) <> IDOK then
      begin
        Result := False;
        Exit;
      end;
    end;

    // Stop the service before overwriting files.
    // Use 'net stop' which is synchronous — it waits for the service to fully stop
    // (including NSSM killing its child Python process) before returning.
    // This is critical because 'nssm stop' returns immediately while the Python
    // process may still be running in Session 0, holding DLL locks.
    Log('Stopping OwletteService via net stop (synchronous)...');
    Exec('net', 'stop OwletteService', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Log('net stop returned with code: ' + IntToStr(ResultCode));

    // Verify the service actually reached the Stopped state before continuing.
    // Without this, a net stop timeout (e.g., service hung on shutdown) leaves
    // NSSM alive — which would then respawn the python child when our PowerShell
    // kill pass terminates it (NSSM AppExit=Default Restart from install.bat).
    // The respawned process re-loads libcrypto-3.dll mid-copy and we end up back
    // at "DeleteFile failed: code 5". exit 0 = stopped or non-existent (safe to
    // proceed). exit 1 = still running (must abort).
    Log('Verifying OwletteService reached Stopped state...');
    Exec('powershell.exe',
      '-NoProfile -ExecutionPolicy Bypass -Command ' +
      '"$svc = Get-Service -Name OwletteService -ErrorAction SilentlyContinue; ' +
      'if (-not $svc) { exit 0 }; ' +
      'if ($svc.Status -eq ''Stopped'') { exit 0 } else { exit 1 }"',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Log('Service-state check returned: ' + IntToStr(ResultCode));

    if ResultCode <> 0 then
    begin
      Log('OwletteService did not reach Stopped state - aborting upgrade');
      if not WizardSilent() then
        MsgBox('Cannot upgrade Owlette: the OwletteService could not be stopped.' + #13#10 + #13#10 +
               'This usually means the service is hung. Please reboot the machine ' +
               'and run the installer again.',
               mbError, MB_OK);
      Result := False;
      Exit;
    end;
    ServiceWasStopped := True;

    // Fallback: also tell NSSM directly in case net stop didn't fully clean up.
    // Keep the legacy path for upgrades from pre-ProgramData installs where NSSM may still live under C:\Owlette.
    if FileExists(ExpandConstant('{commonappdata}\Owlette\tools\nssm.exe')) then
      Exec(ExpandConstant('{commonappdata}\Owlette\tools\nssm.exe'), 'stop OwletteService', '', SW_HIDE, ewWaitUntilTerminated, ResultCode)
    else if FileExists('C:\Owlette\tools\nssm.exe') then
      Exec('C:\Owlette\tools\nssm.exe', 'stop OwletteService', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end;

  // Kill ALL Owlette Python processes to release DLL locks before file overwrite.
  // Must run BEFORE Inno Setup's file copy phase — if any python.exe or pythonw.exe
  // still holds a handle to python3XX.dll or libcrypto, Inno Setup will schedule the
  // locked files for next-reboot replacement (MoveFileEx DELAY_UNTIL_REBOOT) in silent
  // mode instead of replacing them immediately, leaving the agent on the old version.
  //
  // Two-pass kill:
  //   1. By .Path — fast, catches the common case in one pipeline.
  //   2. By .Modules — defense in depth. Catches processes whose .Path returns null
  //      (Get-Process can't read MainModule.FileName for processes with restricted
  //      integrity-level access, even from an elevated admin) and processes whose
  //      exe lives outside Owlette but loaded an Owlette .pyd/.dll.
  Log('Killing Owlette Python processes by exe path...');
  Exec('powershell.exe',
    '-NoProfile -ExecutionPolicy Bypass -Command ' +
    '"Get-Process -Name python, pythonw -ErrorAction SilentlyContinue | ' +
    'Where-Object { $_.Path -like ''*\Owlette\*'' } | ' +
    'Stop-Process -Force -ErrorAction SilentlyContinue"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Log('Path-based kill returned: ' + IntToStr(ResultCode));

  Log('Killing Python processes that loaded an Owlette DLL...');
  Exec('powershell.exe',
    '-NoProfile -ExecutionPolicy Bypass -Command ' +
    '"Get-Process -Name python, pythonw -ErrorAction SilentlyContinue | ' +
    'Where-Object { try { $_.Modules | Where-Object { $_.FileName -like ''*\Owlette\*'' } } catch { $false } } | ' +
    'Stop-Process -Force -ErrorAction SilentlyContinue"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Log('Module-based kill returned: ' + IntToStr(ResultCode));

  // Poll libcrypto-3.dll for exclusive-write availability instead of a fixed sleep.
  // OpenSSL is loaded by every Owlette Python process (via _ssl / _hashlib) and is
  // typically the last DLL to fully release after process exit — AV scanners often
  // hold its handle for several seconds while inspecting the terminated process.
  // If still locked after 30s, abort cleanly so the user sees a useful message
  // instead of "DeleteFile failed: code 5" mid-copy.
  //
  // Use {commonappdata}\Owlette directly (not {app}) because {app} is not yet
  // initialized inside InitializeSetup. DefaultDirName is {commonappdata}\Owlette,
  // so this resolves to the same path the install will use.
  LibCryptoPath := ExpandConstant('{commonappdata}\Owlette\python\libcrypto-3.dll');
  Log('Polling for unlock: ' + LibCryptoPath);
  Exec('powershell.exe',
    '-NoProfile -ExecutionPolicy Bypass -Command ' +
    '"$p = ''' + LibCryptoPath + '''; ' +
    'if (-not (Test-Path -LiteralPath $p)) { exit 0 }; ' +
    '$deadline = (Get-Date).AddSeconds(30); ' +
    'while ((Get-Date) -lt $deadline) { ' +
      'try { $fs = [System.IO.File]::Open($p, ''Open'', ''Write'', ''None''); $fs.Close(); exit 0 } ' +
      'catch { Start-Sleep -Milliseconds 250 } ' +
    '}; exit 1"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Log('libcrypto-3.dll unlock poll returned: ' + IntToStr(ResultCode));

  if ResultCode <> 0 then
  begin
    Log('libcrypto-3.dll still locked after 30s — aborting to avoid mid-copy failure');
    if not WizardSilent() then
      MsgBox('Cannot upgrade Owlette: a process is still holding' + #13#10 +
             LibCryptoPath + #13#10 + #13#10 +
             'This DLL is loaded by every Owlette Python process. The installer ' +
             'tried to terminate them but the handle was not released within 30 seconds.' + #13#10 + #13#10 +
             'Please reboot the machine and run the installer again.',
             mbError, MB_OK);

    // Service restart on abort is handled by DeinitializeSetup, which fires
    // even when InitializeSetup returns False (Inno Setup contract) and reads
    // ServiceWasStopped + InstallSucceeded. Doing it here too would double-fire.

    Result := False;
    Exit;
  end;
end;
