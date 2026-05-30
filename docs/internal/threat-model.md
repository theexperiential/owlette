# roost — threat model

**status**: canonical security design constraint for project distribution v2 (roost).
**created**: 2026-04-19 | **owner**: dylan@roscover.com
**applies to**: wave 2-5 of `dev/active/project-distribution-v2/plan.md`. every implementation task in those waves must be implementable against this doc. if a task cannot be implemented without violating a baseline below, the plan is wrong, not this doc.

> roost is always lowercase, including in code, docs, and ui. this doc covers the cloud-side (r2, cloud run, cloud functions, firestore) and agent-side (windows service running as `nt authority\system`) of roost — the content-addressed file sync platform that hosts customer media files.

---

## scope

### in scope

- **customer file storage** — upload, chunking, storage in cloudflare r2, server-side dedup, per-tenant namespace.
- **agent download / extract** — windows service pulls chunks, verifies sha-256, assembles files, atomic-swaps into allowlisted destination roots.
- **web upload** — drag-and-drop folder upload via uppy + tus + tusd on cloud run; manifest builder web worker.
- **api surface** — `/api/v2/*` next.js routes, cloud functions (`chunkVerify`, `chunkGc`, `quotaEnforce`, `distributionFanout`, `webhookDispatch`, `auditLog`, `telemetry`), tusd hooks.
- **firestore data plane** — pointer documents, distribution records, audit log, manifest metadata.
- **r2 control plane** — bucket policies, signed urls, lifecycle rules, per-tenant prefixes.
- **identity** — `owk_*` api keys, firebase id tokens, agent oauth refresh tokens, device pairing phrases.
- **build + release pipeline** — installer signing, version pin, checksum publication.

### out of scope (covered elsewhere)

- v1 single-url distribution security — handled in v1 codebase; ssrf fix tracked separately (see baseline 11).
- agent process supervision (touchdesigner, etc.) — pre-existing; this doc only covers roost surfaces.
- web dashboard non-roost surfaces (metrics, hardware profile, etc.) — pre-existing.
- billing / stripe integration — pci surfaces are stripe-hosted; not in roost scope.

### explicitly deferred to v3 (acknowledged risks)

- **ed25519 / tuf manifest signing** — v2 relies on tls + firebase auth + signed urls + content-addressing for integrity. v3 adds tuf + gcp kms.
- **cmek by default** — v2 uses r2 default at-rest encryption. cmek available as enterprise upsell only.
- **agent privilege drop below `system`** — v2 agent runs as `system` for service-control + write-access reasons. v3 splits into a low-priv worker.
- **multi-region failover** — single gcp/r2 region in v2.

---

## threat actors

ordered by **probability**, not severity. mitigations are linked to baselines (`B#`) and failure modes (`F#`) below.

| # | actor | probability | motivation | typical capability | primary baselines |
|---|---|---|---|---|---|
| 1 | opportunistic firebase scanners | very high | mass credential / data harvesting | scripted scanners against public buckets; gitguardian found 19.8m exposed secrets in misconfigured firebase apps in 2024-2025 | B1, B2, B7, B12, B13 |
| 2 | insider with stale `owk_*` key | high | data exfiltration after offboarding; accidental commit | possesses a real, unrevoked api key | B7, B8, B9, B14 |
| 3 | ransomware operators | high | bitcoin extortion via signage takedown | known precedents: bristol airport 2018, atlanta 2018, multiple dooh networks 2023-2025 | B1, B6, B10, F1, F2 |
| 4 | content-defacement vandals | medium | shock value, reputational harm to victim | upload offensive media via stolen creds (union station dc porn-on-billboard 2017 archetype) | B2, B7, B8, B12 |
| 5 | competitors | medium | pre-release ip exfiltration (e.g. unaired campaigns) | hire ex-employees, social engineer support staff | B2, B7, B8, B14 |
| 6 | state actors | low (but tail risk) | intelligence on critical infra (airport, embassy, doe installs) | full apt toolkit; supply-chain capable | B10, B14, F4, plus v3 tuf signing |

### why this order

probability is calibrated to **what has actually happened** to comparable saas + signage-network operators in the last 5 years, not to hypothetical sophistication. an opportunistic scanner finding an unauthenticated r2 bucket is orders of magnitude more likely than a state actor pivoting through an installer signing cert. the design must defend against the high-probability cases first, with defense-in-depth covering the tail.

---

## the 15 non-negotiable security baselines

every wave 2-5 task must satisfy or extend these. **if a task removes one of these, it is not shippable.** deviations require explicit doc update + sign-off.

| # | baseline | threat addressed | mitigation | wave / task | verification test |
|---|---|---|---|---|---|
| B1 | default-deny `storage.rules` (r2 bucket policy) | actor 1, 3, 4 — public bucket exposure | r2 bucket policy denies all unsigned reads + writes by default; only signed urls and worker-bound credentials allowed; ci test runs unauthenticated curl against a known chunk path and asserts http 403 | wave 1.8 (firestore.rules) + wave 1.4 (`storage/r2-bucket-policy.json`) | `tests/storage/test_default_deny.py` — fails build if 200/206 returned for unsigned read |
| B2 | `customerId` / `siteId` derived from token claims, never request body | actors 1, 2, 4, 5 — cross-tenant access via parameter tampering | every `/api/v2/*` route resolves tenant ids from `requireAdminOrIdToken()` claims; request body fields ignored if present; lint rule (`web/lint/no-tenant-from-body`) fails on `req.body.siteId` reads | wave 2a.1-2a.6 (api stubs, already wired) | `__tests__/api/v2/tenant-isolation.test.ts` — sends mismatched body siteid + token siteid, asserts 403 |
| B3 | signed-url ttl ≤15min download, ≤60min upload, single-object scope | actors 1, 2 — leaked url replay window | r2 presigned urls issued with `X-Amz-Expires` capped at 900s (download) / 3600s (upload); url scope is single chunk hash, never prefix | wave 2a.2 (`/api/v2/chunks/upload-urls`), 2a.3 (`/api/v2/chunks/download-urls`) | `__tests__/api/v2/signed-url-ttl.test.ts` — asserts every issued url has `X-Amz-Expires ≤ 900/3600` and exact-key scope |
| B4 | content-addressed chunks; agent re-hashes after download | actors 1, 3, 6 — chunk substitution at rest, in transit, or mitm of r2 cdn edge | chunk filename **is** the sha-256 of its bytes; agent re-computes sha-256 after download and rejects mismatched chunks via `sync_downloader.py` | wave 1.1 spike + wave 4a (`agent/src/sync_downloader.py`) | `agent/tests/test_chunk_verify.py::test_corrupted_chunk_rejected` — replaces chunk byte at random offset, asserts download fails |
| B5 | cloud-function-validated chunk uploads (server sha-256 verify on storage trigger) | actor 4 — uploading content under wrong hash to poison dedup pool | `functions/src/chunkVerify.ts` triggers on r2 put (via cloudflare worker → pubsub bridge), recomputes sha-256, deletes object if mismatch + writes audit entry; chunk filename **must** equal computed hash or the object is purged within 60s | wave 2b (`functions/src/chunkVerify.ts`) | `functions/__tests__/chunkVerify.test.ts` — uploads object named `<hashA>` containing bytes that hash to `<hashB>`, asserts deletion within 60s |
| B6 | per-file `destination_allowlist` validation before atomic rename + realpath check + reject symlinks on windows | actor 3, 4, 6 — path traversal on extract, symlink swap to `c:\windows\system32` | v2 does **not** unpack archives — there is no `tarfile` / `zipfile` call site. instead, `agent/src/sync_assembler.py` (planned, wave 4a.5/4b.2) does per-file chunked assembly: for every file in the manifest, the destination path is validated against the `destination_allowlist` module (wave 1.7) **before** any bytes are written; `os.path.realpath(target).startswith(allowed_root)` is asserted for every file; any `os.path.islink()` entry is rejected outright on windows (audit entry written); only after all checks pass does the agent write `<path>.partial`, fsync, and `MoveFileEx`. installer pins bundled python to ≥3.12 (existing 3.9 floor is a breaking change — user-approved per context.md) for `pathlib.Path` improvements + general security posture. **lesson from cve-2025-4330**: even mature stdlib path-validation (python's `data` filter) has been bypassed via crafted member names; defense in depth (multiple independent checks per file) is mandatory, not optional. see [manifest-format.md `validation`](./manifest-format.md#validation) for the schema-level constraints that complement these runtime checks. | wave 4b.2 + wave 1.7 (`destination_allowlist.py`) | `agent/tests/test_path_traversal.py` — manifest with `../../etc/passwd` member; manifest with windows symlink; assert both rejected with named exception |
| B7 | per-customer storage quotas + per-token signed-url rate limits | actors 1, 2, 4 + failure mode F1 — runaway r2 bill, quota abuse | tusd pre-upload hook checks customer quota in firestore before issuing tus session; daily reconcile job recomputes from r2 list; `quotaEnforce.ts` cloud function emits 50/80/100% alarms; per-`owk_*`-token signed-url rate limiter (token-bucket, redis or firestore counter) caps url issuance; hard cap returns http 402 + upgrade cta | wave 2b (`functions/src/quotaEnforce.ts`) + tusd hook | `functions/__tests__/quota.test.ts` — burst 100 url requests, assert rate-limit kicks in; upload past hard cap, assert 402 |
| B8 | append-only audit log of signed-url issuance, distribution starts, `owk_*` use, manifest pointer changes, gc runs | actors 2, 3, 4, 5 — investigation + soc 2 cc7.2 evidence | `functions/src/auditLog.ts` writes immutable entries (firestore subcollection with rules denying update + delete); every signed url issuance, distribution start, `owk_*` request, manifest pointer compare-and-swap, and gc mark/sweep gets an entry with actor identity, timestamp, action, target | wave 2b (`functions/src/auditLog.ts`) | firestore.rules must reject update/delete on `auditLog/{entryId}`; `firestore.rules.test.ts` covers it |
| B9 | no tokens in logs — enforced by pre-commit lint rule, not just policy | actors 1, 2 — credential exfil via log aggregation, support tickets | pre-commit hook + ci lint rule scans diffs for `Bearer `, `owk_`, `firebase-id-token`, `refresh_token`, `access_token` in any `*.py`, `*.ts`, `*.tsx` log/print statement; rule lives in `.claude/hooks/no-token-logs.mjs` | wave 1 (pre-commit infra) + ongoing | `tests/lint/no-token-logs.test.ts` — staged file with `logger.info(f"token={token}")` fails commit |
| B10 | authenticode-signed installer; sha-256 published in firestore; ephemeral build vm | actors 3, 6 — installer trojan via build-server compromise | ev code-signing cert (6-8 week lead time per plan wave 0.7); installer build runs on ephemeral vm (gcp shielded vm, fresh per release); sha-256 published to `installer_metadata/{version}` doc and shown in admin ui; `add` page asserts checksum match before accepting download | wave 0.7 + wave 5 release flow | manual: corrupt installer in transit, assert agent-side checksum check rejects |
| B11 | ssrf allowlist + metadata-ip denylist + redirect-disable on every customer-url fetcher | actors 1, 2, 6 — pivot from cloud function into gcp/aws metadata service (169.254.169.254) | every server-side fetch of a customer-supplied url (v1 byo-url flow, future webhook destinations, manifest-builder edge cases) goes through `web/lib/safeFetch.ts`: rejects rfc1918 (10/8, 172.16/12, 192.168/16), link-local (169.254/16, fe80::/10), loopback (127/8, ::1), metadata ips (169.254.169.254, 169.254.170.2, fd00:ec2::254), aws/gcp/azure imds; disables http redirects (`redirect: 'manual'`); enforces https-only for prod; explicit allowlist for known integration hosts | wave 5 (webhooks) + **v1 hot-fix in parallel** (do not defer to v1 deprecation per plan.md risks) | `web/__tests__/lib/safeFetch.test.ts` — 200+ malicious url fixtures from ssrf-bible, assert all rejected |
| B12 | filename sanitization at upload; safe rendering in dashboard | actors 4, 5 — stored xss via `<img onerror=alert(1)>.toe` filename | `web/lib/sanitize.ts` strips control chars, normalizes unicode (nfkc), rejects path separators, caps length 255; dashboard renders filenames via react text nodes only — **never `dangerouslySetInnerHTML`**; eslint rule `react/no-danger` set to `error` repo-wide | wave 3 (`web/lib/sanitize.ts`) + lint config | `__tests__/lib/sanitize.test.ts` — payloads from xss-cheat-sheet; ui snapshot test asserts no html injection in filename column |
| B13 | `X-Frame-Options: DENY` + baseline csp | actors 4 — clickjacking on dashboard, deployment-confirm flows | `next.config.js` headers block sets `X-Frame-Options: DENY`, `Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline' https://*.firebaseapp.com; connect-src 'self' https://*.googleapis.com https://*.cloudflare.com wss://*; frame-ancestors 'none'`; csp tightened iteratively to remove `unsafe-inline` (tracked separately) | wave 2a (next.js config) | `__tests__/headers.test.ts` — assert headers present on every route |
| B14 | hardware-backed mfa on every firebase admin / gcp owner / npm publisher / signing-cert holder | actors 2, 3, 6 — credential reuse (dropbox 2012/2016 archetype) | yubikey 5 (or equivalent fido2) required for: firebase project owners, gcp project owners, npm `@owlette/*` publish accounts, ev code-signing cert custodian, cloudflare account, registrar account; sms + totp explicitly disallowed for these accounts; documented in `docs/internal/key-custody.md` (separate doc, not this one) | wave 0 ops (key custody) | quarterly attestation: list account holders, confirm mfa method per account, store screenshot evidence |
| B15 | documented deletion sla in dpa | gdpr art. 17, soc 2, customer trust | dpa (wave 0.1, lawyer-drafted) commits to: 30-day hard-delete from r2 + firestore; 90-day soft-delete expiry (manifest pointer hidden, chunks marked for gc, full purge after 90d); per-tenant deletion api at `/api/v2/customers/{customerId}/data` (admin-only) | wave 0.1 + wave 5 (deletion api) | `__tests__/api/v2/data-deletion.test.ts` — issue delete, assert manifest pointer hidden in <1min, chunks tombstoned, scheduled purge entry created |

---

## the 5 catastrophic failure modes

these are failure modes that would not be prevented by the baselines above unless explicitly addressed. **each must have a named task in the plan that closes the gap.** if any of these is not a tracked task at wave-start, the plan is incomplete.

| # | failure mode | blast radius | mitigation in plan | verification |
|---|---|---|---|---|
| F1 | per-customer storage / egress quota enforcement does not exist as a task → unbounded r2 bill | catastrophic financial exposure: a single misconfigured customer or runaway agent could rack up $10k+ in egress in hours; r2 egress is free but put/get and storage are not | wave 2b `quotaEnforce.ts` + tusd pre-upload hook + daily reconcile + 50/80/100% alarms (B7) — must exist as a tracked task before wave 3 ui ships, not bolted on later | load test: 1tb upload from a single token in 1h; assert hard-cap kicks in at tier limit and 402 returned |
| F2 | chunk gc is undesigned → first gc run deletes live chunks | fleet-wide breakage: every agent referencing a deleted chunk fails its next sync; rollback impossible if previous-version chunks are gone | wave 2b `chunkGc.ts`: nightly mark-and-sweep, **30-day tombstone** (deleted chunks recoverable for 30d), **dry-run mode for first month in production** (logs what would be deleted but deletes nothing), **pause-during-publish** (gc holds a global lock that publish operations check), per-tenant scope (no cross-tenant gc) | dry-run validation: 30 consecutive nights of dry-run output reviewed; zero false positives required before enabling delete mode |
| F3 | manifest pointer race + no rollback pin → two rapid publishes corrupt fleet state | partial fleet on v1, partial on v2, partial on a torn intermediate state; no clear "good version" to roll back to | firestore transaction with compare-and-swap on `currentManifestId`; atomic write of `previousManifestId`; agent **pins the manifest revision** at start of download (toctou mitigation — see attack surfaces below) and refuses to switch mid-download; rollback ui (wave 3) flips pointer back to `previousManifestId` in single transaction | concurrency test: 100 concurrent publishes against same folder, assert exactly one wins per round, no torn state in firestore |
| F4 | allowlist of destination roots has no schema / default / ui / migration → system-level arbitrary file write | catastrophic: agent runs as `system`; if allowlist is empty, missing, or accepts `*`, a malicious manifest writes anywhere on disk (e.g. `c:\windows\system32\drivers\evil.sys`) | wave 1.7 `agent/src/destination_allowlist.py` (already landed): **fail-closed if list is empty or missing**; default at install: `[~/Documents/Owlette]`; admin ui (`web/components/AllowlistEditor.tsx`) for explicit additions; migration on agent upgrade preserves existing allowlist; manifest extract checks every member's realpath against allowlist (B6) | `agent/tests/test_allowlist.py::test_empty_allowlist_fails_closed` + `test_realpath_escape_rejected` |
| F5 | wave 0 legal items not hard blockers on customer-facing upload → bmg v. cox class liability ($25m precedent) | regulatory + civil: dmca repeat-infringer policy not enforced → contributory copyright liability; no insurance → uninsured loss; no tos → no enforceable terms | plan.md "hard blocks" section: **v2 upload ui cannot be enabled for any external account** until wave 0.1 (tos), 0.2 (dmca + actual repeat-infringer enforcement), 0.3 (cyber insurance) all complete; ui flag gated on firestore feature flag tied to legal-readiness signoff | manual signoff doc (wave 0 exit criteria); ci check that asserts `ENABLE_V2_UPLOAD=false` in any environment whose `legal_ready=false` flag is set |

---

## specific attack surfaces with mitigations

### zip bombs / decompression bombs

- **threat**: customer uploads a 1mb file that decompresses to 10tb, exhausting agent disk + crashing service.
- **mitigation**: agent enforces decompression-ratio cap of **100:1** during extract (`sync_assembler.py`); aborts with named error if exceeded; per-file uncompressed-size cap matches tier max-file-size (5gb starter, 10gb pro, 50gb enterprise); manifest-declared total size validated against r2-reported sum before download begins.
- **verification**: `agent/tests/test_zip_bomb.py` — synthetic 100kb gz that expands to 1gb, assert rejected.

### touchdesigner `.toe` files embed python (run as system unless mitigated)

- **threat**: opening a `.toe` file in touchdesigner runs embedded python; agent runs as `system`; if the agent ever invokes touchdesigner directly on an extracted file (or the supervised process does), an attacker-controlled `.toe` from a compromised account = full system rce.
- **mitigation (v2)**:
  1. agent **never** invokes touchdesigner — it only writes files; touchdesigner is launched by the supervised process tree, which has its own security boundary.
  2. optional virustotal scan hook on upload (cloud function `virusTotalScan.ts` deferred to v3 — tracked).
  3. customer-level acl: only `admin` and `superadmin` roles can publish manifests for a site (gated by `isSiteAdmin(siteId)`); `member` role cannot.
  4. audit log on every manifest publish (B8).
- **mitigation (v3)**: drop agent below `system` (separate low-priv worker process); see "out of scope".
- **verification**: code review checklist — no `subprocess.run(['touchdesigner.exe', ...])` in agent codebase; `tests/agent/test_no_touchdesigner_invocation.py` greps for it.

### path traversal on assembly (cve-2025-4330 lesson)

- **threat**: malicious manifest declares a file path `../../../windows/system32/drivers/evil.sys`. note: v2 does **not** extract archives — there is no `tarfile`/`zipfile` call site. assembly is per-file from chunks listed in the manifest, so the attack surface is the manifest-declared path, not an archive member name. cve-2025-4330's lesson still applies: even mature stdlib path-validation (python's `data` filter) has been bypassed via crafted member names, so a single-layer defense is insufficient.
- **mitigation (defense in depth, all three required)**:
  1. **per-file `destination_allowlist` check** before any bytes are written (wave 1.7 module, enforced in `agent/src/sync_assembler.py` per B6); fail-closed if the allowlist is empty or missing.
  2. **independent realpath check**: for every file, compute `os.path.realpath(target_path)` and assert `startswith(allowlisted_root)` (B6); reject otherwise. catches normalization tricks the allowlist string match might miss.
  3. **reject `os.path.islink()`** outright on windows (windows symlinks require `SeCreateSymbolicLinkPrivilege`, which agent has as `system` — a malicious symlink could swap-in arbitrary content after assembly).
- **verification**: `agent/tests/test_path_traversal.py` covers all three layers; manifest fixture with `../`-laden path stored in `agent/tests/fixtures/path_traversal_manifest.json`.

### hash collision on sha-256

- **status**: theoretical only. sha-256 has no known practical collision (as of 2026-04). chosen-prefix collision cost estimate: ~$1.2b in compute. **document this so future engineers do not re-litigate the choice.**
- **mitigation if it ever materializes**: manifest format includes `hash_algorithm` field (`sha-256` today); transition path is to publish new manifest media type with stronger hash and dual-write during cutover. v3 tuf integration will support hash agility natively.
- **verification**: none required at v2; tracked as a v4+ contingency.

### manifest substitution

- **threat**: attacker swaps a published manifest's bytes for malicious content while keeping the firestore pointer the same.
- **mitigation**: defeated by content-addressing — the chunk hash **is** the storage key. you cannot swap bytes without also changing the key, and the key is recorded in firestore + audit log + agent local sqlite. tampering requires writing to multiple independent stores simultaneously. see [manifest-format.md `goals` and `chunk constraints`](./manifest-format.md#hash-constraints) for the content-addressing invariants this defense relies on.
- **verification**: `tests/integration/test_manifest_substitution.py` — replace manifest bytes in r2, assert agent rejects on next sync (sha-256 mismatch).

### toctou between manifest check and download

- **threat**: agent reads `currentManifestId = vN` at t0; before agent finishes downloading vN's chunks, a publish moves pointer to vN+1; agent ends up with a torn state (some vN chunks, some vN+1 chunks).
- **mitigation**: agent **pins the manifest revision** at the start of a download cycle (`sync_state.py` records `pinned_manifest_id` in sqlite wal); refuses to switch mid-download; on completion, checks pointer one more time — if pointer has moved, agent re-runs sync against new pointer (idempotent due to content-addressing). publish operations check the global gc / publish lock to ensure they don't conflict.
- **verification**: `tests/integration/test_manifest_toctou.py` — race a publish against an in-flight download; assert agent finishes pinned revision then re-syncs cleanly.

### cross-tenant chunk read

- **threat**: tenant a obtains tenant b's chunk hash (e.g. via a leaked manifest or guessing) and requests download.
- **mitigation**: per-tenant path prefix `project-content/{siteId}/{hash[0:2]}/{hash}` — chunks are physically isolated by `siteId` namespace (not in a shared global pool). r2 bucket policy + signed-url issuance route (B2) ensures `siteId` in path matches `siteId` in token claims. dedup is **per-tenant**, not global — a chunk uploaded by tenant a is not automatically reusable by tenant b (eliminates a class of side-channel attacks where reuse confirms presence of specific content).
- **verification**: `__tests__/api/v2/cross-tenant-read.test.ts` — request signed url for `siteId=B`'s chunk using `siteId=A`'s token; assert 403.

### ssrf in v1 byo-url flow

- **threat**: v1 distribution accepts a customer-supplied url and fetches it server-side; attacker supplies `http://169.254.169.254/latest/meta-data/iam/security-credentials/` and exfiltrates gcp metadata service tokens.
- **mitigation**: B11 (`web/lib/safeFetch.ts`) **must be patched into v1 in parallel with v2 work** — explicitly called out in plan.md risks: "ssrf in v1 byo-url flow — fix v1 in parallel with v2 (don't wait for deprecation)". v1 is not safe to keep running in production without this patch even though it's being deprecated; deprecation is calendar-months away (wave 6.4).
- **verification**: ssrf-bible fixture suite run against v1 byo-url endpoint; assert all malicious urls rejected.

### tusd hook injection / smuggling

- **threat**: tusd pre-upload hook receives request from tusd over http; if hook auth is missing or weak, anyone who can reach the hook url can authorize uploads bypassing quota.
- **mitigation**: tusd → cloud-function hook secured with hmac-signed body (`X-Tusd-Signature: sha256=...`); cloud function rejects requests with missing or invalid signature; tusd config + cloud function share the secret via gcp secret manager; secret rotated quarterly.
- **verification**: `functions/__tests__/tusdHook.test.ts` — call hook with missing signature → 401; tampered body → 401; valid signature → 200.

### worker dispatch poisoning

- **threat**: cloud function `distributionFanout.ts` reads firestore for a distribution record and triggers agent fan-out; if firestore record is tamperable post-creation, fan-out could be redirected.
- **mitigation**: distribution records are write-once via firestore rules (no update allowed except by `distributionFanout` cloud function via privileged path); agent commands signed with the firestore document path (agent rejects commands not addressed to its own siteId).
- **verification**: firestore.rules.test asserts `update` denied on `distributions/{distId}` for non-function callers.

### dependency supply chain (codecov 2021, npm sept 2025 worm, axios 2026)

- **threat**: a transitive npm or pip dependency is compromised; ci or production picks up malicious code.
- **mitigation**: `package-lock.json` + `requirements.txt` pinned exact versions; renovate / dependabot pull requests reviewed by human before merge (no auto-merge); ci runs `npm audit --omit=dev` and `pip-audit` and fails on high+ severity; build vm is ephemeral (B10) — even if a dep is compromised post-build, secrets baked into the build vm don't persist; `.npmrc` set to `ignore-scripts=true` for ci installs to defang lifecycle script attacks; for `@uppy/*` packages added in wave 3, audit + pin + defer auto-update.
- **verification**: `ci/audit.sh` runs on every pr; manual audit of any new dep added.

### cloudflare control-plane outage (cf nov 2025 archetype)

- **threat**: cloudflare config push without staging takes down r2 access; customer agents can't reach chunks.
- **mitigation**: agents have local content store + already-extracted projects → **shows keep playing** (decoupled sla per plan.md: 99.99% local, 99.9% cloud). new deploys queue locally and retry with circuit breaker (`agent/src/connection_manager.py`). monitoring alerts within 5 min on cf-side errors. byo-bucket enterprise tier provides r2-independence as an upsell.
- **verification**: chaos test — simulate r2 unavailability for 2h, assert running shows unaffected, deploys queue + resume on recovery.

---

## compliance hooks

each compliance requirement maps to existing baselines and surface-area tasks. this section is the bridge between the threat model and the legal / certification work in wave 0.

### gdpr article 17 (right to erasure)

- **requirement**: data subject can request deletion; controller must comply within 30 days.
- **hooks**:
  - chunk gc (F2 mitigation) **must include per-tenant deletion path** — when customer is deleted, all their `project-content/{siteId}/...` chunks are tombstoned immediately and purged within 30 days (B15).
  - dashboard exposes "delete my account" flow (wave 5 deletion api).
  - manifest history retained for 90 days (soft-delete window, B15) for accidental-deletion recovery; full purge after.
  - audit log entries are immutable but pseudonymized after deletion (actor id replaced with `deleted-user-{hash}`; original mapping destroyed).
- **verification**: `__tests__/api/v2/gdpr-deletion.test.ts` — delete customer, assert all chunks tombstoned within 1min, full purge entry scheduled for t+30d, audit entries pseudonymized.

### soc 2 cc7.2 (system monitoring)

- **requirement**: monitor system components for anomalies; produce evidence of monitoring + response.
- **hooks**:
  - append-only audit log (B8) is the primary evidence source.
  - opentelemetry traces (per plan.md observability section) cover browser → tusd → cf → agent.
  - per-tenant cost attribution + 50/80/100% alarms (B7) double as anomaly detection (sudden quota spike = potential compromise).
  - failed-auth alerting on `owk_*` token misuse (3 failed-auth events in 5min triggers slack alert).
- **verification**: quarterly soc 2 evidence pack pulled from audit log + monitoring dashboards.

### encryption at rest

- **v2**: r2 default at-rest encryption (aes-256, cloudflare-managed keys) — applies to all chunks + manifests.
- **enterprise upsell**: cmek (customer-managed encryption keys) via gcp kms or cloudflare keyless tls — tracked as v3 + enterprise tier feature.
- **verification**: r2 bucket settings audit (manual, quarterly).

### data residency

- **requirement**: enterprise customers (eu, uk, australia) require data stored in-region.
- **hooks**: r2 supports jurisdiction selection (`jurisdiction: 'eu'`); per-tier configuration:
  - free / starter / pro: us-default (no jurisdiction guarantee).
  - enterprise: jurisdiction selectable (eu, uk, fedramp-eligible regions on roadmap).
- **implementation**: customer record includes `jurisdiction` field; r2 client picks bucket per jurisdiction; signed urls issued against the correct regional bucket.
- **verification**: integration test — set customer jurisdiction=eu, upload chunk, assert r2 list shows object in eu jurisdiction, not us.

### encryption in transit

- tls 1.3 enforced on all endpoints (`*.owlette.app`, cloud functions, tusd cloud run, r2 endpoints).
- agent rejects non-tls connections (`firestore_rest_client.py` enforces https-only).
- hsts header on all web responses (`Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`).

---

## penetration testing

### trigger thresholds

- **first enterprise contract above ~$25k acv**: full external pentest (web + api + agent) before contract signing. budget ~$15-25k for a 1-2 week engagement with a reputable firm (e.g. trail of bits, ncc group, doyensec).
- **before soc 2 type 2 fieldwork**: pentest within the 6-month observation window so audit findings are remediated and re-tested before the report period closes.
- **after any catastrophic security incident**: full pentest within 90 days of incident closure.
- **annually**: lightweight retest (~$8-12k) to catch regressions in long-stable surfaces.

### scope

each engagement covers (at minimum):
- web app authn + authz (focus on cross-tenant access — B2)
- `/api/v2/*` surface (focus on rate limiting, signed url issuance, problem+json error info disclosure)
- agent download + extract (focus on path traversal, symlinks, zip bombs — B6)
- installer + signing (focus on supply chain — B10)
- ssrf surfaces (B11)

### out of scope (cost containment)

- tusd internals (delegated to upstream maintainers; we audit configuration only)
- cloudflare workers + r2 (delegated to cloudflare's own audits; we audit our policies only)
- firebase auth internals (delegated to google)

---

## real precedents to internalize

short list — each is one line. these are what we are defending against, named so engineers writing code can think "would my change have prevented this?"

- **dropbox 2012/2016 employee password reuse** → 68m credentials leaked because an employee reused a password across linkedin + corp; mitigation B14 (hardware mfa) + no shared accounts.
- **codecov 2021 supply chain attack** → bash uploader script compromised, exfiltrated env vars from thousands of ci pipelines; mitigation: pinned deps, ephemeral build vm (B10), `ignore-scripts=true`.
- **cloudflare nov 2025 outage** → config push without staging took down significant r2 traffic; mitigation: decoupled slas, agent local content store, byo-bucket upsell.
- **firebase 2024-2025 mass exposure** → gitguardian found 19.8m secrets in misconfigured firebase apps; mitigation: B1 default-deny rules + ci test, B2 token-claim-derived tenant ids.
- **dooh ransomware (bristol airport 2018, atlanta 2018)** → flight info screens taken down by ransomware; mitigation: agent runs only known-good content, content-addressed integrity (B4), local content store survives cloud outage.
- **union station dc 2017** → porn displayed on billboard via stolen creds; mitigation: B14 mfa, B8 audit log, content moderation roadmap (v3).
- **bmg v. cox 2019** → $25m verdict against isp for failing to terminate repeat infringers; mitigation: F5 wave 0 legal blockers, real dmca repeat-infringer enforcement (not just policy on paper).
- **npm sept 2025 self-replicating worm** → malicious package republished itself through compromised maintainer accounts; mitigation: pinned versions, no auto-merge, `ignore-scripts=true`, B14 mfa on npm publisher.
- **axios 2026 compromise** → core http library compromised, affected millions of downstream apps; mitigation: same as npm 2025; reinforces "pin everything, audit before update".

---

## out of scope for v2 (deferred to v3)

acknowledged residual risk. each of these is a real gap; the mitigation is "v2 ships without it, v3 adds it, the risk is accepted in writing."

| deferred item | residual risk | accepted because | v3 plan |
|---|---|---|---|
| ed25519 manifest signing via tuf + gcp kms | manifest integrity rests on tls + firebase auth + signed urls + content-addressing; if all four of those are simultaneously bypassed, manifest forgery is possible | content-addressing already prevents byte-substitution (chunk hash is key); the four-of-four bypass is implausible in v2 threat model; tuf adds significant ops complexity | wave v3.1: tuf root + targets + snapshot + timestamp keys, gcp kms backed, key rotation playbook |
| cmek by default (customer-managed encryption keys) | customer keys held by cloudflare; subpoena risk if cloudflare is compelled | enterprise customers who need cmek can opt in; default tier customers do not | wave v3.2: gcp kms + cloudflare keyless tls integration; per-tier flag |
| agent privilege drop below `system` | a `.toe` file with embedded python invoked by supervised process tree could escalate to `system` if a bug bridges between agent + supervised process | agent does not invoke touchdesigner directly; allowlist (B6) + path traversal defense (F4) + audit log (B8) bound the blast radius | wave v3.3: split agent into `nt authority\system` service-control component + low-priv worker that does i/o |
| multi-region failover | single gcp/r2 region; regional outage delays new deploys | local content store keeps shows running (decoupled sla); cloud outage = no new deploys, not show-down | wave v3.4: multi-region r2 + manifest replication + agent fallback url list |
| visual diff between manifest versions | reviewers approve "publish" without easy way to see what changed | reviewers can compare local manifest text by hand; not a security blocker, just ux | wave v3.5 (sre features) |
| auto-rollback on health regression | once deployed, bad version stays deployed until human notices | one-click rollback (wave 3 ui) is fast (<30s); human notice + click is acceptable for v2 customer profile | wave v3.6 |
| content moderation / virustotal scan on upload | uploaded content is not scanned for malware or copyrighted material at upload time | dmca takedown flow (wave 0.2) handles post-upload reports; virustotal cloud function planned but not v2 | wave v3.7 |

---

## change control for this document

- **owner**: dylan@roscover.com.
- **review cadence**: every wave exit + after any security-relevant incident.
- **change process**: pr against this doc; require reviewer signoff from owner; pr description must call out which baseline / failure mode / surface is changing and why.
- **never silently relax a baseline.** if a baseline is tightened (more strict), commit + ship. if a baseline is relaxed, the pr description must include risk acceptance signed by the owner.
- **link discipline**: when a wave-2-5 task references this doc, link to a specific baseline anchor (e.g. `#B6`) — not the doc as a whole. that way edits are traceable.

---

## appendix a: baseline-to-task crosswalk

quick lookup for plan.md task authors. if your task touches the surface listed, the named baselines apply.

| surface | applicable baselines | applicable failure modes |
|---|---|---|
| any new `/api/v2/*` route | B2, B3, B7, B8, B9, B11, B12, B13 | F1, F3 |
| any cloud function | B5, B7, B8, B9, B11 | F1, F2, F3 |
| any r2 bucket policy or signed-url issuer | B1, B2, B3, B7 | F1 |
| any agent file extract or write | B4, B6 | F4 |
| any installer build / release | B10, B14 | — |
| any new customer-supplied url fetcher (server-side) | B11 | — |
| any new firestore collection | B1, B2, B8 | F2, F3 |
| any new web ui that renders user content | B12, B13 | — |
| any deletion / data-removal flow | B8, B15 | F2 |
| any quota / billing change | B7, B8 | F1 |

---

## appendix b: glossary

- **chunk**: 4 mib slice of a file, keyed by sha-256 of its bytes.
- **manifest**: oci v1.1 derivation listing all chunks for a project; stored in r2; pointer in firestore.
- **manifest pointer**: firestore document referencing the current + previous manifest ids for a folder.
- **pinned manifest revision**: the manifest id an agent commits to for a single download cycle; used to defeat toctou (see attack surfaces).
- **owk_***: long-lived api key prefix for programmatic api access.
- **tusd**: tus protocol server, runs on cloud run.
- **uppy**: browser upload library, paired with tus + dashboard plugins.
- **content store**: agent-local cache at `~/Documents/Owlette/.owlette-content/{hash[0:2]}/{hash}`.
- **fail-closed**: when input is missing or invalid, deny the operation. opposite of fail-open.
- **defense in depth**: multiple independent mitigations for the same threat, so a bypass of one does not bypass all.
- **toctou**: time-of-check / time-of-use race condition.
- **tuf**: the update framework — signing scheme used for software update integrity. v3 adoption planned.
- **cmek**: customer-managed encryption keys.
- **dpa**: data processing addendum (gdpr contract artifact).
- **acv**: annual contract value.

---

## appendix c: trust boundaries and data flows

every arrow that crosses a trust boundary is a place where the receiving side must validate input. listing them here so no boundary is implicit.

### boundary 1: browser → tusd (cloud run)

- **trust delta**: untrusted (browser is on customer device, possibly compromised) → semi-trusted (tusd is our infra but processes customer bytes).
- **what crosses**: file bytes, tus upload metadata (filename, mime type, size), firebase id token in `Authorization` header.
- **what tusd must validate**: id token signature + expiry + tenant claim (B2); upload size against per-tenant quota via pre-upload hook (B7); filename sanitization (B12); mime type is informational only (never trusted for security decisions); chunk size matches expected 4 mib boundary (reject malformed tus offsets).
- **what tusd must not assume**: that filename is utf-8, that chunk bytes match any client-claimed hash (server recomputes via chunkVerify, B5), that the same browser will resume the upload (resumption may be from a different device, must re-validate token).

### boundary 2: tusd → r2 (object put)

- **trust delta**: semi-trusted (tusd) → trusted (our r2 bucket).
- **what crosses**: chunk bytes, object name (= sha-256 hash from chunkVerify), per-tenant prefix.
- **what r2 must enforce**: bucket policy denies puts to objects outside `project-content/{siteId}/...` even from tusd's iam principal (defense in depth — if tusd is compromised, blast radius is limited to one tenant's prefix at a time, gated by the tenant of the request); object lifecycle rule moves stale uploads (`uploads/staging/...`) to deletion after 24h.

### boundary 3: r2 → cloud function (chunkverify trigger)

- **trust delta**: trusted (r2) → trusted (cloud function).
- **what crosses**: object metadata + bytes (function reads object after trigger fires).
- **what function must validate**: re-compute sha-256 of object bytes; if mismatch with object name, delete + audit (B5); if customer's quota is exceeded after this put, mark object for deletion + emit alarm (B7).
- **failure mode**: if cloud function execution lags behind upload rate, a poisoned chunk could be visible for a window. mitigation: function p99 latency budget = 60s; alerting on latency breach; signed-url-issuance (boundary 4) does not list a chunk as available until chunkverify has succeeded (chunk is in `staging/` prefix until verify, then atomically moved to canonical prefix).

### boundary 4: web api → r2 (signed url issuance)

- **trust delta**: trusted (our api) → trusted (r2), but the url leaves boundary 4 to land in untrusted hands.
- **what crosses outbound**: signed url with ttl ≤ 15min (download) or 60min (upload), single-object scope (B3).
- **what api must enforce before issuing**: caller's token claims include the `siteId` in the requested chunk path (B2); rate limit per `owk_*` token not exceeded (B7); audit entry written before url is returned to caller (B8).
- **threat at boundary**: signed url leaks via browser history, ci log, screenshot in support ticket. mitigation: short ttl + single-object scope + url cannot be used to enumerate other chunks.

### boundary 5: agent → web api (download url request)

- **trust delta**: semi-trusted (agent could be compromised at customer site) → trusted (api).
- **what crosses**: agent oauth bearer token (firebase id token, 1h ttl), requested chunk hash list, requested manifest id.
- **what api must validate**: token claims include `siteId`; requested chunks all belong to a manifest the `siteId` is authorized to deploy (folder ↔ site mapping in firestore); chunk count per request capped (e.g. 100 chunks per call) to bound url-issuance cost; rate limit on per-agent url issuance (B7).
- **what api must not assume**: that the agent will actually download the chunks (signed url may be leaked or replayed); audit log every issuance (B8).

### boundary 6: agent → r2 (download via signed url)

- **trust delta**: semi-trusted (agent) → trusted (r2).
- **what r2 enforces**: signed-url validity (ttl, signature, scope); no other auth needed.
- **what agent must validate after download**: sha-256 of downloaded bytes matches the requested hash (B4); reject and re-request (with backoff) if mismatch; circuit-breaker after n consecutive mismatches (suggests upstream poisoning, not transient corruption).

### boundary 7: agent → local filesystem (extract + write)

- **trust delta**: trusted (agent has verified all chunk hashes) → trusted (local fs is the agent's own machine).
- **what agent must enforce**: every output path's realpath must be inside an allowlisted root (B6, F4); no symlinks accepted (B6); file modes set explicitly to admin+system only (B6 acl requirement); decompression-ratio cap (zip bombs); atomic swap via `MoveFileEx(REPLACE_EXISTING|WRITE_THROUGH)` after fsync.
- **what agent must not assume**: that filenames in manifest are filesystem-safe (sanitize); that destination directory exists (create with secure default acl); that target file is not currently locked by another process (handle gracefully — atomic rename via temp-then-replace pattern handles open files on windows).

### boundary 8: cloud functions → firestore (audit log writes)

- **trust delta**: trusted → trusted, but tampering risk if any function is compromised.
- **what firestore must enforce**: audit log subcollection rules deny `update` and `delete` for everyone including admin sdk (B8); only `create` allowed; immutability is structural, not policy.
- **threat**: if attacker compromises a cloud function, they can write false audit entries (but cannot remove real ones). mitigation: append-only structure + correlation-id in every entry + cross-check against opentelemetry traces (different storage) for high-value events (publish, deletion, signing).

### boundary 9: agent → firestore (heartbeat, command poll)

- **trust delta**: semi-trusted → trusted.
- **what firestore rules enforce**: agent can only read/write documents whose path includes its own `siteId`; rules check token claims (consistent with B2 web pattern).
- **what agent must validate**: commands fetched from firestore include the agent's own `siteId` (defense in depth — if rules misconfigured, agent ignores commands not addressed to it).

### boundary 10: ci/cd → r2 + firebase + npm + ev signing

- **trust delta**: ci environment → all production trust roots.
- **what must be true**: every credential ci touches has hardware-backed mfa for the underlying account (B14); ci uses short-lived oidc tokens (gha → workload identity federation), not long-lived service account keys; no human commits credentials (per-commit secret scanning by gitguardian + pre-commit hook); ephemeral build vm for installer (B10).

---

## appendix d: incident response runbook outline

this is the contract — a separate `docs/internal/incident-response.md` (not in scope for this doc) details each step. but the **outline** is part of the threat model because the choices here constrain what can be detected + recovered from.

### severity ladder

- **sev-0**: customer data exposed publicly, signing cert compromised, fleet-wide deployment failure that takes shows offline.
- **sev-1**: cross-tenant data access between specific customers, audit-log tampering attempt detected, single high-value customer fleet down.
- **sev-2**: unbounded billing exposure (quota system bypassed), systemic but recoverable bug affecting <10% of fleet, single customer's deployments stuck.
- **sev-3**: degraded performance, isolated bugs, false-positive alerts.

### response time budget

| sev | acknowledgement | initial mitigation | full resolution | post-mortem |
|---|---|---|---|---|
| 0 | 15 min | 1 hr | 24 hr | 7 days |
| 1 | 1 hr | 4 hr | 72 hr | 14 days |
| 2 | 4 hr | 24 hr | 7 days | 30 days |
| 3 | 24 hr | best effort | best effort | optional |

### sev-0 / sev-1 first-hour playbook (security-relevant only)

1. **contain**: rotate the affected credential class immediately (signing cert → revoke + new cert; `owk_*` token → invalidate via firestore tombstone; firebase admin → rotate via console); if necessary, freeze the affected api route via feature flag (`ENABLE_V2_*` flag set false in firestore — agents and web both honor it).
2. **preserve**: snapshot audit log + relevant firestore subtrees + r2 bucket inventory **before** any cleanup; copy to write-once gcs bucket for forensics.
3. **assess blast radius**: query audit log for all `owk_*` use within the credential's lifetime; query signed-url issuance log for all urls issued via the credential; cross-check cloudflare access logs for r2 reads.
4. **notify**: customers affected within 72 hours per gdpr art. 33 obligations (controller notification — for customer-facing incidents we are processor; we notify the controller, they notify subjects); legal in the loop within the first hour for any sev-0.
5. **remediate**: deploy the structural fix, not just the credential rotation; if the same vulnerability could be hit by a second credential, the bug is the issue, not the credential.
6. **post-mortem**: blameless, public to the team, action items tracked in plan / next wave.

### what triggers an incident vs. an alert

- **alert** (no human on-call action required): single signed-url 403, single chunk hash mismatch, single quota warning.
- **incident**: pattern of 5+ failed-auth events in 5min for the same `owk_*`; chunk hash mismatch rate >0.1% over 5min (suggests upstream poisoning, not transient); signed-url issuance from a token outside its normal geo (potential exfil); audit log update / delete attempt (should be impossible per rules — if seen, indicates rules misconfiguration or bypass).

---

## appendix e: key + secret rotation schedule

this section is the **schedule**, not the procedure. procedures live in `docs/internal/key-custody.md` (separate doc).

| key / secret | rotation cadence | trigger for emergency rotation | owner |
|---|---|---|---|
| ev code-signing cert | every 3 years (cert lifetime) | suspected compromise; cert custodian role change | owner |
| firebase admin sdk service account | every 6 months | any audit-log anomaly involving admin operations | owner |
| `owk_*` api keys (per-customer) | customer-driven; ui supports rotation | any failed-auth pattern; offboarding event | customer + owner |
| tusd ↔ cloud function hook hmac secret | every 3 months | function deployment with new permissions; suspected leak | owner |
| gcp workload identity federation oidc trust | annual review | any github org-level change; ci pipeline change | owner |
| cloudflare api tokens | every 6 months | r2 policy change attempt detected; cloudflare account access change | owner |
| encryption key for `.tokens.enc` (machine-bound fernet) | per-machine, on first install + on os reinstall detection | machine ownership change | agent (automatic) |
| device pairing phrase wordlist | never (canonical list lives in web `pairPhrases.ts`); additions append-only | n/a | dev team |

emergency-rotation invariant: **every key class above has a documented procedure that one engineer can execute end-to-end without consulting another engineer.** if a procedure requires two-person knowledge, that is itself a security defect (single-person bus factor on incident response).

---

## appendix f: lessons that go in this doc, not in code comments

scattered observations from designing v2 that should not be lost in commit messages.

- **the moat is the deployment graph, not the bytes.** which version of which project is on which machine is the high-value data. chunk bytes are commodity. design implications: protect manifest pointers + audit log harder than chunk bytes; chunks are content-addressed and tamper-evident, manifest pointers are mutable and need transactional integrity.
- **content-addressing is not a substitute for authentication.** a chunk's hash proves the bytes are what was uploaded; it does not prove the uploader was authorized. baselines B1, B2, B3, B7, B8 do the auth work; B4, B5 do the integrity work. both are required.
- **audit log is investigative, not preventive.** B8 catches what happened after the fact. it does not stop the attack. preventive controls (B1, B2, B6, B9, B11, B14) are the front line; audit is the second line, used to scope blast radius and remediate.
- **fail-closed everywhere, including ux.** allowlist (F4), quota (B7), legal-readiness flag (F5), feature flags (incident response) all default to denying the operation if the underlying check is missing or errors. opening up requires explicit configuration, not the absence of it.
- **defense in depth is not optional.** cve-2025-4330 bypassed python's `data` filter — relying on a single mitigation, even a well-tested one, is brittle. B6 has three independent layers. the same logic applies to every "the platform handles it" assertion.
- **never trust bytes from the public internet, even after they touch our servers.** every byte that came from a customer device is suspect at every subsequent boundary (boundaries 2, 3, 4, 6, 7) until it has been verified again at that boundary.
- **the agent is on a machine we do not control.** agent-side checks are a safety net, not a security boundary. the security boundary is the cloud — agent compromise must not enable cloud compromise. token claims (B2), per-tenant chunk paths (cross-tenant read mitigation), command addressing (boundary 9) all enforce that agent compromise stays bounded to the compromised site.
- **legal blocks are technical blocks.** F5 is in this doc, not just in a contract drawer, because the implementation must enforce the legal precondition. an `ENABLE_V2_UPLOAD` feature flag tied to a `legal_ready` flag in firestore is the technical embodiment of the legal block.

---

## appendix g: threat actor playbooks (deep dive)

each actor from the top-level table is expanded into a concrete attack-tree sketch. these are not exhaustive — they are the **most-likely** path each actor takes against roost specifically. when reviewing a wave-2-5 design, walk these trees and ask whether the design closes each leaf.

### actor 1 — opportunistic firebase scanner

**capability profile**: scripted, drive-by, no human-in-the-loop, scans known patterns (firebase project ids, common bucket names, exposed `firebaseConfig` blobs in spa bundles). converts hits to credential dumps, sells on darknet markets within 24-72h.

**attack tree**:
1. enumerate `*.firebaseapp.com` + `*.web.app` subdomains for `firebaseConfig` exposure → if `apiKey` + `databaseURL` found, attempt unauthenticated firestore reads.
   - **closed by**: B1 default-deny rules + ci test that asserts unauth read → 403.
2. enumerate r2 buckets via cloudflare's known endpoints + customer-supplied bucket names from leaked manifests → attempt unauthenticated `GET /` for object listing.
   - **closed by**: B1 r2 bucket policy + signed-url-only access pattern.
3. scan github for `OWLETTE_API_KEY=owk_*` patterns → attempt api calls with discovered keys.
   - **closed by**: B9 pre-commit lint rule + gitguardian secondary scan + post-leak rotation procedure (appendix e).
4. attempt parameter tampering on `/api/v2/folders/{folderId}/manifests` to read other tenants' folders.
   - **closed by**: B2 token-derived tenant ids + cross-tenant test (`tenant-isolation.test.ts`).

**hardest leaf to close**: leaked `owk_*` from a customer's own ci. mitigation requires customer education + key-rotation ui + rate limits (B7) so a single leaked key has bounded blast radius.

### actor 2 — insider with stale `owk_*`

**capability profile**: knows internal architecture, has historical access, motivated by spite or financial gain, may operate over weeks not minutes. unlike actor 1, willing to go slow to avoid rate-limit detection.

**attack tree**:
1. retain copy of `owk_*` from active tenure → use post-offboarding to read manifests + chunks for as-yet-undeployed campaigns.
   - **closed by**: B7 rate limit makes mass-exfil noisy; B8 audit log catches use after offboarding date; **must add**: ci check that any `owk_*` not used in 90 days is auto-tombstoned (deferred-revocation pattern); ui for customer admins to see + revoke all keys including ones owned by other team members.
2. drip-exfiltrate one chunk per hour to evade rate-limit detection.
   - **partially closed by**: B7 rate limit + B8 audit log pattern detection (anomalous geo, time-of-day patterns); not fully closed — relies on monitoring sophistication. mitigation: per-customer quota on signed-url issuance (separate budget from upload), surfaced to customer admins.
3. tamper with manifest pointer to publish a deprecated version (e.g. one with a known content moderation issue).
   - **closed by**: B2 + audit log + manifest-publish rate limits + customer admin notification on every publish.

**hardest leaf to close**: the legitimate-looking publish from a user with retained credentials and a history of normal usage. mitigation requires actor-2-aware behavioral analysis (out of scope for v2; tracked as v3.cortex feature). interim: `owk_*` cannot publish — only firebase-id-token authenticated humans can publish (api-key-write-restricted pattern). this is a constraint we should bake into v2 from the start.

### actor 3 — ransomware operator

**capability profile**: highly funded (sometimes nation-state-adjacent), moves fast post-breach (lateral movement in <48h), targets backup + recovery infrastructure first. signage networks are attractive because downtime = pressure to pay.

**attack tree**:
1. compromise admin endpoint via phishing → use admin to publish corrupted manifests fleet-wide.
   - **closed by**: B14 hardware mfa on admin accounts + multi-step publish ui (preview + confirm) + B8 audit log for forensic recovery + manifest rollback (F3 mitigation).
2. compromise installer signing cert → distribute trojan installer to all customers in next release.
   - **closed by**: B10 ephemeral build vm + B14 hardware mfa on cert custodian + sha-256 publication (customer can verify out-of-band) + auto-update opt-in only (customers control when they upgrade).
3. compromise r2 admin → bulk-delete chunks across all tenants.
   - **closed by**: B14 hardware mfa on cloudflare account + r2 versioning + lifecycle rules that retain deleted objects 30 days + offsite manifest backup (manifest in r2 + checksums in firestore = recoverable).
4. ransom-encrypt local agent storage to take shows offline.
   - **partially closed by**: agent runs as `system` and `system` is what ransomware wants — agent itself is not a hardening point. mitigation: customer host hardening (out of scope); local content store + already-extracted projects survive r2 outage but not local fs encryption. accepted risk; documented for customers.

**hardest leaf to close**: customer-host ransomware that takes down all installations on a single customer's network. accepted as out-of-scope (we are not an edr vendor); roost contributes by enabling fast recovery (re-install agent + re-deploy from manifest = full restoration in <30min for a 100gb project given r2 download speed).

### actor 4 — content defacement vandal

**capability profile**: low-skill, high-publicity-seeking. uses stolen credentials or social-engineered access. does not need persistence — single publish event achieves the goal.

**attack tree**:
1. phish customer admin → publish offensive content.
   - **closed by**: B14 mfa (mandatory for admin in customer org policy — we support, customers must enable; documented in onboarding); customer-side approval workflow (v3 feature; v2 mitigation is fast rollback, F3).
2. exploit filename-based xss to deface dashboard for customer's other admins.
   - **closed by**: B12 sanitization + react text-node rendering only.
3. upload content under another tenant's `siteId` via parameter tampering.
   - **closed by**: B2 token-derived tenant ids.

**hardest leaf to close**: a customer-admin account legitimately publishes defacement (insider variant). mitigation: rapid rollback + audit log enables prosecution; v3 approval workflow is the structural fix.

### actor 5 — competitor

**capability profile**: medium-skill, well-funded, time-flexible. hires ex-employees, social engineers support staff, attempts long-term access.

**attack tree**:
1. plant ex-employee at competitor → ex-employee retains `owk_*` or admin access.
   - **closed by**: same controls as actor 2.
2. social-engineer support staff to manually grant access "for debugging".
   - **closed by**: documented support access procedure (no support staff has standing access to customer data; access requests require customer-side approval token; tracked in `docs/internal/support-access.md` — separate doc).
3. target a known customer's publish flow; intercept manifest in transit (mitm).
   - **closed by**: tls 1.3 + cert pinning (web is browser-pinned via hsts; agent pins specific certificate authorities); content-addressing makes byte-level tampering detectable but does not protect manifest pointer (actor 5 needs to break tls + firestore auth — implausible for non-state actor).

**hardest leaf to close**: pre-employment exfiltration before offboarding triggers. mitigation: customer-side audit + access reviews (their responsibility); roost provides B8 audit log as the evidence trail.

### actor 6 — state actor

**capability profile**: full apt toolkit, supply-chain capable, willing to spend years. tail risk for installs at airports, embassies, doe sites.

**attack tree**:
1. compromise upstream dep (npm, pypi) → poison agent or web build.
   - **closed by**: pinned versions + `ignore-scripts=true` + ephemeral build vm (B10) + signed installer (B10). residual: a poisoned dep that survives audit + makes it into a signed release. mitigation: limit dep count (audit `package.json` + `requirements.txt` quarterly; remove unused).
2. compromise cloudflare itself (low probability, high impact).
   - **partially closed by**: byo-bucket enterprise tier (customer can run on aws s3 instead of r2); tuf manifest signing (v3) limits cloudflare-only compromise to availability impact, not integrity.
3. compromise gcp itself (low probability, high impact).
   - **closed by**: nothing in v2; this is the implicit trust assumption. v3 considerations: multi-cloud manifest pointer (cross-write to a non-google datastore as integrity check).
4. lawful-intercept order against firebase or cloudflare to read customer data.
   - **closed by**: cmek (v3 enterprise tier) + data residency (jurisdiction selection) + transparency reports.

**hardest leaf to close**: cloudflare or google compromise / lawful-intercept. v2 accepts this risk; v3 cmek + tuf reduces it.

---

## appendix h: wave-by-wave security task crosswalk

operationalizes this doc against `dev/active/project-distribution-v2/plan.md` waves. each wave's security-relevant tasks are listed. if a wave is missing a row here that the plan implies, **the plan is incomplete and must be updated**.

### wave 0 — legal + business + infra

| task | security item | doc reference |
|---|---|---|
| 0.1 tos | F5 (legal blocker on upload), B15 (deletion sla) | F5, B15 |
| 0.2 dmca + repeat-infringer enforcement | F5, real precedent: bmg v. cox | F5, "real precedents" |
| 0.3 cyber insurance | F5 (uninsured loss is fatal) | F5 |
| 0.5 cloudflare r2 setup | B1, B2, B3, cross-tenant chunk path scheme | B1-B3, "specific attack surfaces" |
| 0.6 gcp project setup | B14 (hardware mfa on owner) | B14 |
| 0.7 ev cert procurement | B10 | B10 |
| ops (key custody) | B14, appendix e | B14, appendix e |

### wave 1 — spikes + foundations + refactor + test infra

| task | security item | doc reference |
|---|---|---|
| 1.1 r2 spike | validate B1, B3, cross-tenant prefix works | "specific attack surfaces" |
| 1.5 commandrouter refactor | boundary 9 (agent ↔ firestore command addressing) | appendix c |
| 1.6 test infrastructure | enables all baseline verification tests | all baselines |
| 1.7 destination_allowlist.py | F4, B6 (allowlist root for realpath check) | F4, B6 |
| 1.8 firestore rules + storage rules | B1, B2, B8 (audit log immutability) | B1, B2, B8 |
| 1.9 manifest format | content-addressing scheme = mitigation for "manifest substitution" | "specific attack surfaces" |
| 1.10 threat model | this document | n/a |
| 1.11 v1-v2 migration | ssrf in v1 byo-url flow must be patched in parallel (B11) | B11, plan.md risks |

### wave 2a — server apis

| task | security item | doc reference |
|---|---|---|
| 2a.1 chunk check route | B2, B3, B7 (rate limit), B8 (audit) | B2, B3, B7, B8 |
| 2a.2 chunk upload-urls route | B2, B3 (60min cap), B7, B8 | B2, B3, B7, B8 |
| 2a.3 chunk download-urls route | B2, B3 (15min cap), B7, B8, cross-tenant prefix check | B2, B3, B7, B8 |
| 2a.4 manifest publish route | B2, B8, F3 (transaction + pointer race) | B2, B8, F3 |
| 2a.5 rollback route | B2, B8, F3 (rollback pin) | B2, B8, F3 |
| 2a.6 deletion route (wave 5 in plan but security here) | B8, B15 | B8, B15 |
| 2a.7 next.config.js headers | B13 | B13 |
| 2a.8 rfc 7807 error middleware | must not leak token / tenant info in error responses | B9 (logging pattern), B12 (sanitization) |

### wave 2b — cloud functions

| task | security item | doc reference |
|---|---|---|
| chunkVerify.ts | B5 | B5 |
| chunkGc.ts | F2 (gc safety) | F2 |
| quotaEnforce.ts | B7, F1 | B7, F1 |
| distributionFanout.ts | boundary 8 (audit log on dispatch), boundary 9 (agent command addressing) | appendix c |
| webhookDispatch.ts | B11 (ssrf on webhook destination url) | B11 |
| auditLog.ts | B8 | B8 |
| telemetry.ts | no token logging in traces (B9); pii handling for trace attributes | B9 |
| tusd hook function | B7 (pre-upload quota), boundary 1 (filename sanitize), tusd hook hmac | B7, B12, "specific attack surfaces" |

### wave 3 — web upload + rollback ui

| task | security item | doc reference |
|---|---|---|
| folder upload dropzone | B12 (sanitize), boundary 1 (browser → tusd) | B12, appendix c |
| pre-upload summary | quota visibility (B7 ui surface) | B7 |
| rollback confirm dialog | F3 (rollback pin), B8 (audit on rollback) | F3, B8 |
| empty-state upload | n/a directly; ensure no info leak in empty-state messaging | n/a |
| allowlist editor (admin ui) | F4 ui surface | F4 |
| sanitize.ts | B12 | B12 |
| upload queue | resume token storage in localstorage acceptable (no secret data); upload metadata only | n/a |

### wave 4a — agent core

| task | security item | doc reference |
|---|---|---|
| sync_commands.py | boundary 9 (agent ↔ firestore command addressing) | appendix c |
| sync_manifest.py | content-addressing (B4), manifest pin (toctou mitigation) | B4, "specific attack surfaces" |
| sync_downloader.py | B4 (re-hash after download), boundary 6 | B4, appendix c |
| sync_state.py | sqlite wal for resume + pin state | "specific attack surfaces" (toctou) |

### wave 4b — agent security

| task | security item | doc reference |
|---|---|---|
| 4b.1 sync_assembler.py | B6 (per-file destination_allowlist + realpath + symlink rejection), zip bomb cap, atomic swap | B6, "specific attack surfaces" |
| 4b.2 python ≥3.12 pin in installer | B6 prerequisite (`pathlib.Path` improvements + general security posture) | B6 |
| 4b.3 acl on extracted assets | B6 (admins+system only) | B6 |
| 4b.4 reject symlinks on windows | B6, F4 | B6, F4 |
| 4b.5 throttled progress reporting | no token in heartbeat (B9) | B9 |

### wave 4c — agent tests

every test under `agent/tests/` listed in baseline + failure mode rows is required here. zero exceptions.

### wave 5 — webhooks + migration + signing

| task | security item | doc reference |
|---|---|---|
| 5.1 webhook routes | B8 (audit), B11 (ssrf on customer webhook url), hmac sign outbound | B8, B11 |
| 5.2 v1 cutover | F5 (legal must be ready before v1 customers can use v2), B11 (v1 ssrf patched) | F5, B11 |
| 5.3 deletion api | B15, F2 (per-tenant gc path), gdpr art. 17 | B15, F2 |

### wave 6 — beta + cutover

| task | security item | doc reference |
|---|---|---|
| 6.1 beta program | scoped to internal accounts only until F5 fully resolved | F5 |
| 6.2 monitoring | audit log review automation; alarms per appendix d incident response | B8, appendix d |
| 6.3 main cutover | full pentest before contract value > $25k acv | "penetration testing" |
| 6.4 v1 code removal | only after 4 weeks production runtime; B11 v1 patch already shipped | B11 |

---

## appendix i: open questions tracked against this doc

these are items where the threat model is **complete enough to ship v2** but where future engineering work needs to revisit. listed so they don't fall off the radar.

1. **`owk_*` publish restriction**: should `owk_*` keys be allowed to publish manifests, or only to read? actor 2 playbook argues for read-only. proposal: v2 ships with `owk_*` read-only for manifest publish; firebase-id-token-only for publish. tracked for wave 2a.4 design review.
2. **deferred-revocation for unused `owk_*`**: 90-day auto-tombstone for unused keys. requires tracking last-use timestamp on token doc + nightly sweep. proposal: ship in wave 2b alongside `auditLog.ts`. tracked.
3. **per-customer signed-url issuance budget vs. download budget**: B7 covers storage; signed-url issuance count is a separate axis (a token can issue many urls without uploading much). proposal: separate budget surfaced to customer admin. tracked for wave 2b `quotaEnforce.ts`.
4. **support staff access procedure**: actor 5 mitigation references `docs/internal/support-access.md`. that doc does not exist yet; before first hire of support staff, this doc must be written. tracked for whichever wave introduces support hires.
5. **incident response runbook full text**: appendix d is an outline; full runbook (`docs/internal/incident-response.md`) needed before first external customer. tracked for wave 0 exit criteria.
6. **key custody full text**: appendix e is a schedule; full procedures (`docs/internal/key-custody.md`) needed before first ev cert + first customer onboarding. tracked for wave 0 exit criteria.
7. **csp `unsafe-inline` removal**: B13 ships with `unsafe-inline` in `script-src` because firebase auth iframe + uppy require it. tracking removal as a separate cleanup task post-v2.
8. **byo-bucket enterprise tier security review**: enterprise customers can use their own r2 / s3 buckets. the threat model assumes our r2 — when enterprise byo ships, a separate review is required for the customer-bucket trust delta (their iam is now in the loop).
9. **virustotal scan on upload**: cloud function `virusTotalScan.ts` is queued for v3 but actor-3 + actor-4 mitigations would benefit from it earlier. proposal: re-evaluate in wave 5; if cheap to bolt on, ship in v2.

---

**end of threat-model.md.**


