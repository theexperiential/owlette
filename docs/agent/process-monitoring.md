# Process Monitoring

The agent monitors configured processes every 10 seconds, detecting crashes, stalls, and exits. When a process goes down, the agent automatically restarts it (if autolaunch is enabled).

---

## Process State Machine

Every configured process is in one of five states:

```
                    ┌──────────┐
          launch    │ RUNNING  │  crash/exit
         ┌────────▶│          │──────────┐
         │         └──────────┘          │
         │              │                ▼
    ┌──────────┐   stall detected  ┌──────────┐
    │ STOPPED  │        │          │ KILLED   │
    │          │        ▼          │          │
    └──────────┘   ┌──────────┐   └──────────┘
         ▲         │ STALLED  │        │
         │         │          │        │ auto-restart
         │         └──────────┘        │ (if autolaunch)
         │              │              │
         │         kill after confirm  │
         └──────────────┘◀─────────────┘
```

### State Definitions

| State | Description | Dashboard Indicator |
|-------|-------------|---------------------|
| **RUNNING** | Process is alive and responsive | Green |
| **STALLED** | Process exists but is not responding (hang detected) | Yellow |
| **KILLED** | Process was terminated (manually or by agent) | Red |
| **STOPPED** | Process is not running, autolaunch disabled | Grey |
| **INACTIVE** | Process is configured but its executable was not found | Grey (dimmed) |

---

## Monitoring Loop

Every 10 seconds, the agent runs through all configured processes:

### 1. Check if Process is Running

The agent validates the process by:

1. **PID check** — Is there a process with the stored PID?
2. **Path verification** — Does the running process match the configured `exe_path`? (prevents PID reuse false positives)
3. **Status update** — Set state to RUNNING or detect crash

### 2. Crash Detection

A process is considered crashed when:

- Its PID no longer exists
- The PID exists but belongs to a different executable (PID was reused by the OS)
- The process exit code indicates abnormal termination

### 3. Hang Detection (Multi-Stage)

The agent uses a progressive approach to detect frozen applications:

| Stage | Time | Action |
|-------|------|--------|
| **Detection** | 0-10s | `owlette_scout.py` sends `WM_NULL` to the process window |
| **Wait** | 10-15s | If no response, wait for possible recovery |
| **Confirmation** | 15s+ | If still unresponsive, mark as STALLED |

`WM_NULL` is a harmless Windows message — if the process responds, it's alive. If it doesn't respond within the timeout, the process is likely hung.

### 4. Auto-Restart

When a crash is detected and `autolaunch` is enabled:

1. Agent increments the **relaunch counter**
2. If under the limit (`relaunch_attempts`), restart the process
3. Wait `launch_delay` seconds before starting
4. Wait `init_time` seconds before monitoring responsiveness
5. If at the limit, show a **reboot prompt** to the user

---

## Process Launch Methods

The agent uses a two-stage launch strategy:

### Primary: Task Scheduler

```
Agent creates one-time scheduled task
    → Task runs under logged-in user account
    → Agent finds the new PID
    → Task is deleted (cleanup)
```

**Advantages**: Processes survive service restarts (not killed by NSSM job objects).

### Fallback: CreateProcessAsUser

If Task Scheduler fails, the agent falls back to `CreateProcessAsUser` via `pywin32`:

```
Agent gets user token (WTSQueryUserToken)
    → CreateProcessAsUser with the token
    → Process runs under user session
```

---

## PID Recovery

When the service restarts, it doesn't re-launch processes that are already running. Instead, it **recovers** existing PIDs:

1. For each configured process, scan running processes for matching `exe_path`
2. If found, adopt the PID — mark as RUNNING without relaunching
3. If not found and autolaunch is enabled, start the process

This prevents duplicate instances after service restarts or crashes.

---

## Relaunch Limits

Each process has a configurable `relaunch_attempts` limit (default: 5). When the limit is reached:

1. The agent stops trying to restart the process
2. A **reboot countdown prompt** appears on screen (`prompt_restart.py`)
3. The user can dismiss the prompt or allow the reboot
4. The relaunch counter resets after a successful process start or manual intervention

!!! tip "Email alerts"
    If email alerts are configured, the agent sends a **process crash alert** email when a process crashes, including the process name, machine name, and error details.

---

## Metrics Collection

Every 60 seconds, the agent collects and reports:

| Metric | Source | Description |
|--------|--------|-------------|
| **CPU** | `psutil.cpu_percent()` | Overall CPU usage percentage |
| **Memory** | `psutil.virtual_memory()` | RAM usage percentage |
| **Disk** | `psutil.disk_usage('/')` | Primary disk usage percentage |
| **GPU** | WinTmp / nvidia-ml-py | GPU usage percentage (if available) |
| **CPU Model** | Registry/psutil | CPU model name (e.g., "Intel Core i9-9900X") |
| **Processes** | Per-process | Status, PID, uptime for each configured process |

GPU monitoring uses:

- **NVIDIA GPUs**: nvidia-ml-py (NVML) for load and temperature
- **Other GPUs**: WinTmp/LibreHardwareMonitor for basic metrics
- **No GPU**: Gracefully returns 0
