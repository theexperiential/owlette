# Roost Kill Switch

This runbook covers the per-site Roost emergency stop for project distribution. Use it when a specific site needs new Roost publish, signed-URL, or agent sync work paused while an incident is investigated.

This is not a public API launch flag. It does not hide docs, change package distribution, disable API authentication, or turn the whole public API on or off.

## Switch

| field | normal value | disabled value | scope |
|---|---|---|---|
| `sites/{siteId}.roostEnabled` | missing or `true` | `false` | one site |

The web route gate lives in `web/lib/roostKillSwitch.ts`. Agent-side sync gating lives in `agent/src/roost_kill_switch.py`.

Semantics:

- Missing field means enabled.
- `true` means enabled.
- `false` means disabled for that site.
- Non-boolean values are treated as enabled and should be corrected.
- Firestore read errors fail open so a transient Firestore issue does not silently pause a customer's site.

## Impact

When disabled:

- web Roost routes that use the gate return `503` `application/problem+json` with title `roost disabled`
- agents skip new `sync_pull` work for the site after their cache expires
- already-running agent work is not cancelled mid-flight
- API keys, authentication, scopes, audit behavior, and Firestore rules remain unchanged

Agent propagation is bounded by a 30 second cache and normal polling, with a target of effect within 60 seconds for new sync work.

## When To Use

Use this switch for:

- bad Roost content or a bad rollout affecting one site
- site-specific R2 or chunk distribution investigation
- customer-requested pause of new Roost sync work
- suspected Roost publish/deploy regression where pausing one site reduces blast radius while preserving other API use

Do not use it for:

- missing API-key scopes or failed authentication
- general public API launch pause; use the [public API launch runbook](../api/launch-runbook.md) instead
- docs, SDK, CLI, or GitHub Action package regressions
- broad platform outage where a deployment rollback or status incident is the right response
- capability or privileged rate-limit bugs covered by the security-boundary kill switches

## Flip Off

Use the approved operator write path for the environment, such as Firebase console or an internal admin tool. Update only the affected site document:

```text
sites/{siteId}.roostEnabled = false
```

Record the site id, operator, reason, start time, expected review time, and customer impact in the incident or launch ticket. The field itself has no owner, reason, or expiry metadata, so the ticket is the audit trail for operational intent.

## Verify Off

1. Read `sites/{siteId}` and confirm `roostEnabled` is exactly boolean `false`.
2. Call a gated Roost API route for the site with a scoped credential and confirm `503` with title `roost disabled`.
3. Confirm agents for the site stop starting new `sync_pull` work after the propagation window.
4. Confirm unrelated sites still publish, deploy, and sync normally.
5. Keep the public status page unchanged unless customers outside the affected site would notice or the issue meets incident policy.

## Re-Enable

Set the same field back to `true`, or remove the field if the site should return to the default enabled state:

```text
sites/{siteId}.roostEnabled = true
```

Prefer writing `true` during an incident so verification is unambiguous.

After re-enable:

1. Confirm `sites/{siteId}.roostEnabled` is boolean `true`.
2. Run a Roost publish or signed-URL smoke for the affected site.
3. Confirm one agent starts new sync work successfully.
4. Close the incident or launch-ticket action only after support confirms no new `roost disabled` reports are arriving.
