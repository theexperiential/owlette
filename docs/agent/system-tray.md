# system tray

The owlette system tray icon provides at-a-glance status and quick access to common actions. It runs as a separate process from the service, using `pystray` for the tray icon and `owlette_tray.py` for logic.

---

## tray icon

The tray icon appears in the Windows notification area (system tray). It uses a HAL 9000-inspired owl eye design:

- **Connected**: Icon is visible and responsive
- **Disconnected**: Icon may show different state

The icon is pure white with a grey background, designed for visibility in both light and dark Windows themes.

---

## right-click menu

Right-clicking the tray icon shows:

| menu item | description |
|-----------|-------------|
| **Service: Running/Stopped** | Current service status (read-only) |
| **Firebase: Connected/Disconnected** | Current cloud connection status (read-only) |
| **Open GUI** | Launch the configuration GUI |
| **Restart Service** | Stop and restart the OwletteService |
| **Exit** | Stop the Owlette service (triggers a UAC prompt). Also closes the GUI and the tray icon. |

---

## ipc communication

The tray icon communicates with the service through an **IPC status file**:

```
C:\ProgramData\Owlette\tmp\service_status.json
```

The service attempts status updates from its main loop, but writes are throttled. It updates the file when service, Firebase, or health state changes, when the service is shutting down, or when unchanged content has reached the 30-second refresh floor. Unchanged content inside that floor is skipped.

### status file contents

```json
{
  "service": {
    "running": true,
    "last_update": 1777053600,
    "version": "2.3.1"
  },
  "firebase": {
    "enabled": true,
    "connected": true,
    "site_id": "my-site",
    "last_heartbeat": 1777053595
  },
  "health": {
    "status": "ok",
    "error_code": null,
    "error_message": null,
    "checked_at": 1777053580,
    "probe_results": {
      "config_readable": true,
      "firebase_section_present": true,
      "token_store_accessible": true,
      "network_reachable": true
    }
  }
}
```

---

## launching the tray

The service launches the tray icon automatically during startup using the logged-in user's session:

1. Service detects the active user session via `WTSQueryUserToken`
2. Launches `owlette_tray.py` under the user's account (so the icon appears in their tray)
3. Uses the embedded Python interpreter at `C:\ProgramData\Owlette\python\pythonw.exe`

The tray process is independent — if it crashes, the service continues running. The service re-launches the tray on its next status check if it's not running.
