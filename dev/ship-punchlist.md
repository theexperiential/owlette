# Ship punchlist — synthesized from 8 parallel audits

**Generated**: 2026-04-28
**Current version**: 2.11.0 (next planned: TBD — likely 2.12.0 or the cutover release)
**Sources**: 5 codex agents (agent / roost / security / public-api / cross-cutting) + 3 Claude agents (recent agent changes / plan deferrals / installer-GUI)
**Reports**: `dev/codex-dev-audit-{1..5}*.output.md` and the 3 Claude transcripts above

> **READER NOTE**: This list was assembled by deep-audit agents. It will tend to MAXIMIZE findings — that's its job. Severity labels (P0/P1/P2) are an aggregator's first cut, NOT validated as ship-blockers. A second-pass review (3 codex + 3 claude) is challenging every item to produce a "smallest set of fixes that lets us ship safely" recommendation. The team has been on these initiatives for weeks; ship pressure is real.

The plan headers said ~80–87% done across 4 active plans. The audits found that several "checked" items are partially-shipped or wrong, and the cross-cutting audit surfaced 45 uncommitted files plus untracked production hazards. The picture is more complex than the headers suggested — but how much of it is genuinely ship-blocking is the question this list cannot answer on its own.

---

## P0 — Candidate ship blockers (real bugs / show-stoppers)

These are not "to-do" items. They are bugs in code that's marked done.

### Roost (claimed-done with broken implementations)
1. **Cloud-function fanout queues `folder_id` but agent expects `roost_id`** — `functions/src/distributionFanout.ts` vs `agent/src/sync_commands.py`. Fanout-triggered canary/fleet syncs fail before any disk work.
2. **R2 production adapters throw `R2 object store not wired`** in `functions/src/chunkVerify.ts`, `chunkGc.ts`, `quotaEnforce.ts` (`getDefaultStore()`). Pure logic exists, real adapter doesn't. Tasks 2b.2, 2b.4, 2b.5 are checked as done but stubbed.
3. **Firestore rules protect WRONG fields** — rules guard `currentManifestId` / `previousManifestId` / `manifestUrl` but live code writes `currentVersionId` / `previousVersionId` / `versionUrl` ([web/app/api/roosts/[roostId]/versions/route.ts](web/app/api/roosts/[roostId]/versions/route.ts) and rollback). Direct client writes can bypass server-mediated CAS controls. (task 1.8)
4. **Roost kill switch (`gateOrProceed`) not wired** into web API chunks/folders routes — agent checks it, web side ignores it. Kill switch is dead code on the upload path. (task 5.4)
5. **GC scans wrong Firestore path** — `chunkGc.ts` looks for `version.chunks` array but publish stores `sites/{siteId}/chunk_referrers/{digest}/entries/...`. If R2 were wired today, GC would treat live chunks as unreferenced. (task 2b.4)
6. **Reboot resume not wired** — `agent/src/sync_state.list_pending_distributions()` exists but no startup caller. Power loss mid-sync requires the same `sync_pull` command to be re-delivered. (task 4a.4)
7. **`cancel_sync` cannot run during active `sync_pull`** — both queued on the single slow-command worker. While `sync_pull` is downloading, the cancel handler can't run to set `_inflight_cancels[dist_id]`. The roost v2 cancellation contract is unreachable during an active sync.
8. **`PreUploadSummary` component exists but not rendered** in `ProjectDistributionDialog` or roost upload UI. Disk/quota blockers don't actually stop the user before upload. (task 3.4)

### Security boundary (claimed-done with wrapper bypasses)
9. **Reconcilers not exported** — `functions/src/reconcileDeploymentStatus.ts` and `reconcileDistributionStatus.ts` exist + tested, but `functions/src/index.ts` doesn't export them. They will not deploy. (task 2.4)
10. **Project distribution routes bypass `authorizedSiteHandler`** — POST/DELETE/cancel use legacy `requireSiteAuthAndScope`. No capability check, no rate limit, no blocking audit:
    - [web/app/api/sites/[siteId]/project-distributions/route.ts:113](web/app/api/sites/[siteId]/project-distributions/route.ts#L113)
    - [web/app/api/sites/[siteId]/project-distributions/[distId]/route.ts:96](web/app/api/sites/[siteId]/project-distributions/[distId]/route.ts#L96)
    - [web/app/api/sites/[siteId]/project-distributions/[distId]/cancel/route.ts:41](web/app/api/sites/[siteId]/project-distributions/[distId]/cancel/route.ts#L41)
11. **Site-member routes bypass wrapper** — direct `FieldValue.arrayUnion` / `arrayRemove` on `users/{uid}.sites` without `authorizedSiteHandler(Capability.SITE_MEMBER_MANAGE)`:
    - [web/app/api/sites/[siteId]/members/route.ts:227](web/app/api/sites/[siteId]/members/route.ts#L227)
    - [web/app/api/sites/[siteId]/members/[uid]/route.ts:103](web/app/api/sites/[siteId]/members/[uid]/route.ts#L103)
12. **Installer routes bypass `authorizedPlatformHandler`** — `requirePlatformAuthAndScope` instead. No capability/rate/audit:
    - [web/app/api/installer/upload/route.ts:68](web/app/api/installer/upload/route.ts#L68) and `:207`
    - [web/app/api/installer/[version]/set-latest/route.ts:58](web/app/api/installer/[version]/set-latest/route.ts#L58)
    - [web/app/api/installer/[version]/route.ts:49](web/app/api/installer/[version]/route.ts#L49)
13. **`MockService` ↔ `OwletteService` drift (8 attributes)** — production NSSM runs through MockService; missing `_drift_pending_key`, `_last_auto_restore_success_key`, `hWaitStop`, `_scm_stop_requested`. Known crash landmine.

### Cross-cutting production landmines
14. **`validateEnvironmentOrThrow()` is TEMPORARILY DISABLED** in [web/app/layout.tsx:71](web/app/layout.tsx#L71). Production can boot with placeholder/missing Firebase env.
15. **Webhook URL TOCTOU SSRF** — `web/lib/webhookUrl.ts:17` says dispatcher MUST re-validate at send time but `functions/src/webhookDispatch.ts:377` and `web/lib/webhookSender.server.ts:304` fetch stored URLs directly. SSRF gap.

---

## P1 — Block "secure / clean / observable" launch claim

16. **Audit log emission from existing callsites is deferred** — plumbing exists, mutations don't call it. Same gap surfaces in roost task 2b.7 AND public-api `audit-event-coverage.md`. "Append-only audit log" is currently a marketing promise, not a wired feature.
17. **90-day audit-log TTL cleanup cron** is a no-op placeholder ([web/lib/auditLog.server.ts:309](web/lib/auditLog.server.ts#L309)). Was stubbed in security wave 1.3, never implemented. Unbounded audit growth.
18. **ESLint rules A/B (wave 2.1) tests are skipped with TODOs** — direct-write scanner has known blind spots that lint wouldn't catch:
    - [web/__tests__/lib/authorizedHandler.eslint.test.ts:91](web/__tests__/lib/authorizedHandler.eslint.test.ts#L91), `:116`, `:157`
19. **Wave 8.2 observability scaffolding** — never started. Blocking prereq for wave 9.1 prod deploy. Need: dashboards, alerts, indexes, `docs/ops/security-boundary-monitoring.md`.
20. **Webhook events not emitted** — `version.published`, `version.rolled_back`, `deployment.started/completed/failed` are dispatcher-owned and never fire. [web/app/api/roosts/[roostId]/rollback/route.ts:246](web/app/api/roosts/[roostId]/rollback/route.ts#L246) carries the explicit TODO.
21. **Long-path support partial** — agent code uses `_long_path()`, but installer never flips `LongPathsEnabled=1` registry. Paths >260 chars still fail on default Windows. Trivial Inno Setup edit. (task 4b.4)
22. **No auth on `getUsageSummaryHttp`** — per-tenant cost endpoint depends on caller-supplied siteId. Privacy gap. (task 2b.6)
23. **Schema migration missing for `sites/{siteId}.plan`** — quota assumes field that doesn't exist on existing site docs. Existing customers can't be quota-enforced.
24. **`extract_path` migration question is STILL OPEN** — `dev/active/project-distribution-v2/context.md` flags this. Existing distributions with non-default `extract_path` may silently break post-cutover.
25. **R2 keys + Railway env propagation + 1MB live agent smoke** — task 0.5 deferred. R2 wiring has never been exercised end-to-end from the deployed web service. Latent prod risk.
26. **Wave 8.0 rate-limit shadow data** — calibration accepted with caveat ("low-traffic risk accepted for W7 lockdown only"). Going to PROD presumably needs a real calibration window with prod-like traffic.

---

## P2 — Hygiene / hidden debt

### CI / build / lint
27. **`npm run lint` is RED** — 3 `no-var` errors in `web/__tests__/api/site-logs.test.ts:15`, `sites-machines-display-layout.test.ts:8`, `sites-machines-processes.test.ts:70`.
28. **No web unit/lint/typecheck CI** — only e2e + openapi-validate + token-logs guards run.
29. **No agent CI** — `build-installer.yml` only fires on tags/manual dispatch, doesn't run agent unit tests for PRs/dev pushes. No 4c.5-style job.
30. **No functions test CI**, no SDK test CI.
31. **SLSA provenance bug** — `build-installer.yml` outputs hex from `steps.digest.outputs.sha256` but passes to SLSA `base64-subjects`. Provenance generation may be malformed.
32. **Six missing Firestore indexes** that will fail in prod with "missing index" runtime errors:
    - `webhook_deliveries` (subscriptionId ASC, createdAt DESC)
    - `users` (role ASC, __name__ ASC)
    - `users` (sites ARRAY_CONTAINS, __name__ ASC)
    - `users` (role ASC, sites ARRAY_CONTAINS, __name__ ASC)
    - `dmca_notices` (complainant.email ASC, submittedAt ASC)
    - `dmca_notices` (sourceIp ASC, submittedAt ASC)

### Stale / wrong paperwork
33. **`reference/write-inventory.md` is stale** — says 24 control-plane hits; actual is 0.
34. **Readiness gate has a bug** — `scripts/check-lockdown-ready.mjs:370-381` looks for dormant `test.failing()` denial tests, but wave 7 flipped them all to active. Gate runs against wrong assumption.
35. **CLAUDE.md says public CLI is "v3-deferred"** — but the CLI is actually shipped. Will cause future agents to suppress CLI work. (Note: the v3 framing throughout planning docs is itself an artifact — actual current version is 2.11.0.)
36. **CLAUDE.md links `docs/version-management.md`** — actual file is at `docs/internal/version-management.md`.
37. **Stale `agent/owlette_setup.iss`** (Nov 2024, PyInstaller-era, v0.4.2 / config v1.3.0) — not referenced by any build script but a footgun for anyone who runs ISCC on the wrong file.
38. **Multiple "coming soon" doc lies**:
    - `owlette machine live-view` registered as stub, no public route
    - `owlette webhook ...` planned but webhook routes already exist
    - `owlette listen` is liveness only; full event fanout deferred
    - `docs/api/webhooks.md` lists lifecycle events not accepted by current validator
    - `docs/internal/manifest-format.md:422` plans `web/scripts/validate-manifest.ts` (file doesn't exist)
    - `docs/internal/threat-model.md:110` plans VirusTotal scan (`functions/src/virusTotalScan.ts` doesn't exist)
    - 90-day auto-tombstone for unused `owk_*` keys is "must add" but no plan owns it

### 45 uncommitted files
WIP feature work that needs to land or be deliberately discarded:
- Chat owner-isolation: `web/app/api/chat/[conversationId]/route.ts`, `web/app/api/chat/route.ts`, `web/__tests__/api/chat.test.ts` — fixes cross-user conversation access inside a site
- Mandatory installer checksum: `agent/src/owlette_service.py` (uncommitted)
- Idempotency streaming guard: `web/lib/idempotency.ts` — avoid caching streaming responses
- Isolated E2E setup: `web/e2e/global-setup.ts`, `helpers/emulator.ts`, `helpers/roles.ts`, `specs/auth/logout.spec.ts`, `web/eslint.config.mjs`
- Landing redesign: `web/app/page.tsx`, `web/app/globals.css`, `web/components/landing/FAQSection.tsx`, `UseCaseSection.tsx` + `dev/landing-redesign/` brief docs
- Public-api launch docs: `docs/api/{developer-preview-checklist,launch-assets,overview}.md`, `docs/api/examples/{ci-cd-github-actions,sdk-workflows}.md`, `mkdocs.yml`
- GitHub Action: `.github/actions/owlette-roost-deploy/{action.yml,README.md}`, `examples/github-actions/{README.md,roost-deploy.yml}`
- Lockdown readiness gate: `scripts/check-lockdown-ready.mjs`
- Emulator host parsing: `web/lib/firebase.ts`

Plus 12 investigation artifacts (`.claude/codex-prompts/*`, `dev/build-failure-context.md`, `test-results/*` error contexts) that should be moved or deleted.

### Agent dead code / cleanup (cutover PR)
39. **v1 distribution code in agent** — delete in cutover PR:
    - `agent/src/project_utils.py` (entire file)
    - `agent/src/owlette_service.py:14` (`import project_utils`)
    - `agent/src/owlette_service.py:3601-3689` (`distribute_project` + `cancel_distribution` handlers)
40. **GUI dead methods** — `agent/src/owlette_gui.py:984` (`add_process` legacy), `:1362` (`_bind_right_click_to_list` no-op), `:1977` (`restart_service` orphan).
41. **12 unreferenced functions** in agent — full list in [dev/codex-dev-audit-1-agent.output.md](dev/codex-dev-audit-1-agent.output.md).
42. **~30 unused imports** in agent.
43. **Cortex `get_gpu_processes` decorated as Tier 1 tool but omitted from `_make_tier1_tools()` list** — unreachable. Either wire or remove.
44. **29 agent modules with zero test coverage** — `owlette_service.py`, `owlette_runner.py`, `configure_site.py`, `cortex_tools.py`, `machine_commands.py`, `nvapi_display.py`, `pair_phrases.py`, etc.

### Installer / GUI polish (claude installer audit)
45. Bump `agent/owlette_installer.iss:43` example to current version (cosmetic)
46. Bump `:57` fallback `MyAppVersion "2.4.0"` → current version (so build-without-env still gets a sane name)
47. Hardcoded `nssm.exe` path uses 3 nested `dirname` calls — brittle in dev mode
48. GUI `Join Site` 5-min timeout vs server 10-min phrase TTL
49. Silent install + no `/ADD=` + no default browser = silent black hole. Either fail with MsgBox or write phrase to `C:\ProgramData\Owlette\PAIRING_PHRASE.txt`
50. First-boot `python.exe` console window during pairing looks like malware to non-technical users — replace with branded CTk popup

---

## P3 — Roadmap items with no active plan

(Not ship blockers — flagged for future planning):
- Log TTL for site/machine logs (`sites/{id}/logs`, `machines/{id}/logs`) — distinct from audit log retention
- SMS alerts
- Process reports
- Send logs to Owlette from tray/GUI
- In-app support chat
- Stripe integration
- Usage dashboard

---

## SDK / CLI launch readiness (public-api)

| Surface | Coverage | Publish path |
|---|---|---|
| Node SDK (`@owlette/sdk`) | 87/153 (~57%) | No publish workflow, no package script |
| Python SDK (`owlette-sdk`) | 84/153 (~55%) | No publish workflow, no package script |
| CLI (`@owlette/cli`) | 63/153 (~41%) | `cli-publish.yml` exists but not RC-ready |
| Homebrew/Scoop/winget | 0 | Not present |
| Docs narrative pages | partial | Missing: sites, machines, processes, classic deployments, installer mgmt, users/members, quotas, logs, audit-log, presets, project distributions, platform utilities, runbook |

**Decision needed**: ship the partial-coverage SDKs/CLI with a "raw `client.http.request()` for non-MVP endpoints" doc, or invest M-L weeks to bring coverage to ~100%.

---

## What was VERIFIED clean

- Browser-side direct Firestore writes: **0** ✓ (only 8 allowlisted preference writes in `AuthContext.tsx`, `useCortex.ts`, `useDevicePrefs.ts`)
- `enforcementBypassed` usage: confined to audit writers + wrappers + invokers + documented self-delete inline exception ✓
- `/api/admin` namespace: gone from production code ✓
- `firestore.rules` v2.3.0: browser writes to control-plane paths denied ✓
- Wave-3 action cores + tests: all 12 ship with real implementations ✓ (with the `requireSiteAuthAndScope` wrapper-mismatch noted in P0)
- Roost agent sync stack: wired into command_router, registered, dispatched ✓ (with cancel-during-active-sync gap noted in P0)
- 7-day denial-test suite: 37 active tests, no `test.failing` left ✓
- e2e security-boundary specs: bypass + rollback rehearsal coverage exists ✓
- OpenAPI validator: 106 paths × 144 routes × 153 ops, all green ✓

---

## TL;DR — what's actually left to DEV

The plan headers said ~80–87% done. The audit-adjusted picture:

- **Real bug fixes that block prod**: ~15 items across roost (fanout payload, R2 stubs, kill switch, reboot resume, cancel race, rules-field mismatch) and security (reconciler exports, 5+ wrapper bypasses, MockService drift) and cross-cutting (env validation, webhook SSRF). Each is small individually. Total: **probably 1–2 engineer-weeks**.
- **Partial-feature completion**: ~10 items (audit emission wiring, observability scaffolding, long-path installer flag, schema migration, R2 live smoke, webhook event firing). Total: **another 1–2 engineer-weeks**.
- **Hygiene**: lint-fix, missing CI workflows, missing Firestore indexes, stale paperwork, dead code deletion, doc honesty pass. Total: **~3–5 engineer-days** if batched.
- **Uncommitted WIP**: 45 files to land-or-discard. Total: **~2–3 engineer-days** of triage + small fixes.
- **Launch glue (out of dev scope)**: design-partner soak, prod deploy, 24h soak, rules lockdown, audit emission verification.

**Aggregator's first-cut estimate**: 3–4 engineer-weeks IF every item on this list is treated as ship-blocking. **The second-pass review will sharply reduce this** by ruling out items that are perfectionism, items that can be hot-fixed post-ship, and items that turn out to be false alarms on closer reading. Don't take this number to bed — wait for the review verdicts.
