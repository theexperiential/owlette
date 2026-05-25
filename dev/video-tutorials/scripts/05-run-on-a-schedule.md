---
number: 5
slug: run-on-a-schedule
title: run apps on a schedule
est_duration: "6:00"
capture: web
scenario: automate-schedule-editor
voice: null
model: null
---

# episode 5 — run apps on a schedule

> After this you can make an app run only during set days and times — and stop on its own outside them.

## [b01] why schedule
**SCREEN:** the lobby-display card.
**VOICEOVER:**
not everything should run around the clock. a gallery exhibit only needs to be up during
opening hours; a show machine only during show times. owlette can start and stop an app
on a schedule, so it's running exactly when it should be — and resting when it shouldn't.

## [b02] switch to scheduled
**SCREEN:** open a process for edit; in the launch mode segmented control, switch from "Always On" to "Scheduled". An inline schedule editor + a week-summary bar appear in the dialog. (From a process row on the card, the same is reached via the schedule gear.)
**VOICEOVER:**
take any process and change its launch mode from always on to scheduled. the moment you
do, a schedule editor appears, along with a little week-at-a-glance bar so you can see
your coverage.

## [b03] the schedule editor
**SCREEN:** the "configure schedule" editor — day pills mon–sun, a time range with a start, "to", and stop using the time picker.
**VOICEOVER:**
a schedule is made of blocks. pick the days with these pills, then set a time range —
from a start time, to a stop time. the time picker is forgiving; you can type "9am",
"17:00", whatever's natural. need a different pattern on weekends? add another block.

## [b04] overnight windows
**SCREEN:** set a range like 23:00 to 06:00; the "+1 day" badge and "ends the following day" note appear.
**VOICEOVER:**
running something overnight? just set a start later than the stop — say 11pm to 6am — and
owlette understands it crosses midnight, flagging it as ending the following day. no
awkward workarounds.

## [b05] presets
**SCREEN:** the preset pills — "business hours", "extended hours", "weekday 24h", "24/7"; then the "new preset" save action.
**VOICEOVER:**
you don't have to build common patterns by hand. there are built-in presets — business
hours, extended hours, around the clock — one click and you're done. and if you've got a
schedule you reuse, like your venue's exact opening hours, save it as your own preset to
reuse on any machine.

## [b06] outside the window
**SCREEN:** save the schedule ("save schedule"); show the warning if current time is outside the schedule. Briefly cut to the agent GUI showing the saved schedule summary, read-only (it only says "configure via web" when no schedule is set).
**VOICEOVER:**
save it, and you're done. outside the scheduled window, owlette keeps the app stopped —
and if you happen to save while you're currently outside the window, it'll tell you the
process will stop shortly. one note: schedules are set here in the dashboard. the agent's
local screen shows them, but read-only — the web is where you edit. next up: actually
reading what all these machines are telling you.
