---
number: 4
slug: keep-a-process-alive
title: keep a process alive
est_duration: "6:00"
capture: web
scenario: control-process-restarting
voice: null
model: null
---

# episode 4 — keep a process alive

> After this you can add a process to a machine and have owlette automatically restart it whenever it crashes.

## [b01] the promise
**SCREEN:** the "td-control-room" card with touchdesigner in its process list.
**VOICEOVER:**
this is the heart of owlette. you tell it which app must always be running, and it makes
sure it is — relaunching it the moment it crashes, even at 3am with nobody on site. let's
set one up.

## [b02] add a process
**SCREEN:** on a machine card, click the "+ add process" control; the "add process" dialog opens.
**VOICEOVER:**
on the machine's card, click add process. this dialog is where you describe the app you
want owlette to watch over.

## [b03] the essential fields
**SCREEN:** fill the dialog — name "TouchDesigner"; launch mode segmented control set to "Always On"; executable path "C:\Program Files\Derivative\TouchDesigner\bin\TouchDesigner.exe"; file path / arguments pointing at a .toe project.
**VOICEOVER:**
three things matter most. give it a name. set the launch mode — and for an app that
should never be down, that's "always on." then point it at the executable. if your app
opens a specific project file, add that in the file path field too. that's genuinely all
you need.

## [b04] the resilience knobs
**SCREEN:** scroll the dialog to working directory, task priority (low/normal/high/realtime), window visibility (normal / hidden), launch delay, init timeout, relaunch attempts.
**VOICEOVER:**
the rest are dials you'll rarely change. priority and window visibility, a launch delay
if it needs other things up first, an init timeout — how long to let it start before
owlette starts health-checking it — and relaunch attempts: how many times to bring it
back before owlette decides something's really wrong. the defaults are sensible; leave
them until you have a reason.

## [b05] save and watch it run
**SCREEN:** click "create process"; the process row appears, status goes LAUNCHING then RUNNING (green).
**VOICEOVER:**
hit create process. within a second or two the agent picks it up — you'll see the status
go from launching to running, green. it's alive, and owlette is now watching it.

## [b06] what happens on a crash
**SCREEN:** the focus card's touchdesigner mid-restart (LAUNCHING). Then show the amber "reboot pending" banner with approve / dismiss buttons.
**VOICEOVER:**
so what happens when it dies? owlette relaunches it — once, twice, up to the attempt
limit you set. if the app keeps crashing past that limit, owlette stops fighting it and
raises a "reboot pending" banner right here, because sometimes the machine itself needs a
fresh start. you can approve that reboot or dismiss it — you stay in control.

## [b07] day-to-day controls
**SCREEN:** hover a process row; point out the inline Off / Always On / Scheduled toggle, plus the restart, kill, and edit (pencil) buttons.
**VOICEOVER:**
once a process exists, you manage it right from its row: flip it between off, always on,
and scheduled, or restart and kill it on demand. the pencil reopens everything we just
filled in. next, let's make a process run only when it should — on a schedule.
