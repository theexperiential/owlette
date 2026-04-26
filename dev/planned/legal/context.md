# legal + production-readiness — context
**Last updated**: 2026-04-26 | **Status**: Planned (cost-gated)

## problem statement

owlette is engineering-ready to ship roost v2 (project distribution) to external customers, but four production-readiness items require funding that isn't currently available. these items don't block internal use of the platform — they block accepting external customer files, signing the installer for unprompted SmartScreen acceptance, and the legal posture required to operate a public service.

this plan exists to keep these items visible and timeline-tracked so the moment funding lands, work can start without re-planning. all four were originally part of `dev/active/project-distribution-v2/` (waves 0 + 5) and have been deferred here with cross-references.

## scope — 5 items

| # | item | originally | cost | lead time | unlocks |
|---|---|---|---|---|---|
| 1 | lawyer engagement (ToS + privacy + AUP + DMCA) | project-distribution-v2 wave 0.1 | $3-8k | 2-4 weeks | accepting external customer files |
| 2 | insurance (E&O + cyber + media liability) | project-distribution-v2 wave 0.3 | $1.5-5k/yr | days after policy quoted | accepting external customer files |
| 3 | EV code-signing cert (Sectigo or DigiCert) | project-distribution-v2 wave 0.7 | $400-700/yr | **6-8 weeks** | unprompted installer download (no SmartScreen warning) |
| 4 | authenticode signing of installer | project-distribution-v2 wave 5.9 | autonomous after #3 | days | (depends on #3) |
| 5 | OFAC sanctions screening | project-distribution-v2 wave 0.4 | $100-500/mo + 1 day eng | days after vendor account | accepting public signups (legally required) |

**Total annual cost**: ~$6-21k for legal + insurance + cert + sanctions screening. **Total one-time**: ~$3-8k for lawyer drafting.

## design principles

1. **roost v2 still ships internally without these.** the engineering side of project-distribution-v2 (waves 1-4 + most of 5) can complete and the platform can be used by you + internal/friend users without legal/cert posture. these items only gate **external customer launch**.
2. **EV cert is the longest pole.** 6-8 weeks lead time. when funding lands, start the cert procurement on day 1 in parallel with lawyer engagement.
3. **don't half-ship legal.** ToS + privacy + AUP + DMCA need to be drafted as a coherent package by one firm. piecemealing them invites contradictions.
4. **insurance is fast once policies are quoted.** but quote shopping takes a few weeks. start the conversation with brokers (vouch, embroker, coalition) in parallel with lawyer work.
5. **authenticode signing is a 1-day code task once the cert is in hand.** don't bother spinning up the signing pipeline before the cert exists; it has nothing to test against.

## key decisions (locked)

1. **defer indefinitely until funding is available.** no specific revival date.
2. **roost v2 internal launch can proceed without these.** engineering should not wait.
3. **status page is tracked separately** at `dev/planned/status-page/` (also cost-gated at $20/mo for instatus). same revival trigger.
4. **no halfway measures** — don't try to use a self-hosted cert or community legal templates as substitutes. the SmartScreen reputation system specifically rewards EV certs; community ToS templates create more liability than they avoid.
5. **founder is the responsible party** until a legal/ops hire happens.

## what each item unlocks

### 1. lawyer engagement → ToS / privacy / AUP / DMCA published
- legally accept customer files (without ToS, every uploaded file is a potential liability with no terms-of-use protection)
- DMCA safe harbor (must register a designated agent + publish takedown procedure)
- privacy policy (required by California CCPA, EU GDPR if you ever serve EU customers, basically any consumer-facing service)
- AUP (acceptable use policy — defines what content + workloads are not allowed; gives you grounds to terminate abusive accounts)

### 2. insurance → coverage for accidents
- E&O (errors & omissions): protects against customer claims of harm caused by software bugs
- cyber: protects against breach response costs (notifying affected customers, credit monitoring, forensics)
- media liability: protects against claims that hosted customer content infringed copyright (DMCA safe harbor mitigates but doesn't eliminate)

### 3. EV code-signing cert → unprompted installer downloads
- without it: every download triggers Windows SmartScreen "this file is not commonly downloaded — are you sure?" warning, killing conversion
- with EV: trusted immediately on first download. a regular OV (organization validation) cert is cheaper but takes 30+ days of download traffic to build SmartScreen reputation
- requires hardware token (HSM/USB) for signing operations

### 4. authenticode signing → installer is signed with the cert
- 1-day implementation: hook into the build pipeline to sign the .exe before upload
- runs on every installer release going forward

## key files (when revived)

### create
- `docs/legal/terms-of-service.md` (lawyer-drafted, this plan stores the markdown copy)
- `docs/legal/privacy-policy.md`
- `docs/legal/aup.md`
- `docs/legal/dmca-policy.md` (lawyer-reviewed version of the existing internal SOP)
- `agent/build_installer_full.bat` (modify) — add signtool.exe call after build
- `dev/planned/legal/reference/cert-storage-runbook.md` (new) — how to use the HSM safely

### modify
- `web/app/legal/*` — add the four legal documents as next.js pages
- `agent/owlette_installer.iss` — link to ToS in installer EULA
- `web/components/Footer.tsx` — link to legal pages

## dependencies + ordering when revived

1. **week 0** — pay lawyer retainer + start cert procurement in parallel. brokers contacted for insurance quotes.
2. **week 2-4** — lawyer first draft arrives. insurance quotes back.
3. **week 4-6** — legal review iterations. insurance bound.
4. **week 6-8** — cert arrives in hardware token.
5. **week 8** — authenticode signing wired into build pipeline. installer ships with valid signature.
6. **week 8-10** — legal documents published to dashboard + linked from installer EULA + footer.
7. **week 10+** — external customer launch unblocked.

## out of scope

- **status page** — separate plan at `dev/planned/status-page/`. cost-gated independently.
- **counter-notice flow / subpoena response playbook** (DMCA follow-ups) — wait until the lawyer-drafted policy lands; build the operational tooling on top of that.
- **bug bounty / responsible disclosure program** — separate concern, not deferred from project-distribution-v2.
- **soc 2 / iso 27001** — irrelevant until enterprise customers ask. not in scope here.

## success criteria

1. signed engagement letter with a startup-focused law firm.
2. ToS / privacy / AUP / DMCA published at `owlette.app/legal/*` and linked from footer + installer EULA.
3. insurance certificate of insurance on file (not just quote).
4. EV cert in hsm/kms; test signing of dummy installer succeeds.
5. production installer is signed; passes SmartScreen with no warning on first download.
6. OFAC sanctions screening live on signup flow; blocked-country test signup returns 403.
7. external customer can sign up + accept ToS + use the platform without legal exposure to the company.
