# Workstream 5: Process Scheduling

**Priority:** 5 | **Effort:** Medium | **Round:** 4 (last — touches core loop) | **Branch:** `dev`

## Goal
Per-process daily start/stop times so installations can run on a schedule (e.g., 8am–10pm for museums, retail, offices). Integrated into the existing 10-second monitoring loop — no separate scheduler.

## Status
- [ ] Agent: `is_within_schedule()` utility in `shared_utils.py`
- [ ] Agent: Schedule check in process monitoring loop
- [ ] Agent: Schedule-triggered start/stop with event logging
- [ ] Agent: Manual override support (user starts process outside schedule)
- [ ] Agent: Overnight schedule support (crosses midnight)
- [ ] Web UI: Schedule fields in process config editor
- [ ] Web UI: Visual indicator on process card ("Scheduled: 8am–10pm")
- [ ] Config: Schema addition with backward compatibility
- [ ] Testing: Schedule start/stop
- [ ] Testing: Overnight schedule
- [ ] Testing: Day filtering
- [ ] Testing: Manual override
- [ ] Testing: Timezone handling

## Context

### What Already Exists
- **Process monitoring loop:** `owlette_service.py` runs a 10-second loop checking all processes. This is where schedule logic should be injected.
- **Process config:** Each process has `name`, `exe_path`, `file_path`, `autolaunch`, `time_delay`, `time_to_init`, `relaunch_attempts`, `priority`, `visibility`, `responsive_check`.
- **Config sync:** Config changes pushed from web dashboard sync to agent via Firestore listener. No restart needed — the listener updates the config and the next loop iteration picks it up.
- **Site settings:** Sites have timezone configuration. Use this as the default for schedule timezone.
- **Config upgrade:** `shared_utils.py` has `upgrade_config()` that handles schema migrations (adds missing fields with defaults).
- **Event logging:** `log_event()` already logs process starts and stops.

### Files to Modify
| File | Change |
|------|--------|
| `agent/src/owlette_service.py` | Add schedule check before process relaunch/monitoring logic |
| `agent/src/shared_utils.py` | Add `is_within_schedule()` function + schedule schema to config upgrade |
| `web/components/ProcessEditor.tsx` (or equivalent) | Add schedule toggle, time pickers, day checkboxes |
| `web/hooks/useFirestore.ts` | Include schedule fields in config read/write |

### Config Schema Addition
```json
{
  "processes": [
    {
      "name": "MyApp",
      "exe_path": "C:/path/to/app.exe",
      "autolaunch": true,
      "schedule": {
        "enabled": false,
        "start_time": "08:00",
        "stop_time": "22:00",
        "days": ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
      }
    }
  ]
}
```

**Notes:**
- `schedule` defaults to `None`/missing (backward compatible — no schedule = always on)
- `enabled: false` means schedule is configured but inactive (toggle without losing settings)
- `days` uses lowercase 3-letter abbreviations
- Timezone comes from site settings, NOT per-process (keep it simple)
- No `timezone` field on schedule — use site-level timezone

### Implementation Details

**`shared_utils.py` — Schedule checking:**
```python
from datetime import datetime, time
import zoneinfo  # Python 3.9+ stdlib

def is_within_schedule(schedule: dict, site_timezone: str = None) -> bool:
    """
    Check if current time falls within the process schedule.

    Args:
        schedule: { enabled, start_time, stop_time, days }
        site_timezone: IANA timezone string (e.g., "America/New_York")

    Returns:
        True if process should be running now.
    """
    if not schedule or not schedule.get('enabled'):
        return True  # No schedule or disabled = always active

    # Get current time in site timezone
    tz = zoneinfo.ZoneInfo(site_timezone) if site_timezone else None
    now = datetime.now(tz)

    # Check day of week
    day_map = {'mon': 0, 'tue': 1, 'wed': 2, 'thu': 3, 'fri': 4, 'sat': 5, 'sun': 6}
    active_days = [day_map[d] for d in schedule.get('days', []) if d in day_map]

    if active_days and now.weekday() not in active_days:
        return False  # Not an active day

    # Parse start and stop times
    start_h, start_m = map(int, schedule['start_time'].split(':'))
    stop_h, stop_m = map(int, schedule['stop_time'].split(':'))
    start = time(start_h, start_m)
    stop = time(stop_h, stop_m)
    current = now.time()

    if start <= stop:
        # Normal schedule (e.g., 08:00 - 22:00)
        return start <= current <= stop
    else:
        # Overnight schedule (e.g., 22:00 - 06:00)
        return current >= start or current <= stop
```

**`owlette_service.py` — Integration into monitoring loop:**

Find the main process check loop (where it iterates processes and decides whether to relaunch). Before the relaunch decision, add:

```python
# Check schedule
process_config = self._get_process_config(process_name)
schedule = process_config.get('schedule')

if schedule and schedule.get('enabled'):
    site_tz = self._get_site_timezone()  # From config or Firestore
    in_schedule = is_within_schedule(schedule, site_tz)

    if not in_schedule:
        # Outside schedule window
        if process.status == 'RUNNING' and not process.get('manual_override'):
            # Stop the process (schedule says it should be off)
            self._kill_process(process)
            self.firebase_client.log_event(
                'process_killed', 'info', process.name,
                f'Stopped by schedule (outside {schedule["start_time"]}-{schedule["stop_time"]})'
            )
        continue  # Skip relaunch logic
    else:
        # Inside schedule window — clear manual override if set
        if process.get('manual_override'):
            process['manual_override'] = False
```

**Manual override logic:**
- If a user manually starts a process outside its schedule (via dashboard "Start" button), set `manual_override: True` on the process in memory
- While `manual_override` is True, don't auto-stop the process even if outside schedule
- Clear `manual_override` when the schedule window starts OR when the user explicitly stops the process
- `manual_override` is in-memory only (not persisted to config) — resets on service restart, which is correct behavior

**Config upgrade (`shared_utils.py`):**
Add to `upgrade_config()`:
```python
# v2.2.0: Add schedule to processes
for process in config.get('processes', []):
    if 'schedule' not in process:
        process['schedule'] = None  # No schedule by default
```

**Web UI — Process Editor:**
- Add collapsible "Schedule" section below existing process config fields
- Toggle: "Enable schedule" (default: off)
- When enabled, show:
  - Start time picker (HH:MM, 24-hour format)
  - Stop time picker (HH:MM, 24-hour format)
  - Day checkboxes: Mon Tue Wed Thu Fri Sat Sun (all checked by default)
  - Timezone display (read-only, from site settings): "Times are in [site timezone]"
- Visual indicator on process card/row: small clock icon + "8:00 AM – 10:00 PM" text when schedule is active
- If process is currently outside its schedule, show status as "Scheduled off" instead of "Stopped"

### Edge Cases
1. **Overnight schedule (22:00 – 06:00):** The `is_within_schedule` function handles this with the `start > stop` check — returns True if current time is >= start OR <= stop.

2. **Empty days list:** If no days are selected, treat as "all days" (backward compat and prevents accidental "never run").

3. **Schedule + autolaunch interaction:**
   - `autolaunch: true` + schedule → schedule controls when process runs
   - `autolaunch: false` + schedule → schedule takes priority during active window (launch if within schedule), but don't launch outside window
   - `autolaunch: false` + no schedule → process is fully manual (current behavior)

4. **Service restart during scheduled off period:** On restart, process won't be running. If within schedule, agent launches it. If outside schedule, agent leaves it stopped. Correct behavior.

5. **Config change during operation:** If schedule is added/modified while process is running, the next loop iteration (10 seconds) picks up the change. No restart needed.

6. **DST transitions:** `zoneinfo` handles DST automatically. During "fall back" (duplicate hour), process may run an extra hour. During "spring forward" (skipped hour), process may start an hour late. Both are acceptable — not worth over-engineering.

### Key Considerations
- **No separate scheduler thread.** Integrate into the existing 10-second loop.
- **`zoneinfo` is Python 3.9+ stdlib** — no new dependency needed.
- **Site timezone is the only timezone source.** Don't add per-process timezone — it's complexity for no real benefit.
- **Schedule is optional and backward-compatible.** Missing or null `schedule` field = always active (current behavior).
- **Log schedule-triggered starts and stops** so the activity log shows why a process started/stopped.
- **The web process editor component:** Find the actual component name by searching for where process config is edited in the web UI. It might be `ProcessEditor`, `ProcessConfig`, `EditProcessDialog`, or embedded in `MachineCard`.

### Testing Plan
1. Set schedule with `start_time` 1 minute from now → verify process launches when time arrives
2. Set schedule with `stop_time` 1 minute from now → verify process stops when time arrives
3. Set overnight schedule (22:00 – 06:00) → verify process runs during those hours
4. Uncheck today's day → verify process doesn't run today
5. Manually start a process outside its schedule → verify it keeps running (manual override)
6. Wait for schedule window to start → verify manual override clears
7. Set schedule on a process that's currently running outside the window → verify it stops within 10 seconds
8. Test timezone: set site timezone to UTC+5, verify schedule respects that timezone
9. Remove schedule (set to null) → verify process returns to normal always-on behavior
10. Verify config upgrade: old config without schedule field → still works correctly
