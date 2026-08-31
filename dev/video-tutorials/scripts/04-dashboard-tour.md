---
number: 4
slug: dashboard-tour
title: the dashboard, end to end
est_duration: "5:00"
capture: web
scenario: dashboard-mixed-states
voice: null
model: eleven_v3
---

# episode 4 — the dashboard, end to end

> After this you can navigate sites, read a machine card, switch views, and open any panel without getting lost.

## [b01] orientation
**SCREEN:** /dashboard with the seeded fleet. Highlight the header breadcrumb "owlette / flagship ▾" (the dashboard-mixed-states fixture seeds the site name as "flagship"), then the "online" stat tile (showing "9 / 10") and the "processes" tile.
**NOTE:** the fixture seeds no processes — `writeMachineMetrics` never writes `metrics.processes`, and the tile counts exactly that (page.tsx:804). As shot today the "processes" tile reads 0 while this beat narrates "how many processes owlette is managing for you". Seed processes on at least three machines before recording.
**VOICEOVER:**
this is home. up top, this breadcrumb is your site switcher — click it to hop between
sites or to manage them. right next to your welcome line are two quick numbers: how many
machines are online out of your total, and how many processes owlette is managing for
you. that's your whole operation in one glance.

## [b02] the machines section
**SCREEN:** slow pan across the card grid — online machines (green pill), one offline machine (red pill), and the left accent bars on the metric tiles at their natural spread (emerald and violet on the quiet machines, sky and amber and red on media-server-stage, nyc-signage-01, unreal-render-1, td-control-room).
**NOTE:** five bands, not three (web/lib/usageColorUtils.ts:8-20). The narration deliberately talks about headroom vs pinned rather than naming a hue ramp, so no grading is needed — shoot it as it renders.
**VOICEOVER:**
below that, every machine in the site gets a card, and the colors tell the story
instantly: a green pill means online, a red pill means offline, and each usage bar shifts
color as a machine works harder — cool colors while there's headroom, amber under load,
red when it's pinned. you can read the health of a whole venue without clicking a thing.

## [b03] reading a single card
**SCREEN:** zoom into the "media-server-stage" card, top to bottom in the order it actually renders: status pill and last heartbeat (plus the display button in the header with its drift / circuit-breaker dots), then the metric tiles — cpu, ram, disk, gpu, network — with sparklines behind cpu / ram / disk / gpu and up-down throughput on network, cpu and gpu carrying inline temperature readings. Then the displays section, and BELOW it the process list.
**NOTE:** order matters — the displays collapsible is MachineCardView.tsx:646 and the process list is :750, so displays sits above processes. The second tile's on-screen label is "ram", not "memory".
**VOICEOVER:**
let's read one card top to bottom. the pill shows online status and last heartbeat. then
the live metrics — cpu, ram, disk and gpu, each with a sparkline behind it, plus network
throughput up and down. under those, its displays, and then the processes owlette is
keeping alive on this machine. everything you'd remote-desktop in to check, already here.

## [b04] card view vs list view
**SCREEN:** click the list-view toggle (List icon, tooltip "list view"); the fleet becomes dense rows (machine-row). Then click the card-view toggle (LayoutGrid icon, tooltip "card view") to switch back.
**VOICEOVER:**
two ways to look at the fleet. cards are great for a handful of machines you want to
watch closely. but when you've got dozens, switch to list view with this toggle — same
information, packed into scannable rows. one click back to cards when you want the detail
again.

## [b05] expand, collapse, and the detail panel
**SCREEN:** click the expand/collapse-all control (ChevronsUpDown / ChevronsDownUp, tooltip "expand all" / "collapse all"). Then click a card's "cpu" metric tile; the MetricsDetailPanel slides open above the list.
**NOTE:** to close the panel, click its X button (MetricsDetailPanel.tsx:935-942) — `page.keyboard.press('Escape')` does nothing, the panel has no key handler, and the old harness line that relied on it leaves the panel open through the rest of the take.
**VOICEOVER:**
this control expands or collapses every card at once — handy for tidying up a big fleet.
and any metric is clickable: tap a card's cpu tile and a detail panel slides open with the
full history charted out. we'll dig into that panel properly in the monitoring episode.

## [b06] the rest of the app
**SCREEN:** open the page switcher (the second breadcrumb dropdown) so all six destinations are on screen in order — dashboard, hoot, talons, roost, deploy, logs — each with its one-line description. Hover down the list as the names are spoken.
**B-ROLL:** optional two-second cut — the same dashboard on a phone; the hamburger opens the drawer that carries the site switcher and this same page list below the md breakpoint.
**NOTE:** the nav label is "hoot" (PageHeader.tsx:39-43); nothing in the UI reads "cortex" any more. "roost" points at /roosts and "deploy" at /deployments.
**VOICEOVER:**
and that's just the dashboard. the page switcher up here holds five more: hoot for
managing machines by chat, talons for rules that watch and act, roost for distributing
project folders, deploy for pushing software, and your activity logs. each one gets its
own episode. next, let's make a machine actually do something useful — keeping an app
alive.
