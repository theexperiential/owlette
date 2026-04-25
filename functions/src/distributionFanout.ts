/**
 * Distribution fan-out cloud function (roost wave 2b.3).
 *
 * Two firestore triggers implement a staged → canary → fleet rollout
 * when an operator publishes a new version:
 *
 *   onRoostWritten          — fires when `currentVersionId` changes on
 *                             a roost. Issues canary sync commands
 *                             and creates a rollout state doc.
 *
 *   onTargetStateWritten    — fires when an agent reports a target_state
 *                             for a version under rollout. Advances the
 *                             state machine: canary → fleet, or aborts.
 *
 * The pure decision logic (who is in the canary, did it pass, did it
 * fail hard enough to abort) lives in lib/fanoutLogic.ts and is covered
 * by unit tests. Handlers below are thin: load firestore state, feed
 * to logic, write decisions.
 *
 * **Why not all-at-once?** The cloudflare 2025-11-18 config push that
 * took down the fleet globally is the standing reminder: canary first.
 */

import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import {
  evaluateWave,
  nextStage,
  selectCanary,
  type RolloutStage,
  type TargetState,
  type TargetStatus,
} from './lib/fanoutLogic';

const db = admin.firestore();

/* --------------------------------------------------------------------- */
/*  Types                                                                */
/* --------------------------------------------------------------------- */

interface Roost {
  currentVersionId?: string;
  versionUrl?: string;
  targets?: string[];
  extractPath?: string;
}

// Fallback extraction root when the roost doc carries no explicit
// extractPath. Matches agent DEFAULT_ROOTS in destination_allowlist.py —
// keep these in sync.
const DEFAULT_EXTRACT_ROOT = '~/Documents/Owlette';

interface RolloutDoc {
  stage: RolloutStage;
  versionId: string;
  versionUrl: string;
  extractRoot: string;
  canary: string[];
  fleet: string[];
  startedAt?: FirebaseFirestore.Timestamp;
  completedAt?: FirebaseFirestore.Timestamp;
  abortedAt?: FirebaseFirestore.Timestamp;
  abortReason?: string;
}

/* --------------------------------------------------------------------- */
/*  Trigger 1: roost write → kick off canary                             */
/* --------------------------------------------------------------------- */

export const onRoostWritten = onDocumentWritten(
  'sites/{siteId}/roosts/{roostId}',
  async (event) => {
    const { siteId, roostId } = event.params;

    const before = event.data?.before?.data() as Roost | undefined;
    const after = event.data?.after?.data() as Roost | undefined;

    // deletion or no-op writes — nothing to do.
    if (!after) return;
    if (!after.currentVersionId || !after.versionUrl) return;
    if (before?.currentVersionId === after.currentVersionId) return;

    const versionId = after.currentVersionId;
    const versionUrl = after.versionUrl;
    const targets = Array.isArray(after.targets) ? after.targets : [];
    const extractRoot =
      typeof after.extractPath === 'string' && after.extractPath.trim()
        ? after.extractPath.trim()
        : DEFAULT_EXTRACT_ROOT;

    if (targets.length === 0) {
      console.warn(
        `[fanout] roost ${siteId}/${roostId} has no targets; ` +
          `version ${versionId} will not be fanned out.`,
      );
      return;
    }

    const { canary, fleet } = selectCanary(targets, versionId);

    const rolloutRef = db
      .collection('sites')
      .doc(siteId)
      .collection('roosts')
      .doc(roostId)
      .collection('rollouts')
      .doc(versionId);

    // idempotent initialisation: if the rollout doc already exists for
    // this versionId, bail. trigger retries don't re-issue commands.
    const existing = await rolloutRef.get();
    if (existing.exists) {
      console.log(
        `[fanout] rollout already initialised for ${siteId}/${roostId}/${versionId}; skipping.`,
      );
      return;
    }

    const rolloutDoc: RolloutDoc = {
      stage: 'canary',
      versionId,
      versionUrl,
      extractRoot,
      canary,
      fleet,
      startedAt: FieldValue.serverTimestamp() as unknown as FirebaseFirestore.Timestamp,
    };

    const batch = db.batch();
    batch.set(rolloutRef, rolloutDoc);
    for (const machineId of canary) {
      queueSyncCommand(batch, siteId, machineId, roostId, versionId, versionUrl, extractRoot);
    }
    await batch.commit();

    console.log(
      `[fanout] ${siteId}/${roostId}/${versionId}: canary started with ` +
        `${canary.length}/${targets.length} machine(s); ${fleet.length} queued for fleet wave`,
    );
  },
);

/* --------------------------------------------------------------------- */
/*  Trigger 2: target_state write → advance rollout state                */
/* --------------------------------------------------------------------- */

export const onTargetStateWritten = onDocumentWritten(
  'sites/{siteId}/roosts/{roostId}/target_state/{machineId}',
  async (event) => {
    const { siteId, roostId, machineId } = event.params;
    const after = event.data?.after?.data() as
      | { reportedVersionId?: string; status?: string }
      | undefined;

    if (!after?.reportedVersionId || !after.status) return;
    const reportedVersionId = after.reportedVersionId;

    const rolloutRef = db
      .collection('sites')
      .doc(siteId)
      .collection('roosts')
      .doc(roostId)
      .collection('rollouts')
      .doc(reportedVersionId);

    // transaction: read rollout, evaluate wave, write transition atomically.
    // prevents two concurrent target_state writes from both trying to
    // promote canary → fleet.
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(rolloutRef);
      if (!snap.exists) return; // no rollout for this version — ignore

      const rollout = snap.data() as RolloutDoc;
      if (rollout.stage === 'complete' || rollout.stage === 'aborted') return;

      const waveIds =
        rollout.stage === 'canary' ? rollout.canary : rollout.fleet;
      if (!waveIds.includes(machineId)) return; // not part of current wave

      // pull reported status for every machine in the current wave
      const waveStates = await readWaveStates(
        tx,
        siteId,
        roostId,
        reportedVersionId,
        waveIds,
      );

      const evaluation = evaluateWave(waveStates);
      const transition = nextStage(rollout.stage, evaluation);
      if (!transition) return; // still in flight

      if (transition.stage === 'fleet') {
        // promote: fire fleet commands in the same transaction.
        // Older rollout docs predate the `extractRoot` field; fall back
        // to the default so a mid-flight promotion still completes.
        const extractRoot = rollout.extractRoot || DEFAULT_EXTRACT_ROOT;
        for (const mid of rollout.fleet) {
          queueSyncCommand(
            tx,
            siteId,
            mid,
            roostId,
            reportedVersionId,
            rollout.versionUrl,
            extractRoot,
          );
        }
        tx.update(rolloutRef, {
          stage: 'fleet',
          fleetStartedAt: FieldValue.serverTimestamp(),
        });
        console.log(
          `[fanout] ${siteId}/${roostId}/${reportedVersionId}: ${transition.reason}; fleet wave dispatched`,
        );
        return;
      }

      if (transition.stage === 'aborted') {
        tx.update(rolloutRef, {
          stage: 'aborted',
          abortedAt: FieldValue.serverTimestamp(),
          abortReason: transition.reason,
        });
        console.error(
          `[fanout] ${siteId}/${roostId}/${reportedVersionId}: ABORTED — ${transition.reason}`,
        );
        return;
      }

      if (transition.stage === 'complete') {
        tx.update(rolloutRef, {
          stage: 'complete',
          completedAt: FieldValue.serverTimestamp(),
        });
        console.log(
          `[fanout] ${siteId}/${roostId}/${reportedVersionId}: ${transition.reason}`,
        );
        return;
      }
    });
  },
);

/* --------------------------------------------------------------------- */
/*  Helpers                                                              */
/* --------------------------------------------------------------------- */

/**
 * Minimal shape we need from a batch or transaction for our writes.
 * Union of `WriteBatch | Transaction` doesn't narrow in TS because
 * each exposes set() with different generic signatures; this interface
 * captures the one call we actually make. Runtime behaviour is
 * identical for both SDKs.
 */
interface Writable {
  set(
    ref: FirebaseFirestore.DocumentReference,
    data: FirebaseFirestore.DocumentData,
    options: FirebaseFirestore.SetOptions,
  ): unknown;
  update(
    ref: FirebaseFirestore.DocumentReference,
    data: FirebaseFirestore.UpdateData<FirebaseFirestore.DocumentData>,
  ): unknown;
}

/**
 * Queue a `roost_sync` command in the machine's pending commands doc.
 * Agent's command_router dispatches it; result lands in completed/.
 *
 * `roostId` is passed as `folder_id` in the command payload — the agent's
 * sync_commands handler + on-disk sqlite schema still use `folder_id` for
 * the local filesystem-folder-of-sync concept (unrelated to the firestore
 * collection rename).
 */
function queueSyncCommand(
  writable: Writable,
  siteId: string,
  machineId: string,
  roostId: string,
  versionId: string,
  versionUrl: string,
  extractRoot: string,
): void {
  const pendingRef = db
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .collection('commands')
    .doc('pending');

  // one-doc-per-machine pending commands (matches existing pattern used
  // by deploymentStatus.ts). command id is deterministic per version+roost
  // so retries of this function don't duplicate.
  const cmdId = `roost_sync_${roostId}_${versionId}`;
  writable.set(
    pendingRef,
    {
      [cmdId]: {
        type: 'sync_pull',
        site_id: siteId,
        folder_id: roostId,
        version_id: versionId,
        version_url: versionUrl,
        extract_root: extractRoot,
        queued_at: FieldValue.serverTimestamp(),
      },
    },
    { merge: true },
  );
}

async function readWaveStates(
  tx: FirebaseFirestore.Transaction,
  siteId: string,
  roostId: string,
  versionId: string,
  machineIds: string[],
): Promise<TargetState[]> {
  const col = db
    .collection('sites')
    .doc(siteId)
    .collection('roosts')
    .doc(roostId)
    .collection('target_state');

  // firestore transactions require all reads before writes. fetch in
  // parallel; unreported machines default to 'pending'.
  const refs = machineIds.map((mid) => col.doc(mid));
  const snaps = await Promise.all(refs.map((ref) => tx.get(ref)));
  return snaps.map((snap, i) => {
    const data = snap.exists ? (snap.data() as any) : null;
    const reportedVersion = data?.reportedVersionId as string | undefined;
    const rawStatus = data?.status as string | undefined;
    // only count status if the agent's report is for THIS version.
    // a stale status from a prior version shouldn't inform this wave.
    const status: TargetStatus =
      reportedVersion === versionId && rawStatus
        ? coerceStatus(rawStatus)
        : 'pending';
    return { machineId: machineIds[i], status };
  });
}

/**
 * Agents report fine-grained sync states. Collapse them to the four
 * terminal-or-in-flight categories the fan-out logic cares about.
 */
function coerceStatus(raw: string): TargetStatus {
  switch (raw) {
    case 'committed':
    case 'succeeded':
      return 'succeeded';
    case 'failed':
    case 'error':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'pending':
      return 'pending';
    default:
      // in_progress / downloading / assembling / any unknown in-flight
      // state rolls up to in_progress.
      return 'in_progress';
  }
}
