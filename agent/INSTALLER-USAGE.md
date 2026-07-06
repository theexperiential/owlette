# Owlette Installer Usage Guide

## Basic Installation

Double-click the installer and follow the prompts:

```bash
Owlette-Installer-v<version>.exe
```

This will install Owlette configured for the **production environment** (owlette.app) by default. Pass `/SERVER=dev` to target the development environment instead.

## Environment Selection

### Command-Line Flags

The installer supports switching between development and production environments using the `/SERVER` flag:

#### Production Environment (Default)
```bash
Owlette-Installer-v<version>.exe /SERVER=prod
```
- Connects to: `https://owlette.app`
- Use for production deployments
- This is the default when `/SERVER` is omitted

#### Development Environment
```bash
Owlette-Installer-v<version>.exe /SERVER=dev
```
- Connects to: `https://dev.owlette.app`
- Use for testing, development, and staging

### How It Works

1. The `/SERVER` parameter is passed to the Inno Setup installer
2. Installer translates it to the appropriate setup URL:
   - `dev` → `https://dev.owlette.app/setup`
   - `prod` → `https://owlette.app/setup`
3. The URL is passed to `configure_site.py` during installation
4. The console prints the pairing URL and starts polling; press Enter only if you want to open the local browser

## Silent Installation

For automated deployments, combine with standard Inno Setup silent flags:

```bash
# Silent install for development with a preauthorized phrase
Owlette-Installer-v<version>.exe /SILENT /SERVER=dev /ADD=silver-compass-drift

# Silent install for production with a preauthorized phrase
Owlette-Installer-v<version>.exe /SILENT /SERVER=prod /ADD=silver-compass-drift

# Very silent (no progress window)
Owlette-Installer-v<version>.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SERVER=prod /ADD=silver-compass-drift
```

**Note:** For unattended installs, pass `/ADD=<phrase>` with a preauthorized pairing phrase from the dashboard. Silent installs without `/ADD=` still need an existing valid config or an operator to complete interactive pairing.

## Installation Process

1. **Administrator Privileges Check**
   - Installer verifies admin rights (required for Windows service installation)

2. **Existing Installation Cleanup**
   - Stops any running Owlette processes
   - Prepares for service installation

3. **File Extraction**
   - Copies Python runtime, Owlette Agent code, tools, and configurations to `C:\ProgramData\Owlette`

4. **Site Configuration**
   - Prints the pairing phrase and authorization URL for the selected environment (dev/prod)
   - User presses Enter to open the browser, or authorizes from another device
   - User logs in and selects/creates a site
   - **Automatic device-code token exchange:**
     - Web backend authorizes the pairing phrase
     - Agent polls until access + refresh tokens are returned
     - Tokens are stored in the encrypted Owlette token file
     - Site ID and configuration saved to `config.json`
   - **No manual credential downloads required!**

5. **Service Installation**
   - Installs Owlette as a Windows service using NSSM
   - Configures service to start automatically
   - Starts the service
   - Agent automatically authenticates using stored device-code tokens

6. **Shortcuts Creation**
   - Start Menu shortcuts for GUI and tray icon
   - Startup folder shortcut for tray icon (auto-starts on login)

## Post-Installation

### Firebase Integration

**Firebase integration is automatic!** The installer device-code flow handles all authentication:

✅ **Automatic:**
- Device-code tokens (access + refresh)
- Encrypted token-file storage
- Automatic token refresh (when access token expires)
- Site assignment and permissions

❌ **No longer needed:**
- Manual Firebase credential downloads
- Service account JSON files
- Manual configuration steps

### Authentication Details

**Where tokens are stored:**
- Location: `C:\ProgramData\Owlette\.tokens.enc`
- Encryption: Machine-bound key
- Access: Local Owlette processes on this machine

**Token lifecycle:**
- Access token: Valid for 1 hour (auto-refreshes)
- Refresh token: Valid for 30 days (stored encrypted)
- Automatic refresh: Agent handles this transparently

**Token revocation:**
- Via web dashboard: "Remove Machine" button
- Immediately revokes agent access
- Agent stops syncing within 1 hour (when access token expires)

### Verify Installation

Check service status:
```bash
sc query OwletteService
```

View logs:
```bash
# Service logs
type C:\ProgramData\Owlette\agent\logs\service_stdout.log
type C:\ProgramData\Owlette\agent\logs\service_stderr.log
```

## Uninstallation

Use Windows Settings → Apps → Owlette → Uninstall

Or from Command Prompt:
```bash
C:\ProgramData\Owlette\unins000.exe
```

The uninstaller will:
- Stop and remove the Windows service
- Delete installation files
- Remove shortcuts
- Preserve config and logs (optional to delete manually)

## Troubleshooting

### Port 8765 Already in Use

If pairing cannot reach the server:
1. Check outbound HTTPS access to `owlette.app` or `dev.owlette.app`
2. Confirm the pairing phrase has not expired
3. Re-run the installer or `configure_site.py`

### Browser Doesn't Open

The installer no longer opens a browser automatically during setup:
1. Press Enter in the pairing console to open the local browser, or manually navigate to the URL shown in the installer
2. Complete the pairing flow
3. Installation will continue automatically

### Service Won't Start

Check logs at `C:\ProgramData\Owlette\agent\logs\` for error messages.

Common issues:
- Missing or expired pairing tokens
- Python dependencies missing (re-run installer)
- Port conflicts (check firewall settings)

## Advanced Options

### Custom Installation Directory

The installer uses `C:\ProgramData\Owlette` by default. To change:
```bash
Owlette-Installer-v<version>.exe /DIR="D:\CustomPath\Owlette"
```

### Skip Pairing

Not recommended. The agent needs encrypted tokens from the pairing flow; editing `config.json` alone is not enough to connect to a site.

## Developer Notes

### Testing Different Environments

During development, you can test both environments:

```bash
# Test dev environment
Owlette-Installer-v<version>.exe /SERVER=dev

# Uninstall
C:\ProgramData\Owlette\unins000.exe

# Test prod environment
Owlette-Installer-v<version>.exe /SERVER=prod
```

### Manual Configuration Override

The `configure_site.py` script also accepts `--url` directly:

```bash
python configure_site.py --url https://localhost:3000/setup
```

This is useful for local web development.

## Version History

- **2.1.0** - Legacy browser-based custom token authentication (eliminated service accounts)
  - Browser handoff during installation
  - Tokens stored in the then-current Windows encrypted store
  - No manual credential downloads required
  - Token revocation via web dashboard

- **2.0.0** - Initial release with dev/prod environment support
