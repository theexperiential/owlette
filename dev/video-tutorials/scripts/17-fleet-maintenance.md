---
number: 17
slug: fleet-maintenance
title: keeping the fleet current
est_duration: "6:00"
capture: web
scenario: dashboard-mixed-states
model: eleven_v3
voice: null
---

# episode 17 — keeping the fleet current

> After this you can see what version every machine is running, roll the agent forward safely, revoke a credential without knocking out the wrong box, and retire a machine cleanly.

## [b01] the upkeep nobody schedules
**SCREEN:** dashboard, mixed fleet — several online, one offline, one stale. slow pan across the machine list.
**VOICEOVER:**
[warm] the point of owlette is machines you never have to touch. but the fleet itself still needs a little upkeep — the agent moves forward, credentials pile up, and retired machines linger. this is the ten-minutes-a-month version of that job.

## [b02] the button that tells you
**SCREEN:** deploy page (nav label "deploy"), one site selected. top-right cluster: the orange outlined `update owlette to v3.2.0` button with its count badge, beside `new deployment`. hold on the badge.
**NOTE:** the button is scoped to the selected site (`useMachines(currentSiteId)`) and renders only when at least one of that site's machines is outdated — the seed must include a machine behind `installer_metadata/latest`.
**VOICEOVER:**
owlette tells you when something's behind instead of making you go looking. on the deploy page, an orange update button appears with the newest version and a count of the machines that can take it. it only shows up when at least one machine is out of date — so no button means this site is current.

## [b03] why three-point-oh is a wall
**SCREEN:** site selector → `manage sites` → expand a site row (chevron) → the per-machine list: status dot, last seen, agent version column (`v3.2.0`, `v2.12.21`, `—`).
**VOICEOVER:**
one version matters more than the others. three-point-oh replaced the service host that runs the agent, and anything older can't run under it — so machines still on a two-point-something have to come forward. to find them, open manage sites and expand the site: every machine lists the version it's on.

## [b04] roll it to one machine
**SCREEN:** click `update owlette` → dialog `update owlette agents` → the cyan "what happens during an update" banner → `deselect all` → tick one machine (row shows `current: v2.12.21 → latest: v3.2.0`) → `update 1 machine`.
**VOICEOVER:**
roll it to one machine first. click the button, deselect all, tick a single box, confirm — sending an update is a site admin action. owlette downloads the installer, verifies its checksum before it runs anything, then the service stops, the new build installs quietly, and the service starts itself back up. config and pairing untouched.

## [b05] then the rest of them
**SCREEN:** reopen the dialog → `select all` → an offline row with its checkbox disabled and "offline — must be online to receive an update" → confirm → rows showing the `updating...` badge. cut to a row with the red `may have failed` badge and its `clear` button.
**VOICEOVER:**
[calm] then do the rest — reopen it, select all, confirm. offline machines still show in the list but can't be ticked; an agent that isn't listening can't take the command, so catch those on the next pass. and if one sits on updating for fifteen minutes, it gets flagged may have failed — clear it and send again.

## [b06] the token ledger
**SCREEN:** admin → `agent tokens`. site selector, then the table: machine ID, version, status, created, last used. show the search box, the version filter, the `duplicates` toggle, and the `N live` count.
**NOTE:** superadmin-only surface — capture with a superadmin session.
**VOICEOVER:**
now the credentials. every paired machine holds a refresh token, and the agent tokens page under admin is the ledger — superadmin only. pick a site and you see every live token, the version it registered with, and when it was last used. the duplicates filter flags hostnames holding more than one.

## [b07] revoke the right one
**SCREEN:** dashboard → machine row menu → `revoke token` → the dialog, holding on both buttons: `revoke current token` (amber) and `revoke all for hostname` (red).
**NOTE:** since e0c8341a this menu item and its route are both site-admin — film with an admin session on an assigned site, not a superadmin one.
**VOICEOVER:**
revoking is where people get hurt. from a machine's menu on the dashboard — a site admin power, on your own sites — revoke current token drops only the most recently used credential for that hostname. revoke all for hostname drops every one, disconnecting any other machine sharing that name. either way, that agent has to pair again.

## [b08] retiring a machine, in order
**SCREEN:** deploy page → a deployment row → `uninstall software` dialog (machines, then software). cut to dashboard → machine menu → `remove machine` → the dialog's bullet list of what gets deleted.
**VOICEOVER:**
retiring a machine has an order. while the agent is still online, uninstall anything you deployed to it — that's on the deploy page, admin only. then remove machine, from the machine's own menu: a site admin action that deletes its data, its config, its command history, and revokes its tokens. it doesn't uninstall owlette itself — that's a job on the box.

## [b09] the monthly rhythm
**SCREEN:** montage — deploy page with no update button in the header (switch the site selector across two sites to show both clean), tokens page with a clean list, dashboard all green. end on the dashboard.
**VOICEOVER:**
if that machine ever comes back, it's a fresh install and a fresh pairing, same as day one. that's the whole rhythm: once a month, clear the orange badge on every site, prune the dead tokens, retire what's gone. windows' own updates are a different problem — that's what the automation rules are for. [warm] and the best sign of all? no button to press.
