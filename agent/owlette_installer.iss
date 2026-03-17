; Owlette Installer Script for Inno Setup
; ============================================================================
; This script creates a professional Windows installer for Owlette
; Requires: Inno Setup 6.x (https://jrsoftware.org/isinfo.php)
; ============================================================================
;
; AUTHENTICATION:
; ---------------
; This installer uses OAuth custom token authentication (no service accounts).
; During installation, the user is prompted to authenticate via their browser.
; The agent receives OAuth tokens which are encrypted and stored in
; C:\ProgramData\Owlette\.tokens.enc (machine-specific encryption key).
;
; OAUTH FLOW:
; -----------
; 1. Installer runs configure_site.py (opens browser to owlette.app/setup)
; 2. User logs in and selects/creates a site
; 3. Web backend generates registration code (single-use, 24h expiry)
; 4. Browser sends callback to http://localhost:8765 with site_id + code
; 5. configure_site.py exchanges code for access token + refresh token
; 6. Tokens encrypted and stored in C:\ProgramData\Owlette\.tokens.enc (not in config files)
; 7. Agent uses tokens to authenticate with Firestore REST API
;
; SECURITY:
; ---------
; - No service accounts required (eliminated firebase-credentials.json)
; - Tokens are user-scoped (tied to user's account)
; - Tokens can be revoked via web dashboard ("Remove Machine" button)
; - Access token: 1 hour expiry (auto-refreshes)
; - Refresh token: 30 days expiry (stored encrypted)
;
; BUILD PARAMETERS:
; -----------------
; /SERVER=dev   → Uses dev.owlette.app (default)
; /SERVER=prod  → Uses owlette.app (production)
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
    #define MyAppVersion "2.0.3"
    #pragma message "WARNING: Using fallback version 2.0.3 - VERSION file not found or OWLETTE_VERSION not set"
  #endif
#endif

#define MyAppName "Owlette"
#define MyAppPublisher "Owlette Project"
#define MyAppURL "https://github.com/yourusername/owlette"
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
DefaultDirName=C:\{#MyAppName}
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

; README and documentation
Source: "README.md"; DestDir: "{app}"; Flags: ignoreversion isreadme
Source: "..\LICENSE"; DestDir: "{app}"; Flags: ignoreversion

[Dirs]
; Create ProgramData directories (proper location for Windows service data)
Name: "{commonappdata}\Owlette"; Permissions: users-modify
Name: "{commonappdata}\Owlette\config"; Permissions: users-modify
Name: "{commonappdata}\Owlette\logs"; Permissions: users-modify
Name: "{commonappdata}\Owlette\cache"; Permissions: users-modify
Name: "{commonappdata}\Owlette\tmp"; Permissions: users-modify

[Icons]
; Start Menu shortcuts (now pointing to ProgramData for user data)
Name: "{group}\Owlette Configuration"; Filename: "{app}\scripts\launch_gui.bat"; IconFilename: "{app}\agent\icons\normal.png"; WorkingDir: "{app}"
Name: "{group}\Owlette Tray Icon"; Filename: "{app}\scripts\launch_tray.bat"; IconFilename: "{app}\agent\icons\normal.png"; WorkingDir: "{app}"
Name: "{group}\View Logs"; Filename: "{commonappdata}\Owlette\logs"; IconFilename: "{sys}\shell32.dll"; IconIndex: 4
Name: "{group}\Edit Configuration"; Filename: "{commonappdata}\Owlette\config\config.json"; IconFilename: "{sys}\shell32.dll"; IconIndex: 70
Name: "{group}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"

; Startup shortcut (always installed - important for monitoring UX)
Name: "{userstartup}\Owlette Tray"; Filename: "{app}\scripts\launch_tray.bat"; IconFilename: "{app}\agent\icons\normal.png"; WorkingDir: "{app}"

[Run]
; Step 0: Add Windows Defender exclusion for Owlette directory
; This prevents false positive alerts for the WinRing0 driver used by LibreHardwareMonitor
; WinRing0 is flagged as VulnerableDriver:WinNT/Winring0 but is required for CPU/GPU temperature monitoring
; Only exclude the specific library directories that contain flagged drivers, not the entire app
Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -Command ""Add-MpPreference -ExclusionPath '{app}\python\Lib\site-packages\wintmp' -ErrorAction SilentlyContinue; Add-MpPreference -ExclusionPath '{app}\python\Lib\site-packages\LibreHardwareMonitor' -ErrorAction SilentlyContinue"""; StatusMsg: "Configuring Windows Defender exclusion..."; Flags: runhidden waituntilterminated

; Step 1: Configure site (browser-based OAuth flow) - RUNS FIRST
; Pass server URL based on /SERVER= command-line parameter
; Usage: Owlette-Installer-v2.0.0.exe              (uses owlette.app, default)
;        Owlette-Installer-v2.0.0.exe /SERVER=prod (uses owlette.app)
;        Owlette-Installer-v2.0.0.exe /SERVER=dev  (uses dev.owlette.app for testing)
;
; IMPORTANT: Skip configuration in silent mode if config already exists (for self-updates)
; This prevents the installer from hanging while waiting for browser OAuth that won't happen
Filename: "{app}\python\python.exe"; Parameters: """{app}\agent\src\configure_site.py"" --url ""{code:GetServerEnvironment}"""; Description: "Configure Owlette site"; StatusMsg: "Opening browser for site configuration..."; Flags: waituntilterminated; Check: ShouldConfigureSite

; Step 2: Install and start the Windows service - RUNS SECOND (only after configuration completes)
Filename: "{app}\scripts\install.bat"; Parameters: "--silent"; Description: "Install Owlette service"; StatusMsg: "Installing Owlette service..."; Flags: runhidden waituntilterminated

; Note: Tray icon launches automatically on login via startup folder (see [Icons] section above)
; No need to launch it here - it will start on next login or can be launched manually from Start Menu

[UninstallRun]
; Stop and remove the Windows service before uninstalling
Filename: "{app}\tools\nssm.exe"; Parameters: "stop OwletteService"; Flags: runhidden waituntilterminated
Filename: "{app}\tools\nssm.exe"; Parameters: "remove OwletteService confirm"; Flags: runhidden waituntilterminated
; Remove Windows Defender exclusions
Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -Command ""Remove-MpPreference -ExclusionPath '{app}\python\Lib\site-packages\wintmp' -ErrorAction SilentlyContinue; Remove-MpPreference -ExclusionPath '{app}\python\Lib\site-packages\LibreHardwareMonitor' -ErrorAction SilentlyContinue"""; Flags: runhidden waituntilterminated

[Code]
var
  ConfigBackupPath: String;
  DidUninstallExisting: Boolean;
  DidRunOAuth: Boolean;  // Track if we ran OAuth configuration

function GetServerEnvironment(Param: String): String;
var
  ServerParam: String;
begin
  // Get SERVER parameter from command line (e.g., /SERVER=prod or /SERVER=dev)
  ServerParam := ExpandConstant('{param:SERVER|prod}');  // Default to 'prod'

  if ServerParam = 'dev' then
    Result := 'https://dev.owlette.app/setup'
  else
    Result := 'https://owlette.app/setup';  // Default to production

  Log('Server environment: ' + ServerParam + ' -> ' + Result);
end;

function ShouldConfigureSite(): Boolean;
var
  ConfigPath: String;
begin
  // Check if config already exists (self-update scenario)
  ConfigPath := ExpandConstant('{commonappdata}\Owlette\config\config.json');

  // If running in silent mode AND config exists, skip configuration
  // (machine is already set up - this is a self-update)
  if WizardSilent() and FileExists(ConfigPath) then
  begin
    Log('Silent mode + config exists - skipping OAuth (self-update)');
    DidRunOAuth := False;
    Result := False;
  end
  else
  begin
    Log('Will run OAuth configuration (fresh install or interactive)');
    DidRunOAuth := True;  // Track that OAuth will run
    Result := True;
  end;
end;

procedure BackupConfigIfExists;
var
  ConfigPath: String;
begin
  // Check ProgramData location (proper location for config)
  ConfigPath := ExpandConstant('{commonappdata}\Owlette\config\config.json');

  // Fallback: Check old location if ProgramData doesn't exist
  if not FileExists(ConfigPath) then
    ConfigPath := ExpandConstant('{app}\agent\config\config.json');

  if FileExists(ConfigPath) then
  begin
    ConfigBackupPath := ExpandConstant('{tmp}\config.json.backup');
    FileCopy(ConfigPath, ConfigBackupPath, False);
    Log('Backed up config from: ' + ConfigPath);
  end;
end;

procedure RestoreConfigIfBackedUp;
var
  ConfigPath: String;
begin
  // CRITICAL: NEVER restore backup if OAuth just ran
  // OAuth creates a fresh config with firebase authentication - we must preserve it!
  if DidRunOAuth then
  begin
    Log('OAuth ran - SKIPPING config restore to preserve fresh authentication');
    Exit;
  end;

  // IMPORTANT: DO NOT restore config during silent mode (self-updates)
  // The service will sync processes/settings from Firestore automatically
  if WizardSilent() then
  begin
    Log('Silent mode - SKIPPING config restore (service will sync from Firestore)');
    Exit;
  end;

  // For interactive upgrades without OAuth: restore the old config to preserve processes and Firebase settings
  // This ensures "Leave Site" (enabled=false) is preserved across upgrades
  if ConfigBackupPath <> '' then
  begin
    if FileExists(ConfigBackupPath) then
    begin
      ConfigPath := ExpandConstant('{commonappdata}\Owlette\config\config.json');
      FileCopy(ConfigBackupPath, ConfigPath, False);
      Log('Restored config from backup to preserve settings (interactive upgrade without OAuth)');
    end;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssInstall then
  begin
    // Backup config before installation
    BackupConfigIfExists;
  end
  else if CurStep = ssPostInstall then
  begin
    // Restore config after installation
    RestoreConfigIfBackedUp;
    Log('Owlette installation completed successfully');
    Log('User data stored in: ' + ExpandConstant('{commonappdata}\Owlette'));
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
    // Clean up installation directory including runtime-generated files (.pyc, __pycache__)
    InstallDir := ExpandConstant('{app}');
    if DirExists(InstallDir) then
    begin
      Log('Removing installation directory and runtime files: ' + InstallDir);
      if DelTree(InstallDir, True, True, True) then
        Log('Installation directory removed successfully')
      else
        Log('Warning: Some files in installation directory could not be removed');
    end;

    // Ask user if they want to remove configuration and logs from ProgramData
    // In silent mode, always preserve data (for upgrades)
    DataDir := ExpandConstant('{commonappdata}\Owlette');
    if DirExists(DataDir) then
    begin
      // Silent uninstall (triggered by upgrade) → preserve data automatically
      // Interactive uninstall → ask user
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
          Log('Removed user data from: ' + DataDir)
        else
          Log('Failed to remove user data from: ' + DataDir);
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
  UninstallExe: String;
begin
  Result := True;
  DidUninstallExisting := False;  // Initialize flag
  DidRunOAuth := False;  // Initialize OAuth tracking flag

  // Check if running as admin
  if not IsAdmin then
  begin
    Log('ERROR: Not running as administrator');
    // Only show error dialog in interactive mode
    if not WizardSilent() then
      MsgBox('This installer requires administrator privileges to install the Windows service.' + #13#10 +
             'Please right-click the installer and select "Run as administrator".',
             mbError, MB_OK);
    Result := False;
    Exit;
  end;

  // Check for existing installation
  if RegQueryStringValue(HKEY_LOCAL_MACHINE, 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{A7B8C9D0-E1F2-4A5B-8C9D-0E1F2A3B4C5D}_is1', 'UninstallString', UninstallString) then
  begin
    // In silent mode, automatically proceed with uninstall without user confirmation
    // In interactive mode, ask user for confirmation
    if WizardSilent() or
       (MsgBox('An existing Owlette installation was detected.' + #13#10#13#10 +
               'Your configuration can be preserved, but the installer needs to uninstall the old version first.' + #13#10#13#10 +
               'Click OK to uninstall and continue, or Cancel to exit.',
               mbConfirmation, MB_OKCANCEL) = IDOK) then
    begin
      if WizardSilent() then
        Log('Proceeding with uninstall (Silent mode - auto-confirmed)')
      else
        Log('Proceeding with uninstall (Interactive mode - user confirmed)');
      // Extract the uninstaller path (remove /SILENT flag if present)
      UninstallExe := RemoveQuotes(UninstallString);

      // Stop the service first (if NSSM exists)
      if FileExists('C:\Owlette\tools\nssm.exe') then
      begin
        Exec('C:\Owlette\tools\nssm.exe', 'stop OwletteService', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
        Sleep(2000);
      end;

      // Run uninstaller very silently (no dialogs at all)
      if Exec(UninstallExe, '/VERYSILENT /NORESTART /SUPPRESSMSGBOXES', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
      begin
        Log('Previous installation uninstalled successfully');
        DidUninstallExisting := True;  // Track that we handled uninstall
        Sleep(3000);  // Give Windows time to clean up
      end
      else
      begin
        Log('ERROR: Failed to uninstall the existing version');
        // Only show error dialog in interactive mode
        if not WizardSilent() then
          MsgBox('Failed to uninstall the existing version. Please uninstall manually and try again.', mbError, MB_OK);
        Result := False;
        Exit;
      end;
    end
    else
    begin
      Result := False;
      Exit;
    end;
  end;

  // Silently close any running Owlette processes if we didn't just uninstall
  // (uninstall already stopped the service and closed processes)
  if not DidUninstallExisting then
  begin
    Log('Closing any running Owlette processes (fresh install path)');
    // Try to close GUI and tray icon processes silently
    Exec('taskkill', '/F /IM pythonw.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec('taskkill', '/F /IM python.exe /FI "WINDOWTITLE eq OWLETTE*"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);

    // Wait a moment for processes to close
    Sleep(2000);
  end
  else
  begin
    Log('Skipping process cleanup (already handled by uninstaller during upgrade)');
  end;
end;
