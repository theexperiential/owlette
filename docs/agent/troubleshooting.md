# Agent Troubleshooting

Common issues and how to resolve them.

---

## Log Locations

| Log | Path | Contents |
|-----|------|----------|
| **Service** | `C:\ProgramData\owlette\logs\service.log` | Main service operations, Firebase sync, command execution |
| **GUI** | `C:\ProgramData\owlette\logs\gui.log` | Configuration GUI operations |
| **Tray** | `C:\ProgramData\owlette\logs\tray.log` | System tray icon operations |
| **Installer** | `C:\ProgramData\owlette\logs\setup.log` | Installation/setup logging |

Logs use rotating file handlers: 10 MB per file, 5 backups. Old logs are auto-deleted after 90 days (configurable).

---

## Debug Mode

Run the service in debug mode to see real-time console output:

```bash
cd C:\ProgramData\owlette\agent\src
python owlette_service.py debug
```

!!! warning "Requires Administrator"
    Debug mode must be run from an elevated command prompt.

---

## Common Issues

### Agent Won't Start

**Symptoms**: Service fails to start, or starts and immediately stops.

**Check**:

1. Run in debug mode to see the error:
    ```bash
    cd C:\ProgramData\owlette\agent\src
    python owlette_service.py debug
    ```
2. Check `service.log` for startup errors
3. Verify Python is installed: `C:\ProgramData\owlette\python\python.exe --version`
4. Verify config.json is valid JSON

**Common causes**:

- Corrupt `config.json` — delete it and restart (a new default will be created)
- Missing Python dependencies — reinstall the agent
- Port conflict — another instance may be running

---

### Agent Shows Offline in Dashboard

**Symptoms**: Machine shows offline (red/grey) despite the service running.

**Check**:

1. Verify service is running: `sc query OwletteService`
2. Check `service.log` for Firebase connection errors
3. Verify internet connectivity
4. Check firewall rules for outbound HTTPS (port 443)

**Common causes**:

- **No internet** — Agent works offline but can't update Firestore
- **OAuth token expired** — Check for "Token expired" in logs. Agent should auto-refresh.
- **Wrong site_id** — Verify `firebase.site_id` in config.json matches your dashboard site
- **Firebase disabled** — Check `firebase.enabled` is `true` in config.json

---

### "Agent not authenticated" Error

**Symptoms**: Log shows "Agent not authenticated - no refresh token found"

**Cause**: The agent's stored OAuth tokens are missing or corrupt.

**Fix**:

1. Delete the token file and re-pair:
    ```
    del C:\ProgramData\owlette\.tokens.enc
    ```
2. Run the pairing flow:
    ```
    C:\ProgramData\owlette\python\python.exe C:\ProgramData\owlette\agent\src\configure_site.py
    ```
3. Authorize on the web page that opens, then restart the service

---

### Processes Not Auto-Restarting

**Symptoms**: Configured processes crash but aren't restarted.

**Check**:

1. Verify `autolaunch` is `true` for the process
2. Check if `relaunch_attempts` limit has been reached (counter resets on manual restart)
3. Verify the `exe_path` exists and is correct
4. Check `service.log` for launch errors

**Common causes**:

- **Executable not found** — Process shows as INACTIVE
- **Relaunch limit reached** — The reboot prompt should have appeared
- **Permission error** — Service may not have access to the executable path
- **Task Scheduler issues** — Fallback to CreateProcessAsUser

---

### ConnectionManager States

The agent's connection to Firestore follows a state machine. Check `service.log` for the current state:

| State | Meaning | Action |
|-------|---------|--------|
| `DISCONNECTED` | No connection, not trying | Will attempt on next cycle |
| `CONNECTING` | Actively establishing connection | Wait |
| `CONNECTED` | Online and syncing | Normal operation |
| `RECONNECTING` | Lost connection, retrying | Automatic retry |
| `BACKOFF` | Too many failures, waiting | Exponential backoff (up to 5 min) |

If stuck in `BACKOFF`:

1. Check internet connectivity
2. Verify Firebase project is accessible
3. The agent will automatically retry — backoff resets after a successful connection

---

### High CPU/Memory Usage

**Symptoms**: The owlette service itself uses excessive resources.

**Normal usage**: ~20-50 MB RAM, <1% CPU

**If excessive**:

1. Check if debug logging is enabled (generates more I/O)
2. Look for rapid reconnection loops in `service.log`
3. Verify no circular config updates (MD5 hash tracking should prevent this)

---

### GUI Won't Open

**Symptoms**: Clicking "Open GUI" from tray does nothing, or GUI crashes immediately.

**Check**:

1. Look at `gui.log` for errors
2. Verify GUI file exists: `C:\ProgramData\owlette\agent\src\owlette_gui.py`
3. Try launching manually:
    ```bash
    "C:\ProgramData\owlette\python\pythonw.exe" "C:\ProgramData\owlette\agent\src\owlette_gui.py"
    ```
4. Check for CustomTkinter import errors (missing dependency)

---

### Windows Defender Blocking

**Symptoms**: Agent files quarantined, service won't start after update.

**Cause**: WinRing0 driver (used by LibreHardwareMonitor for CPU/GPU temps) may be flagged.

**Fix**: The installer should add a Defender exclusion automatically. If it didn't:

```powershell
Add-MpPreference -ExclusionPath "C:\ProgramData\owlette"
```

---

## Service Management Commands

```bash
# Check service status
sc query OwletteService

# Start service
net start OwletteService

# Stop service
net stop OwletteService

# Restart service
net stop OwletteService && net start OwletteService

# View service configuration
sc qc OwletteService
```

All commands require **Administrator** privileges.
