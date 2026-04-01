# Server-Side Deployment Status - Context & Integration Points

**Last Updated**: 2026-03-23

## Key Files

### To Create
- `functions/src/deploymentStatus.ts` -- Firestore trigger: command completion -> deployment status update
- `functions/src/deploymentSweeper.ts` -- Scheduled function: fail stuck deployments after timeout
- `functions/src/lib/deploymentUtils.ts` -- Shared status calculation logic (used by both functions)

### To Modify
- `functions/src/index.ts` -- Add exports for `onCommandCompleted` and `sweepStaleDeployments`
- `web/hooks/useDeployments.ts` -- Remove ~250 lines of command-listening + status mutation logic; keep as read-only deployment doc listener

### Reference (read-only, do not modify)
- `functions/src/metricsHistory.ts` -- Existing trigger pattern to follow
- `agent/src/firebase_client.py` -- Agent's command completion write format (lines 703-856)
- `agent/src/owlette_service.py` -- Agent's install_software handler (lines 2121-2213)
- `web/app/api/admin/deployments/[deploymentId]/cancel/route.ts` -- Cancel endpoint (already recalculates status)

## Architectural Decisions

1. **Firestore trigger (not agent-side update)** -- Agent stays dumb, only reports command results. Server-side function handles deployment status. This means agent crashes don't orphan deployments.
2. **Sweeper only fails `pending` targets** -- Targets that are `downloading` or `installing` have an actively-working agent, so we give them more grace time. Only targets that never started (stuck at `pending`) get timed out at 15 minutes.
3. **Phase 2 after Phase 1** -- Deploy functions first as additive behavior. Frontend mutation logic coexists harmlessly (both write the same values). Remove frontend logic only after verifying functions work.

## Integration Points

### Cloud Functions <-> Firestore
- **Trigger path**: `sites/{siteId}/machines/{machineId}/commands/completed` (same doc agent writes to)
- **Reads**: Command data from trigger event (`deployment_id`, `status`, `type`, `error`, `progress`)
- **Writes**: `sites/{siteId}/deployments/{deploymentId}` (targets array + overall status)

### Deployment Status Calculation Logic
Current logic lives in `useDeployments.ts`. Must be replicated exactly in `deploymentUtils.ts`:

| Condition | Deployment Status |
|---|---|
| All targets `completed` | `completed` |
| All targets `cancelled` | `failed` |
| All targets `uninstalled` | `uninstalled` |
| Mixed terminal (any `failed`) | `partial` |
| Any non-terminal target remaining | `in_progress` |

Target terminal statuses: `completed`, `failed`, `cancelled`, `uninstalled`

### Command -> Target Status Mapping

| Command `status` | Command `type` | Target Status |
|---|---|---|
| `downloading` | `install_software` | `downloading` |
| `installing` | `install_software` | `installing` |
| `completed` | `install_software` | `completed` |
| `failed` | `install_software` | `failed` |
| `cancelled` | `cancel_installation` | `cancelled` |
| `completed` | `uninstall_software` | `uninstalled` |
| `failed` | `uninstall_software` | `failed` |

## Dependencies

**No new packages needed.** Everything uses existing `firebase-admin` and `firebase-functions` v5.

Internal ordering:
1. `deploymentUtils.ts` must exist before `deploymentStatus.ts` and `deploymentSweeper.ts`
2. Functions must be deployed before frontend simplification
3. E2E tests depend on functions being live

## Data Flow

```
Agent finishes install
    | writes to commands/completed
    v
onCommandCompleted trigger fires
    | extracts deployment_id, status, machineId from command
    | reads deployment doc
    | finds matching target in targets[]
    | updates target status + metadata (progress, error, completedAt)
    | recalculates overall deployment status
    | writes updated deployment doc
    v
Dashboard onSnapshot listener sees change -> UI updates

Meanwhile, every 5 minutes:
sweepStaleDeployments
    | queries all deployments where status == 'in_progress' or 'pending'
    | for each: checks target ages
    | marks targets stuck at 'pending' > 15 min as failed
    | recalculates overall status
    | writes back
```

## Firestore Paths

```
sites/{siteId}/
  machines/{machineId}/
    commands/
      pending    -- agent reads commands from here
      completed  -- agent writes results here (TRIGGER SOURCE)
  deployments/{deploymentId}  -- deployment status doc (TRIGGER TARGET)
```

## Edge Cases & Considerations

- **Non-deployment commands**: Trigger must early-return if command has no `deployment_id`
- **Duplicate trigger fires**: Must be idempotent -- setting same status twice is harmless
- **Deployment already deleted**: Trigger should gracefully handle missing deployment doc
- **Multiple commands per deployment**: Each machine has its own command; trigger only updates that machine's target
- **Intermediate state spam**: `downloading` with progress updates fires trigger repeatedly -- only write if status or progress actually changed
- **Rate limit on trigger writes**: The completed doc gets written multiple times per install (progress updates). Each write triggers the function. Keep function fast to avoid quota issues.

## Next Steps

1. Create `functions/src/lib/deploymentUtils.ts` with shared status calculation
2. Create `functions/src/deploymentStatus.ts` with the Firestore trigger
3. Create `functions/src/deploymentSweeper.ts` with the scheduled sweeper
4. Update `functions/src/index.ts` to export both
5. Build and deploy functions
6. Run E2E integration tests to verify

---
**Last Updated**: 2026-03-23
