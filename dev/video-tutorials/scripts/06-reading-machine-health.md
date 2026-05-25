---
number: 6
slug: reading-machine-health
title: reading machine health
est_duration: "5:00"
capture: web
scenario: monitor-single-machine
voice: null
model: null
---

# episode 6 — reading machine health

> After this you can read a machine's metrics at a glance, understand the colors, and drill into the detail charts.

## [b01] the card at a glance
**SCREEN:** the "media-server-stage" card with cpu / memory / disk / gpu tiles and sparklines.
**VOICEOVER:**
every machine card is a live vital-signs monitor. cpu, memory, disk, gpu — each with a
current number and a sparkline showing the last little while. you learn to read these the
way you read a dashboard in a car: you don't study them, you just notice when something's
off.

## [b02] the color language
**SCREEN:** point across cards at different usage levels; overlay the band key: <30 green, 30–50 violet, 50–70 sky blue, 70–85 amber, ≥85 red.
**VOICEOVER:**
the colors do the noticing for you. it's a five-step spectrum: green when there's plenty
of headroom, into violet and blue as load builds, amber when a machine's working hard,
and red when it's maxed out. you're not memorizing numbers — you're scanning for the
machine that's turned amber or red.

## [b03] temperatures
**SCREEN:** a card showing cpu / gpu temperature; overlay: under 70°C normal, 70 to under 85°C warning, 85°C and above critical. Note the °C / °F toggle in account settings.
**VOICEOVER:**
temperatures get their own bands: comfortable under seventy degrees celsius, a warning
yellow from seventy, and critical red at eighty-five and above — the range where a render
node starts throttling or crashing. prefer fahrenheit? flip it in your account settings
and every reading follows.

## [b04] network health
**SCREEN:** the card's network latency + packet loss readout.
**VOICEOVER:**
there's network health too — latency and packet loss. a machine that's technically online
but sitting behind a flaky connection will show its latency creeping into yellow or red,
which often explains a sluggish stream long before anyone files a complaint.

## [b05] the detail panel
**SCREEN:** click the "cpu" tile; the MetricsDetailPanel slides open with a full line chart. Note cpu temperature appears alongside.
**VOICEOVER:**
when a sparkline isn't enough, click the metric. the detail panel opens the full history
as a proper chart — and it's smart about pairings, so clicking cpu also brings in cpu
temperature so you can see load and heat together.

## [b06] per-device tabs and time range
**SCREEN:** in the panel, show tabs for each disk, gpu, and network adapter; the time-range selector; and (with >5 machines) the machine switcher in the title bar.
**NOTE:** the title-bar machine switcher only appears with >5 machines; the monitor-single-machine scenario seeds 4, so record this beat against dashboard-mixed-states (10) if you want the switcher on screen.
**VOICEOVER:**
if a machine has two drives, three gpus, a couple of network cards — each gets its own tab
right here, so you can isolate exactly which device is the busy one. change the time range
to zoom out to the day, and on a bigger fleet you can flip between machines without ever
leaving the panel.

## [b07] what offline looks like
**SCREEN:** the offline "touring-rig-04" card — red "offline" pill, stale heartbeat (the row dims in list view).
**NOTE:** touring-rig-04 is offline only in the dashboard-mixed-states scenario; monitor-single-machine seeds all its machines online, so cut to that fleet for the offline shot.
**VOICEOVER:**
and when a machine drops off entirely, its pill flips to red and its heartbeat goes stale
— your cue that it's the connection or the box itself that needs attention, not any one
app. next, let's actually reach out and do something to these machines, remotely.
