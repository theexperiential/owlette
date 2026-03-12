# Owlette Agent Architecture Reference

**Last Updated**: 2026-03-12
**Applies To**: `agent/src/` (Python 3.9+ Windows Service)

This document captures the architecture and design decisions of the Owlette agent — a Windows service that monitors processes, syncs with Firebase, and accepts remote commands. Read this before modifying any agent code.

---

## Module Dependency Graph

```
owlette_service.py          Main Windows service (ServiceFramework)
  ├── firebase_client.py    Cloud communication (Firestore REST API)
  │   ├── auth_manager.py   OAuth two-token system (access + refresh)
  │   │   └── secure_storage.py  Encrypted token file (Fernet AES)
  │   ├── firestore_rest_client.py  Firestore REST API wrapper
  │   └── connection_manager.py  State machine, circuit breaker, thread watchdog
  ├── shared_utils.py       Config, logging, system metrics, file paths
  ├── installer_utils.py    Download/execute/cancel remote installers
  ├── project_utils.py      Project directory management
  └── registry_utils.py     Windows registry queries (installed software)

owlette_runner.py           NSSM-compatible runner (bridges NSSM → service main loop)
owlette_gui.py              CustomTkinter configuration GUI (separate process)
owlette_tray.py             System tray icon (separate process, reads IPC status file)
owlette_updater.py          Self-update bootstrap (stop service → download → silent install)
configure_site.py           OAuth registration during installation (localhost:8765 callback)
owlette_scout.py            Process responsiveness checker (sends WM_NULL to window)
cleanup_commands.py          Firestore command queue cleanup
prompt_restart.py           UI prompt when process exceeds relaunch limits
```

---

## Service Lifecycle

### Startup Flow
```
SvcDoRun()
 → initialize logging (RotatingFileHandler → C:\ProgramData\Owlette\logs\service.log)
 → upgrade_config() (schema migration)
 → lazy import FirebaseClient (FIREBASE_AVAILABLE flag, no crash if missing)
 → if firebase enabled + has OAuth tokens → init FirebaseClient + ConnectionManager
 → recover_running_processes() (adopt PIDs from previous session)
 → launch tray icon as user (schtasks)
 → obtain console user token (for process launching)
 → main() loop
```

### Main Loop (10-second interval)
```
while self.is_alive:
  update current_time
  for each configured process:
    handle_process(process)  → launch / monitor / recover
  sleep(SLEEP_INTERVAL=10)
```

### Shutdown Flow
```
SvcStop()
 → self.is_alive = False (breaks main loop)
 → firebase_client.stop() → marks machine offline, stops listeners
 → close all Owlette GUI windows
 → terminate tray icon process
 → write service_status.json (running=false)
 → signal hWaitStop event (allows Windows SCM to proceed)
```

**Key state variables**:
- `self.is_alive` — service running flag
- `self.first_start` — True until first loop completes (affects relaunch counting)
- `self.relaunch_attempts` — dict[process_name → int] tracking restart counts
- `self.last_started` — dict[process_id → {time, pid}] tracking launch times
- `self.results` — dict loaded from app_states.json (persisted PIDs)
- `self.active_installations` — dict tracking deployment processes for cancellation

---

## Process Management

### Process Status Values
- `RUNNING` — confirmed running via psutil
- `STALLED` — detected unresponsive (hung window)
- `KILLED` — manually terminated via dashboard command
- `STOPPED` — process terminated/crashed
- `INACTIVE` — configured but autolaunch disabled

### Two-Stage Process Launch (`launch_process_as_user`)

**Stage 1 — Task Scheduler (preferred)**:
```
schtasks /Create /TN "OwletteProcess_{id}" /TR "{command}" /SC ONCE /ST 00:00 /RU {username}
schtasks /Run /TN "OwletteProcess_{id}"
schtasks /Delete /TN "OwletteProcess_{id}" /F
```
**Why**: Processes launched by Task Scheduler run under svchost.exe, NOT under the NSSM job object. This means they survive service restarts. If launched directly via CreateProcessAsUser, NSSM's job object would kill all child processes when the service stops.

**Stage 2 — CreateProcessAsUser (fallback)**:
Used when schtasks fails (no user logged in, permission issues).
Uses `CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB` flags.

**Hidden window support**: Wraps command in VBScript via `wscript.exe` with `intWindowStyle = 0`.

### Multi-Stage Hang Detection (`handle_unresponsive_process`)

Uses a 3-stage confirmation to prevent false positives from momentary UI hangs:

1. **Stage 1 (0-10s)**: First detection → record `hung_since` timestamp, set status STALLED
2. **Stage 2 (10-15s)**: Still hung → log warning, continue monitoring
3. **Stage 3 (15s+)**: Confirmed hung → kill process and relaunch

Responsiveness is checked by `owlette_scout.py` which runs as a user-space process and sends `WM_NULL` to the process window. Results written to `app_states.json`.

Can be disabled per-process: `check_responsive: false`

### Crash Recovery (`recover_running_processes`)

On service restart:
1. Read app_states.json for PIDs from previous session
2. For each PID: validate it's still running via `psutil.Process(pid)`
3. **Security**: verify `psutil.Process(pid).exe()` matches configured `exe_path` (prevents PID hijacking after reuse)
4. Clean dead PIDs from state file
5. Adopt valid processes (skip launch, mark RUNNING)

### Relaunch Limits
- Per-process config: `relaunch_attempts` (default: 3, 0 = unlimited)
- Tracked in `self.relaunch_attempts[process_name]`
- When exceeded: launches `prompt_restart.py` (countdown to machine reboot)
- Counter resets after prompt is shown

---

## Firebase Integration Chain

```
FirebaseClient
  ├── AuthManager (token lifecycle)
  │   └── SecureStorage (encrypted persistence)
  ├── FirestoreRestClient (HTTP calls to Firestore)
  └── ConnectionManager (state + reconnection)
```

### FirebaseClient (`firebase_client.py`)

**Constructor**: `FirebaseClient(auth_manager, project_id, site_id, config_cache_path)`

**Data sync cycles**:
- **Presence/heartbeat**: Every 30s → `sites/{siteId}/machines/{machineId}/presence`
- **System metrics**: Every 60s → `sites/{siteId}/machines/{machineId}/status`
- **Config sync**: On change → `config/{siteId}/machines/{machineId}`

**Background threads** (supervised by ConnectionManager):
- `command_listener` — listens to `sites/{siteId}/machines/{machineId}/commands/pending`
- `config_listener` — listens to `config/{siteId}/machines/{machineId}`

**Offline resilience**:
- Config cached to `cache/firebase_cache.json`
- Loaded on connection failure, re-uploaded on reconnect
- Hash-based dedup prevents re-uploading unchanged config

**Key methods**:
- `start()` / `stop()` — lifecycle management
- `register_command_callback(fn)` — service registers command handler
- `register_config_update_callback(fn)` — service registers config handler
- `log_event(action, level, details)` — log events for web dashboard
- `is_connected()` — check connection state

### ConnectionManager (`connection_manager.py`)

**State machine**:
```
DISCONNECTED → CONNECTING → CONNECTED
                    ↑           ↓
                 RECONNECTING ← (error)
                    ↓
                 BACKOFF → (wait) → RECONNECTING

Any state → FATAL_ERROR (unrecoverable: machine removed, auth permanently revoked)
```

**Exponential backoff**: base=30s, max=3600s, formula: `min(current * 2, MAX)`, jitter: 50-100% (prevents thundering herd from multiple agents reconnecting simultaneously)

**Circuit breaker**: Opens after 5 consecutive failures, tests recovery after 5 minutes

**Thread supervision**: Watchdog checks every 10s, auto-restarts dead listener threads on next successful connection

**Key methods**:
- `connect()` / `disconnect()` — control state
- `report_error(exception, context)` — any component reports failures here
- `report_success()` — resets failure counters
- `register_thread(name, factory)` — register supervised thread
- `start_watchdog()` — enable thread health checks
- `add_state_listener(callback)` — subscribe to state changes
- `force_reconnect()` — bypass backoff for immediate retry

### OAuth Two-Token System (`auth_manager.py`)

**Tokens**:
- **Access token**: 1-hour Firebase custom token for Firestore REST API
- **Refresh token**: 30-day token to obtain new access tokens

**Auto-refresh**: 5 minutes before expiry (`TOKEN_REFRESH_BUFFER_SECONDS = 300`)

**Flow**: `get_valid_token()` → check cached → if expired → `POST /api/agent/auth/refresh` → cache new token

**Error handling**:
- 401/403: Clear tokens, require re-registration
- 429: Rate limited → backoff
- Network errors: Transient, retry with exponential backoff

**Exceptions**: `AuthenticationError` (fatal), `TokenRefreshError` (retriable)

### Encrypted Token Storage (`secure_storage.py`)

**File**: `C:\ProgramData\Owlette\.tokens.enc` (hidden file)

**Encryption**: Fernet symmetric (AES-128-CBC + HMAC-SHA256)

**Key derivation**:
```python
key_material = f"{machine_guid}:{hostname}:owlette-agent"
key = base64url(SHA256(key_material))
```
Machine GUID from Windows registry (`HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid`).

**Stored data**: `{refresh_token, access_token, token_expiry, site_id}`

**Access**: Readable by both regular users and SYSTEM (C:\ProgramData is shared).

---

## Command Handling

Commands arrive via Firestore listener on `commands/pending/{commandId}`.

### Supported Commands

| Command | Data Fields | Behavior |
|---------|-------------|----------|
| `restart_process` | `process_name` | Kill running process + relaunch |
| `kill_process` | `process_name` | Terminate via `psutil.Process(pid).terminate()` |
| `toggle_autolaunch` | `process_name`, `autolaunch` | Update config, affects next cycle |
| `update_config` | `config` (full object) | Replace local config, preserve firebase section |
| `install_software` | `installer_url`, `silent_flags`, `timeout_seconds`, `sha256_checksum`, `deployment_id` | Download + execute installer |

### Config Update Preservation

**Critical rule**: The `firebase` section of config.json is NEVER overwritten by remote config updates. This prevents authentication loss.

Flow:
1. Read current config → extract firebase section
2. Write new config from Firestore
3. Restore original firebase section
4. Hash-based dedup prevents listener feedback loops (config change → upload → listener fires → ignored because hash matches)

---

## IPC: Service ↔ Tray Icon

**Mechanism**: Status file written by service, read by tray icon.

**Path**: `C:\ProgramData\Owlette\tmp\service_status.json`

**Written every**: ~10 seconds by service main loop

**Structure**:
```json
{
  "service": { "running": true, "last_update": 1234567890, "version": "2.0.54" },
  "firebase": { "enabled": true, "connected": true, "site_id": "...", "last_heartbeat": 1234567890 }
}
```

**Tray icon colors**:
- White: Service running + Firebase connected
- Orange: Service running + Firebase disconnected/issues
- Red: Service stopped or Firebase disabled

**Stale detection**: If file is >120s old → red (service likely crashed)

---

## Critical Maintenance Rules

### Do's
- Always preserve `firebase` config section during config updates
- Use atomic file writes (.tmp → rename) for config changes
- Validate PID ownership (exe_path match) during recovery
- Report all errors to ConnectionManager (centralized handling)
- Use `shared_utils.read_json_from_file()` with null checks for all JSON reads
- Test token refresh error paths (critical for 30-day token expiry)

### Don'ts
- Never log OAuth tokens (even in DEBUG mode) — sanitize in auth_manager.py
- Never write credentials to config.json (tokens go to .tokens.enc only)
- Never modify the firebase section during remote config updates
- Never skip PID validation in `recover_running_processes()`
- Never use blocking operations in the 10-second main loop
- Never spawn reconnection logic outside ConnectionManager (it's the single source of truth)

### Debugging
- Service logs: `C:\ProgramData\Owlette\logs\service.log`
- Tray logs: `C:\ProgramData\Owlette\logs\tray.log`
- GUI logs: `C:\ProgramData\Owlette\logs\gui.log`
- Status file: `C:\ProgramData\Owlette\tmp\service_status.json`
- Config: `C:\ProgramData\Owlette\config\config.json`
- Debug mode: `cd agent\src && python owlette_service.py debug` (admin prompt)
