# billing runbook

Operator reference for owlette's billing system: the 14-day trial, Stripe subscriptions, metered
usage, and the read-only lockout. Written for whoever is on the other end of a "my invoice is wrong"
or "our fleet went read-only" message.

Customer-facing counterpart: [billing](../../web/content/docs/dashboard/billing.mdx), published at
`owlette.app/docs/dashboard/billing`. Anything told to a customer should agree with that page.
Design source of truth: `dev/active/billing-system/plan.md` (lockout matrix, "decisions pinned
during implementation") and its `tasks.md`.

---

## architecture one-pager

### who is authoritative for what

- **Firestore is authoritative for the trial.** No card is collected to start a trial, so no Stripe
  subscription exists during it. The clock is `customers/{uid}.trialEndsAt`.
- **Stripe is authoritative once a subscription exists.** Webhooks mirror subscription status,
  invoices, and the payment method into Firestore for fast reads. Firestore is a cache from that
  point on; when the two disagree, Stripe wins and the mirror is the bug.
- **Never read `customers/{uid}.billingState` directly to make a decision.** It is a cached mirror.
  `resolveBillingState()` in `web/lib/billing/billingState.ts` is the only correct answer, and every
  gate goes through it.

### state resolution

`resolveBillingState(customer, now)`:

| stored state | resolves to |
|---|---|
| `subscriptionStatus` is `active` or `past_due` | `active` |
| `subscriptionStatus` is `canceled` | `canceled` |
| `subscriptionStatus` is `incomplete`, `null`, absent, or unrecognised | falls through to the trial clock |
| no `customers/{uid}` doc at all | `trialing` — fails open; the account predates wave 0.1 and the backfill |
| `trialEndsAt` is `null` | `trialing` — the pre-go-live sentinel, **not** "expired" |
| `trialEndsAt` is in the future | `trialing` |
| `trialEndsAt` is now or in the past | `expired` |
| `trialEndsAt` is unparseable | `trialing` — fails open on purpose |

`past_due` deliberately resolves to `active`: Stripe's dunning owns the recovery window, and cutting
service on the first failed charge punishes an expired card rather than a non-paying customer. When
dunning gives up, Stripe moves the subscription to `canceled`, and that lands here as a lockout.

`trialing` grants the **pro** feature set account-wide. A trialing account can never see a
`tier_insufficient`.

### firestore paths

| path | written by | contents |
|---|---|---|
| `customers/{uid}` | signup, webhook handler, trial cron | `stripeCustomerId`, `subscriptionId`, `subscriptionStatus`, `subscriptionTier`, `trialEndsAt`, `billingState`, `currentPeriodEnd`, `defaultPaymentMethod`, `taxId`, `trialEmails.*`, `alertEmailsDisabledAt` |
| `billing/{uid}/invoices/{invoiceId}` | webhook handler | invoice mirror for in-app history |
| `billing/{uid}/usage/{YYYY-MM-DD}` | usage cron | per-site measurements, account totals, and the `meterEvents` dedupe ledger |
| `billing/{uid}/stripe_events/{eventId}` | webhook handler | claim-first dedupe ledger |
| `stripe_events/{eventId}` (top level) | webhook handler | same ledger for events whose customer could not be attributed |
| `sites/{siteId}` | `createSite`, webhook handler | `tier` (`core` / `pro`), `tierUpgradedAt` |
| `sites/{siteId}/roost/quota` | roost reconcile | `usedBytes`, `planLimitBytes` (a one-off grant overrides the tier constant) |
| `config/billing` | task 5.1, by hand | `{ goLiveAt }` — deployment-wide; drives the announcement banner |
| `sites/{siteId}/audit_log` | `authorizedSiteHandler` | lockout denials, `denyReason: 'billing_locked'` |

The billing customer is the **site-owner user's uid**. There is no org entity in this codebase; do
not add one to satisfy the plan's original `customers/{orgId}` wording.

### webhook flow

`POST /api/billing/stripe-webhook` (`web/app/api/billing/stripe-webhook/route.ts`):

1. Verify the signature against `STRIPE_WEBHOOK_SECRET`, falling back to `STRIPE_WEBHOOK_SECRET_TEST`.
   Missing header or bad signature -> `400`. Missing secret -> `400`. Stripe SDK unconfigured ->
   **`500`, deliberately**, so Stripe retries and holds the event rather than discarding it.
2. Resolve the owlette uid: `metadata.uid` on the event object, then on the expanded customer, then a
   `customers where stripeCustomerId ==` query.
3. **Claim the event id** with a Firestore `create()` on the ledger doc. An `ALREADY_EXISTS` means a
   replay -> outcome `duplicate`, answer `200`, do nothing.
4. Dispatch to the handler. On a thrown fault the claim is released and the route answers `500` so
   Stripe retries.
5. Mark the ledger doc with the final outcome and answer `200`.

Handled event types (8): `customer.subscription.created` / `.updated` / `.deleted`,
`invoice.created` / `.finalized` / `.paid` / `.payment_failed`, `customer.updated`. Anything else
returns outcome `ignored` with no ledger entry.

Outcomes, all of which answer `200`: `processed`, `duplicate`, `unknown_customer`, `ignored`. Only a
thrown fault produces a `500`.

Pinned behaviours worth knowing before you debug an "impossible" state:

- An unrecognised Stripe subscription status normalises to `incomplete` — never `active`, never
  `canceled`. It falls through to the trial clock instead of fabricating a cancellation.
- `invoice.payment_failed` promotes to `past_due` **only** from a stored `active`. A first-invoice
  failure on an `incomplete` subscription must not gain entitlement through `past_due` -> `active`.
- Price -> tier resolution: pro wins across line items, and an unmapped price omits
  `subscriptionTier` rather than writing `null`. An unconfigured price env var can never silently
  downgrade a paying account.
- Site tier stamping compares the **raw stored** `tier` field, not the resolved value, so legacy
  sites without the field still get stamped.

### the two crons

Both are `GET`, both authenticate with `X-Cron-Secret: <CRON_SECRET>`, both are registered per
environment on **cron-job.org** (not Railway, not Cloud Scheduler). Neither takes a dry-run flag.

| route | schedule | does |
|---|---|---|
| `/api/cron/billing-trial-lifecycle` | daily | re-mirrors `billingState`, sends the day-10 / day-13 / expiry emails, stamps and clears `alertEmailsDisabledAt` |
| `/api/cron/billing-usage-report` | daily 03:00 UTC | measures machines and roost storage for every subscribed account and posts meter events to Stripe |

Both fail **silently** if unscheduled: trials never expire, reminder emails never send, and Stripe
meters receive no usage, so invoices bill zero. Confirm a `200` per environment after registering.
See the scheduled-endpoints table in `web/content/docs/setup/web-deployment.mdx`.

Success bodies:

```json
// billing-trial-lifecycle
{"ok":true,"processed":312,"expired":4,
 "emailsSent":{"day10":2,"day13":1,"expired":4},"alertCutoffs":1,"errors":0}

// billing-usage-report
{"ok":true,"period":"2026-08-01","mode":"live",
 "customers":{"scanned":48,"eligible":47,"failed":0},
 "meterEvents":{"sent":141,"alreadyReported":0},
 "totals":{"activeMachines":263,"coreMachines":31,"proMachines":244,"storageOverageGb":0},
 "failures":[]}
```

`"skipped":"unconfigured"` on the usage report means no Stripe key resolved. That is a clean no-op,
not a failure.

### stripe meters

Usage is **Billing Meters v1 meter events**. The legacy usage-records API does not exist in
`stripe@22` — it was removed from the SDK, not deprecated.

| `event_name` | aggregation | backing price env var |
|---|---|---|
| `owlette_core_machines` | **`last`** | `STRIPE_PRICE_CORE_MACHINE` |
| `owlette_pro_machines` | **`last`** | `STRIPE_PRICE_PRO_MACHINE` |
| `owlette_roost_storage_overage_gb` | **`last`** | `STRIPE_PRICE_PRO_STORAGE_OVERAGE` |

> **`default_aggregation.formula` must be `last` on all three meters.** The cron posts a *daily
> snapshot*, not a delta. A meter created with `sum` bills roughly **30x** the real machine count.
> This is the single most expensive mistake available in this system — verify it in both Stripe
> modes before any account is charged.

Three meters, not two: core and pro machines bill at different rates, so a shared meter would charge
a mixed account for its machines at both rates.

Every eligible account reports **all three meters every day, including zeros**. Under `last`
aggregation a skipped report leaves yesterday's value standing as the period's answer, so an account
that decommissioned its fleet would keep paying for it.

Dedupe is two-layered and neither layer is redundant. First, a deterministic `identifier` of
`{event_name}-{uid}-{period}` — Stripe's own deduplication key for meter events, which it drops
repeats against over a rolling window (the contract note in `usageReport.server.ts` puts that window
at at least 24 hours). Second, the Firestore ledger at
`billing/{uid}/usage/{YYYY-MM-DD}.meterEvents`. The ledger is written **after** Stripe accepts, so a
crash in between re-posts the event and Stripe's identifier absorbs it.

Note that the HTTP `Idempotency-Key` header is **not** the deduplication mechanism for meter events,
which is why no `idempotencyKey` request option is set at the call site. Do not add one.

---

## current state — what is not wired yet

Check this list before diagnosing anything as broken. As of the wave-3 landing:

| gap | consequence |
|---|---|
| **Stripe account not provisioned** (task 1.1) | no keys resolve; checkout and portal answer `503 billing_unavailable`, the usage cron returns `skipped: 'unconfigured'`, and the billing tab hides its action buttons behind "billing setup in progress" |
| **Crons not registered on cron-job.org** | both billing routes exist and never fire |
| **Backfill scripts not run** | `scripts/backfill-customers.mjs` and `scripts/backfill-stripe-customers.mjs` have not been executed in any environment. Accounts that predate wave 0.1 therefore have **no `customers/{uid}` doc at all**, which resolves to `trialing` indefinitely — the fail-open path, not the `null` sentinel |
| ~~New signups already carry a live trial clock~~ **RESOLVED 2026-08-01** | `bootstrapUser` now mints the `null` sentinel until `config/billing.goLiveAt` exists and has passed — a pre-go-live signup can never resolve `expired`. Post-go-live signups self-start their 14-day clock; task 5.3 stamps everyone minted before |
| ~~No admin billing override~~ **RESOLVED 2026-08-01** (task 4.1 landed) | `/admin/customers` UI + `POST /api/admin/billing/customers/{uid}` — see "trial extension / comp" below |
| **Roost storage metering not wired** | `sites/{siteId}/roost/quota.usedBytes` is not populated from the object store, so overage always measures 0 and always reports 0 to Stripe |
| **No 110% overage cap** | `functions/src/lib/quotaLogic.ts` hard-stops uploads at **100%** of the included allowance (`402 quota_exceeded` / `quota_would_exceed`). Overage cannot currently accrue through the admission path at all |
| **Webhook *delivery* is not billing-gated** | the plan's lockout matrix says delivery pauses for an expired account; the dispatch paths (`web/lib/webhookSender.server.ts`, `functions/src/webhookDispatch.ts`) do not consult billing state. Only webhook *creation* is pro-gated. Do not tell a customer their webhooks stop |
| **Core's one-site limit is not enforced** | nothing prevents a core subscriber creating more sites; each additional site is simply billed at $10/machine |
| **No self-service tier change** | `POST /api/billing/checkout` answers `409 already_subscribed` for an active subscription. Moving a customer between core and pro is a Stripe-side subscription edit |

---

## failure modes

### 1. failed payment / dunning

**Symptom.** `invoice.payment_failed` in the Stripe dashboard; `customers/{uid}.subscriptionStatus`
becomes `past_due`.

**What the customer experiences.** Nothing. `past_due` resolves to `active`, so the fleet keeps
working and usage keeps being reported. Both halves are deliberate: cutting service off the first
failed charge punishes an expired card rather than a non-paying customer, and the invoice that
dunning is trying to collect needs this period's usage on it.

**Response.**

1. Confirm the state in Stripe (Customers -> the customer -> Subscriptions). Stripe's retry schedule
   and dunning emails are configured Stripe-side; owlette sends nothing of its own for this.
2. Check that owlette saw it: `customers/{uid}.subscriptionStatus`. Expect `past_due` — but only if
   the stored status was `active` first. A **first-invoice** failure on an `incomplete` subscription
   deliberately stays `incomplete`, because promoting it would hand entitlement to a subscription
   that has never been paid for. `active` still standing while Stripe says past due is the real
   signal that the webhook did not land — go to failure mode 2.
3. If the customer updates their card, Stripe retries and `invoice.paid` flips the status back. No
   owlette-side action.
4. If dunning exhausts, Stripe cancels the subscription, `customer.subscription.deleted` arrives, and
   the account moves to `canceled` — the same read-only lockout as an expired trial. Reactivation is
   a fresh checkout, not a Stripe-side un-cancel, because the checkout flow is what re-stamps site
   tiers.

**Do not** hand-edit `subscriptionStatus` to keep a customer working. Extend the trial clock instead
(failure mode 3) — that is the mechanism designed to grant access without lying about Stripe state.

### 2. webhook signature failures or missed events

**Symptom.** Stripe's webhook log shows `400`s or `500`s; Firestore mirrors are stale (a subscription
exists in Stripe but `customers/{uid}` still reads `trialing`).

**Triage by status code.**

| status | meaning | fix |
|---|---|---|
| `400 Missing signature` | something other than Stripe posted to the endpoint | ignore, or check for a misconfigured proxy |
| `400 Webhook not configured` | neither `STRIPE_WEBHOOK_SECRET` nor `STRIPE_WEBHOOK_SECRET_TEST` is set on the origin | set the secret and redeploy |
| `400 Invalid signature` | wrong secret for the mode, or a body-mutating proxy | verify the secret matches the endpoint in that Stripe mode. On prod, **both origins must hold the same value** — one Stripe endpoint (`owlette.app`) is served by Railway and Vercel behind the load balancer, so a mismatch makes every webhook `400` after a failover |
| `500 Stripe not configured` | no secret key on the origin | set `STRIPE_SECRET_KEY`. Stripe will retry, so no events are lost |
| `500 Webhook handling failed` | the handler threw (usually Firestore) | check host logs; Stripe retries on its own schedule |

**Replaying an event.** Open the endpoint's event log in the Stripe dashboard and use its resend
action on the individual event.

> A resend carries the **same event id**, and the dedupe ledger is claim-first. If the ledger doc
> still exists — i.e. the original attempt got as far as claiming the id (step 3) — the resend
> answers `200 duplicate` and changes nothing. To genuinely re-process, delete the ledger doc first:
> `billing/{uid}/stripe_events/{eventId}`, then resend.

Two cases replay cleanly without touching the ledger: an attempt that failed *before* the claim
(signature rejection, unconfigured SDK) never wrote a doc, and an attempt whose handler *threw* had
its claim released on the way out. Only a claim that reached a final outcome blocks a replay.

**`unknown_customer` outcomes.** The event was acknowledged with no state change because no owlette
account could be attributed to the Stripe customer. Its ledger doc is at the **top-level**
`stripe_events/{eventId}`, not under `billing/{uid}`. Fix the linkage — set `metadata.uid` on the
Stripe customer, or write `stripeCustomerId` onto `customers/{uid}` — then resend. The replay will
resolve the uid, claim a *different* ledger path, and process normally; no ledger deletion is needed
for this case.

**Reconstructing a missed window.** Stripe's event log only reaches back a limited retention window —
check what is actually still listed before promising a customer a full replay. Filter by type and
resend in chronological order. Subscription handlers are last-write-wins on the customer doc, so
ordering matters more than completeness: resending only the most recent
`customer.subscription.updated` is usually enough to correct a stale mirror.

### 3. trial extension / comp

**Use the admin UI** (task 4.1, landed): `/admin/customers` (superadmin-only) — search the account,
then row actions for **extend trial**, **set tier (comp)**, and **force-expire**, each behind a
confirm dialog. API equivalent: `POST /api/admin/billing/customers/{uid}`. Every operation is
audit-logged (`billing_mutated` in the platform audit tenant) and rewrites `billingState` through
the resolver in a transaction.

What the override does for you (so you don't hand-fix):

- **Extend trial** anchors at `max(current end, now)` — "+7 days" on a long-lapsed account grants
  seven usable days. It also clears any `trialEmails.*` reminder markers whose recomputed milestone
  is back in the future (the re-extended account gets its new day-13 warning) and clears
  `alertEmailsDisabledAt` when the 30-day grace no longer applies. A relative extension on the
  `null` pre-go-live sentinel is refused (it would impose a deadline on an unbounded trial); set an
  explicit date instead.
- **Comp** writes `subscriptionTier` plus provenance (`compedTier`/`compedAt`/`compedBy`/`compNote`)
  so a later real Stripe subscription automatically falsifies the comp claim.
- **Force-expire** moves the clock; if a live Stripe subscription exists the subscription still wins
  (state stays `active`) and the response says so — cancel in Stripe for those.

The change takes effect **immediately** — every gate resolves state per request. Direct Firestore
console edits remain possible in an emergency but leave no audit trail; if you must, never set
`trialEndsAt: null` (reserved pre-go-live sentinel — task 5.3 stamps a real clock over it), and log
the edit in a support ticket.

### 4. refunds

Refunds are issued entirely in the Stripe dashboard (Payments -> the payment -> **Refund**). There is
no owlette-side refund flow and none is planned.

**owlette-side state to check afterwards:**

1. `billing/{uid}/invoices/{invoiceId}` — the mirror updates from `invoice.*` events. A refund alone
   does not always emit one, so the mirror may still show the pre-refund figures. It is display-only;
   the portal shows the customer the truth.
2. `customers/{uid}.subscriptionStatus` — a refund does not cancel a subscription. If the customer
   also wants to stop, cancel the subscription in Stripe and let
   `customer.subscription.deleted` move them to `canceled`.
3. `billing/{uid}/usage/{period}` — a refund does not retract meter events. If the refund was issued
   because usage was over-reported, correct the *cause* (see failure mode 5) or the same over-report
   lands on the next invoice.

For a duplicate charge caused by a double subscription, check for two `customers` docs pointing at
the same `stripeCustomerId`. The adoption rules make that unlikely — a Stripe customer carrying a
different `metadata.uid` is never adopted — but a manually created Stripe customer can bypass them.

### 5. meter misconfiguration

**The 30x hazard.** A meter created with `default_aggregation.formula: 'sum'` instead of `'last'`
sums every daily snapshot over the period. A 10-machine pro account bills as ~300 machines: $15,000
instead of $500.

**Symptoms.**

- Stripe's upcoming invoice shows a machine quantity roughly equal to (real machines x days elapsed
  in the period).
- The quantity grows every day at a constant rate instead of tracking the fleet.
- `billing/{uid}/usage/{YYYY-MM-DD}.totals` shows the correct, small number. **The mirror being right
  while Stripe is wrong is the signature of this bug** — it means we reported correctly and the meter
  aggregated wrongly.

**Response.**

1. Check the meter's aggregation in Stripe. Treat it as fixed at creation — if the dashboard offers
   no way to change it, it is not editable and the meter has to be replaced.
2. Create a replacement meter with the correct `event_name` and `formula: 'last'`. `event_name` is
   single-use across an account's meters (Stripe rejects a second meter claiming the same name), so
   the broken meter must be deactivated first.
3. Re-point the price at the new meter and update the `STRIPE_PRICE_*` env var if the price id
   changed.
4. Issue credit notes or refunds for anything already invoiced.
5. Verify with a single day's cron run: the reported value in `billing/{uid}/usage/{period}` and the
   pending quantity on the Stripe meter must match exactly.

**Other meter faults.**

- *No usage at all on the invoice* — the cron is unregistered, `skipped: 'unconfigured'` is being
  returned, or the meter `event_name` does not match `MACHINE_METER_EVENT_NAMES` /
  `STORAGE_OVERAGE_METER_EVENT_NAME` in `web/lib/billing/usageReport.server.ts`.
- *Machines billed at both rates* — core and pro machines are sharing one meter. There must be three
  meters.
- *Usage attributed to the wrong customer* — the meter's `customer_mapping.event_payload_key` is not
  the default `stripe_customer_id`, or `value_settings.event_payload_key` is not `value`.
- *A single account missing from an otherwise healthy run* — check the `failures` array in the cron
  response. One failing account never aborts the run; it retries the next day.

---

## env var map

Canonical registry: `scripts/env-manifest.json`. Manage with `node scripts/sync-env.mjs`
(`status` / `check` / `diff` / `sync <target>`); full workflow in `.claude/skills/env-management.md`.

| key | class | targets | notes |
|---|---|---|---|
| `STRIPE_SECRET_KEY` | must-match | railway-prod, vercel-prod | live-mode key. Both prod origins must hold the **same** key, or a failover mid-checkout mints customers in a different Stripe account than the webhook mirrors |
| `STRIPE_SECRET_KEY_TEST` | secret | railway-dev | test-mode key. Read only when `STRIPE_SECRET_KEY` is unset — never set both on one target |
| `STRIPE_WEBHOOK_SECRET` | must-match | railway-prod, vercel-prod | live signing secret. One Stripe endpoint (`owlette.app`) is served by both origins behind the load balancer, so a mismatch `400`s every webhook on failover |
| `STRIPE_WEBHOOK_SECRET_TEST` | secret | railway-dev | test signing secret. The route prefers the live name and falls back to this, so dev can never verify a live event |
| `STRIPE_PRICE_CORE_MACHINE` | config | railway-dev, railway-prod, vercel-prod | metered price id, $10/machine/month. **Mode-specific value**: dev holds the Test id, prod the Live id, under the same key name |
| `STRIPE_PRICE_PRO_MACHINE` | config | railway-dev, railway-prod, vercel-prod | metered price id, $50/machine/month. Mode-specific value |
| `STRIPE_PRICE_PRO_STORAGE_OVERAGE` | config | railway-dev, railway-prod, vercel-prod | metered price id, $0.05/GB. Mode-specific value; maps to the pro tier in the webhook's price -> tier resolution |
| `CRON_SECRET` | secret | railway-dev, railway-prod, vercel-prod | both billing crons authenticate with `X-Cron-Secret`. Per-environment value |
| `RESEND_API_KEY` | secret | railway-dev, railway-prod, vercel-prod | trial reminder emails. Absent, the trial cron still mirrors state and simply skips the sends — milestones stay unstamped and retry once mail is configured |
| `NEXT_PUBLIC_BASE_URL` | public | railway-prod, vercel-prod | checkout / portal return URLs and the deep-link in trial emails. Never derived from a request header; unset, the code falls back to `owlette.app` / `dev.owlette.app` by environment |

Mode is decided by the **key's own prefix**, not by which variable supplied it: `sk_live_` / `rk_live_`
read as live, anything else as test. `stripeMode()` returns `live` / `test` / `unconfigured` and is
safe to log. The secret key itself is never logged, in any mode, at any level.

Checkout attaches one price for core (`STRIPE_PRICE_CORE_MACHINE`) and two for pro (machine +
storage overage). Resolution is all-or-nothing: a missing price id for the requested tier answers
`503 billing_unavailable` and logs the missing **names** only.

---

## go-live sequence

Full steps and ordering: wave 5 of `dev/active/billing-system/tasks.md`. Summary of what an operator
touches, in order:

1. **5.1 — announce (T-30).** Mass email to every account owner, then write
   `config/billing { goLiveAt: <T0> }` to switch the dashboard banner into its announcement state.
   Also add `billing` to `RESERVED_SITE_IDS` in `web/lib/validators.ts` while you are there.
2. **5.2 — enable Stripe live mode.** Flip the env vars from test to live. Smoke test with a real
   card ($1 charge, then refund) before any customer can reach checkout. Verify all three meters
   exist in **live** mode with `last` aggregation.
3. **5.3 — T0: start the clocks.** Run `scripts/billing-go-live.mjs` (dry-run first). It stamps
   `trialEndsAt = T0 + 14d` on every customer without a subscription, stamps an explicit `tier` on
   every site doc that lacks one, and emails owners their trial end date. Take a backup snapshot of
   `customers` and `sites` before this runs.
4. **5.4 — flip the copy.** Marketing surfaces move from "free during beta" to real prices plus "free
   14-day trial". The pinned e2e specs assert the beta copy and gate the deploy, so their updates
   must land in the same commit. Run `/preflight` before pushing.

Prerequisite for all of it: the backfills (`scripts/backfill-customers.mjs`, then
`scripts/backfill-stripe-customers.mjs`) must have run in that environment. Both take
`--env=dev|prod` and `--dry-run`; both prompt for confirmation on a non-dry-run against prod, and the
Stripe one prompts again when the key resolves to live mode.

---

## support faq

**How do I comp an account?**
`/admin/customers` → the account → **set tier** (writes `subscriptionTier` plus
`compedTier`/`compedAt`/`compedBy`/`compNote` provenance, audit-logged). Effective immediately. A
later real Stripe subscription automatically supersedes the comp.

**How do I un-expire an account?**
`/admin/customers` → **extend trial** (anchors at `max(current end, now)`, re-arms reminder emails,
clears the alert mute when applicable — audit-logged). Access returns on the next request. If the
account has a Stripe subscription, the subscription outranks the trial clock — fix it in Stripe
instead.

If they are simply paying, the honest path is to have them choose a plan: checkout works from an
expired state exactly as it does from a trialing one, and it is what stamps site tiers correctly.

**A customer says their fleet went read-only. What do I check?**

1. `resolveBillingState()` on their `customers/{uid}` doc — `expired` or `canceled` is the lockout.
2. Whether the blocked action is even in scope. The lockout covers process control, machine and
   process config, deploys, and roost distribution. Viewing, member management, agent-token
   revocation, machine removal, and uninstalls all stay open by design.
3. `sites/{siteId}/audit_log` for entries with `denyReason: 'billing_locked'` — they carry the
   capability, route, method, and resolved billing state, which pins down exactly which call was
   refused.

**A customer says their API key stopped working.**

- `402` with code `trial_expired` — account-level lockout. They need a plan.
- `403` with code `tier_insufficient` — a core subscription hitting a pro-only operation (roost and
  chunk endpoints, webhook creation, API key creation). Listing and revoking stay open on purpose.
- Neither is retryable until the underlying state changes. Codes are documented at
  `owlette.app/docs/api/errors`.

**Where are the audit trails?**

| what | where |
|---|---|
| lockout denials | `sites/{siteId}/audit_log`, `denyReason: 'billing_locked'`, `outcome: 'deny'` |
| every Stripe event we received | `billing/{uid}/stripe_events/{eventId}` (or top-level `stripe_events/` when unattributed) — id, type, receipt time, outcome |
| invoices | `billing/{uid}/invoices/{invoiceId}`, and authoritatively in Stripe |
| daily usage we reported | `billing/{uid}/usage/{YYYY-MM-DD}` — per-site measurements plus the exact meter values sent |
| trial emails sent | `customers/{uid}.trialEmails.{day10At,day13At,expiredAt}` |
| manual billing edits | nowhere — record them in the ticket yourself |

Pro-tier denials on the public API (`requirePro` / `requireProAccount`) are **not** audited; they
surface only as the `403` on the wire.

**A customer asks whether their data was deleted.**
No. Non-payment never deletes anything. The only thing that removes data is the ordinary 400-day
retention sweep, which is unrelated to billing and runs identically for paid, trialing, and expired
accounts.

**A customer complains about the 3-machine pro minimum.**
It is a billing floor, not a gate — they can run one machine, they just pay for three ($150/month).
Core has no minimum. Anything beyond that is a pricing conversation: `hey@tridant.io`.
