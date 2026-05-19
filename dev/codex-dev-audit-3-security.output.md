# Security boundary migration — plan-vs-code audit

## Summary
- 40/47 checked boxes verified ✓
- 7 discrepancies
- 0 residual browser-side control-plane Firestore writes (target: 0)

Production readiness: **not yet**. The browser-write migration itself is clean, but the server boundary is not fully production-ready because the new reconcilers are not exported for deployment, several mutation routes bypass the wave-2 capability/rate/audit wrapper, and the claimed ESLint/CI guards are incomplete.

Scanner run: `node scripts/scan-firestore-writes.mjs --no-md --json=%TEMP%\owlette-audit3-firestore-writes.json` completed. Current totals: `total=8`, `preference=8`, `control_plane=0`, `no_action=0`, `unclear=0`. Remaining direct writes are only the allowlisted user preference/chat writes in `AuthContext.tsx`, `useCortex.ts`, and `useDevicePrefs.ts`.

## Wave-by-wave verification
### Wave 1
- 1.0 ✓ — `dev/active/security-boundary-migration/reference/agent-compat.md:3` records PASS/sign-off; regression coverage exists at `agent/tests/unit/test_command_compat.py:5`.
- 1.1 ✗ — scanner exists and current run is clean, but `dev/active/security-boundary-migration/reference/write-inventory.md:17` is stale and still reports 24 control-plane hits. I also found no CI workflow invoking `scan:firestore-writes`; `web/package.json:14` only defines the local script.
- 1.2 ✓ — `web/lib/capabilities.ts:1` exports `Capability`; `web/lib/capabilities.ts:80`/`:86` export role/system matrices; tests cover matrix and site-scope behavior in `web/__tests__/lib/capabilities.test.ts:81`.
- 1.3 ✓ — audit writer exports `generateCorrelationId`, `writeAuditEntry`, and `writeAuditEntryBlocking` at `web/lib/auditLog.server.ts:121`, `:134`, `:156`; bypass warning behavior is at `web/lib/auditLog.server.ts:178`.
- 1.4 ✓ — rate-limit helper exports user/system limits and combined checks at `web/lib/rateLimit.server.ts:73`, `:99`, `:523`; observe-only support exists at `web/lib/rateLimit.server.ts:273`.
- 1.5 ✓ — Next 16 proxy stamps `x-security-version` at `web/proxy.ts:39`; hook and banner exist at `web/hooks/useSecurityVersion.ts:90` and `web/components/SecurityVersionBanner.tsx:30`; layout integration is `web/app/layout.tsx:118`.
- 1.6 ✓ — `stampCommand` and `writeCommandFanOut` exist at `web/lib/commandLifecycle.ts:84` and `:118`; lifecycle limitations/manual recovery are documented in `reference/command-lifecycle.md:93` and `:159`.
- 1.7 ✓ — rules harness exports `asUser`, `asAgent`, `asUnauthenticated` at `web/__tests__/rules/harness.ts:126`, `:158`, `:175`; `npm run test:rules` is wired at `web/package.json:13`.

### Wave 2
- 2.1 ✗ — wrappers exist (`authorizedSiteHandler` at `web/lib/authorizedHandler.server.ts:406`, `authorizedPlatformHandler` at `:645`), but the claimed ESLint rules A/B are not actually active. `web/eslint.config.mjs` only has token logging and system-invoker import rules; the intended tests are skipped with TODOs at `web/__tests__/lib/authorizedHandler.eslint.test.ts:91`, `:116`, `:157`.
- 2.2 ✓ — `fanOutToMachines` exists at `web/lib/fanOut.server.ts:102`; chunk size is `FANOUT_CHUNK_SIZE = 50` at `:33`; tests exist at `web/__tests__/lib/fanOut.test.ts`.
- 2.3 ✓ — `invokeAsSystem` exists at `web/lib/systemInvoker.server.ts:281`; caller scanner passed (`check-system-invoker-callers: ok (0 violations)`); eslint import guard is in `web/eslint.config.mjs:48`.
- 2.4 ✗ — reconciler source files exist (`functions/src/reconcileDeploymentStatus.ts:48`, `functions/src/reconcileDistributionStatus.ts:28`) and tests exist at `web/__tests__/functions/reconciler.test.ts:7`, but `functions/src/index.ts:14-35` does **not** export either function, so they will not deploy. The readiness gate also runs `npm test` in `functions` (`scripts/check-lockdown-ready.mjs:435`) which does not include `web/__tests__/functions/reconciler.test.ts`.

### Wave 3
- 3.0 ✓ — route audit exists at `dev/active/security-boundary-migration/reference/route-audit.md`.
- 3.1 ✓ — command route and core exist (`web/app/api/sites/[siteId]/machines/[machineId]/commands/route.ts:337`, `web/lib/actions/executeMachineCommand.server.ts`); exact planned test path is absent, but equivalent tests exist at `web/__tests__/lib/actions/executeMachineCommand.test.ts` and `web/__tests__/api/sites-machines-commands.test.ts`.
- 3.2 ✓ — machine config routes exist and mutations use `authorizedSiteHandler`, e.g. process POST at `web/app/api/sites/[siteId]/machines/[machineId]/processes/route.ts:87`, display PUT at `web/app/api/sites/[siteId]/machines/[machineId]/display-layout/route.ts:43`.
- 3.3 ✓ — deployment mutations are wrapped, e.g. POST at `web/app/api/sites/[siteId]/deployments/route.ts:97`, cancel at `web/app/api/sites/[siteId]/deployments/[deploymentId]/cancel/route.ts:27`.
- 3.4 ✗ — project distribution files exist, but mutation handlers are raw `export async function` routes using legacy `requireSiteAuthAndScope`, not `authorizedSiteHandler(Capability.DISTRIBUTION_MANAGE)`: create at `web/app/api/sites/[siteId]/project-distributions/route.ts:105`/`:113`, delete at `[distId]/route.ts:89`/`:96`, cancel at `[distId]/cancel/route.ts:34`/`:41`.
- 3.5 ✓ — uninstall POST/DELETE use `authorizedSiteHandler` at `web/app/api/sites/[siteId]/machines/[machineId]/uninstall/route.ts:52` and `:138`.
- 3.6 ✓ — schedule/reboot preset routes exist and use wrapper, e.g. `web/app/api/sites/[siteId]/presets/schedule/route.ts:32`/`:53`, `presets/reboot/route.ts:26`/`:47`.
- 3.7 ✓ — distribution preset routes exist and are covered by action tests (`web/__tests__/lib/actions/distributionPreset.test.ts`).
- 3.8 ✓ — machine removal DELETE uses `authorizedSiteHandler(Capability.MACHINE_REMOVE)` at `web/app/api/sites/[siteId]/machines/[machineId]/route.ts:90`.
- 3.9 ✓/gap — listed user routes use `authorizedPlatformHandler` (`web/app/api/users/[uid]/promote/route.ts:39`, `assign-sites/route.ts:38`, `remove-sites/route.ts:36`, `[uid]/route.ts:121`), but the site-member surface still bypasses the wrapper; see handler section below.
- 3.10 ✗ — self-delete route exists and enforces an inline capability path (`web/app/api/users/me/route.ts:197`, `:238`), but the planned `web/lib/accountDeletionCascade.server.ts` file is absent; implementation lives as `web/lib/actions/deleteOwnAccount.server.ts:200`.
- 3.11 ✗ — system-preset routes use `authorizedPlatformHandler`, but installer mutation routes do not; upload/finalize/set-latest/delete use `requirePlatformAuthAndScope` at `web/app/api/installer/upload/route.ts:68`/`:207`, `installer/[version]/set-latest/route.ts:58`, `installer/[version]/route.ts:49`.
- 3.12 ✓ — cortex autonomous dispatch imports `invokeAsSystem` at `web/lib/cortex/dispatch.server.ts:38` and wraps dispatches at `:192` and `:271`. Caller scanner reports 0 violations.

### Wave 4
- 4.0 ✓ — baseline doc exists at `dev/active/security-boundary-migration/reference/hook-baseline.md`.
- 4.1 ✓ — `useDisplayActions.ts` has no direct write calls; calls display/command APIs at `web/hooks/useDisplayActions.ts:106`, `:293`, `:310`.
- 4.2 ✓ — `useMachineOperations.ts` calls `DELETE /api/sites/{siteId}/machines/{machineId}` at `web/hooks/useMachineOperations.ts:34`.
- 4.3 ✓ — `useDeployments.ts` uses deployment/template APIs at `web/hooks/useDeployments.ts:219`, `:238`, `:254`, `:317`, `:321`; no direct writes found.
- 4.4 ✓ — `useProjectDistributions.ts` uses `/api/sites/{siteId}/project-distributions` at `web/hooks/useProjectDistributions.ts:105`, `:124`, `:140`, `:174`; no direct writes found.
- 4.5 ✓ — `useUninstall.ts` calls uninstall API at `web/hooks/useUninstall.ts:103` and `:144`.
- 4.6 ✓ — `useUserManagement.ts` calls user APIs at `web/hooks/useUserManagement.ts:96`, `:144`, `:171`, `:197`.
- 4.7 ✓ — account deletion calls `/api/users/me` at `web/contexts/AuthContext.tsx:859`; remaining `setDoc` calls at `:742`, `:769`, `:779` are allowlisted self-preference writes.
- 4.8 ✓ — `useSchedulePresets.ts` calls schedule preset APIs at `web/hooks/useSchedulePresets.ts:134`, `:151`, `:162`.
- 4.9 ✓ — `useRebootPresets.ts` calls reboot preset APIs at `web/hooks/useRebootPresets.ts:128`, `:145`, `:156`.
- 4.10 ✓ — `useProjectDistributionPresets.ts` calls distribution preset APIs at `web/hooks/useProjectDistributionPresets.ts:172`, `:191`, `:202`.
- 4.11 ✓ — `useSystemPresets.ts` calls platform system preset APIs at `web/hooks/useSystemPresets.ts:128`, `:150`, `:166`.
- 4.12 ✓ — `useInstallerManagement.ts` calls installer APIs at `web/hooks/useInstallerManagement.ts:103`, `:122`, `:146`, `:167`.

### Wave 5
- 5.1 ✓ — no `web/app/api/admin/**/route.ts` files remain.
- 5.2 ✓ — no `authorizedLegacyBodySiteHandler`/`readJsonBodySiteId` callers found.
- 5.3 ✓ — `/api/admin` is gone from production web/app/components/hooks/lib/tests/OpenAPI surfaces. One stale reference remains in `dev/active/security-boundary-migration/reference/cortex-integration.md:171`, but no live route exists.

### Wave 6
- 6.1 ✓ — `web/__tests__/rules/denials.test.ts` has 37 active denial tests and no `test.failing`; coverage includes sites, deployments, project distributions, webhooks, logs, commands, machine config, presets, users, installer metadata.
- 6.2 ✗ — readiness report exists and passed at `e9425f7`, but the gate is not a reliable current production gate: it checks for dormant `test.failing()` denial tests (`scripts/check-lockdown-ready.mjs:370-381`) even though Wave 7 flipped them to active tests, and it does not run the actual reconciler test file.

Spot-checks from denial tests:
- `commands/pending`: `web/__tests__/rules/denials.test.ts:279`
- `commands/completed`: `web/__tests__/rules/denials.test.ts:297`
- machine control fields: `web/__tests__/rules/denials.test.ts:315` and `:325`
- machine config: `web/__tests__/rules/denials.test.ts:341`
- installer metadata: `web/__tests__/rules/denials.test.ts:527`

### Wave 7
- 7.1 ✓ — `firestore.rules` version is `2.3.0`; browser writes to sites, deployments, distributions, webhooks/settings/log deletes, config, presets, users, installer metadata, system presets are service-account-only or denied (`firestore.rules:137`, `:250`, `:284`, `:384`, `:404`, `:431`, `:441`, `:455`, `:485`, `:497`, `:511`).
- 7.2 ✓ — denial tests are active (`test.failing=0`); baseline preserves agent and preference writes.
- 7.3 ✓ — plan records dev deploy to `owlette-dev-3838a` and ruleset `bcd8ed7d-c1e9-4902-8fb0-eb9402772b96`.

### Wave 8.1
- 8.1 ✓ — e2e security-boundary specs exist: `direct-write-bypass.spec.ts`, `major-flows.spec.ts`, `account-deletion.spec.ts`, `cortex-autonomous-burst.spec.ts`, `rollback-rehearsal.spec.ts`, `railway-drill.spec.ts`. Bypass coverage is explicit at `direct-write-bypass.spec.ts:50` and checks deployments, machine toggles, commands, and config writes. Rollback rehearsal exists at `rollback-rehearsal.spec.ts:317`, but it is environment-gated by `SECURITY_BOUNDARY_RUN_ROLLBACK_REHEARSAL=1` at `rollback-rehearsal.spec.ts:36`.

## Residual control-plane writes from browser
- None found. Current AST scanner output is `control_plane=0`, `unclear=0`.

## Handlers missing authorization wrapper
- `web/app/api/sites/[siteId]/project-distributions/route.ts:105` — `POST` creates distributions via `createDistribution`, but auth is legacy `requireSiteAuthAndScope` at `:113`; missing `authorizedSiteHandler` capability/rate/blocking audit path.
- `web/app/api/sites/[siteId]/project-distributions/[distId]/route.ts:89` — `DELETE` calls `deleteDistribution`, but auth is legacy `requireSiteAuthAndScope` at `:96`.
- `web/app/api/sites/[siteId]/project-distributions/[distId]/cancel/route.ts:34` — `POST` calls `cancelDistribution`, but auth is legacy `requireSiteAuthAndScope` at `:41`.
- `web/app/api/sites/[siteId]/members/route.ts:176` — `POST` mutates `users/{uid}.sites` via `FieldValue.arrayUnion` at `:227`; missing `authorizedSiteHandler(Capability.SITE_MEMBER_MANAGE)`.
- `web/app/api/sites/[siteId]/members/[uid]/route.ts:40` — `DELETE` mutates `users/{uid}.sites` via `FieldValue.arrayRemove` at `:103`; missing `authorizedSiteHandler(Capability.SITE_MEMBER_MANAGE)`.
- `web/app/api/installer/upload/route.ts:63` and `:202` — installer upload/finalize mutate installer metadata but use `requirePlatformAuthAndScope` at `:68` and `:207`; missing `authorizedPlatformHandler(Capability.INSTALLER_MANAGE)`.
- `web/app/api/installer/[version]/set-latest/route.ts:44` — set-latest mutates `installer_metadata/latest` but uses `requirePlatformAuthAndScope` at `:58`.
- `web/app/api/installer/[version]/route.ts:40` — delete mutates installer metadata but uses `requirePlatformAuthAndScope` at `:49`.

## enforcementBypassed leaks
- No leak found in production code. Usage is confined to audit writers/wrappers/invokers plus the documented self-delete inline exception:
  - audit writer: `web/lib/auditLog.server.ts:178`, `:229`
  - authorized wrappers: `web/lib/authorizedHandler.server.ts:526`, `:588`, `:713`, `:779`
  - system invoker: `web/lib/systemInvoker.server.ts:348`, `:394`
  - self-delete auth-bypass route: `web/app/api/users/me/route.ts:236`, `:286`, `:314`
- Test/e2e assertions also grep as expected (`web/__tests__/lib/*`, `web/e2e/specs/security-boundary/rollback-rehearsal.spec.ts:301`).

## Top 3 DEV items left before prod lockdown is safe
1. Export and deploy the new reconcilers from `functions/src/index.ts`, then update the readiness gate to run `web/__tests__/functions/reconciler.test.ts` or move those tests into the functions suite.
2. Move remaining mutating server routes onto `authorizedSiteHandler`/`authorizedPlatformHandler`: project distributions, site members, and installer management.
3. Finish the enforcement gates: implement active ESLint rules A/B, unskip their tests, add scanner/check-system-invoker/readiness checks to CI, and regenerate `reference/write-inventory.md` so committed evidence matches current code.
