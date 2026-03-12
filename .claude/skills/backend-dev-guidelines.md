# Backend Development Guidelines

**Version**: 2.0.0
**Last Updated**: 2026-03-12
**Applies To**: Owlette Python Agent (`agent/` directory)

---

## Tech Stack

- **Language**: Python 3.9+ (type hints encouraged)
- **Platform**: Windows Service via NSSM (not pywin32 ServiceFramework directly)
- **Cloud**: Firestore REST API (`firestore_rest_client.py`) — NOT Firebase Admin SDK
- **Auth**: OAuth two-token system (access + refresh) with Fernet AES encrypted storage
- **Process Management**: psutil, pywin32, Task Scheduler (schtasks)
- **GUI**: CustomTkinter (`owlette_gui.py`)
- **System Tray**: pystray (`owlette_tray.py`)
- **Build**: Inno Setup with embedded Python 3.11 + NSSM (not PyInstaller)

---

## Module Map (21 files in `agent/src/`)

### Core Service
| Module | Purpose |
|--------|---------|
| `owlette_service.py` | Main Windows service — process monitoring loop (10s interval), command handling, crash recovery |
| `owlette_runner.py` | NSSM-compatible bridge — translates NSSM console signals to service lifecycle |
| `shared_utils.py` | Config loading, logging, system metrics, file paths, atomic JSON writes |

### Firebase Chain
| Module | Purpose |
|--------|---------|
| `firebase_client.py` | Cloud communication — presence/heartbeat (30s), metrics (60s), config sync, command listener |
| `firestore_rest_client.py` | Low-level Firestore REST API wrapper (GET/POST/PATCH/DELETE) |
| `connection_manager.py` | State machine (6 states), circuit breaker, exponential backoff, thread supervision watchdog |
| `auth_manager.py` | OAuth two-token system — access token (1h) + refresh token (30d), auto-refresh 5min before expiry |
| `secure_storage.py` | Fernet AES encrypted token file (`.tokens.enc`), machine-specific key derivation |

### Process Utilities
| Module | Purpose |
|--------|---------|
| `owlette_scout.py` | Process responsiveness checker — sends WM_NULL to window handles |
| `prompt_restart.py` | UI prompt when process exceeds relaunch limits (countdown to reboot) |

### User-Facing
| Module | Purpose |
|--------|---------|
| `owlette_gui.py` | CustomTkinter configuration GUI (separate process) |
| `owlette_tray.py` | System tray icon — reads `service_status.json` for status colors |

### Installation & Updates
| Module | Purpose |
|--------|---------|
| `configure_site.py` | OAuth registration during install — localhost:8765 callback server |
| `owlette_updater.py` | Self-update bootstrap — stop service → download → silent install → verify |
| `installer_utils.py` | Download/execute/cancel remote installers (deployment system) |

### Utilities
| Module | Purpose |
|--------|---------|
| `project_utils.py` | Project directory management |
| `registry_utils.py` | Windows registry queries (installed software list) |
| `cleanup_commands.py` | Firestore command queue cleanup |

> **Full architecture details**: See `skills/resources/agent-architecture.md`
> **Build system details**: See `skills/resources/installer-build-system.md`

---

## Development Patterns

### Adding a New Command

1. Add command name to the handler in `owlette_service.py` → `handle_command()`
2. Implement the handler method on the service class
3. Commands arrive via Firestore listener as `{command, data, timestamp}`
4. Always move command to `completed` collection after handling
5. Log the action via `firebase_client.log_event()`

Existing commands: `restart_process`, `kill_process`, `toggle_autolaunch`, `update_config`, `install_software`

### Modifying Process Handling

- Process states: `RUNNING`, `STALLED`, `KILLED`, `STOPPED`, `INACTIVE`
- Main loop in `handle_process()` runs every 10s per configured process
- Two-stage launch: Task Scheduler first (escapes NSSM job object), CreateProcessAsUser fallback
- Hang detection: 3-stage confirmation (0-10s watch → 10-15s confirm → 15s+ kill)
- Crash recovery: `recover_running_processes()` validates PIDs against `exe_path` on startup

### Changing Config Schema

1. Update `upgrade_config()` in `owlette_service.py` for migration
2. Use atomic writes: write to `.tmp` file → `os.replace()` to final path
3. **NEVER modify the `firebase` section** during remote config updates
4. Hash-based dedup prevents listener feedback loops

### Error Handling

- **All Firebase/network errors** → report to `ConnectionManager.report_error()`
- **JSON file reads** → use `shared_utils.read_json_from_file()` with null checks
- **Config writes** → atomic writes via `.tmp` → rename pattern
- **Process operations** → wrap in try/except, log via `shared_utils` logger
- **Token errors** → `AuthenticationError` (fatal, clear tokens) vs `TokenRefreshError` (retriable)

---

## Critical Rules

### Do
- Report all errors to ConnectionManager (centralized state + reconnection)
- Validate PID ownership (`psutil.Process(pid).exe()` vs configured `exe_path`) during recovery
- Use atomic file writes for config changes
- Test with `python owlette_service.py debug` (requires admin prompt)
- Preserve `firebase` config section during any config update

### Don't
- Never log OAuth tokens (even in DEBUG mode)
- Never write credentials to config.json (tokens go to `.tokens.enc` only)
- Never skip PID validation in `recover_running_processes()`
- Never use blocking operations in the 10-second main loop
- Never spawn reconnection logic outside ConnectionManager

---

## File Paths (Production)

| Path | Purpose |
|------|---------|
| `C:\Owlette\` | Installation directory (agent code, Python, NSSM) |
| `C:\ProgramData\Owlette\config\config.json` | Runtime configuration |
| `C:\ProgramData\Owlette\logs\service.log` | Service logs (rotating) |
| `C:\ProgramData\Owlette\logs\tray.log` | Tray icon logs |
| `C:\ProgramData\Owlette\logs\gui.log` | GUI logs |
| `C:\ProgramData\Owlette\.tokens.enc` | Encrypted OAuth tokens |
| `C:\ProgramData\Owlette\cache\firebase_cache.json` | Offline config cache |
| `C:\ProgramData\Owlette\tmp\service_status.json` | IPC status file (service → tray) |
| `C:\ProgramData\Owlette\tmp\app_states.json` | Persisted PIDs for crash recovery |

---

## Build Commands

```bash
# Full build (first time, downloads Python + NSSM, ~5-10 min)
cd agent
build_installer_full.bat

# Quick build (development, copies + compiles only, ~30 sec)
cd agent
build_installer_quick.bat

# Debug mode (requires admin prompt)
cd agent/src
python owlette_service.py debug
```

> See `skills/resources/installer-build-system.md` for complete build pipeline documentation.
