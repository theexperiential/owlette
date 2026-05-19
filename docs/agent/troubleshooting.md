# agent troubleshooting

Common issues and how to resolve them.

---

## log locations

| log | path | contents |
|-----|------|----------|
| **Service** | `C:\ProgramData\Owlette\logs\service.log` | Main service operations, Firebase sync, command execution |
| **Service stdout** | `C:\ProgramData\Owlette\logs\service_stdout.log` | NSSM-captured stdout from the service runner |
| **Service stderr** | `C:\ProgramData\Owlette\logs\service_stderr.log` | NSSM-captured stderr from the service runner |
| **GUI** | `C:\ProgramData\Owlette\logs\gui.log` | Configuration GUI operations |
| **Tray** | `C:\ProgramData\Owlette\logs\tray.log` | System tray icon operations |
| **Pairing** | `C:\ProgramData\Owlette\logs\pairing_debug.log` | Device-code pairing and token setup |
| **Self-update installer** | `C:\ProgramData\Owlette\logs\installer_update.log` | Inno Setup log written during remote agent updates |
| **Interactive installer** | Path passed with `/LOG=...` | Inno Setup log for manual installs; no fixed ProgramData installer log is written by default |

Logs use rotating file handlers: 10 MB per file, 5 backups. Old logs are auto-deleted after 90 days by default.

---

## debug mode

Run the service in debug mode to see real-time console output:

```bash
cd C:\ProgramData\Owlette\agent\src
python owlette_service.py debug
```

!!! warning "Requires Administrator"
    Debug mode must be run from an elevated command prompt.

---

## common issues

### agent won't start

**Symptoms**: Service fails to start, or starts and immediately stops.

**Check**:

1. Run in debug mode to see the error:
    ```bash
    cd C:\ProgramData\Owlette\agent\src
    python owlette_service.py debug
    ```
2. Check `service.log` for startup errors.
3. Verify Python is installed: `C:\ProgramData\Owlette\python\python.exe --version`.
4. Verify `C:\ProgramData\Owlette\config\config.json` is valid JSON.

**Common causes**:

- Corrupt `config.json`: repair it, or move it aside and re-run pairing so the agent can create a fresh config.
- Missing packaged files or Python dependencies: repair or reinstall the agent.
- Broken service registration after a failed upgrade: rerun the packaged repair flow or reinstall the service.

---

### agent shows offline in dashboard

**Symptoms**: Machine shows offline (red/grey) despite the service running.

**Check**:

1. Verify service is running: `sc query OwletteService`.
2. Check `service.log` for Firebase connection errors.
3. Verify internet connectivity.
4. Check firewall rules for outbound HTTPS (port 443) to the configured API host (`owlette.app` or `dev.owlette.app`) and Firebase services.
5. Verify `firebase.site_id` in `C:\ProgramData\Owlette\config\config.json`.

**Common causes**:

- **No internet**: The agent keeps running locally but cannot update Firestore.
- **OAuth token expired**: Check for token refresh errors in `service.log`; the agent should auto-refresh when the stored refresh token is valid.
- **Wrong site_id**: The config is paired to a different dashboard site.
- **Firebase disabled**: Check `firebase.enabled` is `true` in `config.json`.
- **Heartbeat has not refreshed yet**: Presence and metrics use an adaptive interval: about 5 seconds with the GUI open, 30 seconds when monitored processes are active, and 120 seconds when idle.

---

### "agent not authenticated" error

**Symptoms**: Log shows "Agent not authenticated - no refresh token found".

**Cause**: The agent's stored OAuth tokens are missing or corrupt.

**Fix**:

1. Delete the token file and re-pair:
    ```cmd
    del C:\ProgramData\Owlette\.tokens.enc
    ```
2. Run the pairing flow:
    ```cmd
    C:\ProgramData\Owlette\python\python.exe C:\ProgramData\Owlette\agent\src\configure_site.py
    ```
3. At `open browser on this machine? [y/N]`, choose `y` to open the local browser, or press Enter and enter the pairing phrase from another device.
4. Wait for authorization to complete, then restart the service.

If pairing fails before authorization completes, check `C:\ProgramData\Owlette\logs\pairing_debug.log`.

---

### processes not auto-restarting

**Symptoms**: Configured processes crash but are not restarted.

**Check**:

1. Verify `launch_mode` is `always`, or `scheduled` with the current time inside a configured schedule window.
2. Check if the `relaunch_attempts` limit has been reached. The counter resets on manual restart.
3. Verify the `exe_path` exists and is correct.
4. Check `service.log` for launch errors.
5. Check `time_delay` and `time_to_init` if restarts are delayed after a failure.

**Common causes**:

- **Executable not found**: Process shows as INACTIVE.
- **Relaunch limit reached**: The reboot prompt should have appeared.
- **Permission error**: Service may not have access to the executable path.
- **Task Scheduler issues**: The agent falls back to CreateProcessAsUser when possible.

When the executable is missing, the service logs `process_launch_failed` and sends an `exe_missing` alert with suggested sibling paths when it can find likely replacements. The dashboard toast can open the process edit dialog with a suggested path pre-filled.

---

### connectionmanager states

The agent's connection to Firestore follows a state machine. Check `service.log` for the current state:

| state | meaning | action |
|-------|---------|--------|
| `DISCONNECTED` | No connection, not trying | Will attempt on next cycle |
| `CONNECTING` | Actively establishing connection | Wait |
| `CONNECTED` | Online and syncing | Normal operation |
| `RECONNECTING` | Lost connection, retrying | Automatic retry |
| `BACKOFF` | Too many failures, waiting | Exponential backoff, up to 1 hour |
| `FATAL_ERROR` | Unrecoverable auth or site-access error | Re-pair the machine or restore site access |

If stuck in `BACKOFF`:

1. Check internet connectivity.
2. Verify Firebase project is accessible.
3. Wait for the automatic retry. Circuit-breaker recovery probes run after about 5 minutes, and repeated failures can stretch retry backoff up to 1 hour.

---

### high cpu/memory usage

**Symptoms**: The owlette service itself uses excessive resources.

**Normal usage**: ~20-50 MB RAM, <1% CPU.

**If excessive**:

1. Check if debug logging is enabled.
2. Look for rapid reconnection loops in `service.log`.
3. Verify no circular config updates; hash tracking should prevent feedback loops.
4. Check whether the GUI is open. Metrics and heartbeat uploads run about every 5 seconds while the GUI is active, 30 seconds while processes are active, and 120 seconds when idle.

---

### gui won't open

**Symptoms**: Clicking "Open GUI" from tray does nothing, or GUI crashes immediately.

**Check**:

1. Look at `gui.log` for errors.
2. Verify GUI file exists: `C:\ProgramData\Owlette\agent\src\owlette_gui.py`.
3. Try launching manually:
    ```bash
    "C:\ProgramData\Owlette\python\pythonw.exe" "C:\ProgramData\Owlette\agent\src\owlette_gui.py"
    ```
4. Check for CustomTkinter import errors.

---

### tray status looks stale

**Symptoms**: The tray status does not match the service or Firebase state.

**Check**:

1. Confirm `OwletteService` is running.
2. Inspect `C:\ProgramData\Owlette\tmp\service_status.json`.
3. Check `C:\ProgramData\Owlette\tmp\status_writer.log` for status-file write decisions.

The service writes `service_status.json` immediately when important state changes and otherwise uses a 30-second refresh floor with content-change throttling. The status file has nested `service`, `firebase`, and `health` sections.

---

### remote install or update fails

**Symptoms**: A dashboard deployment fails before the installer runs, or an agent self-update does not complete.

**Check**:

1. Check `service.log` for the command result.
2. For self-updates, check `C:\ProgramData\Owlette\logs\installer_update.log`.
3. Check whether `C:\ProgramData\Owlette\logs\update_in_progress.json` exists after a failed self-update.
4. Verify the installer URL is reachable from the target machine.

**Common causes**:

- **Missing `sha256_checksum`**: `install_software` refuses to run remote installers without this 64-character SHA-256 checksum.
- **Missing `checksum_sha256`**: `update_owlette` refuses to self-update without this checksum field.
- **Missing `target_version`**: The agent can infer a version from the installer filename, but the command should send `target_version` explicitly.
- **No interactive user session**: Third-party installers run in the user's desktop session; a user must be logged in.
- **Wrong silent flags or verify path**: The installer may complete but fail post-install verification.

---

### windows defender blocking

**Symptoms**: Agent files quarantined, service won't start after update.

**Cause**: WinRing0 driver used by LibreHardwareMonitor for CPU/GPU temperatures may be flagged.

**Fix**: The installer should add targeted Defender exclusions automatically. If it did not, add the same scoped exclusions manually from an elevated PowerShell prompt:

```powershell
Add-MpPreference -ExclusionPath "C:\ProgramData\Owlette\python\Lib\site-packages\WinTmp"
Add-MpPreference -ExclusionProcess "C:\ProgramData\Owlette\python\python.exe"
Add-MpPreference -ExclusionProcess "C:\ProgramData\Owlette\python\pythonw.exe"
```

Use a broader `C:\ProgramData\Owlette` exclusion only as a temporary diagnostic step after reviewing the security tradeoff.

---

## service management commands

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

---

## getting help

- Email us at [support@owlette.app](mailto:support@owlette.app)
- File a bug or feature request on [GitHub](https://github.com/theexperiential/owlette/issues)
