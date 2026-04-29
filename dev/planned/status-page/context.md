# status page — context
**Last updated**: 2026-04-26

## problem statement

owlette has no public-facing system status indicator. when a customer's agent goes offline, an api call 5xxs, or a webhook fails to deliver, the customer has no way to tell whether it's their problem or ours. internally, oncall has no canonical place to publish "we know about this, eta 30min" updates during an incident.

this lands as the api-sprint and roost-public-api endpoints get traffic from external integrations — the moment a 3rd-party developer hits a 503, they need a place to look first. without a status page, every transient hiccup becomes a support ticket.

## scope

a public status page at `status.owlette.app` that shows:

1. **overall system health** — green/yellow/red banner ("all systems operational" / "partial outage" / "major outage")
2. **component-level status** — each major surface (dashboard, api, agent registry, webhook delivery, r2 uploads, firestore reads, cortex chat) with its own indicator
3. **active incidents** — what's wrong, when it started, what we're doing, eta if known
4. **incident history** — last ~90 days of incidents with postmortem links where available
5. **uptime numbers** — 30/60/90 day uptime per component
6. **subscriptions** — email/webhook for status changes (optional but cheap to ship)
7. **scheduled maintenance** — planned downtime announcements with start/end times

## design principles

1. **3rd-party first, self-hosted later**. ship a hosted status page (instatus or better stack) on day one with a subdomain (`status.owlette.app`). evaluate self-built only if cost or feature limits become a real problem. building a status page from scratch is 2-4 weeks; using a hosted service is 1-2 days.
2. **synthetic uptime + real signals**. ship synthetic checks (curl every 60s against `/api/whoami`, `/api/version`, etc.) on day one. plug in real internal signals (firestore latency, r2 5xx rate) over time as we instrument them.
3. **operators publish, system reads**. incidents are human-curated — an oncall person publishes an update during an incident, the page reads it. don't try to auto-detect incidents (false positives ruin the signal).
4. **public read, admin write**. no auth on the status page itself — it must work even when our auth is broken. updates published from a separate admin view (or the vendor's web ui).
5. **cheap to be wrong**. start with a small set of components. add more only when they have a clear "this could break independently" story. fewer green dots is better than too many that confuse customers.

## key decisions (locked)

1. **vendor selection: instatus**. $20/mo, custom subdomain, email + webhook subscribers, public api, 90-day history, no per-component pricing. better stack is comparable but bundles uptime monitoring we don't need (we already have synthetic checks via railway/cron). atlassian statuspage is enterprise-priced ($29-99/mo). instatus has the cleanest free-tier path if we ever need to start.
2. **subdomain: `status.owlette.app`**. dns + ssl handled by instatus.
3. **no integration with the dashboard initially**. dashboard links to `status.owlette.app` in the footer. inline incident banners inside the dashboard are a v2 concern.
4. **synthetic uptime via existing cron infra**. railway already runs cron jobs. a 60s `pingHealthCheck` cron writes results to firestore and calls the Instatus component-status API when state changes.
5. **components list (initial)** — 7 components, deliberately small:
   - dashboard (`https://owlette.app`)
   - api (`/api/whoami`, `/api/version`)
   - agent registry (heartbeat ingest)
   - webhook delivery (last hour delivery success rate ≥95%)
   - r2 uploads (chunk upload p99 ≤ slo)
   - firestore (read latency p99 ≤ 500ms)
   - cortex chat (sse stream success rate ≥95%)
6. **incident severity levels** — 3 tiers: `investigating` (yellow), `identified` (yellow), `monitoring/resolved` (green). don't add severity-by-impact (low/medium/high) — confuses customers.
7. **no postmortems in v1**. an "incidents" section will list past events but not link to writeups. add postmortem links once we actually write any.
8. **no public api in v1** — instatus has one if we want to programmatically post updates from internal tooling. defer until proven need.

## key files (create / modify)

### create

Public API W5.1 has already created the autonomous foundation files: `web/lib/healthChecks.server.ts`, `web/lib/instatusClient.ts`, `web/app/api/cron/status-ping/route.ts`, focused tests, and `docs/api/status-uptime.md`. The remaining new files in this section are still needed after vendor setup.
- `web/lib/healthChecks.server.ts` (new) — internal healthcheck functions returning `{component, ok, latency_ms}` for each tracked component.
- `web/app/api/cron/status-ping/route.ts` (new) — railway cron handler, runs every 60s, calls each healthcheck, posts Instatus component-status updates on state change.
- `dev/active/status-page/reference/instatus-config.md` (new) — vendor setup notes (component ids, webhook urls, email template, dns record).
- `dev/active/status-page/reference/runbook.md` (new) — how to publish an incident: which dashboard, what to say, when to update.

### modify
- `web/components/Footer.tsx` (or wherever the global footer lives) — add "system status" link to `https://status.owlette.app`.
- `docs/changelog.md` — entry under unreleased: "added status page at status.owlette.app".

### do not touch
- existing rate-limit/audit infra — status page healthchecks should be excluded from rate limiting (use a dedicated bypass header or hardcoded path allowlist).
- firestore rules — healthcheck reads are server-side only (cron uses admin sdk).

## dependencies on existing infrastructure

Public API W5.1 can record local pings before vendor setup, but external incident visibility remains blocked until `status.owlette.app` resolves and the Instatus page/component ids are configured.

- **railway cron** — already configured for other cron jobs. add a new entry for `/api/cron/status-ping` every 60s.
- **firestore** — write a `status_pings` collection for historical pings; instatus is the source of truth for the public page.
- **instatus account** — $20/mo. one-time setup: create components, record component ids/status update endpoint details, and configure subdomain dns.

## out of scope for this plan

- **automated incident detection** — false-positive risk too high. operators decide what's an incident.
- **dashboard inline incident banners** — v2; banner inside the dashboard surfaces "currently degraded" state. defer until we have ≥3 customer reports of "i didn't know there was an outage."
- **mobile app push notifications** — not building a mobile app yet.
- **public-facing incident postmortems** — write postmortems internally first; public versions follow once we have a few good ones.
- **slo/sla pages** — separate doc; status page is uptime + incidents only.
- **performance dashboards** — status page is binary up/down per component. detailed graphs (latency over time, error rate) are a separate observability concern.
- **self-hosted status page** — defer indefinitely. revisit if instatus pricing or feature limits become a real problem.

## success criteria

1. `status.owlette.app` resolves and shows the 7-component list with current status.
2. when the api `/api/whoami` returns 5xx for >2 consecutive synthetic checks, the api component flips to "degraded" within 2 minutes.
3. an oncall operator can publish an incident update from the instatus admin ui in <2 minutes during a real incident.
4. footer link from `owlette.app` and `dev.owlette.app` points at the status page.
5. email subscribers get notified within 1 minute of an operator-published incident.
6. one full end-to-end test: simulate an api outage (kill rate-limit middleware via env var), confirm component flips, restore, confirm it goes green.
