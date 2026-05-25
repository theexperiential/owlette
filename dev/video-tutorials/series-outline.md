# Owlette tutorial series — outline

Layperson-facing. **Excludes** the REST API, CLI, and SDK (developer surfaces — those
audiences don't need video).

Two batches: **core essentials** (1–8, ship first) and **power features** (9–13).
Each episode is one discrete capability, 2–10 minutes, demonstrating real value.

The `scenario` column is the `seedScreenshotFixtures(...)` fixture the web-capture
harness seeds before recording (defined in `web/e2e/screenshots/fixtures.ts`). Native
episodes are captured with pywinauto/OBS on the fresh demo machine.

---

## Batch 1 — core essentials

| # | Title | ~Time | Capture | Scenario / surface | Viewer can… |
|---|---|---|---|---|---|
| 1 | what is owlette? | 2:00 | web (b-roll) | `dashboard-mixed-states` | explain what owlette does and decide if it fits |
| 2 | install owlette & pair your first machine | 6:00 | native | installer wizard + browser pairing | get the agent running and paired on a fresh machine |
| 3 | the dashboard, end to end | 5:00 | web | `dashboard-mixed-states` | navigate sites, machines, card vs list, panels |
| 4 | keep a process alive | 6:00 | web | `control-process-restarting` | add a process and have it auto-restart on crash |
| 5 | run apps on a schedule | 6:00 | web | `automate-schedule-editor` | launch/stop apps on a days+times schedule |
| 6 | reading machine health | 5:00 | web | `monitor-single-machine` | read metrics, sparklines, thresholds, temps |
| 7 | remote actions: reboot, screenshot, live view | 6:00 | web | `dashboard-mixed-states` | reboot/shutdown, capture screenshots, watch live |
| 8 | the agent on the machine: tray & local gui | 5:00 | native | tray menu + Tkinter GUI | check status and configure processes locally |

## Batch 2 — power features

| # | Title | ~Time | Capture | Scenario / surface | Viewer can… |
|---|---|---|---|---|---|
| 9 | deploy software to many machines | 9:00 | web | `deploy-roost-rolling` | push an installer to a fleet with silent flags + templates |
| 10 | distribute project folders with roost | 9:00 | web | `deploy-roost-rolling` | upload once, sync to targets, roll back a version |
| 11 | team & alerts | 9:00 | web | `automate-schedule-editor` + admin | invite users/roles and set up email alert rules |
| 12 | cortex: manage machines by chat | 8:00 | web | `diagnose-cortex-chat` | ask cortex to diagnose and act, with tier confirmations |
| 13 | logs & troubleshooting | 5:00 | web | `control-process-restarting` | read the event timeline, filter, open crash screenshots |

Optional add-on (only if there's appetite): **display layouts** (`display-layout-editor`
/ `display-storyboard-frame-1..3`) — multi-monitor topology capture + remote re-apply.
It's powerful but niche; hold unless asked.

---

## Per-episode beat sketches

Short bullet sketches the full scripts expand on. Scripts live in `scripts/NN-slug.md`.

### 1 — what is owlette? `[done: 01-what-is-owlette.md]`
Hook (the 3am crash problem) → what owlette is (cloud-connected process mgr for
unattended windows machines) → who it's for (TD installs, signage, kiosks, media
servers) → 20-second tour of the dashboard fleet view → "here's what the rest of the
series covers."

### 2 — install & pair `[done: 02-install-and-pair.md]`
Cold open → run installer (UAC) → what it installs (service via NSSM) → pairing phrase
appears → browser prompts to open (press y), or enter the phrase on another device at owlette.app/add → pick a site → authorize → machine
appears in dashboard within 30s → recap (3 ways to add a machine, silent install teaser).

### 3 — the dashboard, end to end
Orientation (site switcher, quick stats) → machines section card view → card anatomy
(status pill, sparklines, processes, displays) → list view toggle → expand/collapse
controls → clicking a metric opens the detail panel → nav to the other pages (preview).

### 4 — keep a process alive
The promise (your app never stays dead) → open a machine → add process dialog (name,
exe path, launch mode "always on") → save → watch status go LAUNCHING → RUNNING →
simulate a crash → owlette relaunches → relaunch attempts + init timeout explained → edit
to tweak init timeout.

### 5 — run apps on a schedule
Why schedule (museum hours, show times) → set launch mode "scheduled" → schedule editor
(days + time ranges, overnight windows) → save → reuse a schedule preset → what the
agent does outside the window.

### 6 — reading machine health
Card metrics at a glance → color thresholds (emerald→red) and temperature bands → click
a metric → detail panel → per-device tabs (each disk/gpu/nic) → switch machines in the
panel → what "offline / stale heartbeat" looks like.

### 7 — remote actions
Machine actions menu → screenshot (and history browser) → live view stream → reboot
with countdown → cancel a pending reboot → shutdown → mute alerts → who can do what
(admin/superadmin gating).

### 8 — the agent on the machine
The tray icon (a dot in a circle) → right-click menu (service + firebase status, open gui,
restart service) → open the local gui → process list + details panel → add/edit/save a
process locally → how local config syncs to cloud → restart service.

### 9 — deploy software to many machines
New deployment → pick a template (blank / system preset / saved) → installer url +
silent flags → options (parallel, close running) → select targets → deploy
→ per-machine progress → retry a failed install → save as a template.

### 10 — distribute project folders with roost
What roost is (content-addressed sync, immutable versions) → new roost → upload folder
(chunked in browser) → extract path → select targets → upload & distribute → per-target
status → publish a new version → roll back → re-sync a recovered machine.

### 11 — team & alerts
Admin panel (superadmin) → assign a self-registered user's role + sites → email alerts: machine
offline, process crash, threshold rules (metric/operator/severity/cooldown) → test
email delivery → personal alert prefs + muting + CC recipients.

### 12 — cortex
What cortex is + one-time setup (provider + model + key) → pick a machine or "all
machines" → ask a read-only question (which machines look unhealthy) → a tier-2 action
(restart touchdesigner) → a tier-3 action (reboot) with the confirmation gate → reading
tool calls inline.

### 13 — logs & troubleshooting
The event timeline → filters (action type, machine, level, date range) → expand an
entry → crash screenshot attached to a crash event → clear logs → mapping a symptom to
the right log → where to go next (tray status, restart service).

---

## Why this order

Each episode only assumes the ones before it. 2 gets a machine online; 3 orients the
viewer; 4–7 are the daily-driver loop (keep alive → schedule → monitor → act); 8 closes
the local-machine story. Batch 2 is opt-in depth — a viewer who only watches 1–8 can
already run owlette productively.
