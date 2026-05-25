---
number: 13
slug: logs-and-troubleshooting
title: logs & troubleshooting
est_duration: "5:00"
capture: web
scenario: control-process-restarting
voice: null
model: null
---

# episode 13 — logs & troubleshooting

> After this you can find what happened on any machine, filter the noise, and see the screenshot from the moment a process crashed.

## [b01] the activity timeline
**SCREEN:** the logs page — a reverse-chronological list of events across the site.
**NOTE:** capture needs seeded log entries — the control-process-restarting scenario seeds processes but not logs; a small log-seed fixture should be added before recording this episode.
**VOICEOVER:**
when you want the full story of what happened — and when — this is the place. the logs page
is a running timeline of everything across the site: agents starting and stopping,
processes launching, crashing, being killed, deployments finishing or failing, scheduled
reboots. newest first.

## [b02] reading an entry
**SCREEN:** point at one row: the colored level badge, the action, the machine, the process, and the timestamp.
**VOICEOVER:**
each line tells you the essentials at a glance: a colored badge for severity, what
happened, which machine, which process if it applies, and exactly when. cyan is routine
info, yellow is a warning, red is an error — so your eye goes straight to the red.

## [b03] filtering the noise
**SCREEN:** use the filters — action dropdown, machine dropdown, level, date range (presets like last 24h / custom), and the full-text search box.
**VOICEOVER:**
a busy fleet generates a lot of lines, so the filters do the work. narrow to one action
type, one machine, one severity, or a time window like the last twenty-four hours. or just
type in the search box to find every mention of a process or a phrase. "show me only the
errors on the media server yesterday" is a few clicks.

## [b04] the crash screenshot
**SCREEN:** a "process crashed" entry with a camera indicator; open the attached crash screenshot full-size.
**VOICEOVER:**
here's the detail that saves you. when a process crashes, owlette grabs a screenshot at
that moment and attaches it to the log entry. so instead of guessing, you can see exactly
what was on screen when it died — the error dialog, the frozen frame, the blue screen.
click the thumbnail to view it full size.

## [b05] expand for the full record
**SCREEN:** expand a row to reveal the full details; show expand-all / collapse-all.
**VOICEOVER:**
expand any row for the complete record — the full machine id, the exact timestamp, and the
raw details behind the summary. it's the difference between "something went wrong" and
knowing precisely what.

## [b06] clear up, and where to go next
**SCREEN:** the "clear logs" button → confirm dialog. IMPORTANT: clearing is scoped only by the action, machine, and level filters — the date-range and search filters do NOT limit what gets deleted.
**VOICEOVER:**
when you've resolved things and want a clean slate, clear logs deletes entries — and here's
the one thing to know: it's scoped by the action, machine, and level filters, but not by
date range or search. so if the only thing you've narrowed by is a date or a search term,
clearing wipes the whole log, not just what's on screen. when in doubt, narrow by machine
or level first. and that's the toolkit: a symptom in the logs points you to the right
machine, where a screenshot, the metrics, or the tray's status tells you the rest. that's
owlette, end to end — go keep your machines happy.
