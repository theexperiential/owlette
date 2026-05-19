# v1 → v2 (roost) migration

**status**: canonical migration design
**owner**: project distribution v2 (roost)
**referenced by**: `dev/active/project-distribution-v2/plan.md` wave 1.11 (this doc) and wave 6.3 (production cutover)
**last updated**: 2026-04-19

---

## scope

owlette is replacing v1 project distribution (single `project_url`, no resume, no rollback, single-shot fan-out) with **roost** — a content-addressed, chunked, resumable sync platform with immutable manifests and one-click rollback. roost is always lowercase in copy, module names, and external surfaces.

both code paths must coexist for one full release cycle so that no v1 customer is broken during cutover. this document is the canonical plan for that coexistence, the cutover, and the eventual removal of v1.

it is the source of truth for:
- which collections exist when
- which agent versions are supported when
- what gets dual-written, when, and for how long
- how each phase rolls back if something goes wrong
- what the field-by-field mapping is between v1 and v2
- when the v1 code is allowed to be deleted

if a phase decision conflicts with this doc, this doc wins. update this doc, then change the code.

---

## goals

these are non-negotiable. every phase below is justified by one or more of these:

1. **zero data loss for existing v1 distributions.** every v1 distribution that exists at cutover time keeps its history, status, and configuration. nothing is destructively migrated.
2. **zero downtime during cutover.** at no point during the migration is project distribution unavailable to customers. running shows are never affected by cloud-side migration work (per the "show keeps running" sla).
3. **zero forced action by customers.** existing v1 distributions keep working until v1 is removed. customers do not need to re-upload, re-create, or re-configure anything to keep what they already have running.
4. **clean v2 schema.** v1-only fields do not pollute v2 documents in steady state. a small number of `legacy*` / `migratedFromV1` fields are tolerated during the migration soak window and removed in phase 5.

---

## phases

migration runs in **six phases**, phase 0 through phase 5. each phase has explicit entry criteria ("ready when"), explicit exit criteria, and an explicit rollback path. phases are not skippable.

### phase 0 — coexistence (now → v2 GA)

**state**: v1 is the production path. v2 code is being written and tested but is not enabled for any external customer.

**collections**:
- v1: `sites/{siteId}/project_distributions/` (active, read+write)
- v2: `sites/{siteId}/synced_folders/` (exists, internal-only writes)

**discriminator**: `schemaVersion: 2` field on every `synced_folders` document. v1 documents have no `schemaVersion` field (or `schemaVersion: 1` if backfilled defensively).

**agent behavior**:
- `CommandRouter` (introduced in wave 1.5) routes inbound commands to two distinct handler families:
  - v1 family: `distribute_project` → existing handler
  - v2 family: `sync_pull`, `cancel_sync`, `rollback_to_manifest` → new sync handlers (in `agent/src/sync_commands.py`)
- a single agent build contains both families. neither is conditionally compiled out.
- v1 handlers continue to write progress into the existing `targets[]` array on the v1 distribution doc.
- v2 handlers write progress into a `target_state/{machineId}` subcollection under the synced_folder doc.

**web behavior**:
- the project distribution dialog (`web/components/ProjectDistributionDialog.tsx`) has two tabs:
  - **upload** (v2): uppy + tus dropzone. internal-only feature flag.
  - **url** (v1): existing url-based form. labelled "legacy" once v2 GA is announced, but not removed.
- v2 tab is gated behind `feature_flags.v2_upload_enabled` (per-tenant). default off.

**no data movement**. no v1 records are touched. no v2 records are written for v1 customers.

**ready when** (entry criteria for phase 0): wave 1 (foundations) is merged to `feature/distribution-v2`.

**exit criteria** (move to phase 1): v2 has reached GA — wave 6.1 (design-partner beta with 3 friendly partners) and wave 6.2 (beta feedback triage + fixes) are complete, and the wave 6 success criteria pass.

**rollback**: not applicable. no production traffic is on v2 yet. if v2 GA is delayed, phase 0 simply continues.

### phase 1 — dual-write (v2 GA → cutover date)

**state**: v2 is GA and customers can opt in. v1 is still the default for net-new distributions until phase 3.

**duration**: minimum **4 weeks**. this is the upgrade window for agents and the soak window for telemetry. extending is fine; shortening is not.

**dual-write rule** (web side, on every NEW v2 distribution):
1. customer drops a folder via uppy → tusd → r2.
2. server resolves the v2 manifest and writes the `synced_folders/{folderId}` doc with `schemaVersion: 2`.
3. server **also** creates a corresponding v1 record in `project_distributions/` with:
   - `name`: same as the v2 name
   - `project_url`: a signed download url for the manifest's primary archive (or, if the upload was a single-file upload, the file's signed url)
   - `extract_path`: derived from the v2 manifest config where the v1 destination is unambiguous (single common root); omitted otherwise (a stale v1 agent will then refuse the dual-write record, which is the correct safe behavior)
   - `targets[]`: same machine target list, status `pending`
   - `dualWrittenFromV2: true` (flag for later cleanup)
4. the v2 doc records the v1 record id in `dualWrittenV1Id` for cross-reference.

**why**: an agent that has not yet upgraded to v3.0.0 will only know how to consume v1 records. dual-writing keeps those agents functional during the upgrade window. once telemetry confirms ≥98% of agents are on v3.0.0+, the dual-write becomes redundant — but we leave it on through phase 2 as a safety net.

**shadow-read rule** (web side, on every v2 read):
- when the dashboard loads `synced_folders/{folderId}` and the doc is missing or marked `migratedFromV1: true` with no manifest yet, fall back to the corresponding v1 record so the row still renders. clearly tag the row in dev tools as "shadow-read from v1" for telemetry.

**this is purely defensive.** in practice the vast majority of customers will use one path or the other, not both at once. dual-write protects the small population that mixes them (e.g. dashboard upload via v2 while a stale agent still polls v1).

**ready when** (entry criteria for phase 1): all of:
- v2 GA announced
- `feature_flags.v2_upload_enabled = true` rolled out to all tenants
- telemetry instrumentation from §5 below is live in production
- this doc's phase 1 customer-comm template (§6) has been sent

**exit criteria** (move to phase 2): minimum 4 weeks elapsed AND no critical bugs in dual-write path for the last 7 days.

**rollback**: stop dual-writing. this is a code change only — flip a server-side boolean (`feature_flags.dual_write_v1 = false`). no data needs to be touched. v1 records that were already dual-written remain valid.

### phase 2 — agent upgrade window (4 weeks)

**state**: v2 is GA, dual-write is on, customers are being asked to upgrade their agents.

**duration**: minimum **4 weeks** from the v3.0.0 agent installer release. runs in parallel with phase 1 (the four weeks overlap, not stack — the cutover gate is "phase 1 ≥ 4 weeks AND phase 2 ≥ 4 weeks AND ≥98% agents upgraded").

**rollout plan**:
- v3.0.0 agent installer is published (it contains both v1 and v2 handler families — see phase 0).
- existing agents auto-upgrade per their normal upgrade cadence (the existing self-update path).
- telemetry tracks `% of registered agents on v3.0.0+` per tenant.
- if a tenant's agent fleet is < 98% upgraded after 3 weeks, a customer comm goes out (template in §6) asking them to manually trigger upgrade on stragglers.

**hard gate**: cutover (phase 3) is **blocked** until ≥98% of registered, currently-online agents are on v3.0.0+ globally. per-tenant 100% is not required (some agents may be permanently offline / decommissioned), but a tenant with < 95% upgrade gets a customer-specific outreach before being cut over.

**ready when** (entry criteria for phase 2): v3.0.0 agent installer published + verified via the standard installer release flow (changelog updated, version bumped, sha256 published, finalize call ok).

**exit criteria** (move to phase 3): both:
- ≥98% of agents on v3.0.0+ globally (telemetry-verified)
- ≥4 calendar weeks elapsed since v3.0.0 release

**rollback**: roll back the agent installer to the previous version via the installer release api (`setAsLatest` on the prior version). agents that auto-upgraded stay at v3.0.0 (downgrade is not a normal supported flow), but new installs go back to v2.x. this is a partial rollback — sufficient because v3.0.0 is backwards-compatible with v1 by design.

### phase 3 — hard cutover (specific date, announced ≥2 weeks in advance)

**state**: v2 becomes the only path for NEW distributions. existing v1 distributions keep working unchanged.

**the flip**: set `feature_flags.use_v2_only = true` in firestore. this is a single document update, instant, global. it changes web behavior:
- the v1 ("url") tab in the project distribution dialog is grayed out with the copy: "this method is deprecated. new distributions use roost. your existing distributions are unaffected."
- POSTs to v1 distribution endpoints from the dashboard return 410 gone with rfc 7807 problem+json body explaining the deprecation.
- agents continue to honor `distribute_project` commands for any v1 distribution doc that already exists.
- net-new distributions only land in `synced_folders/`.

**active-distribution rule**: any v1 distribution that is **already in flight** (has at least one `targets[]` entry in `downloading` or `extracting`) at the moment of the flip completes on the v1 path. it is not interrupted, not re-routed, not reissued as v2. only NET-NEW distributions go v2-only.

**soak monitoring (7 days)**: telemetry watches for any v1 traffic post-flip:
- new v1 distribution doc created → alert (should be zero)
- v1 `distribute_project` command issued for a distribution doc created post-flip → alert
- agent error rate on `sync_pull` > baseline → alert
- if any of these fire, **roll back the flag immediately** (don't fight it). investigate. fix. re-attempt cutover after a fix is shipped + verified.

**ready when** (entry criteria for phase 3): all of:
- phase 1 exit criteria met
- phase 2 exit criteria met
- ≥2 weeks since the phase 3 advance-notice customer comm went out (template in §6)
- on-call rotation knows about the cutover and the rollback procedure
- the rollback procedure has been dry-run in staging within the last 7 days

**exit criteria** (move to phase 4): 7 consecutive days of soak with no v1-traffic alerts and no elevated v2 error rate.

**rollback**: flip `feature_flags.use_v2_only = false`. instant. v1 dialog tab re-enables, v1 endpoints stop returning 410. dual-write (phase 1) is still on, so net-new v2 distributions created during the failed cutover window are still v1-compatible. **no data repair needed.**

### phase 4 — migrate existing v1 records to v2 (one-shot cloud function)

**state**: cutover is stable. now we backfill v2 records for the v1 distributions that still exist, so the dashboard can show a unified "all your distributions" view and so phase 5 can delete v1 code without leaving dashboard rows in limbo.

**migration job**: a one-shot cloud function (`functions/src/migrateV1ToV2.ts`, written for this phase) that:
1. iterates `sites/{siteId}/project_distributions/` for every site
2. for each v1 doc, if it does not already have a corresponding v2 record (i.e. `dualWrittenV1Id` does not point back to it), creates a `synced_folders/{folderId}` doc with:
   - `schemaVersion: 2`
   - `name`: copied from v1
   - `legacyUrl`: copied from v1's `project_url` (read-only, displayed in dashboard with a "legacy url" badge; phase 5 may delete this field)
   - `targets[]`: subcollection seeded from v1's `targets[]` (one `target_state/{machineId}` doc per entry, with `reportedManifestId: null`)
   - `currentManifestId: null` (no manifest exists — these are url-based, not chunk-based)
   - `migratedFromV1: true` (idempotency + rollback flag)
   - `migratedAt`: server timestamp
   - `migratedFromV1DocId`: the original v1 doc id (for cross-reference)
3. updates the v1 doc with `migratedToV2: true`, `migratedToV2DocId: <new v2 folder id>`, and `migratedAt: <server timestamp>`. **does not delete** the v1 doc.

**no chunk re-upload**. these migrated records remain url-based — they point at the same external/signed url they always did. customers who want chunked, resumable, content-addressed semantics for an existing distribution must re-upload it through the roost dialog (creating a new v2 record from scratch). this is by design: migration is not a covert content-rewrite.

**dropped fields**: `verify_files` is dropped entirely (manifest is authoritative when there is one; for legacy url records there is no manifest). `file_name` is dropped (redundant — the url contains it or the manifest contains it).

**idempotency**: the job is safe to re-run. it skips any v1 doc where `migratedToV2: true`. if a re-run is needed (e.g. mid-flight failure), just re-invoke.

**ready when** (entry criteria for phase 4): phase 3 exit criteria met. cloud function deployed to staging, dry-run on staging fixture data passing.

**exit criteria** (move to phase 5): all of:
- migration job completed for 100% of v1 docs (counter: `v1Total == v1Migrated`)
- no errors in the migration job's audit log
- spot-check: pick 20 random migrated docs across 5 tenants, verify v2 dashboard renders them correctly with the "legacy url" badge

**rollback**: the migration is **additive and idempotent**. v1 docs are unchanged except for the `migratedToV2: true`, `migratedToV2DocId`, and `migratedAt` fields. to roll back:
1. delete every `synced_folders/{folderId}` doc with `migratedFromV1: true` (single-collection-group query)
2. clear the `migratedToV2: true` flag on v1 docs (optional — leaving it in place is harmless)
3. no chunk data was uploaded, so no r2 cleanup is required

**because the migration only touches docs and never moves bytes, rollback is cheap.**

### phase 5 — v1 code removal (≥4 weeks after phase 3 exit)

**state**: v2 is the only path, all v1 docs are migrated, dashboard surfaces both "active" (v2 native) and "legacy" (v2 migrated, url-based) distributions through the same component.

**duration**: this phase is a single PR merged after the soak window.

**code removals**:
- `web/components/ProjectDistributionDialog.tsx`: delete the v1 ("url") tab and all its supporting code
- `web/hooks/useProjectDistributions.ts`: delete the v1 read path; rename to `useSyncedFolders` if not already done
- `web/app/api/v1/distributions/*`: delete the route handlers (or return a permanent 410)
- `agent/src/owlette_service.py` / command router: delete the `distribute_project` handler registration
- `agent/src/` whichever module owned v1 distribution: delete the file
- `agent/src/sync_commands.py`: stays (this is v2)

**field cleanup** on `synced_folders` docs:
- if no display surface uses `legacyUrl`, drop the field via a one-shot cloud function.
- drop `dualWrittenFromV2`, `dualWrittenV1Id` fields (no longer meaningful — there is no v1).
- keep `migratedFromV1` and `migratedFromV1DocId` for audit purposes.

**v1 collection archive**:
- move `sites/{siteId}/project_distributions/` to `_archive/v1_project_distributions/{siteId}/{distributionId}` via a final one-shot cloud function. these are kept for 1 year for audit / compliance, then permanently deleted.

**final v1 PR**: a single PR titled "remove v1 distribution code" that captures all the above. squash-merge to `dev` then to `main` per the standard two-branch model.

**ready when** (entry criteria for phase 5): all of:
- ≥4 weeks since phase 3 exit (soak window)
- phase 4 complete
- last v1 customer comm sent (template in §6)
- no support tickets in the last 14 days that depend on v1 code paths

**exit criteria**: PR merged, deployed to `main`, build green for 7 days post-deploy.

**rollback**: this is the most expensive rollback in the migration. requires `git revert` of the v1-removal PR. v1 collection in `_archive/` can be restored via a one-shot cloud function (write paths exist in git history). plan for this only if a critical regression is discovered post-removal that cannot be fixed forward. the existence of the archive collection is the safety net.

---

## field mapping

source of truth for translating v1 → v2 schemas during phase 4 migration and during dual-write in phase 1.

### v1 → v2 field translation

| v1 field | v2 field | notes |
|---|---|---|
| `name` | `name` | unchanged |
| `file_name` | (dropped) | redundant — url contains the file name or manifest path metadata does |
| `project_url` | `legacyUrl` (read-only, phase 4-5 only) | dropped after phase 5 if no display surface uses it |
| `extract_path` | (dropped) | v1 stored a single destination root per distribution; v2 carries this metadata inside the manifest config (per-file paths are manifest-relative and the destination root is enforced at the agent via the `destination_allowlist` module — see [threat-model.md B6](./threat-model.md#the-15-non-negotiable-security-baselines)). no separately-stored v2 field. |
| `verify_files` | (dropped entirely) | manifest is authoritative; every chunk is sha-256 verified; atomic project swap; monthly scrub. v1 spot-check is dead weight in v2. |
| `targets[]` (array) | `target_state/{machineId}` (subcollection) | shape extends: v1 had `{machineId, status, progress, error, completedAt}`; v2 has same shape + `reportedManifestId` (so the dashboard can show which manifest version each agent has reported back) |
| `status` (string) | (computed, not stored) | derived from `target_state` aggregation in the read layer |
| `createdAt` | `createdAt` | unchanged |
| `completedAt` | `completedAt` | unchanged |
| n/a (new in v2) | `currentManifestId` | pointer to the active manifest in r2; null for migrated-from-v1 url-based records |
| n/a (new in v2) | `previousManifestId` | for one-click rollback; null for migrated-from-v1 records |
| n/a (new in v2) | `manifestUrl` | r2 url of the current manifest json; null for migrated-from-v1 records |
| n/a (new in v2) | `schemaVersion: 2` | discriminator |

### migration metadata (v2-side, on docs created by phase 4)

| v2 field | type | notes |
|---|---|---|
| `migratedFromV1` | bool | always `true` on phase 4 migrated docs; absent on native v2 docs |
| `migratedFromV1DocId` | string | original v1 doc id (cross-reference) |
| `migratedAt` | timestamp | server timestamp at migration time |

### migration metadata (v1-side, written by phase 4 onto the source v1 doc)

| v1 field added | type | notes |
|---|---|---|
| `migratedToV2` | bool | always `true` once the phase 4 job has emitted a v2 doc for this v1 record; used as the idempotency key on re-runs |
| `migratedToV2DocId` | string | id of the synthesized v2 `synced_folders/{folderId}` doc (cross-reference) |
| `migratedAt` | timestamp | server timestamp at migration time (mirrors the v2-side field for symmetry) |

### dual-write metadata (phase 1)

| field | written on | notes |
|---|---|---|
| `dualWrittenFromV2: true` | v1 doc | only on v1 docs created by the phase 1 dual-write path |
| `dualWrittenV1Id` | v2 doc | only on v2 docs whose dual-write created a v1 doc |

**v1 fields that will fail loudly if seen on v2 docs in steady state** (caught by lint / schema validator added in wave 1.8):
- `file_name`
- `project_url`
- `verify_files`
- `extract_path` (v1 concept; not stored separately in v2)

---

## rollback plan (per phase)

summarised from the per-phase sections above for quick reference during incident response.

| phase | rollback action | cost | data impact |
|---|---|---|---|
| 0 (coexistence) | n/a — no production v2 traffic yet | n/a | none |
| 1 (dual-write) | flip `feature_flags.dual_write_v1 = false` | code change only | v1 records already dual-written remain valid |
| 2 (agent upgrade) | re-set `setAsLatest` on prior installer version | one api call | new installs go back to v2.x; auto-upgraded agents stay on v3.0.0 (backwards-compatible) |
| 3 (hard cutover) | flip `feature_flags.use_v2_only = false` | one firestore write | none — dual-write still on, v2 records remain valid |
| 4 (migration) | delete `synced_folders` docs with `migratedFromV1: true`; clear `migratedToV2` flag on v1 docs | one cloud function run | additive only — no chunk data was uploaded, no bytes to clean |
| 5 (v1 removal) | `git revert` the removal PR; restore v1 collection from `_archive/` via cloud function | high — code revert + archive restore + redeploy | depends on how long the archive has been deleted (1 year retention) |

**rollback tier**: phases 0-4 are **fast** (minutes to hours, no code revert). phase 5 is **slow** (a full release cycle to revert and redeploy). plan accordingly — do not enter phase 5 without high confidence in v2.

---

## telemetry to add before phase 1

these metrics must be live in production **before** dual-write is enabled, because they are the gating signals for every subsequent phase. add them to the telemetry pipeline in wave 5 and verify they are emitting before the phase 1 entry criteria are checked.

1. **`agent.version.distribution`** — histogram, per tenant, of agent versions seen heartbeating in the last 24h. used to compute "% of agents on v3.0.0+" → gates phase 3.
2. **`distribution.v1.created.weekly`** — counter of v1 distribution docs created per week, per tenant. expected to drop to zero after phase 3 cutover. any non-zero value post-phase-3 is an alert.
3. **`distribution.v2.manifests.published.weekly`** — counter of v2 manifests published per week, per tenant. expected to rise after phase 3.
4. **`distribution.v1.traffic.post_cutover`** — composite alert that fires if any of the following happen after phase 3 entry:
   - new v1 distribution doc created
   - v1 `distribute_project` command issued for a doc created post-flip
   - agent reports a v1 distribution status update for a post-flip distribution
   labelled `SOAK MONITORING` so on-call sees it immediately.
5. **`migration.v1_to_v2.progress`** — gauge of `(migratedV1DocsCount / totalV1DocsCount) * 100`. used to gate phase 5.
6. **`sync.error.rate`** — error rate for v2 sync operations (pull, manifest publish, rollback). a sustained spike post-cutover is a rollback signal.
7. **`dual_write.v1.created`** — counter of v1 docs created by the phase 1 dual-write path. used to confirm dual-write is functioning, and to confirm it has stopped after the phase 1 → phase 2 transition.

each of these is dimensioned by tenant id at minimum, and exported via opentelemetry to the standard metrics pipeline. dashboards live at `/admin/migration` (internal-only).

---

## customer communication

template snippets for each phase. owned by the product / customer-success function. must be sent on the timelines noted in the phase definitions.

### phase 1 announcement (sent at v2 GA)

> subject: meet roost — your existing distributions keep working
>
> we've launched **roost**, the new way to distribute projects in owlette. roost gives you native folder uploads, resumable transfers for huge projects, and one-click rollback to any prior version.
>
> you don't have to do anything. your existing distributions keep working exactly as they do today. when you're ready to try roost, look for the new "upload" tab in the distribute dialog.
>
> we'll be running both the old and new methods side-by-side for at least four weeks before any change.

### phase 2 stragglers nudge (sent at week 3 of phase 2 if a tenant is < 95% upgraded)

> subject: keep your owlette agents up to date
>
> a few of your owlette agents are running an older version. they'll keep working today, but to use the new roost distribution method (and the upcoming improvements that come with it), please make sure all your agents are on version 3.0.0 or later.
>
> agents auto-upgrade when they reconnect. if any have been offline, please bring them online to receive the update — or run the latest installer manually.

### phase 3 advance notice (sent ≥2 weeks before the cutover date)

> subject: distribution method change on [DATE]
>
> on **[DATE]**, the legacy url-based distribution method will be deprecated for net-new distributions. all new distributions you create after that date will use roost.
>
> **your existing distributions are unaffected** — they will continue to work and will be visible in your dashboard. you don't need to re-create or re-upload anything.
>
> if you have any automated scripts that POST to the legacy `/api/v1/distributions` endpoint, please switch them to `/api/v2/folders` before [DATE]. see [api migration guide].

### phase 5 final notice (sent when the v1 removal PR is merged)

> subject: roost is now the only distribution method
>
> the legacy distribution method has been retired. all your distributions — including the ones that pre-date roost — are now visible and managed through the unified dashboard. existing distributions continue to work as they always have.
>
> if you used the legacy `/api/v1/distributions` endpoint, it now returns a permanent 410 gone. please switch to `/api/v2/folders`. see [api migration guide].

---

## risks and mitigations

these are the failure modes considered during design. each has a specific mitigation; the mitigation is encoded in a phase entry criterion or a rollback path above.

| risk | mitigation |
|---|---|
| we cut over (phase 3) before agent upgrades complete, breaking customers stuck on v2.x | phase 3 entry criterion: ≥98% of agents on v3.0.0+, telemetry-verified. cutover is **blocked** until this is met. |
| migrated records (phase 4) point at urls that have since become stale (signed-url expiry, source removed) | `legacyUrl` is preserved during the phase 4 → phase 5 grace period (≥4 weeks). dashboard surfaces the legacy badge so the customer can decide to re-upload. customers can re-upload any legacy record at any time to convert it to a native v2 manifest. |
| rollback after phase 4 leaves orphaned `synced_folders` docs cluttering the v2 collection | every phase 4 record is tagged `migratedFromV1: true` — rollback deletes by flag. idempotent. |
| customer is mid-distribution at the moment of the phase 3 flip | active distributions on the v1 path **complete on the v1 path**. only NET-NEW distributions go v2-only. encoded in phase 3 "active-distribution rule" above. |
| dual-write (phase 1) creates inconsistent state if v1 write succeeds but v2 write fails (or vice versa) | dual-write happens inside a single firestore transaction where possible; where not (because r2 manifest must be written first), the v1 write is the **second** write — if it fails, the v2 write is rolled back via a compensating delete. the dual-write path has explicit unit + integration tests in wave 1.6 test infra. |
| a customer is on a fork / custom build of the agent that does not handle the v3.0.0 command router refactor | command router is fully backwards-compatible — it still accepts `distribute_project`. the only break is for an agent that explicitly rejects unknown commands; standard owlette agents log-and-skip. forked customers are identified via telemetry (uncommon agent version strings) and contacted before phase 3. |
| chunk gc (running nightly during phase 4) sweeps a chunk that a partially-migrated record still references | phase 4 migration is **url-only** — it does not reference any r2 chunks. chunk gc has no interaction with the migration. (gc dry-run for the first 30 days of production further reduces risk.) |
| feature flag flip in phase 3 has a propagation delay that creates a window where some tenants are pre-cutover and others are post-cutover | flag is a single firestore document with a real-time listener on every web instance. propagation is sub-second. the 7-day soak monitoring would catch any per-tenant inconsistency. |
| the v1 → v2 migration job is interrupted partway (cloud function timeout, deploy mid-run, etc.) | job is idempotent (skips `migratedToV2: true`) and resumable (no in-memory state, just iterates the v1 collection). re-running picks up where it left off. |
| customer support team is not prepared for the cutover and gets flooded with "where did my distributions go" tickets | phase 3 entry criterion includes "on-call rotation knows about the cutover". customer success team is briefed at phase 1 GA and again 2 weeks before phase 3. dashboard explicitly labels migrated records with a "legacy url" badge so customers can identify them. |

---

## validation gates between phases (summary)

each phase explicitly defines its entry and exit criteria above. consolidated here for reference:

| transition | gate |
|---|---|
| phase 0 → phase 1 | wave 6.1 design-partner beta + wave 6.2 beta feedback triage complete; v2 success criteria pass |
| phase 1 → phase 2 | ≥4 weeks elapsed in phase 1; no critical dual-write bugs in last 7 days |
| phase 2 → phase 3 | ≥4 weeks since v3.0.0 release; ≥98% of agents on v3.0.0+; phase 3 customer comm sent ≥2 weeks ago; rollback dry-run within last 7 days |
| phase 3 → phase 4 | 7 consecutive days of soak with no v1-traffic alerts and no elevated v2 error rate |
| phase 4 → phase 5 | 100% of v1 docs migrated; spot-check 20 random docs across 5 tenants pass; ≥4 weeks since phase 3 exit |
| phase 5 → done | v1-removal PR merged; build green for 7 days post-deploy; no support tickets in last 14 days that depend on v1 |

each gate is the conjunction of all listed conditions. if any one is missing, the phase does not advance.

---

## related documents

- `dev/active/project-distribution-v2/plan.md` — overall roost plan; this doc is wave 1.11
- `dev/active/project-distribution-v2/context.md` — file-by-file context for the project
- `docs/internal/manifest-format.md` — wave 1.9, manifest schema (oci v1.1 derivation)
- `docs/internal/threat-model.md` — wave 1.10, security analysis
- `docs/changelog.md` — every phase boundary that ships customer-visible changes must add an entry
- `docs/version-management.md` — for the v3.0.0 agent installer release that gates phase 3
