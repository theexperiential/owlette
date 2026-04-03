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

| Menu Item | Description |
|-----------|-------------|
| **Service: Running/Stopped** | Current service status (read-only) |
| **Firebase: Connected/Disconnected** | Current cloud connection status (read-only) |
| **Open GUI** | Launch the configuration GUI |
| **Restart Service** | Stop and restart the OwletteService |
| **Exit** | Stop the tray icon process |

---

## ipc communication

The tray icon communicates with the service through an **IPC status file**:

```
C:\ProgramData\Owlette\tmp\service_status.json
```

The service writes status updates to this file, and the tray reads it periodically (every 60 seconds) to display current state.

### status file contents

```json
{
  "service_running": true,
  "firebase_connected": true,
  "firebase_state": "CONNECTED",
  "site_id": "my-site",
  "machine_id": "DESKTOP-ABC123",
  "agent_version": "2.3.1",
  "health": {
    "status": "healthy",
    "last_check": "2026-03-24T10:00:00",
    "details": {}
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
