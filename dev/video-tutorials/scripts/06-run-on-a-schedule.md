---
number: 6
slug: run-on-a-schedule
title: run apps on a schedule
est_duration: "6:00"
capture: mixed
scenario: automate-schedule-editor
voice: null
model: eleven_v3
---

# episode 6 — run apps on a schedule

> After this you can make an app run only during set days and times — and stop on its own outside them.

## [b01] why schedule
**SCREEN:** (web) the lobby-display card.
**VOICEOVER:**
not everything should run around the clock. a gallery exhibit only needs to be up during
opening hours; a show machine only during show times. owlette can start and stop an app
on a schedule, so it's running exactly when it should be — and resting when it shouldn't.

## [b02] switch to scheduled
**SCREEN:** (web) open a process for edit; in the launch mode segmented control, switch from "always on" to "scheduled" — labels are lowercase on screen. An inline schedule section + a week-summary bar appear in the dialog. (From a process row on the card, the same is reached via the schedule gear.)
**NOTE:** the gear flush at the end of the segmented control (aria-label "configure schedule", testid `process-dialog-configure-schedule`) opens the same section in EVERY launch mode — including "off" and "always on", where it just stores the windows for later ("saved with the process — switch to scheduled whenever you want these windows to run it"). Frame the gear while the mode still reads "always on" so that's visible, then flip to "scheduled".
**VOICEOVER:**
take any process and change its launch mode from always on to scheduled. the moment you
do, a schedule editor appears, along with a little week-at-a-glance bar so you can see
your coverage.

## [b03] the schedule editor
**SCREEN:** (web) the "configure schedule" editor — day pills mon–sun, a time range with a start, "to", and stop using the time picker.
**NOTE:** locate the card-row gear by icon (`button:has(svg.lucide-settings-2)`) — it has no accessible name.
**VOICEOVER:**
a schedule is made of blocks. pick the days with these pills, then set a time range —
from a start time, to a stop time. the time picker is forgiving; you can type "9am",
"17:00", whatever's natural. need a different pattern on weekends? add another block.

## [b04] overnight windows
**SCREEN:** (web) set a range like 23:00 to 06:00; the "+1 day" badge and "ends the following day" note appear.
**NOTE:** the seeded admin preference is 12h and the default block ends 17:00, so a bare "06:00" parses as 6 pm. Type "6am" (or seed timeFormat 24h) or the frame will read 11pm→6pm and contradict the narration.
**VOICEOVER:**
running something overnight? just set a start later than the stop — say 11pm to 6am — and
owlette understands it crosses midnight, flagging it as ending the following day. no
awkward workarounds.

## [b05] presets
**SCREEN:** (web) the preset pills — "business hours", "extended hours", "weekday 24h", "24/7"; then the "new preset" save action.
**NOTE:** dismiss the inline "new preset" form with its X cancel button, never Escape — Escape closes the whole dialog and "save schedule" disappears before b06 can click it.
**VOICEOVER:**
you don't have to build common patterns by hand. there are built-in presets — business
hours, extended hours, around the clock — one click and you're done. and if you've got a
schedule you reuse, like your venue's exact opening hours, save it as your own preset to
reuse on any machine.

## [b06] save it
**SCREEN:** (web) click "save schedule"; hold on the outside-window banner ("this looks outside the current window — a machine outside it will stop the process shortly after saving."), then the dialog closing back to the process row with its new schedule summary.
**NOTE:** whose clock evaluates a window is a per-site setting now — `sites/{siteId}.schedulesFollowSiteTime`, with agent support since 3.2.3. It is three-state and absent is a real state: absent = never asked, `false` = declined, `true` = site time. Only `true` puts a `source="site"` timezone chip under the "configure schedule" title and swaps every schedule surface to "times run on the site's clock"; absent and `false` both read "times run on each machine's own clock". This scene records the flag OFF, so there is no chip to avoid and the machine-clock wording on camera is exactly what that site ships. The narration makes no timezone claim either way, so it stays true if a site later opts in — but do not re-film this episode against an opted-in site without re-cutting b04 and b06, or the chip and the "site's clock" wording sit on camera unspoken. The scene also pins the flag rather than leaving it absent so the one-time "which clock runs this site's schedules?" confirm banner stays off camera; teaching that banner is a scripted beat, not a side effect.
**VOICEOVER:**
save it, and you're done. outside the scheduled window, owlette keeps the app stopped —
and if you happen to save while you're currently outside the window, it'll tell you the
process will stop shortly.

## [b07] the machine can edit them too
**SCREEN:** (native) the owlette desktop app on the machine — process detail, the schedule summary line, and the pencil beside the launch-mode control (aria-label "edit schedule", testid `edit-schedule`); open it to show the same day pills and time picker. Cut back to (web) the dashboard preset pills to land the contrast.
**NOTE:** this is the Tauri desktop app, not the retired python window — and it is NOT read-only. Assemble as a native insert in the editor.
**VOICEOVER:**
one more thing: the dashboard isn't the only place to edit these. the machine's own
owlette app has the same schedule editor built in, and anything you change there syncs
back up within about a second. what the web gives you that the local app doesn't is
presets. next up: actually reading what all these machines are telling you.
