/**
 * removeMachine action core (security-boundary-migration wave 3.8).
 *
 * Hard-deletes a machine and all of its associated data from a site:
 *
 *   1. `sites/{siteId}/machines/{machineId}`          — main machine doc
 *   2. `config/{siteId}/machines/{machineId}`         — machine config
 *   3. `sites/{siteId}/machines/{machineId}/commands/pending`   — pending command map
 *   4. `sites/{siteId}/machines/{machineId}/commands/completed` — completed command map
 *   5. `agent_refresh_tokens` where `siteId` and `machineId` match
 *
 * The fixed machine/config/commands paths mirror the client-side cascade in
 * `web/hooks/useMachineOperations.ts`. The hook will be deleted in a
 * follow-up wave once the route-side action is the only writer.
 *
 * Capability: `MACHINE_REMOVE` — site-scoped per the role matrix in
 * `web/lib/capabilities.ts`. Site admins can remove machines on their assigned
 * sites; superadmins on any site.
 *
 * Atomicity: the main doc + config delete run in a Firestore batch; the
 * command-map docs and agent refresh token docs are deleted as best-effort
 * follow-ups since they may not exist (a freshly-paired machine that never
 * received a command has no commands subcollection at all). Missing-doc
 * deletes are NOT errors — Firestore's `delete()` is naturally idempotent
 * for absent docs, so we don't need to pre-check existence.
 *
 * Active-deployment guard: the legacy client flow checked
 * `checkMachineHasActiveDeployment` BEFORE calling the cascade. We do NOT
 * replicate that check here because:
 *   (a) it lived in the dashboard UI, not the data layer, and was never
 *       authoritative — racy against in-flight commands.
 *   (b) the audit log captures the removal action; downstream
 *       reconciliation handles abandoned deployments.
 * If a stronger guard is needed it ships in a follow-up wave.
 *
 * Resumability: cascade size is bounded by fixed machine/config/commands
 * docs plus matching agent refresh token docs. No need for operation-id
 * resumption at this scale.
 */

import { Firestore } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import logger from '@/lib/logger';

const AGENT_REFRESH_TOKEN_DELETE_BATCH_SIZE = 500;

export interface RemoveMachineInput {
  siteId: string;
  machineId: string;
  /** Inject a Firestore instance — tests pass a mock; production omits. */
  db?: Firestore;
}

export interface RemoveMachineResult {
  siteId: string;
  machineId: string;
  /** Paths that were deleted. Always populated regardless of pre-existence. */
  deleted: {
    machine: string;
    config: string;
    pendingCommands: string;
    completedCommands: string;
  };
}

/**
 * Hard-delete a machine and its associated data. Idempotent: re-issuing
 * the call after the first success is a no-op (every delete target is
 * already gone, and Firestore deletes never error on missing docs).
 *
 * Throws if the underlying Firestore write fails. Callers (the route
 * shim) translate to RFC 7807 via `problemFromError`.
 */
export async function removeMachine(
  input: RemoveMachineInput,
): Promise<RemoveMachineResult> {
  const { siteId, machineId } = input;
  if (!siteId) throw new Error('siteId is required');
  if (!machineId) throw new Error('machineId is required');

  const db = input.db ?? getAdminDb();

  const machineRef = db
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId);
  const configRef = db
    .collection('config')
    .doc(siteId)
    .collection('machines')
    .doc(machineId);
  const pendingCommandsRef = machineRef.collection('commands').doc('pending');
  const completedCommandsRef = machineRef.collection('commands').doc('completed');

  // Phase 1: atomic batch for the two top-level docs (main + config). If
  // this fails the machine remains visible — desired, since the audit log
  // records the failure and the user can retry.
  const batch = db.batch();
  batch.delete(machineRef);
  batch.delete(configRef);
  await batch.commit();

  // Phase 2: best-effort command-map cleanup. These docs are NOT always
  // present (machines that have never received a command have no
  // `commands/pending` doc at all), but Firestore deletes are idempotent
  // so a missing doc is not an error. We still log warnings for
  // unexpected failure modes (e.g. permission denied from a misconfigured
  // emulator) so they're visible in production telemetry.
  try {
    await pendingCommandsRef.delete();
  } catch (err) {
    logger.warn('removeMachine: pending commands delete failed (non-fatal)', {
      context: 'removeMachine',
      data: {
        siteId,
        machineId,
        err: err instanceof Error ? err.message : String(err),
      },
    });
  }

  try {
    await completedCommandsRef.delete();
  } catch (err) {
    logger.warn('removeMachine: completed commands delete failed (non-fatal)', {
      context: 'removeMachine',
      data: {
        siteId,
        machineId,
        err: err instanceof Error ? err.message : String(err),
      },
    });
  }

  // Phase 3: best-effort token cleanup. The agent refresh token documents
  // are top-level docs keyed by token hash, so locate them by the same
  // siteId + machineId query used by the manual revoke route.
  try {
    for (;;) {
      const tokensSnapshot = await db.collection('agent_refresh_tokens')
        .where('siteId', '==', siteId)
        .where('machineId', '==', machineId)
        .limit(AGENT_REFRESH_TOKEN_DELETE_BATCH_SIZE)
        .get();

      if (tokensSnapshot.docs.length === 0) break;

      const tokenBatch = db.batch();
      tokensSnapshot.docs.forEach((doc) => {
        tokenBatch.delete(doc.ref);
      });
      await tokenBatch.commit();

      if (tokensSnapshot.docs.length < AGENT_REFRESH_TOKEN_DELETE_BATCH_SIZE) break;
    }
  } catch (err) {
    logger.warn('removeMachine: agent refresh token delete failed (non-fatal)', {
      context: 'removeMachine',
      data: {
        siteId,
        machineId,
        err: err instanceof Error ? err.message : String(err),
      },
    });
  }

  return {
    siteId,
    machineId,
    deleted: {
      machine: `sites/${siteId}/machines/${machineId}`,
      config: `config/${siteId}/machines/${machineId}`,
      pendingCommands: `sites/${siteId}/machines/${machineId}/commands/pending`,
      completedCommands: `sites/${siteId}/machines/${machineId}/commands/completed`,
    },
  };
}
