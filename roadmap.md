# owlette roadmap

Roughly prioritized. Not a commitment — just a living list of what's next.

---

## infrastructure / ops

- **Log TTL** — site event logs (`sites/{id}/logs`) and machine logs (`machines/{id}/logs`) have no expiry. Add a cleanup cron to delete entries older than 30-90 days. Low urgency (negligible cost), good hygiene.

- **Reduce single-points-of-failure across the stack.** 2026-05-19 Railway platform outage took both `owlette.app` and `dev.owlette.app` offline simultaneously — *every* API route returned 404, agents went into deep token-refresh backoff, and customers had no operational dashboard. Audit each vendor relationship for what happens when they go down, then prioritize the cheapest reductions in blast radius. Specific lines to think through:
  - **Hosting (Railway)** — currently the entire web app. Cheapest improvement: have a static-fallback page (Cloudflare Worker?) at `owlette.app` that explains the outage + links to a status page, instead of leaving Railway's "Application not found" as the customer-facing message. Bigger move: practice a portability test — can the Next.js app build + deploy on Vercel or Fly.io as a warm standby? No need to dual-deploy continuously, just verify the runbook works.
  - **Firestore + Firebase Auth (GCP)** — agent → web auth flow assumes Firebase. A hard GCP outage is rare but total. Mitigation here is architectural and expensive (multi-cloud identity); document as accepted-risk for now but think about it before scale.
  - **DNS (current provider unknown — Cloudflare?)** — if DNS goes, everything goes. Lowest-hanging fruit: confirm we have a secondary DNS provider configured for `owlette.app` (e.g. Cloudflare + AWS Route 53 on the same zone).
  - **Cron-job.org** — schedules the prod `/api/cron/*` endpoints (see `docs/runbooks/upgrade-2.12.0.md` §1.6). Free-tier, no SLA. If it dies silently we lose health alerts and status pings until manual recovery. Mirror critical schedules on a second provider (GitHub Actions cron is free and reliable) or migrate to Cloudflare Workers cron triggers (also free, better SLA).
  - **Cloudflare R2 + email-decoding edge feature** — R2 is the only object store for roost. Outage = no new content syncs to agents. Recovery design (re-sync from agent local cache) is in scope already, but verify the SLO is right.
  - **Resend (transactional email)** — outage = no alerts delivered. Multi-provider fallback (Postmark / SES as backup) is feasible.
  - **Sentry + Instatus** — observability outages don't take prod down but degrade incident response. Multi-region or self-hosted alternatives possible.

  Action: cut a follow-up issue tagging each line above with effort + value, then schedule one quarter per release window. The goal isn't five-9s — Owlette is fundamentally a control-plane for unattended machines, and a Railway outage means customers can't issue *new* commands but existing agents keep running their workloads. So the bar is "graceful degradation + clear customer comms during outages," not "100% uptime."

---

## notifications

- **SMS alerts** — email is live. SMS (via Twilio or similar) is the main gap vs sudoSignals Standard tier.

---

## observability

- **Process reports** — weekly/monthly uptime and crash summaries per machine or site, delivered by email.

---

## support

- **Send logs** — "Send logs to Owlette" button on the agent tray/GUI that pushes recent agent logs to Firestore, viewable in the dashboard. Eliminates back-and-forth asking users to find log files.
- **In-app chat** — embed a support chat widget (Intercom, Crisp, or Plain) in the web dashboard. Automatically attach user + machine context so support has full visibility without asking.

---

## testing

- **Cortex API route tests** — complex async flows (tool execution, streaming, conversation management). Needs mocking for SSE streams and tool call chains.
- **Alert system tests** — email dispatch + webhook dispatch for process crash alerts and threshold breaches. Mock external HTTP calls, verify retry logic.
- **Screenshot API tests** — storage CRUD, concurrent upload handling, history cleanup. Low risk, good for expanding coverage.
- **Agent service main loop tests** — `owlette_service.py` (4400 lines). Needs integration testing framework with mocked Firestore + psutil. Large effort, high value.
- **React component/hook tests** — hooks (`web/hooks/`), pages, contexts. Requires React Testing Library + Firebase context providers.
- **E2E tests** — Playwright for critical user flows (login, add machine, dashboard). Requires test Firebase project with seeded data.

---

## billing

- **Stripe integration** — two tiers post-beta: core at $10/machine/month (single site, no API), pro at $50/machine/month with a 3-machine minimum (unlimited sites, public API + CLI + SDK + webhooks, roost with 1 TB included storage per site, $0.05/GB overage). Metered billing keyed off active machine count + per-tier flag on each site doc. See `dev/active/billing-system/plan.md` for the implementation track.
- **Usage dashboard** — show machine count, current tier, projected bill, and roost storage usage vs cap in account settings.
