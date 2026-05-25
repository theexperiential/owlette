---
number: 7
slug: remote-actions
title: remote actions — reboot, screenshot, live view
est_duration: "6:00"
capture: web
scenario: dashboard-mixed-states
voice: null
model: null
---

# episode 7 — remote actions: reboot, screenshot, live view

> After this you can see what's on a machine's screen and reboot, shut down, or quiet it — all from the dashboard.

## [b01] the actions menu
**SCREEN:** click the "⋮" machine-options menu on a card; the menu opens.
**VOICEOVER:**
every machine card has a three-dot menu — machine options. this is your remote control:
everything you'd normally walk over to the machine to do, you can do from here, from
anywhere.

## [b02] take a screenshot
**SCREEN:** click "screenshot"; the ScreenshotDialog captures the desktop; show the history sidebar and the download / fullscreen controls.
**VOICEOVER:**
start with screenshot. owlette grabs whatever's on that machine's display right now — the
fastest way to answer "is it actually showing the right thing?" past captures stack up in
a history sidebar, and you can download or blow any of them up full screen.

## [b03] live view
**SCREEN:** click "live view"; the LiveViewModal starts a polling live feed with an interval; show start/stop.
**VOICEOVER:**
need more than a snapshot? live view streams the desktop on a refresh, so you can watch
something actually happen — a transition, a crash, a frozen frame coming back to life.
it runs for a set window and then stops itself, so you're never accidentally streaming
all day.

## [b04] reboot
**SCREEN:** click "reboot machine"; a 30-second cancelable countdown appears; show the cancel control.
**VOICEOVER:**
now the heavier hitters. reboot machine kicks off a thirty-second countdown — a built-in
"wait, not that one" window. let it run and the machine restarts; owlette and your apps
come back on their own. change your mind in those thirty seconds and you can cancel it.

## [b05] shutdown
**SCREEN:** "shutdown machine" with its countdown; and the "schedule reboots" gear sub-action.
**VOICEOVER:**
shutdown works the same way, with the same safety countdown. and if you'd rather not do
this by hand, the reboot option has a little scheduling gear — set a machine to reboot
itself every monday at 4am and forget about it.

## [b06] mute alerts
**SCREEN:** click "mute alerts" on a noisy machine.
**VOICEOVER:**
doing maintenance and don't want a flurry of alerts? mute alerts silences notifications
for that machine — just for you, not your whole team — and unmutes with the same click
when you're done.

## [b07] who can do what
**SCREEN:** group the menu by permission — shown-but-server-checked for members (screenshot, live view), site-admin (reboot, shutdown, remove machine), superadmin only (revoke token), everyone (mute alerts).
**VOICEOVER:**
a quick word on permissions, because it trips people up. taking action on a machine —
screenshots, live view, reboot, shutdown, even removing it from the site — is for site
admins, scoped to the sites they manage. the one action that goes a step higher is revoking
a machine's access token, which is a superadmin job. and the one thing every team member
can do is mute a machine's alerts, since that only changes their own notifications. so if
someone finds an action doesn't go through, that's expected — they need the right role on
that site. next, we go from one machine to many — pushing software across a whole fleet.
