# owlette roadmap

Roughly prioritized. Not a commitment — just a living list of what's next.

---

## infrastructure / ops

- **Log TTL** — site event logs (`sites/{id}/logs`) and machine logs (`machines/{id}/logs`) have no expiry. Add a cleanup cron to delete entries older than 30-90 days. Low urgency (negligible cost), good hygiene.

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
