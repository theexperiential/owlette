---
number: 11
slug: team-and-alerts
title: team & alerts
est_duration: "9:00"
capture: web
scenario: automate-schedule-editor
voice: null
model: null
---

# episode 11 — team & alerts

> After this you can give teammates the right level of access and have owlette email you when something crosses a line.

## [b01] how the team works
**SCREEN:** the admin "user management" page listing existing users with their roles.
**VOICEOVER:**
owlette has two halves to team setup. first, people: a teammate creates their own owlette
account by registering — there's no "invite" step to chase. once they've signed up, you,
as a superadmin, decide what they can see and do from this user management page.

## [b02] assign a role and sites
**SCREEN:** change a user's role via the row's menu → role-change confirm dialog (member → admin); then open "manage sites" to assign which sites they cover.
**VOICEOVER:**
two controls per person. their role, which sets how much power they have. and their
sites — which venues or clients they're responsible for. an admin, for instance, only has
their elevated powers on the sites you assign them. set both, and that person sees exactly
their slice of the operation.

## [b03] what each role can do
**SCREEN:** overlay the three role descriptions: member, admin, superadmin.
**VOICEOVER:**
three roles. a member can see the machines on their assigned sites and manage their own
alert preferences — great for someone who just needs eyes on the fleet. the actions that
change a machine — sending commands, restarting a process, rebooting — are an admin power.
an admin gets all of that on their assigned sites, plus removing machines, editing saved
display layouts, and managing site settings. and a superadmin runs the whole platform —
every site, plus managing users, uploading installers, and revoking agent tokens. give
people the least they need; you can always promote later.

## [b04] alerts: let owlette tell you
**SCREEN:** the admin "alerts" page with the per-site selector and a list of threshold rules.
**NOTE:** capture as superadmin (admin pages require it). To show a populated list, seed sites/{id}/settings/alerts (see web/e2e/screenshots/email-alerts.spec.ts) — the automate-schedule-editor fixture seeds a different automation-rule schema (sites/{id}/alertRules) that does NOT populate this email-alerts page.
**VOICEOVER:**
the second half is alerts — so you're not the one constantly watching. alert rules are set
per site, and each one is a simple sentence: when this metric crosses this line, tell me.

## [b05] build a rule
**SCREEN:** create a rule — metric dropdown (cpu / memory / disk / gpu usage, cpu/gpu temperature, latency, packet loss), operator (> < >= <=), value, severity (info/warning/critical), channel (email and/or webhook), cooldown. Then show the preset templates.
**VOICEOVER:**
pick a metric — say gpu temperature — an operator and a value, like greater than
eighty-five degrees. choose how loud it is: info, warning, or critical. choose how it
reaches you: email, a webhook, or both. and set a cooldown so a flapping machine doesn't
email you fifty times. don't want to build from scratch? there are ready-made templates —
gpu overheating, low disk, high memory, high cpu — one click each.

## [b06] your personal alert preferences
**SCREEN:** Account Settings → "alerts" tab: toggles for machine offline, process crash, threshold, cortex escalation, display events; the alert email + up to 5 CC recipients.
**VOICEOVER:**
finally, what lands in your inbox is yours to tune. in your account settings, under alerts,
toggle the categories you care about — machine offline, a process crashing, threshold
trips — and add up to five extra people to copy on every alert. now owlette watches, and
only pulls you in when it genuinely needs you. next, the most futuristic way to run all of
this — just by chatting.
