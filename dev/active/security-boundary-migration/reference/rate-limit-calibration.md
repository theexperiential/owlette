# rate-limit calibration

generated: 2026-04-27
status: risk flagged - shadow data is not yet collected

## summary

Wave 8.0 is not complete. The rate limiter now has an observe-only mode via
`RATE_LIMIT_OBSERVE_ONLY=true`, which records would-have-rejected requests to
the `rate_limit_observations` collection while allowing the request to proceed.

No shadow-period dataset has been captured yet, so this file must not be used as
evidence that limits are production-calibrated.

## current implementation

- Observe-only flag: `RATE_LIMIT_OBSERVE_ONLY=true`
- Observation collection: `rate_limit_observations`
- Recorded fields: site, bucket, capability, actor type/id, source layer,
  configured limit, window length, retry-after value, observed minute, and
  server timestamp.
- Enforcement behavior in observe-only mode: would-have-rejected requests are
  logged and returned as `{ ok: true }`.

## risk

Current per-capability limits in `web/lib/rateLimit.server.ts` remain starting
defaults. They have not been tuned from live legitimate burst traffic.

Proceeding to rules lockdown is probably independent of this risk because the
rules boundary removes browser control-plane writes, while rate limits sit in
the server authorization path. Proceeding to rate-limit enforcement without
shadow data is not recommended.

## next action

Enable `RATE_LIMIT_OBSERVE_ONLY=true` in the target environment, collect
shadow traffic, then replace this risk note with a completed calibration report
containing measured percentile data and final default limit updates.
