---
number: 1
slug: what-is-owlette
title: what is owlette?
est_duration: "2:30"
capture: web
scenario: dashboard-mixed-states
voice: null
model: eleven_v3
---

# episode 1 — what is owlette?

> After this you can explain what owlette does, who it's for, and whether it fits your setup.

## [b01] cold open
**B-ROLL:** a dark gallery at 3am; a digital display frozen on a windows error dialog; an empty room, nobody to fix it.
**VOICEOVER:**
[concerned] it's three in the morning. the installation is closed, nobody's on site,
and the machine running your show just crashed. the display's been frozen for hours —
and you won't find out until someone walks in at opening.

## [b02] what owlette is
**B-ROLL:** owlette wordmark; then cut to the dashboard fleet view loading.
**VOICEOVER:**
this is the problem owlette solves. owlette is a cloud-connected manager for the
windows machines you can't babysit — the ones running touchdesigner, digital signage,
kiosks, and media servers in places you're not. it watches the apps that matter, and
when one dies, it brings it back. all of it, from one dashboard, from anywhere.

## [b03] who it's for
**SCREEN:** dashboard at /dashboard — the seeded fleet (lobby-display, museum-kiosk-1/2, media-server-stage, nyc-signage-01, unreal-render-1, td-control-room, lobby-2, mainstage-led, plus the offline touring-rig-04) scrolling slowly. Green "online" pills, one red "offline" pill.
**NOTE:** the left accent bar on each metric tile is a FIVE-band scale (emerald <30, violet <50, sky <70, amber <85, red ≥85 — web/lib/usageColorUtils.ts:8-20), so this fleet legitimately shows violet and sky bars on camera. Don't grade or re-time the shot to force a green-to-red look; the revoiced line describes headroom vs pinned, not a hue ramp.
**VOICEOVER:**
if you run unattended windows machines — experiential installs, exhibits, broadcast,
live events — owlette is built for you. here's a real fleet: lobby displays, museum
kiosks, a media server mid-show, a render node flat out. a green pill means online, a
red one means offline, and each usage bar shifts color as load climbs — green when
there's headroom, red when it's pinned.

## [b04] the one-glance promise
**SCREEN:** slow zoom into one machine card — status pill and last heartbeat, then the metric tiles in their real order (cpu, ram, disk, gpu, network) with sparklines behind them, then the displays section, then the process list.
**NOTE:** the spoken word "memory" here maps to the tile the UI labels "ram" (MachineCardView.tsx:506) — audio is unchanged, so frame the zoom on the card as a whole rather than resting on that one label. Also: `dashboard-mixed-states` seeds NO processes (fixtures.ts writeMachineMetrics has no `metrics.processes`), so a card renders the empty "add process" button instead of a process list. Seed processes on the focus machine before recording, or the last clause of this beat has nothing on screen.
**VOICEOVER:**
every card is one machine. at a glance you get its heartbeat, its cpu, memory and gpu,
and the exact apps it's supposed to be running. no remote desktop, no phone calls to
whoever's nearest the building. you just look.

## [b05] what this series covers
**B-ROLL:** quick montage, roughly one second each — the inno installer wizard; the "add process" dialog; the schedule editor; a deployment rolling out on /deployments; a roost version list on /roosts; a talons rule on /talons; the display layout panel on a machine card; and last, the hoot chat frame at /hoot (the nav label and the screen are "hoot" — nothing in the UI says cortex any more).
**VOICEOVER:**
in this series we'll go end to end. installing owlette, keeping your apps alive,
scheduling them, reading machine health, acting remotely. then deploying software,
distributing project folders with roost, automating with talons, managing displays,
and hoot — the assistant built in. [warm] by the end you'll have a setup that takes
care of itself. let's start with your account.
