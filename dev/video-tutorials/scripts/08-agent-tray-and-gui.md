---
number: 8
slug: agent-tray-and-gui
title: the agent on the machine — tray & local gui
est_duration: "5:00"
capture: native
scenario: null
voice: null
model: null
---

# episode 8 — the agent on the machine: tray & local gui

> After this you can check owlette's status and configure processes directly on the machine, without the dashboard.

## [b01] the tray icon
**SCREEN:** native capture. The Windows taskbar; expand the overflow tray; the owlette icon (a dot in a circle).
**NOTE:** capture on the demo machine via OBS; drive with pywinauto where helpful.
**VOICEOVER:**
most of the time you'll run owlette from the dashboard. but there's also a small presence
right on the machine itself. look in the taskbar tray — sometimes under the little
overflow arrow — for the owlette icon, a dot in a circle. that's the agent, running as a
service.

## [b02] the tray menu
**SCREEN:** right-click the tray icon. Show the header lines (owlette v<version>, hostname, service status, firebase status) and the clickable items: "open owlette", "start on login", "restart", "exit".
**VOICEOVER:**
right-click it and you get a quick status read-out: the owlette version, the machine's
name, whether the service is running, and whether it's connected to the cloud. below that,
a few actions — open the full settings window, toggle start-on-login, restart the agent,
or exit. for a fast "is this thing alive and online?", this menu is all you need.

## [b03] open the local gui
**SCREEN:** click "open owlette". The Tkinter GUI opens — left side a "processes" list with a "＋" add-process button.
**VOICEOVER:**
choose open owlette and the local settings window appears. on the left is the same list of
processes you see on the dashboard card — because this is the same configuration, just
viewed from the machine. the plus button adds a new one.

## [b04] the process details form
**SCREEN:** select a process; the right-hand form: launch mode (Off / Always On / Scheduled), name, exe (with browse), path/args, cwd, delay, priority, wait, visibility, attempts. The schedule field is read-only — it shows the saved schedule summary, or "configure via web" when none is set.
**VOICEOVER:**
selecting a process opens its details — and it's the same fields we filled in on the web:
launch mode, the executable, arguments, working directory, the timing and retry settings.
the difference here is you get browse buttons to pick files right off the machine, which
is handy when you're sitting at it. note the schedule is shown read-only — you set
schedules from the dashboard.

## [b05] per-process controls
**SCREEN:** right-click a process in the list; the context menu: restart process, kill process, move up, move down, delete.
**VOICEOVER:**
right-click any process for the local controls — restart it, kill it, reorder the list, or
delete it. exactly what you'd reach for if you were troubleshooting at the machine itself.

## [b06] local and cloud, in sync
**SCREEN:** the footer — firebase status, site name, hostname, and the "join site" / "leave site" button.
**VOICEOVER:**
along the bottom you'll see the machine's connection status, which site it belongs to, and
a join-or-leave-site button. anything you change here syncs straight up to the cloud, and
anything you change in the dashboard shows up here — it's one configuration, two windows
onto it. that wraps the core essentials. from here on we get into the power features —
starting with deploying software to many machines at once.
