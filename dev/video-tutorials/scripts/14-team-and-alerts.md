---
number: 14
slug: team-and-alerts
title: team & alerts
est_duration: "10:00"
capture: web
scenario: automate-schedule-editor
voice: null
model: eleven_v3
---

# episode 14 — team & alerts

> After this you can give teammates the right level of access and have owlette email you when something crosses a line.

## [b01] the team, from your admin seat
**SCREEN:** dashboard as a SITE ADMIN (`roleState('admin')` — never superadmin on camera) → the admin panel entry in the page header → lands on `/admin/members`. Let the filtered nav sit on camera: members, agent tokens, schedules, alerts, webhooks — nothing else (nav filtering: web/app/admin/navItems.ts, guard: RequireAdminAccess).
**NOTE:** e6e99cbf opened /admin to site admins, scoped to their sites. `superadmin` must never appear on screen or in narration — the members page maps per-site "superadmin" to "admin" via displayRole, and the internal-only pages (users, installers, template library, email) are absent from an admin's nav by design.
**VOICEOVER:**
owlette has two halves to team setup. first, people. a teammate creates their own
owlette account by registering — there's no invite email to chase. then, from your
admin panel, you decide who's on each of your sites. [warm] and notice the panel
only shows what's yours to run — members, agent tokens, schedules, alerts,
webhooks — always scoped to your sites.

## [b02] members: who's on this site
**SCREEN:** the members page (web/app/admin/members/page.tsx): the stat chips (total members / admins), the table — the owner row with its crown badge, the "you" badge on your own row, member/admin badges. Click "add member" → the dialog: email + role → add → success toast → the new row appears. Open a row's menu so "remove from site" sits on camera briefly; don't click it.
**NOTE:** seed a fourth emulator account (registered, unassigned to the site) before the take so add-by-email lands a real row. Add as MEMBER — adding as admin when the target's global role is member triggers the roleHonored downgrade toast, which is honest but muddies the demo.
**VOICEOVER:**
pick a site and you see everyone on it — the owner wears the crown, and you'll
find your own row too. adding a teammate takes the email they registered with:
they appear as a member, read-only eyes on this site's machines. [warm] members
watch. admins do — commands, settings, deployments, talons. and if someone needs
to step up from member to admin, that's an account-level change — your platform
operator handles the promotion.

## [b03] the rest of your panel
**SCREEN:** walk the remaining nav items as an admin: agent tokens (the per-site credential list, revoke affordance visible), schedules (preset list), webhooks (integration list) — a short dwell each — ending on the alerts nav item as the handoff to b04.
**VOICEOVER:**
the rest of the panel works the same way. agent tokens lists every machine
credential on your sites — and revokes one that shouldn't be out there. schedules
keeps your reusable schedule presets. webhooks feeds owlette's events into your
other systems. and alerts — alerts are the other half of this episode.

## [b04] alerts: let owlette tell you
**SCREEN:** the admin "alerts" page (web/app/admin/alerts/page.tsx:376) with the per-site selector and a list of threshold rules.
**NOTE:** capture as site admin (the page admits admins since e6e99cbf). To show a populated list, seed sites/{id}/settings/alerts inline the way web/e2e/screenshots/email-alerts.spec.ts does — the automate-schedule-editor fixture seeds nothing this page reads. The other automation schema in the fixtures is sites/{siteId}/talons (scenario automate-talons-list); sites/{id}/alertRules is dead data, written only by fixtures.ts and read by nothing.
**VOICEOVER:**
the second half is alerts — so you're not the one constantly watching. alert rules are set
per site, and each one is a simple sentence: when this metric crosses this line, tell me.

## [b05] build a rule
**SCREEN:** create a rule — metric dropdown (cpu / memory / disk / gpu usage, cpu/gpu temperature, latency, packet loss), operator (> < >= <=, page.tsx:60-65), value, severity (info/warning/critical, :67), channel (email and/or webhook), cooldown. Then open "presets" and show the four templates (:75-117).
**VOICEOVER:**
pick a metric — say gpu temperature — an operator and a value, like greater than
eighty-five degrees. choose how loud it is: info, warning, or critical. choose how it
reaches you: email, a webhook, or both. and set a cooldown so a flapping machine doesn't
email you fifty times. don't want to build from scratch? there are ready-made templates —
gpu overheating, low disk, high memory, high cpu — one click each.

## [b06] your personal alert preferences
**SCREEN:** Account Settings → "alerts" section: six toggles — machine offline alerts, process crash alerts, threshold alerts, hoot escalation alerts, display events, talon alerts (web/components/AccountSettingsDialog.tsx:589-661) — then the alert email block with up to 5 CC recipients ("max 5.", :721).
**VOICEOVER:**
finally, what lands in your inbox is yours to tune. in your account settings, under alerts,
toggle the categories you care about — machine offline, a process crashing, threshold
trips, talons, hoot escalations — and add up to five extra people to copy on every alert.

## [b07] what actually arrives
**SCREEN:** an offline alert email open in a mail client: subject "N machine(s) offline in <site>", the "machines offline" heading (web/app/api/cron/health-check/route.ts:217), and the three grouped sections — not responding / reported shutting down / still offline (:219-221). Scroll to the footer: "manage alerts · unsubscribe" (web/lib/emailTemplates.server.ts:121-133); click "manage alerts" → /settings/alerts, the same toggles from b06. Close on the display layout panel's "store the current live arrangement as the stored layout" row (web/components/charts/DisplayLayoutPanel.tsx:1176) as the handoff lands.
**VOICEOVER:**
[reassuring] so what actually arrives? one email per site, not one per machine — offline
machines grouped into not responding, shutting down, and still offline. every alert email
carries a manage alerts link straight to these toggles, plus one-click unsubscribe. want a
threshold to act, not just email? that's talons. next: storing a display wall's
arrangement, so you can put it back.
