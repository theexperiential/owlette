---
number: 2
slug: day-zero
title: "day zero: sign up, 2fa, and your first site"
est_duration: "5:00"
capture: web
scenario: null
voice: null
model: eleven_v3
---

# episode 2 — day zero: sign up, 2fa, and your first site

> After this you can create an owlette account, get through mandatory two-factor with a passkey or an authenticator app, keep recovery material you can actually use, and stand up your first site with the right clock on it.

## [b01] cold open
**SCREEN:** clean browser on the owlette.app sign-up page, held — where a new account actually begins.
**NOTE:** no capture fixture exists for this episode. `seedScreenshotFixtures` has no scenario for the auth pages or a zero-site dashboard (`web/e2e/screenshots/fixtures.ts` — the union runs `dashboard-mixed-states` … `display-storyboard-frame-3`), so every beat here needs a fresh emulator account: register → enroll → create site. Build one before capture; `scenario: null` until then.
**VOICEOVER:**
[warm] before owlette can look after your machines, it makes sure your account
is looked after first. two-factor is built into setup — no nag screen, no skip
button. a few minutes, done for good. the whole first day: account, second
factor, backup codes, and your first site.

## [b02] signing up
**SCREEN:** `/register` — the "create an account" card. Show "continue with Google" at the top, then click into the email field so the rest unfolds (first/last name, password with its "8+ characters with at least 2 of..." hint, confirm, terms checkbox, the bot-check widget), then "create account". Land on `/setup-2fa`.
**VOICEOVER:**
start at the sign-up page. quickest way in is continue with google — one popup,
no password to invent. prefer your own? click the email field and the rest
unfolds: your name, a password of eight characters or more, and the terms box.
either way, you land on setup — not the dashboard.

## [b03] passkey or authenticator
**SCREEN:** `/setup-2fa`, the "choose your second factor" step — the passkey card (fingerprint icon, "recommended" pill) above the authenticator-app card (phone icon). Hover each so the descriptions are readable.
**VOICEOVER:**
now pick your second factor. a passkey uses what your device already has —
windows hello, touch id, a security key, your password manager. an authenticator
app is the classic six-digit code: scan the qr, or paste the manual code into a
desktop app. pick one now — you can add the other later from account settings.

## [b04] enroll it, and see what sign-in becomes
**SCREEN:** click the passkey card → "create passkey" → the windows hello prompt → "passkey added". Then sign out, land on `/login`, click "continue with passkey", one prompt, straight into the dashboard — no code screen in between.
**NOTE:** the sign-out / sign-back-in half is a SEPARATE take, filmed after b05's codes are claimed — leaving the "passkey added" screen is one-way, and b05 shoots from it.
**VOICEOVER:**
let's take the passkey. click create passkey, and your device asks for its usual
unlock — fingerprint, face, or pin. that unlock is the proof, so there's no code
to type. [reassuring] and it's your whole sign-in from then on: continue with
passkey, one prompt, and you clear who you are and your second factor together.

## [b05] backup codes
**SCREEN:** on the "passkey added" screen, click "get backup codes" — the button flips to "waiting for your device..." and the device prompts a second time. Then the backup step: the ten codes in a mono grid, the red "these codes will only be shown once!" line, "copy all codes", then "continue to dashboard".
**NOTE:** the passkey path needs that extra step-up before any codes render (`web/app/setup-2fa/page.tsx:589-598`). The sibling button on that screen is "skip for now" (`:602-610`) — do not click it on camera; it exits to the dashboard with no codes issued.
**VOICEOVER:**
then owlette hands you ten backup codes. we only store the hashes, so this is the
one time you will ever see them — copy them into your password manager now. you
can mint a fresh set later, but that asks you to prove a factor first, which is
exactly the thing you won't have on the day you need these.

## [b06] trust this device
**SCREEN:** a sign-in on the authenticator path — `/verify-2fa`, the six-digit field, and the "trust this device for 30 days" checkbox being ticked before "verify".
**VOICEOVER:**
if you went the authenticator route, the code screen carries a checkbox: trust
this device for thirty days. tick it on the machine you actually work from and
owlette stops asking for a code there for a month. signing out doesn't clear it —
turning two-factor off does, and so does an admin reset.

## [b07] your first site
**SCREEN:** the dashboard for a brand-new account — the "getting started" card with "step 1: create your first site". Click it → the create dialog: site name ("NYC Office"), the auto-generated site ID with its green available check, "create site". The card re-renders into the download/install steps.
**NOTE:** needs the zero-site account from b01's note — this empty state only renders when the user has no sites at all.
**VOICEOVER:**
first dashboard, and it's empty on purpose — step one is a site. a site is just a
place: an office, a studio, a production floor. machines live inside it, so give
it the name you'd say out loud. owlette generates the id for you — change it if
you like — then create the site.

## [b08] the site's clock
**SCREEN:** the header site switcher → "manage sites" → the pencil "edit site" on the new row → the timezone picker. Show the timezone column before and after.
**VOICEOVER:**
that dialog never asks about the site's clock. it quietly takes the timezone of
the browser you made it in — wrong the moment your machines live somewhere else.
fix it now: site switcher, manage sites, then the pencil. the dashboard reads
this site's times on that clock, from schedule editors to log windows — and each
machine still keeps its own clock, so set both right.

## [b09] locked out, and what's next
**SCREEN:** `/admin/users`, the row menu open with "reset 2FA..." highlighted, then the confirm dialog. Cut back to the getting-started card, now showing "step 1: download owlette agent".
**VOICEOVER:**
last thing — locked out. a backup code gets you straight back in. lost those too,
and a superadmin can reset two-factor on your row in admin users: it strips every
factor, revokes your trusted devices, and drops you back on this setup screen at
the next sign-in. [warm] account done. next up, getting owlette onto a machine
and pairing it with this site.
