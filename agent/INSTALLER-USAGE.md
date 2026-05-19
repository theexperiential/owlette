# Owlette Installer Usage Guide

## Basic Installation

Double-click the installer and follow the prompts:

```bash
Owlette-Installer-v2.0.0.exe
```

This will install Owlette configured for the **development environment** (dev.owlette.app) by default.

## Environment Selection

### Command-Line Flags

The installer supports switching between development and production environments using the `/SERVER` flag:

#### Development Environment (Default)
```bash
Owlette-Installer-v2.0.0.exe /SERVER=dev
```
- Connects to: `https://dev.owlette.app`
- Use for testing, development, and staging

#### Production Environment
```bash
Owlette-Installer-v2.0.0.exe /SERVER=prod
```
- Connects to: `https://owlette.app`
- Use for production deployments

### How It Works

1. The `/SERVER` parameter is passed to the Inno Setup installer
2. Installer translates it to the appropriate setup URL:
   - `dev` → `https://dev.owlette.app/setup`
   - `prod` → `https://owlette.app/setup`
3. The URL is passed to `configure_site.py` during installation
4. Browser opens to the specified environment for OAuth configuration

## Silent Installation

For automated deployments, combine with standard Inno Setup silent flags:

```bash
# Silent install for development
Owlette-Installer-v2.0.0.exe /SILENT /SERVER=dev

# Silent install for production
Owlette-Installer-v2.0.0.exe /SILENT /SERVER=prod

# Very silent (no progress window)
Owlette-Installer-v2.0.0.exe /VERYSILENT /SERVER=prod
```

**Note:** Silent installation will still require Firebase credentials to be configured manually after installation.

## Installation Process

1. **Administrator Privileges Check**
   - Installer verifies admin rights (required for Windows service installation)

2. **Existing Installation Cleanup**
   - Stops any running Owlette processes
   - Prepares for service installation

3. **File Extraction**
   - Copies Python runtime, Owlette Agent code, tools, and configurations to `C:\ProgramData\Owlette`

4. **Site Configuration (OAuth)**
   - Opens browser to specified environment (dev/prod)
   - User logs in and selects/creates a site
   - **Automatic OAuth token exchange:**
     - Web backend generates registration code
     - Agent exchanges code for access + refresh tokens
     - Tokens stored securely in Windows Credential Manager
     - Site ID and configuration saved to `config.json`
   - **No manual credential downloads required!**

5. **Service Installation**
   - Installs Owlette as a Windows service using NSSM
   - Configures service to start automatically
   - Starts the service
   - Agent automatically authenticates using stored OAuth tokens

6. **Shortcuts Creation**
   - Start Menu shortcuts for GUI and tray icon
   - Startup folder shortcut for tray icon (auto-starts on login)

## Post-Installation

### Firebase Integration

**Firebase integration is automatic!** The installer OAuth flow handles all authentication:

✅ **Automatic:**
- OAuth tokens (access + refresh)
- Windows Credential Manager storage (encrypted)
- Automatic token refresh (when access token expires)
- Site assignment and permissions

❌ **No longer needed:**
- Manual Firebase credential downloads
- Service account JSON files
- Manual configuration steps

### Authentication Details

**Where tokens are stored:**
- Location: Windows Credential Manager
- Encryption: Machine + user specific (DPAPI)
- Access: Only the logged-in user on this machine

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

If the OAuth callback server fails to start:
1. Check for other processes using port 8765
2. Close conflicting applications
3. Re-run the installer

### Browser Doesn't Open

If browser doesn't open automatically during setup:
1. Manually navigate to the URL shown in the installer
2. Complete the OAuth flow
3. Installation will continue automatically

### Service Won't Start

Check logs at `C:\ProgramData\Owlette\agent\logs\` for error messages.

Common issues:
- Missing Firebase credentials (non-fatal, service runs in local-only mode)
- Python dependencies missing (re-run installer)
- Port conflicts (check firewall settings)

## Advanced Options

### Custom Installation Directory

The installer uses `C:\ProgramData\Owlette` by default. To change:
```bash
Owlette-Installer-v2.0.0.exe /DIR="D:\CustomPath\Owlette"
```

### Skip OAuth Configuration

Not recommended, but you can manually edit `config.json` after installation to configure the site_id.

## Developer Notes

### Testing Different Environments

During development, you can test both environments:

```bash
# Test dev environment
Owlette-Installer-v2.0.0.exe /SERVER=dev

# Uninstall
C:\ProgramData\Owlette\unins000.exe

# Test prod environment
Owlette-Installer-v2.0.0.exe /SERVER=prod
```

### Manual Configuration Override

The `configure_site.py` script also accepts `--url` directly:

```bash
python configure_site.py --url https://localhost:3000/setup
```

This is useful for local web development.

## Version History

- **2.1.0** - OAuth custom token authentication (eliminated service accounts)
  - Automatic OAuth flow during installation
  - Tokens stored in Windows Credential Manager
  - No manual credential downloads required
  - Token revocation via web dashboard

- **2.0.0** - Initial release with dev/prod environment support
