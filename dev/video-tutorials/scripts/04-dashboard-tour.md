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
**SCREEN:** /dashboard with the seeded fleet, cards COLLAPSED from the first frame (fold everything in the pre-roll, off camera — the whole episode opens rolled up and b03 does the revealing). CLICK the site switcher breadcrumb "owlette / flagship ▾" open exactly on "click it" — hold the open dropdown while the line plays, close it (Escape) — then the "online" stat tile (showing "9 / 10") and the "processes" tile.
**NOTE:** the switcher is DEMONSTRATED, not just pointed at — an earlier take hovered it while the narration said "click it", which read as lame. Cue the click from the measured mp3 (voiceover/measure-phrases.py).
**NOTE:** the fixture seeds no processes — `writeMachineMetrics` never writes `metrics.processes`, and the tile counts exactly that (page.tsx:804). As shot today the "processes" tile reads 0 while this beat narrates "how many processes owlette is managing for you". Seed processes on at least three machines before recording.
**VOICEOVER:**
this is home. up top, this breadcrumb is your site switcher — click it to hop between
sites or to manage them. right next to your welcome line are two quick numbers: how many
machines are online out of your total, and how many processes owlette is managing for
you. that's your whole operation in one glance.

## [b02] the machines section
**SCREEN:** the COLLAPSED card grid (a third the height of the expanded one — no long pan; a short gentle drift down the compact grid and rest). Green pills, the one red offline pill, and each folded card's at-a-glance numbers.
**NOTE:** rewritten 2026-08-31 evening — the expanded-grid version was "too heavy, too complicated, and scrolls weird" (rosco). The usage-bar color talk moved out with the expanded tiles; b03 owns the detail now.
**VOICEOVER:**
below that, your machines — one card each. green pill, online. red, offline. even rolled
up like this, every card shows its vitals at a glance: cpu, memory, disk, gpu. and notice
how much you can read without touching a thing — let's open one up.

## [b03] reading a single card
**SCREEN:** zoom into the "media-server-stage" card with its sections STARTING FOLDED (stats default collapsed on first render, MachineCardView.tsx:142). Reveal each section AS IT IS NAMED: expand the metrics collapsible (cpu, ram, disk, gpu with sparklines, network throughput, cpu/gpu inline temperatures), then the displays collapsible, then the process list. Sections open one at a time — never all at once.
**NOTE:** order matters — the stats collapsible is MachineCardView.tsx:367, displays :646, and the process list below it. The second tile's on-screen label is "ram", not "memory". Cue each expand to the narration phrase that names it (measure the rendered mp3's phrase gaps with silencedetect; do not eyeball the dwells).
**VOICEOVER:**
let's read one card, top to bottom. the pill shows online status and last heartbeat.
open the metrics: cpu, ram, disk and gpu, each with a sparkline behind it, plus network
throughput both ways. below those, its displays — and then the processes owlette is
keeping alive here. each section folds away when you don't need it, so a card only shows
what you care about.

## [b04] card view vs list view
**SCREEN:** hold on the CARD grid while cards are being praised. Click the list-view toggle (List icon, tooltip "list view") exactly on "flip to list view" — the fleet becomes ROLLED-UP rows (machine-row); hold the rolled-up state. Expand ONE row in place (its processes unfold) on the "any row expands" line. Click the card-view toggle (LayoutGrid icon) only as "one click back to cards" is spoken — never earlier.
**NOTE:** the previous take showed list view while the narration still praised cards and cut back to cards well before the VO said so — the actions must be cued to the mp3's internal phrase boundaries, same method as b03.
**VOICEOVER:**
two ways to look at the fleet. cards are great for a handful of machines you watch
closely. with dozens, flip to list view: every machine rolls up into one scannable row —
and any row expands in place when you want its processes. one click back to cards for
the full detail.

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
**NOTE:** the hover must move at the SPOKEN cadence — the previous take crawled down the list while the narration had already finished naming it. Cue each hover step to its name's moment in the rendered mp3 (voiceover/measure-phrases.py), like b03/b04.
**VOICEOVER:**
and that's just the dashboard. the page switcher up here holds five more: hoot for
managing machines by chat, talons for rules that watch and act, roost for distributing
project folders, deploy for pushing software, and your activity logs. each one gets its
own episode. next, let's make a machine actually do something useful — keeping an app
alive.
