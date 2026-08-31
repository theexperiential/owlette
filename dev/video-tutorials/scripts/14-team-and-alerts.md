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

## [b01] how the team works
**SCREEN:** the admin "user management" page listing existing users with their roles (web/app/admin/users/page.tsx:420).
**NOTE:** capture as superadmin — /admin is wrapped in RequireSuperadmin (web/app/admin/layout.tsx:156).
**VOICEOVER:**
owlette has two halves to team setup. first, people: a teammate creates their own owlette
account by registering — there's no "invite" step to chase. once they've signed up, you,
as a superadmin, decide what they can see and do from this user management page.

## [b02] assign a role and sites
**SCREEN:** change a user's role via the row's menu → "change role..." (page.tsx:641) → role-change confirm dialog (member → admin); then open "manage sites" to assign which sites they cover. While the row menu is open, let "reset 2FA..." (page.tsx:659) sit on camera for a beat — it's the recovery path when a teammate loses their last factor.
**VOICEOVER:**
two controls per person. their role, which sets how much power they have. and their
sites — which venues or clients they're responsible for. an admin, for instance, only has
their elevated powers on the sites you assign them. set both, and that person sees exactly
their slice of the operation.

## [b03] what each role can do
**SCREEN:** overlay the three role cards — member, admin, superadmin (page.tsx:771-800, copy from ROLE_DESCRIPTIONS at :47-51). Zoom each card as the narration names it; the card text and the narration now say the same thing.
**VOICEOVER:**
[warm] three roles. a member is read-only on their sites — watch machines, take a
screenshot, open live view, set their own alert preferences. an admin adds the doing:
commands and restarts, machine and process settings, removing machines, deployments,
talons, presets, webhooks, members. a superadmin runs everything, plus users and
installers. and every new teammate sets up two-factor before they reach the dashboard.

## [b04] alerts: let owlette tell you
**SCREEN:** the admin "alerts" page (web/app/admin/alerts/page.tsx:376) with the per-site selector and a list of threshold rules.
**NOTE:** capture as superadmin (admin pages require it). To show a populated list, seed sites/{id}/settings/alerts inline the way web/e2e/screenshots/email-alerts.spec.ts does — the automate-schedule-editor fixture seeds nothing this page reads. The other automation schema in the fixtures is sites/{siteId}/talons (scenario automate-talons-list); sites/{id}/alertRules is dead data, written only by fixtures.ts and read by nothing.
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
