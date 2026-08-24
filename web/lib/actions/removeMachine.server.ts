/**
 * removeMachine action core. Hard-deletes the machine doc, its config doc, its
 * pending/completed command maps, and every matching `agent_refresh_tokens`
 * row. Capability `MACHINE_REMOVE` (site-scoped).
 *
 * Atomicity: machine + config delete in one batch; command maps and tokens are
 * best-effort follow-ups because they may not exist (a freshly-paired machine
 * has no commands subcollection). Firestore deletes are idempotent on absent
 * docs, so no existence pre-check.
 *
 * No active-deployment guard: the legacy client-side check was racy against
 * in-flight commands and lived in the UI, not the data layer. The audit log
 * records the removal; reconciliation handles abandoned deployments.
 *
 * TODO: delete `web/hooks/useMachineOperations.ts` once this is the only writer.
 */

import { Firestore } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import { emitMutation } from '@/lib/auditLogClient';
import logger from '@/lib/logger';

const AGENT_REFRESH_TOKEN_DELETE_BATCH_SIZE = 500;

export interface RemoveMachineInput {
  siteId: string;
  machineId: string;
  /** Audit actor string ("user:<uid>" or "apiKey:<keyId>"). */
  auditActor: string;
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

  // Atomic: a failure leaves the machine visible and retryable.
  const batch = db.batch();
  batch.delete(machineRef);
  batch.delete(configRef);
  await batch.commit();

  // Best-effort: these docs may never have existed. Warn rather than throw,
  // so unexpected modes (e.g. permission denied) stay visible in telemetry.
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

  // Tokens are top-level docs keyed by hash, so they're found by the same
  // siteId + machineId query the manual revoke route uses.
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

  emitMutation({
    kind: 'site_mutated',
    siteId,
    actor: input.auditActor,
    targetId: machineId,
    attributes: {
      verb: 'machine.remove',
      endpoint: 'machines',
      method: 'DELETE',
      machineId,
    },
  });

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
