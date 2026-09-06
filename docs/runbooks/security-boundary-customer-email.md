# Security Boundary Customer Email Draft

Status: draft, not sent.

Audience: accounts with active member seats before the production rules lockdown.

Subject: Upcoming Owlette security-boundary update

Hi,

We are rolling out a security-boundary update for Owlette's control-plane actions. The change moves privileged actions such as machine commands, deployments, presets, installer management, and account administration behind server-side authorization, rate limiting, and audit logging.

For site admins and superadmins, no workflow change is expected. The dashboard and API routes should continue to work normally.

For member users, privileged machine-control actions will be restricted during this milestone. Members can continue using read-only and explicitly allowed workflows, but command-style actions will require an admin or superadmin until the configurable policy work ships in the next milestone.

What is changing:

- Privileged control-plane writes are handled by Owlette's server routes instead of direct browser writes.
- Each privileged decision is audit logged with a correlation id.
- Rate limits protect user and system automation paths independently.
- A monitored rollback path exists if a legitimate admin workflow is blocked.

What you may notice:

- Admins should not need to take action.
- Members who previously triggered privileged machine actions may see those actions unavailable or denied.
- If a legitimate admin action is unexpectedly denied, contact support with the time, site, user, and action attempted.

Timing:

- The web/API deploy happens first with Firestore rules unchanged.
- We then monitor for 24 hours.
- Firestore rules lockdown follows only after the soak period stays healthy.

Thanks,

Owlette team
