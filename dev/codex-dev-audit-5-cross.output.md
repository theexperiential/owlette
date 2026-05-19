# Cross-cutting dev-gap audit

## Summary
- 45 uncommitted files excluding `.next/`, `node_modules/`, `agent/build/`, and `dev/codex-*` artifacts (33 WIP, 0 scratch, 12 artifacts)
- 3 recent commits flagged as incomplete or stub-bearing
- 8 TODO/FIXME/MUST comments with launch implications
- 1 half-finished UI/demo pattern
- 3 skipped/failing tests in `web/__tests__/`
- 7 production gates or default-off flags still controlling launch behavior
- 10 documented "not yet" promises
- 3 changelog gaps

## Uncommitted work
| File | Classification | Recommendation |
|---|---|---|
| `agent/src/owlette_service.py` | WIP feature work | Land with tests or revert intentionally; makes remote third-party installer checksum mandatory. |
| `docs/api/developer-preview-checklist.md` | WIP feature work | Land with launch-assets docs as one public API launch-doc slice. |
| `docs/api/examples/ci-cd-github-actions.md` | WIP feature work | Land after verifying the new action and `@owlette/cli@rc` install path. |
| `docs/api/examples/sdk-workflows.md` | WIP feature work | Land with launch-assets docs. |
| `docs/api/overview.md` | WIP feature work | Land with launch-assets docs. |
| `mkdocs.yml` | WIP feature work | Land with `docs/api/launch-assets.md`; otherwise nav points at an untracked page. |
| `scripts/check-lockdown-ready.mjs` | WIP feature work | Land as security-boundary readiness infra after proving isolated E2E cleanup works on failure. |
| `web/__tests__/api/chat.test.ts` | WIP feature work | Land with chat owner-isolation route changes. |
| `web/app/api/chat/[conversationId]/route.ts` | WIP feature work | Land; fixes cross-user conversation access inside same site. |
| `web/app/api/chat/route.ts` | WIP feature work | Land; defaults chat listing to owner-only unless superadmin. |
| `web/app/globals.css` | WIP feature work | Land with landing reduced-motion changes. |
| `web/app/page.tsx` | WIP feature work | Land with landing copy/SEO updates. |
| `web/components/landing/FAQSection.tsx` | WIP feature work | Land with license-copy fix. |
| `web/components/landing/UseCaseSection.tsx` | WIP feature work | Land with landing copy refresh. |
| `web/e2e/global-setup.ts` | WIP feature work | Land with isolated E2E port/fixture support. |
| `web/e2e/helpers/emulator.ts` | WIP feature work | Land with isolated emulator support. |
| `web/e2e/helpers/roles.ts` | WIP feature work | Land with isolated fixture support. |
| `web/e2e/specs/auth/logout.spec.ts` | WIP feature work | Land with configurable E2E port support. |
| `web/eslint.config.mjs` | WIP feature work | Land with `.next-*` ignore if isolated E2E build dirs stay. |
| `web/lib/firebase.ts` | WIP feature work | Land with emulator host parsing. |
| `web/lib/idempotency.ts` | WIP feature work | Land; avoids caching/buffering streaming responses. |
| `.github/actions/owlette-roost-deploy/README.md` | WIP feature work | Land after action smoke test on clean GitHub-hosted runner. |
| `.github/actions/owlette-roost-deploy/action.yml` | WIP feature work | Land after verifying `owlette roost push/deploy` JSON shape and action inputs. |
| `docs/api/launch-assets.md` | WIP feature work | Land; this is now linked from modified docs and `mkdocs.yml`. |
| `examples/github-actions/README.md` | WIP feature work | Land with the reusable action. |
| `examples/github-actions/roost-deploy.yml` | WIP feature work | Land after action smoke test. |
| `dev/landing-redesign/BRIEF.md` | WIP feature work | Move accepted material into `dev/active/landing-redesign/` or delete/archive losers. |
| `dev/landing-redesign/claude-1.md` | WIP feature work | Same as above. |
| `dev/landing-redesign/claude-2.md` | WIP feature work | Same as above. |
| `dev/landing-redesign/claude-3.md` | WIP feature work | Same as above. |
| `dev/landing-redesign/codex-1.md` | WIP feature work | Same as above. |
| `dev/landing-redesign/codex-2.md` | WIP feature work | Same as above. |
| `dev/landing-redesign/codex-3.md` | WIP feature work | Same as above. |
| `.claude/codex-prompts/codex-a.md` | Investigation artifact | Keep only if prompt archive is intentional; otherwise delete. |
| `.claude/codex-prompts/codex-b.md` | Investigation artifact | Keep only if prompt archive is intentional; otherwise delete. |
| `.claude/codex-prompts/review-flagged-items.md` | Investigation artifact | Keep only if prompt archive is intentional; otherwise delete. |
| `.claude/codex-prompts/review-option-a-ast-static-check.md` | Investigation artifact | Keep only if prompt archive is intentional; otherwise delete. |
| `.claude/codex-prompts/review-option-b-extract-handle-firebase-command.md` | Investigation artifact | Keep only if prompt archive is intentional; otherwise delete. |
| `dev/build-failure-context.md` | Investigation artifact | Move into a completed incident/reference folder or delete; the roost Suspense fix appears already landed. |
| `test-results/.last-run.json` | Investigation artifact | Delete or move into the active security/e2e reference folder; do not commit as-is. |
| `test-results/security-boundary-probe-dev.jsonl` | Investigation artifact | Move to `dev/active/security-boundary-migration/reference/` if it is evidence; otherwise delete. |
| `test-results/web-e2e-specs-admin-tokens-1091c-and-the-Never-expires-badge/error-context.md` | Investigation artifact | Delete after extracting the failure into an issue/task. |
| `test-results/web-e2e-specs-admin-tokens-36b19-ke-all-when-no-tokens-exist/error-context.md` | Investigation artifact | Delete after extracting the failure into an issue/task. |
| `test-results/web-e2e-specs-admin-tokens-40b16-ears-every-doc-for-the-site/error-context.md` | Investigation artifact | Delete after extracting the failure into an issue/task. |
| `test-results/web-e2e-specs-admin-tokens-633e9-n-removes-the-Firestore-doc/error-context.md` | Investigation artifact | Delete after extracting the failure into an issue/task. |

## Incomplete commits
- `158c12e` - `test: skip 5 wave-2 follow-up tests with TODOs` - explicitly landed skipped follow-up coverage; current remaining visible skips are in `authorizedHandler.eslint.test.ts`.
- `95a2159` - `feat(cli): wave 3 c-tier stubs (chat/user/process/installer)` - stubs were later mostly closed, but this is a marker for checking CLI readiness drift.
- `6095e48` - `test(e2e): rollback-to-manifest spec - auth/validation layers (D5.2 partial)` - message says partial; confirm no rollback e2e gap remains after manifest->version rename.

## Launch-blocking TODOs
- `web/app/layout.tsx:71` - `validateEnvironmentOrThrow()` is "TEMPORARILY DISABLED for initial Railway deployment" - production can boot with placeholder/missing Firebase env.
- `web/lib/webhookUrl.ts:17` - dispatcher "MUST re-validate at send time"; `functions/src/webhookDispatch.ts:377` and `web/lib/webhookSender.server.ts:304` fetch stored URLs directly - SSRF TOCTOU gap for production webhooks.
- `web/next.config.ts:72` - nonce-based CSP TODO; current CSP still permits inline script for Google OAuth popups - not necessarily a blocker, but it is explicit XSS hardening debt.
- `web/lib/auditLog.server.ts:309` - audit TTL cleanup is a no-op placeholder - retention/cost/compliance gap before high-volume public API launch.
- `web/lib/actions/deleteSite.server.ts:7` and `web/hooks/useFirestore.ts:758` - site delete preserves subcollections and user-site references; manual orphan cleanup remains required.
- `web/app/api/mfa/verify-login/route.ts:128` - legacy unencrypted MFA secrets are still accepted with TODO migration.
- `web/app/api/roosts/[roostId]/rollback/route.ts:246` - `version.rolled_back` webhook emission missing; same comment says `version.published` has the same dispatcher gap.
- `web/e2e/COVERAGE.md:26` / `:32` / `:41` / `:46` / `:53` / `:58` / `:59` - deferred e2e sweeps for dashboard controls, roost deep actions, agent auth contracts, Cortex real request contracts, destructive account dialogs, deployment dialog options.

## Half-finished UI
- `web/app/demo/page.tsx:32` and `web/app/demo/page.tsx:279` - dashboard demo passes `noop` / `noopAsync` into edit/create/kill/reboot/shutdown/remove handlers. If `/demo` is public, these controls look live but do nothing. Hide controls, wire demo to simulated state, or mark demo-only affordances inert.
- No `onClick={() => {}}`, `action=""`, or `disabled={true}` production UI handlers found. The only bare disabled input found (`web/components/AccountSettingsDialog.tsx:501`) is read-only email and appears intentional.
- `npm.cmd run lint` is not clean: `web/__tests__/api/site-logs.test.ts:15`, `web/__tests__/api/sites-machines-display-layout.test.ts:8`, and `web/__tests__/api/sites-machines-processes.test.ts:70` fail `no-var`. That is not a UI pattern, but it is hidden CI debt.

## Skipped tests
- `web/__tests__/lib/authorizedHandler.eslint.test.ts:93` - skips flagging `export async function POST()` under `app/api/**`; TODO says selector does not fire.
- `web/__tests__/lib/authorizedHandler.eslint.test.ts:116` - skips flagging `export const POST = async () => ...`; same no-restricted-syntax selector gap.
- `web/__tests__/lib/authorizedHandler.eslint.test.ts:157` - skips flagging `setDoc` in a non-allowlisted hook; direct Firestore write scanner/lint still has a known blind spot.

## OFF feature flags in production paths
- `sites/{siteId}.roostEnabled` - gates roost API routes and agent `sync_pull`; default/missing is enabled but explicit false halts new work. Flip-on plan: verify all launch sites have true/missing before v3 and add alerting on roost-disabled 503s.
- `displays.remoteApplyEnabled` - default false in `agent/src/shared_utils.py:1842`, read by agent apply path and web display panel. Gates remote display apply and auto-restore. Flip-on plan: per-machine operator enablement plus launch checklist coverage.
- `displays.autoRestore.enabled` - default false; gates display auto-restore worker. Flip-on plan: opt-in only after remote apply self-test succeeds.
- `RATE_LIMIT_OBSERVE_ONLY` - when true, rate-limit enforcement records observations but allows traffic. `web/scripts/generate-rate-limit-calibration.mjs:281` says keep it true until Wave 8.0 shadow data is complete. Flip-on plan: generate final calibration, set false/unset in production, then watch 429s.
- `global/security_config.capability_enforcement` / `ENABLE_CAPABILITY_ENFORCEMENT` fallback - kill switch can bypass capability checks. Flip-on plan: ensure Firestore config true and expiry not stale before public launch.
- `global/security_config.rate_limit_enforcement` / `ENABLE_RATE_LIMIT_ENFORCEMENT` fallback - kill switch can bypass rate limits. Flip-on plan: ensure true after rate calibration.
- `SEND_WELCOME_EMAIL` - documented as false in `web/README.md:83` and `web/DEPLOYMENT-CHECKLIST.md:121`; `web/app/api/webhooks/user-created/route.ts:82` only sends when true. Flip-on plan: decide whether launch cohort gets welcome email or remove the dormant path from launch expectations.

## "Coming soon" promises in docs
- `.claude/CLAUDE.md:15` - says public CLI is v3-deferred, but public CLI docs and release prep now exist. Stale instruction; update to avoid agents suppressing CLI work.
- `docs/cli/overview.md:169`, `docs/cli/readiness.md:62`, `docs/cli/reference/machine.md:137` - `owlette machine live-view` is a registered stub with no public route.
- `docs/cli/overview.md:173`, `docs/cli/readiness.md:127-136`, `docs/cli/reference/webhook.md:8` - full `owlette webhook ...` noun group is planned while public webhook routes already exist.
- `docs/api/webhooks.md:5`, `:474`, `:503` - automatic production event dispatch and SSE event fanout are deferred; `owlette listen` is liveness only.
- `docs/api/webhooks.md:34` - lifecycle events are planned and not accepted by the current validator yet.
- `docs/api/status-uptime.md:5` - `status.owlette.app` custom domain deferred until paid/custom-domain provider path.
- `docs/internal/dmca-takedown-sop.md:15` and `:61` - counter-notice and subpoena-response flows deferred.
- `docs/internal/manifest-format.md:422` - `web/scripts/validate-manifest.ts` is planned, but the file does not exist.
- `docs/internal/threat-model.md:110` and `:282` - VirusTotal upload scanning deferred; `functions/src/virusTotalScan.ts` does not exist.
- `docs/internal/threat-model.md:500` and `:684` - 90-day auto-tombstone for unused `owk_*` keys is "must add"/tracked, but I found no active plan or implementation.

## Changelog drift
- shipped commits not in changelog: `ec3c75a feat(status): add public api uptime foundation` added `/api/cron/status-ping`, health check clients, tests, and docs, but current `[Unreleased]` does not call out status/uptime as a shipped runtime surface.
- shipped commits not in changelog: `10af1e0 feat(api): add public launch load-test gates` added/renamed k6 scripts and `docs/api/load-testing.md`; changelog testing counts mention old load tests but not the new launch gate.
- partially covered but should be explicit before installer build: `6c7eaf3 feat(api): prepare sdk and cli rc distribution` added license/package distribution docs and RC version bumps. Current changelog says RCs exist, but not the distribution gates/assets now being linked.

## Version drift
- `/VERSION`: `2.11.0`
- `agent/VERSION`: `2.11.0`
- `web/package.json`: `2.11.0`
- `firestore.rules`: `2.3.0` (independent; header says Control-Plane API Boundary Lockdown)
- Drift: none among product/agent/web. Side note: `.claude/CLAUDE.md` points to `docs/version-management.md`, but the real file is `docs/internal/version-management.md`.

## Missing Firestore indexes
- `web/app/api/webhooks/[webhookId]/deliveries/route.ts:101` - top-level `webhook_deliveries` query uses `subscriptionId == webhookId`, `createdAt >= windowStart`, `orderBy createdAt desc`. Needed index: collection `webhook_deliveries`, `subscriptionId ASC`, `createdAt DESC`. The file comment says Firestore will prompt for this; it is not in `firestore.indexes.json`.
- `web/app/api/users/route.ts:96` and `:106` - user list can filter `role ==` then `orderBy __name__`. Needed index if Firestore prompts: collection `users`, `role ASC`, `__name__ ASC`.
- `web/app/api/users/route.ts:99` and `:106` - user list can filter `sites array-contains` then `orderBy __name__`. Needed index: collection `users`, `sites ARRAY_CONTAINS`, `__name__ ASC`.
- `web/app/api/users/route.ts:96-106` - role plus site filter together needs a combined index: collection `users`, `role ASC`, `sites ARRAY_CONTAINS`, `__name__ ASC`.
- `web/app/api/legal/dmca/route.ts:82` - `dmca_notices` count query filters `complainant.email ==` and `submittedAt >=`. Needed index: collection `dmca_notices`, `complainant.email ASC`, `submittedAt ASC`.
- `web/app/api/legal/dmca/route.ts:87` - `dmca_notices` count query filters `sourceIp ==` and `submittedAt >=`. Needed index: collection `dmca_notices`, `sourceIp ASC`, `submittedAt ASC`.

## CI gaps
- workflows present: `.github/workflows/build-installer.yml`, `cli-publish.yml`, `deploy-docs.yml`, `e2e.yml`, `no-token-logs.yml`, `openapi-validate.yml`.
- missing workflows: no general web unit/lint/typecheck CI, no agent unit/integration CI, no functions test CI, no SDK test CI, no PR-level CLI CI outside the publish workflow.
- agent CI: `build-installer.yml` builds the Windows installer only on version tags/manual dispatch; it does not run agent tests for PRs or `dev` pushes. I found no agent 4c.5-style CI job.
- release workflow: installer and CLI publish workflows exist, but there is no single release gate that verifies version sync, changelog update, web tests, agent tests, SDK packages, and docs before building/uploading an installer.
- incomplete workflow bug: `build-installer.yml` outputs `artifact-sha256` from `steps.digest.outputs.sha256` (hex) but passes it to SLSA `base64-subjects`; the digest step also writes `sha256-b64`, which is unused. Provenance generation may be malformed.
- incomplete release hardening: `build-installer.yml:18` says Authenticode signing is separate wave 5.9; no signing job is present.
- local lint is already red: `npm.cmd run lint` fails on three `no-var` errors, so adding a lint workflow will immediately expose existing debt.

## Roadmap items with no active plan
- `roadmap.md:7` - Log TTL for site/machine logs. Active security work covers audit retention, not ordinary `sites/{id}/logs` / `machines/{id}/logs` cleanup.
- `roadmap.md:13` - SMS alerts. No active plan.
- `roadmap.md:19` - Process reports. No active plan.
- `roadmap.md:25` - Send logs to Owlette from tray/GUI. No active plan.
- `roadmap.md:26` - In-app support chat. No active plan.
- `roadmap.md:32-37` - Testing backlog: Cortex route tests, alert tests, screenshot tests, agent service main loop tests, React hook/component tests, e2e. Some coverage exists now, but roadmap is stale and no active plan owns the remaining broad backlog.
- `roadmap.md:43-44` - Stripe integration and usage dashboard. No active plan.
- Extra plan hygiene gap: `dev/active/README.md` is stale v2.2-era text, marks scheduling/Cortex as not started, and references missing files like `dev/active/ws5-process-scheduling.md` and `dev/active/local-cortex-agent-sdk/cortex-plan.md`.

## Top 5 DEV items needed for v3.0.0 that aren't in any plan
1. Land or deliberately discard the hidden source WIP: chat owner isolation, mandatory installer checksum, idempotency streaming guard, isolated E2E readiness, and landing/API launch docs are all uncommitted.
2. Add Firestore indexes for webhook deliveries, user filters, and DMCA rate-limit count queries before prod traffic discovers them via runtime missing-index errors.
3. Close release/CI gates: agent tests, web lint/typecheck/unit tests, functions/SDK tests, version/changelog preflight, and the SLSA `base64-subjects` digest bug.
4. Resolve launch gates that default off or can silently bypass enforcement: `RATE_LIMIT_OBSERVE_ONLY`, security kill switches, `remoteApplyEnabled`, `roostEnabled`, welcome email behavior, and disabled env validation.
5. Finish production webhook safety and truthfulness: re-validate webhook URLs at dispatch time, wire real event fanout/rollback events or keep docs/API/CLI explicitly in developer-preview liveness mode.
