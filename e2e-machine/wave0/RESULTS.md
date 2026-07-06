# Wave 0 Spike — Results

**Run**: 2026-07-03 · against **live dev** (`dev.owlette.app` / `owlette-dev-3838a`) · **10/10 stages passed**

## What it proves

Wave 0 de-risks the single load-bearing assumption of the whole full-machine e2e gate: **an agent can pair fully headlessly — no human, no browser — and receive real tokens.** All three of the plan's biggest unknowns resolved green:

| Unknown (from plan.md risks) | Result |
|---|---|
| MFA blocks headless login for the e2e user | ✅ A no-MFA account gets a fully usable `__session` cookie via `signInWithPassword` + `POST /api/auth/session`. `signInWithPassword` returned no MFA challenge; the session came back `mfaVerified=true`. |
| Cloudflare 1010-blocks the agent's own `requests` poll | ✅ **Not blocked.** The agent's real Python (`C:\ProgramData\Owlette\python`) + `requests` (default UA, no custom headers — exactly `configure_site.py`) reached `/api/agent/auth/device-code/poll` and got HTTP 200 on the first poll. |
| Headless `/ADD=` mint actually authenticates | ✅ The deferred-mint poll returned a real 958-byte access token + 86-byte refresh token bound to `siteId`, and the `agent_refresh_tokens/{hash}` doc landed in dev Firestore with the synthetic `machineId` and an `agentUid`. |

## Stages (all PASS)

```
0.1  seed site-owner + e2e site      e2e-wave0@owlette.test owns e2e-wave0-site (role=member, least privilege)
0.2a Firebase ID token                signInWithPassword, no MFA challenge
0.2b __session cookie minted          POST /api/auth/session -> 200, Set-Cookie __session=
0.2c session usable                   authenticated=true, mfaVerified=true
0.3a phrase generated                 POST /api/agent/auth/device-code (cookie) -> preauthorizedIntent, 600s TTL
0.3b authorized                       POST .../authorize (cookie, siteId) -> deferTokenMint
0.5  Cloudflare/UA                     python-requests default UA -> HTTP 200, 1 poll, not blocked
0.4  headless mint returned tokens     access 958b + refresh 86b, siteId bound
0.4b agent_refresh_tokens doc created  1 doc, machineId=e2e-wave0-vm, agentUid set
0.6  teardown complete                 removed user + site + 1 token doc
```

Post-run residue check confirmed clean: site/user/tokens/device-codes all gone, auth user deleted.

## How it was run safely

- **Least privilege**: seeded a *site-owner* (`role: member`, owns the e2e site), not a global superadmin — `assertUserHasSiteAccess` passes on `site.owner === uid`. Improvement over the plan's "superadmin" wording.
- **No touch to this machine's live agent**: the spike polls with a **synthetic** `machineId` (`e2e-wave0-vm`) over HTTP; it never runs `configure_site.py`, so `C:\ProgramData\Owlette\.tokens.enc` is untouched.
- **Dev-pinned**: aborts unless the service account resolves to `owlette-dev-3838a` and the API base is a `dev.` host.
- **Self-cleaning**: `finally` block deletes the user, site, machine subdocs, device code, and refresh-token doc every run.

## Verified contract facts (fold into Wave 1)

- Poll payload: `{ pairPhrase, machineId, version }`. `machineId` is strictly validated (1–128 chars, no `/`, no control chars).
- Rate limits (per IP, Upstash): device-code generate/authorize = `tokenExchange` (200/hr dev); poll = `api` (300/hr). A real agent polling every 5s for a full 10-min phrase does ~120 polls — keep parallel pairings from one NAT modest.
- A 60s mint-claim lease means a concurrent second poll gets **202 pending**, not tokens — the poller must loop on 202 (it does).
- The refresh leg (post-pairing hourly rotation) now depends on an `X-Owlette-Agent-Version` header (semver ≥ 2.12.0) to take the rotating path; not needed to obtain the first token pair, but Wave 1's "agent stays alive" oracle should be aware.

## Files

- `run_spike.mjs` — Node controller (firebase-admin seed/assert/teardown + cookie/generate/authorize over `fetch`).
- `poll_agent.py` — runs on the agent's Python; the faithful `requests` poll.

## Next

Wave 1 (install + service + auth smoke, no GUI). The headless auth path this proved becomes the pairing step of the real installer run.
