# WS5: Process Launch Mode System (Scheduling Overhaul)

**Priority:** 5 | **Effort:** High | **Round:** 4 | **Branch:** `dev`

## Status
- [x] Agent: `is_within_schedule()` utility in `shared_utils.py`
- [x] Agent: Config migration `autolaunch` → `launch_mode` in `upgrade_config()`
- [x] Agent: Replace all `autolaunch` checks with `launch_mode` logic in `owlette_service.py`
- [x] Agent: Schedule enforcement in monitoring loop (start/stop by schedule)
- [x] Agent: Manual override tracking (in-memory)
- [x] Agent GUI: Replace `CTkSwitch` with `CTkOptionMenu` (Off/Always On/Scheduled)
- [x] Web: `ScheduleEditor.tsx` reusable component (day pills + time ranges + blocks)
- [x] Web: Segmented mode buttons on MachineCardView + MachineListView
- [ ] Web: Schedule summary inline display
- [x] Web: ProcessDialog mode selector + schedule editor integration
- [x] Web: `setLaunchMode()` in useFirestore replacing `toggleAutolaunch()`
- [ ] Web: Manual start confirmation dialog (outside schedule)
- [x] Web: `set_launch_mode` MCP tool replacing `toggle_autolaunch`
- [x] Web: `page.tsx` handler updates
- [x] Backward compat: `autolaunch` field still written alongside `launch_mode`
- [x] Docs: Update agent-architecture, codebase-map, firebase-integration, backend-dev-guidelines
- [ ] Testing: All 13 verification items (see bottom of doc)

## Context

Replacing the binary `autolaunch: boolean` toggle with a **3-mode launch system**: Off, Always On, and Scheduled. This is a major overhaul touching the agent monitoring loop, config schema, web dashboard UI, agent GUI, and MCP tools.

**Current state:** `autolaunch: boolean` — either always on or always off.
**New state:** `launch_mode: 'off' | 'always' | 'scheduled'` with flexible multi-block schedules.

---

## The 3-Mode System

| Mode | Behavior | Replaces |
|------|----------|----------|
| **Off** | Process is not managed. Agent won't launch, relaunch, or monitor it. | `autolaunch: false` |
| **Always On** | Agent keeps the process running 24/7. Auto-relaunches on crash. | `autolaunch: true` |
| **Scheduled** | Agent runs the process during configured time windows only. Auto-stops outside window. Auto-relaunches crashes within window. | New |

---

## Config Schema Change

**Before:**
```json
{
  "name": "MyApp",
  "autolaunch": true
}
```

**After:**
```json
{
  "name": "MyApp",
  "launch_mode": "scheduled",
  "schedules": [
    {
      "days": ["mon", "tue", "wed", "thu", "fri"],
      "ranges": [
        { "start": "08:00", "stop": "12:00" },
        { "start": "13:00", "stop": "17:00" }
      ]
    },
    {
      "days": ["sat"],
      "ranges": [
        { "start": "10:00", "stop": "14:00" }
      ]
    }
  ]
}
```

**Data model:**
- `schedules` is an array of **schedule blocks**
- Each block has `days` (which days it applies to) and `ranges` (time windows within those days)
- A process is "in schedule" if the current day+time matches ANY block's day AND falls within ANY of that block's ranges
- Covers: weekday office hours, weekend half-days, lunch breaks, multiple show times, etc.
- Simple case (daily 8-10pm) = one block with all 7 days and one range

**Migration:** `autolaunch: true` → `launch_mode: "always"`, `autolaunch: false` → `launch_mode: "off"`. Handle in `upgrade_config()`. Keep writing `autolaunch` as a derived field for old agents.

---

## Files to Modify

### Agent
| File | Change |
|------|--------|
| `agent/src/shared_utils.py` | Config migration (`autolaunch` → `launch_mode`), `is_within_schedule()` utility, bump CONFIG_VERSION |
| `agent/src/owlette_service.py` | Replace ALL `autolaunch` checks with `launch_mode` logic. Add schedule enforcement in monitoring loop. Modify crash relaunch, config diffing, process recovery, startup launch. Add `manual_overrides` dict. |
| `agent/src/owlette_gui.py` | Replace `CTkSwitch` (autolaunch) with `CTkOptionMenu` (Off/Always On/Scheduled). Show schedule read-only when scheduled. Follow existing `priority_menu`/`visibility_menu` pattern. |

### Web — New Files
| File | Purpose |
|------|---------|
| `web/components/ScheduleEditor.tsx` | Reusable schedule editor modal. Day pills + time ranges + blocks. Designed for reuse (cron jobs, maintenance windows). |

### Web — Modified Files
| File | Change |
|------|--------|
| `web/hooks/useFirestore.ts` | Replace `toggleAutolaunch()` with `setLaunchMode(machineId, processId, processName, mode, schedules?)`. Update Process interface with `launch_mode`, `schedules`, `ScheduleBlock`, `TimeRange` types. |
| `web/app/dashboard/components/MachineCardView.tsx` | Replace autolaunch toggle with segmented mode buttons `[ Off ][ Always On ][ Scheduled ]`. Show schedule summary inline. |
| `web/app/dashboard/components/MachineListView.tsx` | Same as MachineCardView. |
| `web/app/dashboard/components/ProcessDialog.tsx` | Replace autolaunch toggle with mode selector + "Configure schedule" button that opens ScheduleEditor. |
| `web/app/dashboard/page.tsx` | Replace `handleToggleAutolaunch` with `handleSetLaunchMode`. Add manual start confirmation dialog for scheduled processes outside their window. |
| `web/lib/mcp-tools.ts` | Replace `toggle_autolaunch` with `set_launch_mode` tool (mode + schedules params). |

### Docs
| File | Change |
|------|--------|
| `.claude/skills/resources/agent-architecture.md` | Document 3-mode system, schedule check in monitoring loop, manual overrides |
| `.claude/skills/resources/codebase-map.md` | Update component descriptions, add ScheduleEditor |
| `.claude/skills/firebase-integration.md` | Update config schema with `launch_mode`, `schedules` |
| `.claude/skills/backend-dev-guidelines.md` | Document launch_mode patterns |

---

## Implementation Details

### 1. Agent — `shared_utils.py`

**Config migration in `upgrade_config()`:**
```python
for process in config.get('processes', []):
    if 'launch_mode' not in process:
        if process.get('autolaunch', False):
            process['launch_mode'] = 'always'
        else:
            process['launch_mode'] = 'off'
    # Keep autolaunch for backward compat (derived)
    process['autolaunch'] = process['launch_mode'] != 'off'
    if 'schedules' not in process:
        process['schedules'] = None
```

**Schedule utility:**
```python
from datetime import datetime, time
from zoneinfo import ZoneInfo  # Python 3.9+ stdlib

def is_within_schedule(schedules: list, timezone_str: str = None) -> bool:
    """Check if current time is within ANY schedule block's active window."""
    if not schedules:
        return True  # No schedules = always active (safety fallback)

    tz = ZoneInfo(timezone_str) if timezone_str else None
    now = datetime.now(tz)
    day_names = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
    current_day = day_names[now.weekday()]
    current_time = now.time()

    for block in schedules:
        days = block.get('days', day_names)
        if current_day not in days:
            continue
        for time_range in block.get('ranges', []):
            start_h, start_m = map(int, time_range['start'].split(':'))
            stop_h, stop_m = map(int, time_range['stop'].split(':'))
            start = time(start_h, start_m)
            stop = time(stop_h, stop_m)
            if start <= stop:
                if start <= current_time <= stop:
                    return True
            else:  # Overnight (e.g., 22:00 - 06:00)
                if current_time >= start or current_time <= stop:
                    return True
    return False
```

### 2. Agent — `owlette_service.py`

**IMPORTANT:** Read the current state of `owlette_service.py` before making changes. Previous workstreams (WS1, WS3, WS4) have modified this file. Search for ALL occurrences of `autolaunch` and replace with `launch_mode` logic.

**Key locations to modify:**

| Location | Current Logic | New Logic |
|----------|--------------|-----------|
| Startup launch (~line 3054) | `if process.get('autolaunch', False)` | Check `launch_mode`: 'always' → launch, 'scheduled' → check schedule, 'off' → skip |
| Process recovery (~line 618) | `if process.get('autolaunch', False)` | Same mode-aware check |
| Crash relaunch (~line 1506) | `if not fresh_process.get('autolaunch', False)` | Check mode + schedule for 'scheduled' |
| Config diffing (~line 1682) | Compare `old_autolaunch` vs `new_autolaunch` | Compare `old_mode` vs `new_mode`, handle all transitions |
| toggle_autolaunch command (~line 1805) | Sets `autolaunch` boolean | Replace with `set_launch_mode` that sets `launch_mode` + optionally `schedules` |

**New: Schedule enforcement in monitoring loop:**
```python
mode = process.get('launch_mode', 'off')
if mode == 'scheduled':
    schedules = process.get('schedules')
    in_window = is_within_schedule(schedules, self.site_timezone)
    process_id = process.get('id')
    has_override = process_id in self.manual_overrides

    if in_window:
        if has_override:
            del self.manual_overrides[process_id]  # Schedule takes over
        if not process_is_running:
            self.handle_process_launch(process)
    else:
        if process_is_running and not has_override:
            self.kill_process(process)
            self.firebase_client.log_event('process_killed', 'info', process['name'],
                'Stopped by schedule (outside active window)')
```

**New: Manual override tracking:**
```python
# In __init__:
self.manual_overrides = {}  # { process_id: True }

# In _handle_restart_process, when process is scheduled and outside window:
if mode == 'scheduled' and not is_within_schedule(schedules, self.site_timezone):
    self.manual_overrides[process.get('id')] = True
```

**Backward compat:** Always derive and write `autolaunch` from `launch_mode`:
```python
process['autolaunch'] = process.get('launch_mode', 'off') != 'off'
```

### 3. Web — `useFirestore.ts`

**Replace `toggleAutolaunch` with `setLaunchMode`:**
```typescript
const setLaunchMode = async (
  machineId: string, processId: string, processName: string,
  mode: 'off' | 'always' | 'scheduled',
  schedules?: ScheduleBlock[]
) => {
  // Optimistic UI update (_optimisticLaunchMode)
  // Write to config/{siteId}/machines/{machineId}
  // Set launch_mode, schedules, and autolaunch (derived) on the process
  // Set configChangeFlag for agent notification
};
```

**Types to add:**
```typescript
interface ScheduleBlock { days: string[]; ranges: TimeRange[]; }
interface TimeRange { start: string; stop: string; }
// Process interface: add launch_mode?, schedules?, keep autolaunch?
```

### 4. Web — Dashboard UI

**Segmented mode buttons (MachineCardView + MachineListView):**

Replace `Switch` + "autolaunch" label with:
```
[ Off ][ Always On ][ Scheduled ]
```
- Off → gray, Always On → green/emerald, Scheduled → blue
- Plain `<button>` elements in a flex container with `rounded-lg overflow-hidden`
- When Scheduled is active, show schedule summary next to it with Clock icon
- Clicking schedule summary opens ScheduleEditor modal

**Schedule summary format:**
- Simple: `"8:00 AM – 10:00 PM · daily"`
- Multi-block: `"weekdays 8 AM–5 PM, Sat 10 AM–2 PM"`
- Smart days: 7 days → "daily", Mon-Fri → "weekdays", Sat-Sun → "weekends"

**Process status:** Show `"scheduled off"` (blue badge) instead of `"inactive"` when outside schedule window.

**Manual start confirmation:** When restarting a scheduled process outside its window, show dialog: "This process is outside its schedule. Start it anyway? It will be stopped when the schedule resumes."

### 5. ScheduleEditor Component

**New file: `web/components/ScheduleEditor.tsx`**

Reusable modal for editing schedules. Props: `schedules: ScheduleBlock[]`, `onChange`, `timezone?`.

**Layout per schedule block:**
- Day pills: [M] [T] [W] [T] [F] [S] [S] — toggle on/off
- Time ranges: `<input type="time">` pairs, with [+ range] button to add more
- Delete block button
- [+ Add schedule block] button at bottom

**Validation:** At least one day per block, at least one range per block, start < stop (unless overnight).

### 6. Agent GUI — `owlette_gui.py`

Replace `CTkSwitch` with `CTkOptionMenu`:
```python
self.launch_mode_menu = ctk.CTkOptionMenu(
    master=self.master,
    values=["Off", "Always On", "Scheduled"],
    command=self.on_launch_mode_change
)
```
When Scheduled: show read-only schedule text below. Schedule editing is web-only.

### 7. MCP Tools — `mcp-tools.ts`

Replace `toggle_autolaunch` with `set_launch_mode`:
- Parameters: `process_name`, `mode` (off/always/scheduled), `schedules` (array of blocks)
- Tier 2 (auto-approved)
- Examples: "set lobby to weekdays 8am-10pm", "turn off MyApp", "keep signage 24/7"

---

## Edge Cases

| Case | Behavior |
|------|----------|
| Overnight schedule (22:00–06:00) | `is_within_schedule` handles via `start > stop` |
| Empty days list | Treat as all days (defensive default) |
| Manual start outside schedule | Confirmation dialog → manual_override in agent memory → clears when schedule window opens |
| Schedule change while running | Next 10s loop applies new schedule |
| Mode change always→scheduled | If outside window, stops on next check |
| DST transition | `zoneinfo` handles automatically |
| Old agent, new dashboard | Reads `autolaunch` (still written) |
| New agent, old config | `upgrade_config()` migrates |

---

## Verification

1. **Mode: Off** — process doesn't launch, doesn't relaunch on crash
2. **Mode: Always On** — 24/7 launch + crash recovery (existing behavior)
3. **Mode: Scheduled** — launches in window, stops outside, crash recovery in window only
4. **Overnight schedule** — 22:00–06:00 works across midnight
5. **Day filtering** — exclude today → process doesn't run
6. **Config migration** — `autolaunch: true` upgrades to `launch_mode: "always"`
7. **MCP** — "set MyApp to scheduled 9am-5pm weekdays" updates config
8. **API** — `/api/admin/machines/status` shows schedule fields
9. **Inline display** — schedule summary on process rows in card + list views
10. **Backward compat** — `autolaunch` still written for old agents
11. **Manual override** — start outside schedule → stays running → auto-stops when window opens
12. **Agent GUI** — dropdown shows correct mode, schedule displayed read-only
13. **Segmented buttons** — render correctly in both card and list views
