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

## billing

- **Stripe integration** — $10/machine/month post-beta. Metered billing based on active machine count.
- **Usage dashboard** — show machine count and estimated bill in account settings.
