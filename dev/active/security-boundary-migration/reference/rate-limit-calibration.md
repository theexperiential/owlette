# rate-limit calibration

generated: 2026-04-27
status: risk accepted - low traffic
w7_rules_lockdown waiver: accepted
rate-limit enforcement remains blocked until real calibration or a deliberate load pass updates this report.

## summary

The app has no meaningful live traffic, so a seven-day shadow window would not
produce useful p99 legitimate-burst data. We verified the observe-only pipeline
on Railway dev after deploying `RATE_LIMIT_OBSERVE_ONLY=true`: 13 authenticated
read-only requests to `/api/platform/email/config` all returned 200, and
Firestore recorded 2 `rate_limit_observations` rows.

This waiver applies only to W7 rules lockdown. Firestore rules lockdown removes
browser control-plane writes; rate-limit calibration affects future API 429
enforcement and is a separate risk.

## current implementation

- Observe-only flag: `RATE_LIMIT_OBSERVE_ONLY=true`
- Observation collection: `rate_limit_observations`
- Enforcement behavior in observe-only mode: would-have-rejected requests are
  logged and returned as `{ ok: true }`.
- Smoke result: `GLOBAL_SETTINGS_WRITE`, user bucket, current limit 10/min,
  2 observed in-memory would-have-rejected rows.

## risk acceptance

Current per-capability limits in `web/lib/rateLimit.server.ts` remain starting
defaults. They have not been tuned from live legitimate burst traffic.

Accepted for W7 because there are no active users and the W7 security boundary
does not depend on enforcing calibrated API rate limits. Not accepted for
turning on strict rate-limit enforcement in a production-traffic environment.

## calibrated limits

No post-calibration limit changes are recommended from the smoke sample. The
sample proves instrumentation, not traffic shape.

## next action

Proceed with W7 rules lockdown validation. Before relying on rate-limit
enforcement for production traffic, either collect real traffic or run a
deliberate representative load pass and regenerate this report with measured
p99s and calibrated limits.
