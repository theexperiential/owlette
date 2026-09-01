---
number: 5
slug: keep-a-process-alive
title: keep a process alive
est_duration: "6:00"
capture: web
scenario: control-process-restarting
voice: null
model: eleven_v3
---

# episode 5 — keep a process alive

> After this you can add a process to a machine and have owlette automatically restart it whenever it crashes.

## [b01] the promise
**SCREEN:** the "td-control-room" card with touchdesigner in its process list.
**VOICEOVER:**
this is the heart of owlette. you tell it which app must always be running, and it makes
sure it is — relaunching it the moment it crashes, even at 3am with nobody on site. let's
set one up.

## [b02] add a process
**SCREEN:** on a machine card, click the "add process" control (accessible name is exactly "add process"); the process dialog opens in create mode.
**VOICEOVER:**
on the machine's card, click add process. this dialog is where you describe the app you
want owlette to watch over.

## [b03] or just drop it on the machine
**SCREEN:** native capture — the owlette desktop app open on the machine itself. Drag `lobby-wall.bat` from the desktop onto the owlette window: the drop overlay lights up, release, the "add process" confirm card pops with the details pre-filled. Confirm; the process appears in the list.
**NOTE:** filmed on the VM (`scripts/vm/22-shoot-drag-drop.ps1`) — an OS file drop arrives as a Tauri host event (`useFileDrop` listens to `onDragDropEvent`, not `ondrop`), which CDP cannot synthesize, so this is a real host-driven pointer drag through VMConnect. The same footage fills the drag half of ep09 b04.
**VOICEOVER:**
[warm] there's a faster way too, right on the machine itself. drag an app — or
the file it opens — from anywhere in windows onto the owlette window. drop it,
confirm the one question it asks, and the process is on the card. however you
add one, the dialog is where you shape it — so let's fill it in.

## [b04] the essential fields
**SCREEN:** fill the dialog — name "TouchDesigner"; the launch mode segmented control set to "always on" (all three segments are lowercase: off / always on / scheduled); executable path "C:\Program Files\Derivative\TouchDesigner\bin\TouchDesigner.exe"; then "file path / command arguments" pointing at a .toe project.
**NOTE:** create mode defaults launch mode to "off" (page.tsx:558), so setting it really is required; save only validates name + executable path (page.tsx:586-594), which is what makes "that's genuinely all you need" true.
**VOICEOVER:**
three things matter most. give it a name. set the launch mode — and for an app that
should never be down, that's "always on." then point it at the executable. if your app
opens a specific project file, add that in the file path field too. that's genuinely all
you need.

## [b05] the resilience knobs
**SCREEN:** scroll the dialog to working directory, task priority (low / normal / high / realtime), window visibility (normal / "hidden (console apps only)"), launch delay (sec), init timeout (sec), relaunch attempts.
**NOTE:** relaunch attempts defaults to 3, and 0 is a real setting meaning unlimited — owlette relaunches forever and never escalates to a machine restart (owlette_service.py:2548-2579). Hold on the field a beat longer than the rest; b06 says it out loud.
**VOICEOVER:**
the rest are dials you'll rarely change. priority and window visibility, a launch delay
if it needs other things up first, an init timeout — how long to let it start before
owlette starts health-checking it — and relaunch attempts: how many times to bring it
back before owlette decides something's really wrong. the defaults are sensible; leave
them until you have a reason.

## [b06] save and watch it run
**SCREEN:** click "create process"; the dialog closes and the new process row appears, status LAUNCHING, then flipping to RUNNING (green).
**NOTE:** this needs seeding to film. Create writes only the config doc (useFirestore.ts:1433 → createProcess.server.ts), while rows render from the agent-written status (`data.metrics?.processes || data.processes`, useFirestore.ts:1012) — with no agent in the emulator, no row ever appears. After the create click, write the new process into sites/{siteId}/machines/{machineId}.metrics.processes at LAUNCHING, wait ~4s, then flip it to RUNNING.
**VOICEOVER:**
hit create process. within a second or two the agent picks it up — you'll see the status
go from launching to running, green. it's alive, and owlette is now watching it.

## [b07] what happens on a crash
**SCREEN:** the focus card's touchdesigner mid-relaunch (LAUNCHING), then the same row in STALLED, then the amber "restart pending" banner with its approve and dismiss buttons.
**NOTE:** the banner copy is "restart pending: {reason}" (MachineCardView.tsx:325) and the buttons read approve / dismiss (:343, :358) — site admins only. The underlying field and testids still say reboot; that split is deliberate, never speak it. A hung process is marked STALLED first and only killed and relaunched once the hang is confirmed (owlette_service.py:2837-2854), which is what "or hangs" points at.
**VOICEOVER:**
so what happens when it dies — or hangs? owlette relaunches it, once, twice, up to the
attempt limit you set. set that limit to zero and it never gives up. otherwise, past that
limit owlette stops fighting and raises a restart pending banner — sometimes the machine
itself needs a fresh start. approve that restart, or dismiss it. you stay in control.

## [b08] day-to-day controls
**SCREEN:** a process row's always-visible controls (they are not hover-revealed — they render for every site admin): the inline off / always on / scheduled toggle with its schedule gear inside the "scheduled" segment, then edit (pencil) and duplicate, with restart and kill floated to the right of the row.
**NOTE:** labels are lowercase (MachineCardView.tsx:832). Duplicate (:889-906) clones the whole config as "… (copy)" with launch mode off — show it in the pass, but the narration doesn't name it.
**VOICEOVER:**
once a process exists, you manage it right from its row: flip it between off, always on,
and scheduled, or restart and kill it on demand. the pencil reopens everything we just
filled in. next, let's make a process run only when it should — on a schedule.
