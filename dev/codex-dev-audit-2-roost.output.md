# Roost plan-vs-code audit

## Summary
- 60 checked boxes reviewed.
- 44 checked boxes verified OK or verified as equivalent renamed implementations.
- 16 checked boxes with discrepancies, stale file/path claims, or unproven "done when" criteria.
- 5 partial items broken down.
- 9 wave-6 launch blockers.
- Tests were not executed; this was a static plan-vs-code audit using file, grep, and route-handler inspection.

## Discrepancies (claimed-done but not actually done)
- [task 1.8] - firestore schema v2 + rules - `firestore.rules` protects obsolete `currentManifestId`, `previousManifestId`, and `manifestUrl`, while live code writes `currentVersionId`, `previousVersionId`, and `versionUrl` in `web/app/api/roosts/[roostId]/versions/route.ts` and rollback. A client-side update can bypass the intended server-mediated pointer/CAS controls. Severity: block-v3.
- [tasks 2a.3/2a.4/2a.6/2a.7] - plan claims `/api/folders/{folderId}/manifests` and `/rollback` - actual route files are under `/api/roosts/{roostId}/versions` and `/rollback`; `/api/folders/*` only redirects in `web/proxy.ts`. Functional v2 code exists, but the checked task bodies and OpenAPI comments are stale. Severity: cosmetic.
- [task 2b.2] - cloud function chunk hash verification - `functions/src/chunkVerify.ts` has real pure verification logic, but production `getDefaultStore()` still throws `R2 object store not wired - blocked on wave 0.5`. The deployed function cannot verify/delete real R2 objects without the adapter. Severity: block-v3.
- [task 2b.3] - cloud function distribution fan-out - `functions/src/distributionFanout.ts` queues `folder_id`, but `agent/src/sync_commands.py` requires `roost_id`. Fanout-triggered canary/fleet commands will fail before disk work. The newer web deploy/resync routes queue `roost_id`, but the checked cloud function path is wrong. Severity: block-v3.
- [task 2b.4] - chunk GC - production R2 store still throws. Also, `functions/src/chunkGc.ts` scans version docs for `chunks`, but the publish route stores chunk references under `sites/{siteId}/chunk_referrers/{digest}/entries/...`; version docs do not contain `chunks`. If the R2 store were wired today, GC could treat live chunks as unreferenced. Severity: block-v3.
- [task 2b.5] - quota enforcement - pure quota logic exists, but `functions/src/quotaEnforce.ts` production storage metrics throw `R2 storage metrics not wired`, and the pre-upload hook is not wired into the current roost upload route/tusd path. Severity: block-v3 for paid/beta quotas.
- [task 2b.7] - append-only audit log sink - the Firestore chain logic exists, but the BigQuery/cold-storage exporter throws `BigQuery audit sink not wired`, and roost routes mostly emit via `web/lib/auditLogClient` rather than this cloud-function chain. Severity: nice/compliance.
- [task 3.4] - pre-upload confirmation screen - `web/components/PreUploadSummary.tsx` and `web/lib/preUploadCheck.ts` exist, but `PreUploadSummary` is not rendered by `ProjectDistributionDialog` or roost upload UI. Disk/quota blockers therefore do not actually stop a user before upload. Severity: block-v3.
- [task 3.7] - rollback confirmation + diff modal - `web/components/RollbackConfirmDialog.tsx` and diff code exist, but no caller imports the dialog. `web/components/roost/VersionRow.tsx` uses the generic `ConfirmDialog` and a separate diff menu action instead. Severity: nice.
- [tasks 4a.2/4c.1] - plan names `agent/src/sync_manifest.py` and `agent/tests/test_sync_manifest.py` - actual implementation is `agent/src/sync_version.py` with `agent/tests/unit/test_sync_version.py`. Equivalent behavior exists, but the checked file paths are missing. Severity: cosmetic.
- [task 4a.4] - reboot resume - `agent/src/sync_state.py` persists WAL state and has `list_pending_distributions()`, but no production startup caller resumes pending distributions after reboot. Resume only happens if the same `sync_pull` command is delivered again. Severity: block-v3.
- [task 4a.5] - atomic file reassembler - `sync_assembler.py` uses partial files, fsync, and `os.replace`, but I did not find the claimed 1000-iteration power-cut stress test. Partial assembled files are left in place, but retry opens the `.partial` file with `wb`, so partial file bytes are not actually resumed. Severity: nice.
- [task 4b.4] - long-path support - agent code has `_long_path()`, but the checked task body explicitly says installer `LongPathsEnabled=1` registry and `longPathAware=true` manifest are not done. The production "350-char path extracts correctly" claim is therefore not fully proven. Severity: block-v3 if long paths are in design-partner data.
- [task 4b.7] - periodic on-disk scrub - agent-side scrub and hourly dispatch exist, but the done-when says corrupted chunks surface in the dashboard within 24h. I found local report writing and best-effort Firestore comments, but no dashboard surfacing path for scrub drift reports. Severity: nice.
- [task 5.1] - roost webhooks subsystem - dispatcher and subscription UI exist, but roost producers are not wired. `web/app/api/roosts/[roostId]/rollback/route.ts` still has `TODO(roost-webhooks): emit a version.rolled_back webhook`, and grep found no `fireWebhooks`/`emitWebhook` call from roost publish routes. Severity: block-v3 if webhooks are part of launch promise, otherwise nice.
- [task 5.4] - v2 kill switch - agent `sync_pull` checks `roostEnabled`, and `web/lib/roostKillSwitch.ts` exists, but `gateOrProceed()` is not used by `web/app/api` routes. Upload/finalize/rollback can still proceed from the web API while roost is disabled. Severity: block-v3.

## Partial items breakdown
- [5.11] - changelog block exists under `docs/changelog.md` Unreleased, but version bump/release cut is not done. Missing: run the version sync to `3.0.0`, move the changelog entry under a dated `3.0.0` section, and publish/tag the release. Effort: S once blockers are cleared.
- [0.2] - DMCA page/API/SOP code exists, but external copyright.gov agent registration cannot be verified from repo, and counter-notice/subpoena/admin-queue followups are not implemented. Effort: S for registration, M for operational followups.
- [1.6] - emulator/MinIO/agent-runner/k6 scaffolding exists, but Pact scaffold and CI agent-runner/docker-compose execution are still missing; this also blocks 4c.5. Effort: M.
- [0.5] - R2 bucket provisioning script/config exists, but S3-compatible R2 access keys, Railway env propagation, and the 1 MB agent smoke are still pending. Until env is present, real R2 route calls fail outside E2E fallback. Effort: S/M depending access.
- [3.6] - in-row progress/status/cancel/history UI is more complete in current code, but pause/resume is still missing because there is no pause/resume command protocol. The old manifest-version dropdown is effectively replaced by version history, but the deferred pause/resume acceptance remains open. Effort: M.

## Wave 4 agent sync stack status
- sync_pull: partial. Real handler is registered and orchestrates version fetch, chunk download, assembly, cancellation, and target-state reporting. Production fanout currently sends `folder_id` instead of required `roost_id`, and startup resume is not wired.
- sync_assembler: partial. Atomic `os.replace`, fsync, allowlist enforcement, post-rename realpath check, ACL hardening, and content-store cleanup exist. Partial assembled file bytes are not resumed, and the claimed 1000 power-cut stress is not present.
- sync_downloader: OK. Range resume, sha-256 verification, signed URL refresh, cancellation, and unit tests are present in `agent/src/sync_downloader.py` and `agent/tests/unit/test_sync_downloader.py`.
- sync_state: partial. SQLite WAL schema/state/progress/list-pending methods exist, but no production startup path calls pending-distribution resume after reboot.
- sync_version: partial/OK. Fetch, cache, diff, schema validation, content-addressed chunk references, and path validation exist in `agent/src/sync_version.py`; tests are in `agent/tests/unit/test_sync_version.py`. No manifest signature verification is implemented. `docs/internal/manifest-format.md` explicitly says v1 is not signed and defers TUF/KMS signing to v3, so this is a documented decision rather than a stub.

## Wave 2a R2 wiring verification
- `POST /api/chunks/check`: `web/app/api/chunks/check/route.ts` -> `missingChunks()` -> `hasChunk()` -> `HeadObjectCommand` in `web/lib/r2Client.server.ts`. Status: real R2 call, with `OWLETTE_E2E=1` fallback only for tests.
- `POST /api/chunks/upload-urls`: `web/app/api/chunks/upload-urls/route.ts` -> `presignPutChunk()` -> `PutObjectCommand`. Status: real R2 signed PUT.
- `GET/POST /api/chunks/download-urls`: `web/app/api/chunks/download-urls/route.ts` -> `presignGetChunk()` -> `GetObjectCommand`. Status: real R2 signed GET.
- `GET /api/roosts/{roostId}/versions`: `web/app/api/roosts/[roostId]/versions/route.ts`. Status: real Firestore history list; no R2 call expected.
- `POST /api/roosts/{roostId}/versions`: `web/app/api/roosts/[roostId]/versions/route.ts` -> `hasChunk()` plus `putVersionBody()` -> `HeadObjectCommand` and `PutObjectCommand`. Status: real R2 finalize.
- `POST /api/roosts/{roostId}/rollback`: `web/app/api/roosts/[roostId]/rollback/route.ts`. Status: real Firestore pointer flip; no R2 call expected.
- `POST /api/roosts/{roostId}/version-url`: `web/app/api/roosts/[roostId]/version-url/route.ts` -> `presignGetVersion()` -> `GetObjectCommand`. Status: real R2 signed version-body GET for agents.
- `GET /api/roosts/{roostId}/versions/{versionRef}`: `web/app/api/roosts/[roostId]/versions/[versionRef]/route.ts` -> `getVersionBody()`. Status: real R2 body read.
- Old `/api/folders/*` route files are not present; `web/proxy.ts` redirects them to `/api/roosts/*`.

## Wave 6 launch blockers
- 6.1 ship to 3 partners - blocked on: fanout `folder_id` vs agent `roost_id`; R2 S3 credentials/Railway env still pending; Firestore rules protect old fields; web routes ignore the kill switch; no CI e2e agent-runner path; pre-upload disk/quota confirmation not wired.
- 6.1 ship to 3 partners - also blocked on: startup resume not wired, so power loss/reboot during a sync does not resume unless the command is resent.
- 6.2 canary expansion - blocked on: cloud fanout command payload bug and missing e2e coverage of publish -> canary -> target_state -> fleet promotion.
- 6.3 production cutover - blocked on: chunk verify/GC/quota production R2 adapters still throwing, GC using stale reference model, 2b.1 tusd resumable upload path not done if multi-hour pause/resume upload is required, and web kill switch not enforced.
- 6.3 production cutover - blocked on: security/rules mismatch around `currentVersionId` and `versionUrl`, because client-side mutation could bypass intended pointer authority.
- 6.4 v1 code removal - blocked on: 3.0.0 version bump/release not cut, installer long-path/manifest pieces incomplete, and 4c.5 e2e agent CI not present.
- 6.4 v1 code removal - blocked on: migration/deprecation tasks intentionally out of scope, so cutover requires a hard operational plan for re-roosting rather than code migration.
- 6.5 launch monitoring - blocked on: webhook producer wiring, audit cold-storage export, and dashboard scrub-drift surfacing if those are part of launch observability.
- 6.6 legal/compliance launch checks - blocked on: DMCA external registration verification and deferred compliance/cost items from wave 0.

## Top 3 actual DEV items left for roost before v3.0.0
1. Fix the production sync control path: change cloud fanout to queue `roost_id`, add emulator/agent-runner e2e coverage, and wire startup resume for pending distributions.
2. Align the web/security surface: update Firestore rules to protect `currentVersionId`/`previousVersionId`/`versionUrl`, wire `gateOrProceed()` into all roost web API routes, and wire `PreUploadSummary` into the upload flow.
3. Finish production R2 operations: provision env/keys, replace throwing R2 adapters in chunk verify/GC/quota, fix GC to use the live chunk-referrer model, then run the design-partner smoke of upload -> canary sync -> rollback.
