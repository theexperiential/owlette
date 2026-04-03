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

## billing

- **Stripe integration** — $10/machine/month post-beta. Metered billing based on active machine count.
- **Usage dashboard** — show machine count and estimated bill in account settings.
