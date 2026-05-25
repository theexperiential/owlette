---
number: 3
slug: dashboard-tour
title: the dashboard, end to end
est_duration: "5:00"
capture: web
scenario: dashboard-mixed-states
voice: null
model: null
---

# episode 3 — the dashboard, end to end

> After this you can navigate sites, read a machine card, switch views, and open any panel without getting lost.

## [b01] orientation
**SCREEN:** /dashboard with the seeded fleet. Highlight the header breadcrumb "owlette / flagship ▾" (the dashboard-mixed-states fixture seeds the site name as "flagship"), then the "online" stat tile (showing "9 / 10") and the "processes" tile.
**VOICEOVER:**
this is home. up top, this breadcrumb is your site switcher — click it to hop between
sites or to manage them. right next to your welcome line are two quick numbers: how many
machines are online out of your total, and how many processes owlette is managing for
you. that's your whole operation in one glance.

## [b02] the machines section
**SCREEN:** slow pan across the card grid — online machines (green pill), high-load machines (amber/red usage bars), one offline machine (red pill), just-restarted cards.
**VOICEOVER:**
below that, every machine in the site gets a card, and the colors tell the story
instantly: a green pill means online, a red pill means offline, and the usage bars climb
from green through amber to red as a machine works harder. you can read the health of a
whole venue without clicking a thing.

## [b03] reading a single card
**SCREEN:** zoom into "media-server-stage" card. Point out: status pill, the cpu / memory / gpu / disk metric tiles with sparklines, the process list, the displays row.
**VOICEOVER:**
let's read one card top to bottom. the pill shows online status and last heartbeat. then
the live metrics — cpu, memory, gpu, disk — each with a little sparkline of where it's
been. underneath, the processes owlette is keeping alive on this machine, and a row for
its displays. everything you'd remote-desktop in to check, already here.

## [b04] card view vs list view
**SCREEN:** click the list-view toggle (List icon, tooltip "list view"); the fleet becomes dense rows (machine-row). Then click the card-view toggle (LayoutGrid icon, tooltip "card view") to switch back.
**VOICEOVER:**
two ways to look at the fleet. cards are great for a handful of machines you want to
watch closely. but when you've got dozens, switch to list view with this toggle — same
information, packed into scannable rows. one click back to cards when you want the detail
again.

## [b05] expand, collapse, and the detail panel
**SCREEN:** click the expand/collapse-all control (ChevronsUpDown). Then click a card's "cpu" metric tile; the MetricsDetailPanel slides open above the list.
**VOICEOVER:**
this control expands or collapses every card at once — handy for tidying up a big fleet.
and any metric is clickable: tap a card's cpu tile and a detail panel slides open with the
full history charted out. we'll dig into that panel properly in the monitoring episode.

## [b06] the rest of the app
**SCREEN:** brief tour of the nav — deploy, roost, cortex, logs, and the account/admin menu.
**VOICEOVER:**
and that's just the dashboard. in the navigation you'll find deploy for pushing software,
roost for distributing project files, cortex for managing machines by chat, and your
activity logs. we'll cover each of those in its own episode. next, let's make a machine
actually do something useful — keeping an app alive.
