# App Check rollout runbook

Firebase App Check attests that calls to Firebase services originate from the real
Owlette web app rather than a script hitting Google's APIs directly.

> **scope**: enabling App Check enforcement on **Firebase Authentication only**.
> The client SDK integration already ships (`web/lib/firebase.ts`); everything
> below is console + config work. For the related bot-gate work that covers our
> own API surface, see `web/lib/turnstile.server.ts`.

---

## ⚠️ The one rule: never enforce Cloud Firestore

**Enforcing App Check on Cloud Firestore takes the entire agent fleet offline.**

Agents talk to `https://firestore.googleapis.com/v1` directly over REST
(`agent/src/firestore_rest_client.py`). They authenticate with a Firebase ID
token, but they have no App Check attestation and no way to obtain one — App
Check providers are browser and mobile-app attestations, and there is no
provider a headless Windows service can satisfy. Enforcement rejects every
unverified request with 403, so the moment Firestore enforcement is switched on,
every machine in the fleet stops reporting metrics, stops receiving commands, and
goes offline on the dashboard.

The same reasoning applies to **Cloud Storage** if agents are ever pointed at it
directly (today they upload screenshots through signed URLs, which are unaffected).

Enforcement is configured per product. Enabling it for Authentication does not
enable it anywhere else.

---

## Why Authentication is the right target

`signInWithEmailAndPassword` and `createUserWithEmailAndPassword` are called from
the browser and go straight to Google's `identitytoolkit` endpoint
(`web/contexts/AuthContext.tsx`). Our server is not in that request, which is why
Turnstile could not be placed on the login form — there is no request of ours to
gate. App Check is the only control that reaches it.

Agents are unaffected: they never call `identitytoolkit`. They obtain and refresh
tokens through our own API (`/api/agent/auth/device-code/*`, `/api/agent/auth/refresh`),
which runs server-side on the Admin SDK and is exempt from App Check.

| product | enforce | consequence |
|--|--|--|
| Authentication | ✅ yes | blocks scripted signup / credential stuffing against identitytoolkit |
| Cloud Firestore | ❌ **never** | fleet-wide outage — see above |
| Cloud Storage | ❌ not now | no current need; re-evaluate only with agent impact analysed |

---

## Prerequisites

1. A **reCAPTCHA Enterprise** site key of type *website*, created in Google Cloud
   console for the same project, with `owlette.app` and `dev.owlette.app` in its
   allowed domains. reCAPTCHA Enterprise requires billing to be enabled on the
   project.
2. The web app registered in **Firebase console → App Check** with that key as
   its provider. Register the dev and prod Firebase projects separately
   (`owlette-dev-3838a`, `owlette-prod-90a12`).
3. `NEXT_PUBLIC_FIREBASE_APPCHECK_SITE_KEY` added to `scripts/env-manifest.json`
   (class `public`) and set on `railway-dev`, `railway-prod`, and `vercel-prod`.
   It is inlined at build time, so it must be present **before** the build that
   should send tokens — the same build-vs-runtime split that applies to
   `NEXT_PUBLIC_TURNSTILE_SITE_KEY`.

4. **CSP updated in `web/proxy.ts`.** reCAPTCHA Enterprise is blocked by the
   current policy, and the failure is silent — the widget never loads and every
   client reports unverified. These hosts are deliberately *not* pre-added,
   since allowing them before the feature exists loosens the policy for no
   benefit. Per Google's documented requirements:

   | directive | add |
   |--|--|
   | `script-src` | `https://www.google.com/recaptcha/` (`https://www.gstatic.com/recaptcha/` is already covered by the existing `https://*.gstatic.com`) |
   | `frame-src` | `https://www.google.com/recaptcha/`, `https://recaptcha.google.com/recaptcha/` |
   | `connect-src` | `https://www.google.com/recaptcha/` |

   Verify with DevTools → Console on `/login` after deploying: any
   `Refused to load` entry naming `google.com/recaptcha` means this step is
   incomplete, and the metrics in step 2 will be misleading.

Until step 3 lands, `maybeInitAppCheck()` returns immediately and no tokens are
sent. Nothing changes for users.

---

## Rollout

### 1. Ship token generation (no enforcement)

Set the site key on `railway-dev` first and deploy. Clients begin attaching App
Check tokens. Enforcement is still off, so unverified requests are still served —
there is no user-visible change and no rollback pressure.

### 2. Watch the metrics

Firebase console → App Check → **Request metrics**, per product. Requests are
bucketed as verified / unverified / outdated-client / unknown-origin. Wait until
the **verified** share for Authentication has plateaued.

Do not skip this. The plateau is what tells you no legitimate client population
has been missed. A week of data across a normal usage cycle is a reasonable bar.

Sanity check while waiting: confirm the **Cloud Firestore** panel shows a large
unverified share. That is the agent fleet, and it is the direct evidence for why
Firestore must never be enforced.

### 3. Enforce Authentication on dev

Firebase console → App Check → Authentication → **Enforce**, on the dev project
only. Then verify against `dev.owlette.app`:

- sign in with email + password
- register a new account
- request a password reset
- confirm an agent paired to a dev site stays online and keeps reporting metrics

### 4. Enforce Authentication on prod

Repeat on `owlette-prod-90a12` once dev has been stable. Re-run the same four
checks against `owlette.app`.

---

## Rollback

Enforcement is a toggle and takes effect within minutes. If sign-in breaks:

1. Firebase console → App Check → Authentication → **Unenforce**.
2. Confirm sign-in recovers.
3. Return to the metrics screen before trying again — an enforcement failure
   means a legitimate client population was sending unverified requests.

No deploy or code change is needed to roll back. Leaving the site key configured
is harmless while unenforced.

---

## Verification checklist

- [ ] reCAPTCHA Enterprise key created, domains include `owlette.app` + `dev.owlette.app`
- [ ] App registered in App Check for both Firebase projects
- [ ] `NEXT_PUBLIC_FIREBASE_APPCHECK_SITE_KEY` in the manifest and all three targets
- [ ] Deployed; Request metrics show verified traffic for Authentication
- [ ] Verified share plateaued before enforcing
- [ ] Authentication enforced on dev; sign-in / register / reset all pass
- [ ] An agent on a dev site is still online and reporting
- [ ] Authentication enforced on prod; same checks pass
- [ ] **Firestore enforcement left OFF**
