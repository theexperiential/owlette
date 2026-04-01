# Server-Side Deployment Status Updates - Implementation Plan

**Created**: 2026-03-23
**Status**: In Progress
**Estimated Time**: ~1.5 hours + E2E test wait time

---

## 1. Executive Summary

Add two Firebase Cloud Functions to handle deployment status server-side: a **Firestore trigger** that updates deployment target status whenever the agent writes command results, and a **scheduled sweeper** that fails stuck deployments after a timeout. This eliminates the current dependency on the frontend React hook for status mutations, making deployments observable by any API consumer (tests, scripts, webhooks) without needing the dashboard open.

## 2. Context & Background

### What currently exists
- **Cloud Functions infrastructure** is already set up: `functions/` directory with TypeScript, `firebase-admin`, `firebase-functions` v5, Node 20. One existing function (`onMetricsWrite`) uses the v2 `onDocumentWritten` trigger pattern.
- **Agent** writes command progress/completion to `sites/{siteId}/machines/{machineId}/commands/completed` with a `deployment_id` field linking back to the deployment doc.
- **Frontend hook** (`useDeployments.ts`) listens to the completed commands document, maps command statuses to deployment target statuses, and recalculates the overall deployment status. This is ~250 lines of mutation logic that only runs when the dashboard is open.
- **Deployment doc** lives at `sites/{siteId}/deployments/{deploymentId}` with a `targets[]` array containing per-machine status.

### What needs to change
- **New**: Firestore trigger function on completed commands that updates deployment docs
- **New**: Scheduled function that sweeps stale deployments
- **Modified**: `useDeployments.ts` -- remove mutation logic, keep as read-only real-time listener
- **Modified**: Integration tests -- E2E tests can now poll deployment status and expect it to update

### Why
1. Deployment status only updates when the dashboard is open (client-side only)
2. Agent crash/timeout leaves deployments stuck forever -- no recovery mechanism
3. Integration tests can't verify deployment completion without the dashboard
4. Multiple clients watching the same deployment can race on status writes

## 3. Proposed Solution

### Architecture

```
Agent completes command
    | writes to
commands/completed  -->  onCommandCompleted (Firestore trigger)
                              | reads deployment_id from command
                              | updates target status in deployment doc
                              | recalculates overall deployment status
                              | writes back to deployment doc

Every 5 minutes  -->  sweepStaleDeployments (Scheduled function)
                              | queries deployments with status in_progress
                              | checks each target's age
                              | marks targets > 15 min old as failed (timeout)
                              | recalculates overall deployment status
```

### Technology choices
- **Firebase Functions v2** -- already in use (`onDocumentWritten`), consistent with `metricsHistory.ts`
- **`onDocumentWritten`** trigger on `sites/{siteId}/machines/{machineId}/commands/completed` -- same pattern as existing metrics function
- **`onSchedule`** from `firebase-functions/v2/scheduler` -- built-in, no extra infra
- **Shared status calculation** -- extract into a utility so trigger + sweeper use the same logic

### Key design decisions
- **Trigger fires on every completed doc write** (including intermediate `downloading`/`installing` states) -- we update deployment target progress in real-time, not just on terminal states
- **Idempotent writes** -- if the trigger fires twice for the same command, the result is the same
- **Sweeper threshold**: 15 minutes default -- covers download + install for large packages
- **Frontend hook becomes read-only** -- just listens to deployment doc changes via Firestore `onSnapshot`, no more mutation logic
- **Sweeper only fails `pending` targets** (never started) -- targets already `downloading`/`installing` get a longer grace period since the agent is actively working

## 4. Implementation Phases

### Phase 1: Cloud Functions (core)
**Goals**: Create and deploy both Cloud Functions.

- Create `deploymentStatus.ts` -- Firestore trigger function
- Create `deploymentSweeper.ts` -- Scheduled sweeper function
- Extract shared status calculation into `lib/deploymentUtils.ts`
- Export from `index.ts`
- Build and deploy

**Dependencies**: None -- this is additive, doesn't break existing behavior.

### Phase 2: Frontend simplification
**Goals**: Remove mutation logic from frontend hook, make it read-only.

- Strip command-listening and status mutation from `useDeployments.ts`
- Remove `processedCommandsRef` tracking
- Keep deployment doc `onSnapshot` listener for real-time UI

**Dependencies**: Phase 1 must be deployed and verified first.

### Phase 3: Testing & validation
**Goals**: Verify the full pipeline works end-to-end.

- Run E2E integration tests (should now see `completed` status)
- Verify sweeper catches stuck deployments
- Verify no regressions in dashboard UI
- Run full Jest unit test suite

**Dependencies**: Phases 1 and 2.

## 5. Detailed Tasks

See `server-side-deployment-status-tasks.md` for full checklist.

## 6. Files to Modify/Create

**Created:**
- `functions/src/deploymentStatus.ts` -- Firestore trigger function
- `functions/src/deploymentSweeper.ts` -- Scheduled sweeper function
- `functions/src/lib/deploymentUtils.ts` -- Shared status calculation

**Modified:**
- `functions/src/index.ts` -- Add exports for new functions
- `web/hooks/useDeployments.ts` -- Simplify to read-only listener

## 7. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Trigger fires for non-deployment commands (no `deployment_id`) | Low | Early return if no `deployment_id` in command data |
| Race condition: trigger + sweeper both updating same deployment | Medium | Sweeper only touches targets older than threshold; trigger writes are idempotent |
| Trigger fires for intermediate states on every progress update | Medium | Only update deployment target if status actually changed |
| Frontend removal breaks existing dashboard behavior | High | Deploy functions first (Phase 1), verify, then simplify frontend (Phase 2) |
| Sweeper marks deployment as failed while agent is still installing | Medium | 15-min threshold; only fail `pending` targets, not `downloading`/`installing` |

## 8. Success Criteria

1. **E2E integration tests pass** -- deployment created via API reaches `completed` status without dashboard open
2. **Sweeper catches stuck deployments** -- deployment with no agent response is marked `failed` after timeout
3. **Dashboard still works** -- real-time status updates visible in UI
4. **No duplicate writes** -- trigger is idempotent
5. **Cloud Functions deploy and run** -- no errors in Firebase logs

## 9. Testing Strategy

- **Integration tests** (`tests/api/test_deployments.py::TestDeploymentE2E`) -- already written, validates the full flow
- **Manual testing** -- create deployment from dashboard, watch status update without refreshing
- **Sweeper test** -- create deployment targeting a non-existent machine, verify it gets marked `failed` after 15 min
- **Jest unit tests** -- existing deployment tests should continue to pass

## 10. Estimated Timeline

| Phase | Estimate |
|---|---|
| Phase 1: Cloud Functions | ~45 min |
| Phase 2: Frontend simplification | ~20 min |
| Phase 3: Testing & deploy | ~30 min (plus E2E wait time) |
| **Total** | **~1.5 hours** + E2E polling time |
