# Server-Side Deployment Status - Task Checklist

**Last Updated**: 2026-03-23

## Phase 1: Cloud Functions

- [ ] Create `functions/src/lib/deploymentUtils.ts` -- shared status calculation
  - [ ] `calculateDeploymentStatus(targets)` -- returns overall status from targets array
  - [ ] `mapCommandToTargetStatus(commandStatus, commandType)` -- maps command fields to target status
  - [ ] Target terminal statuses constant
  - [ ] Deployment terminal statuses constant
- [ ] Create `functions/src/deploymentStatus.ts` -- Firestore trigger
  - [ ] `onDocumentWritten` on `sites/{siteId}/machines/{machineId}/commands/completed`
  - [ ] Diff before/after to find changed commands
  - [ ] Early return if no `deployment_id` in command
  - [ ] Read deployment doc, find matching target by machineId
  - [ ] Update target status, progress, error, timestamps
  - [ ] Skip write if status unchanged (avoid unnecessary writes)
  - [ ] Recalculate overall deployment status via utility
  - [ ] Write updated deployment doc
  - [ ] Handle missing deployment doc gracefully (log + return)
- [ ] Create `functions/src/deploymentSweeper.ts` -- Scheduled function
  - [ ] `onSchedule` running every 5 minutes
  - [ ] Query all sites, then deployments where status is `pending` or `in_progress`
  - [ ] For each deployment: check each target's age
  - [ ] Mark `pending` targets older than 15 min as `failed` with timeout error
  - [ ] Leave `downloading`/`installing` targets alone (agent is working)
  - [ ] Recalculate overall deployment status
  - [ ] Write back only if something changed
- [ ] Update `functions/src/index.ts` -- export new functions
- [ ] Build functions (`npm run build` in `functions/`)
- [ ] Deploy functions (`firebase deploy --only functions`)
- [ ] Verify functions appear in Firebase Console
- [ ] Check Firebase logs for errors on first trigger

## Phase 2: Frontend Simplification

- [ ] Simplify `web/hooks/useDeployments.ts`
  - [ ] Remove command completion listener logic (~lines 185-422)
  - [ ] Remove `processedCommandsRef` tracking
  - [ ] Remove command-to-target status mapping
  - [ ] Keep deployment doc `onSnapshot` listener (read-only)
  - [ ] Keep `createDeployment`, `cancelDeployment`, `deleteDeployment` (these write via API)
  - [ ] Keep `checkMachineHasActiveDeployment`
- [ ] Verify dashboard still shows real-time updates

## Phase 3: Testing & Validation

- [ ] Run E2E integration tests (`TestDeploymentE2E`) -- verify `completed` status
- [ ] Run full Jest deployment tests (34 tests, no regressions)
- [ ] Manual test: create deployment from dashboard, verify status updates without refresh
- [ ] Manual test: verify sweeper by checking Firebase logs after 5 min
- [ ] Run full Jest suite to check no other regressions

---

## Progress Notes

### 2026-03-23
- Created dev docs from approved plan
- Ready to begin Phase 1 implementation

---
**Last Updated**: 2026-03-23
