/**
 * Per-site storage quota enforcement (roost wave 2b.5).
 *
 * Two entrypoints:
 *
 *   preUploadCheck   — HTTPS callable. The tusd pre-create hook (wave 2b.1)
 *                      calls this before issuing a signed upload URL. On
 *                      admission the pending-bytes reservation is written
 *                      atomically; on denial a 402 with an upgrade CTA
 *                      returns to tusd which propagates to the client.
 *
 *   reconcileQuota   — scheduled daily. Rebuilds `usedBytes` from the
 *                      authoritative R2 listing and re-emits any crossed
 *                      alarm thresholds (50 / 80 / 100 %). Pending-bytes
 *                      are aged: reservations older than the pending TTL
 *                      are presumed abandoned and released.
 *
 * The pure decision logic lives in lib/quotaLogic.ts. This file glues
 * firestore state + R2 listing into that logic + writes alarm events.
 */

import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { requireInternalSecret } from './lib/requireInternalSecret';
import {
  admitUpload,
  ALARM_LEVELS,
  newAlarmCrossings,
  PLAN_LIMITS_BYTES,
  reportQuota,
  type AlarmLevel,
  type PlanTier,
  type QuotaState,
} from './lib/quotaLogic';

/** Pending reservations older than this are presumed abandoned. */
const PENDING_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/* --------------------------------------------------------------------- */
/*  Dependency interfaces (injectable for tests)                         */
/* --------------------------------------------------------------------- */

export interface QuotaStore {
  /** Return the site's cached quota state + last-seen alarm level. */
  read(siteId: string): Promise<{
    state: QuotaState;
    lastAlarmLevel: AlarmLevel;
  } | null>;
  /**
   * Reserve `bytes` as pendingBytes against the site's quota,
   * identified by `reservationId`. Idempotent on the id.
   */
  reservePending(
    siteId: string,
    reservationId: string,
    bytes: number,
    now: Date,
  ): Promise<void>;
  /** Release a reservation (on finalize/failure/abort). */
  releasePending(siteId: string, reservationId: string): Promise<void>;
  /** Replace `usedBytes` and expire stale pending reservations. */
  rewrite(siteId: string, state: QuotaState, now: Date): Promise<void>;
  /** Record the current alarm level + fired crossings. */
  recordAlarms(
    siteId: string,
    currentLevel: AlarmLevel,
    crossings: AlarmLevel[],
    now: Date,
  ): Promise<void>;
}

export interface StorageMetrics {
  /** Sum of all chunk sizes under `project-content/{siteId}/`. */
  usedBytes(siteId: string): Promise<number>;
}

export interface SiteDirectory {
  listSiteIds(): Promise<string[]>;
  /** Read the plan tier from billing. Defaults to 'free' if missing. */
  readTier(siteId: string): Promise<PlanTier>;
}

/* --------------------------------------------------------------------- */
/*  Pure orchestrator — pre-upload admission                             */
/* --------------------------------------------------------------------- */

export interface PreUploadRequest {
  siteId: string;
  reservationId: string;
  requestedBytes: number;
}

export interface PreUploadResponse {
  status: number;
  body: {
    allowed: boolean;
    reason?: string;
    remainingBytes?: number;
    planLimitBytes?: number;
    upgrade?: {
      currentTier: PlanTier;
      suggestedTier: PlanTier;
      message: string;
    };
  };
}

export interface PreUploadDeps {
  quota: QuotaStore;
  directory: SiteDirectory;
  now?: () => Date;
}

/**
 * Run the pre-upload check. Returns an HTTP-shaped response describing
 * the verdict. Side-effect on admission: the `reservationId` is recorded
 * as pending bytes, so a concurrent call can't also "fit".
 */
export async function runPreUploadCheck(
  req: PreUploadRequest,
  deps: PreUploadDeps,
): Promise<PreUploadResponse> {
  const now = deps.now ? deps.now() : new Date();

  if (
    !req.siteId ||
    !req.reservationId ||
    typeof req.requestedBytes !== 'number' ||
    !isFinite(req.requestedBytes) ||
    req.requestedBytes <= 0
  ) {
    return {
      status: 400,
      body: { allowed: false, reason: 'invalid_request' },
    };
  }

  const [tier, existing] = await Promise.all([
    deps.directory.readTier(req.siteId),
    deps.quota.read(req.siteId),
  ]);

  const state: QuotaState = existing?.state ?? {
    tier,
    usedBytes: 0,
    pendingBytes: 0,
  };
  // directory is the source of truth for tier; never let a stale cached
  // tier in the quota doc grant more than the customer actually pays for.
  state.tier = tier;

  const decision = admitUpload({ state, requestedBytes: req.requestedBytes });

  if (!decision.allowed) {
    return {
      status: decision.status,
      body: {
        allowed: false,
        reason: decision.reason,
        remainingBytes: decision.report.unlimited
          ? undefined
          : decision.report.remainingBytes,
        planLimitBytes: decision.report.unlimited
          ? undefined
          : decision.report.planLimitBytes,
        upgrade: decision.upgradeCta,
      },
    };
  }

  // reserve atomically BEFORE returning admission. if this throws,
  // surface a 503 so the client retries rather than accidentally
  // getting an admission without a reservation.
  await deps.quota.reservePending(
    req.siteId,
    req.reservationId,
    req.requestedBytes,
    now,
  );

  return {
    status: 200,
    body: {
      allowed: true,
      remainingBytes: decision.report.unlimited
        ? undefined
        : decision.report.remainingBytes - req.requestedBytes,
      planLimitBytes: decision.report.unlimited
        ? undefined
        : decision.report.planLimitBytes,
    },
  };
}

/* --------------------------------------------------------------------- */
/*  Pure orchestrator — daily reconcile                                  */
/* --------------------------------------------------------------------- */

export interface ReconcileDeps {
  directory: SiteDirectory;
  quota: QuotaStore;
  metrics: StorageMetrics;
  now?: () => Date;
}

export interface SiteReconcileResult {
  siteId: string;
  previousLevel: AlarmLevel;
  currentLevel: AlarmLevel;
  crossings: AlarmLevel[];
  committedBytes: number;
  planLimitBytes: number;
}

export async function reconcileOneSite(
  siteId: string,
  deps: ReconcileDeps,
): Promise<SiteReconcileResult | null> {
  const now = deps.now ? deps.now() : new Date();

  const [tier, existing, usedBytes] = await Promise.all([
    deps.directory.readTier(siteId),
    deps.quota.read(siteId),
    deps.metrics.usedBytes(siteId),
  ]);

  // preserve previously-tracked pendingBytes, but let the TTL prune by
  // passing `now` to rewrite — store impl expires stale reservations.
  const nextState: QuotaState = {
    tier,
    usedBytes,
    pendingBytes: existing?.state.pendingBytes ?? 0,
  };
  const report = reportQuota(nextState);
  const previousLevel: AlarmLevel = existing?.lastAlarmLevel ?? 0;
  const crossings = newAlarmCrossings(previousLevel, report.alarmLevel);

  await deps.quota.rewrite(siteId, nextState, now);
  if (crossings.length > 0 || report.alarmLevel !== previousLevel) {
    await deps.quota.recordAlarms(siteId, report.alarmLevel, crossings, now);
  }

  return {
    siteId,
    previousLevel,
    currentLevel: report.alarmLevel,
    crossings,
    committedBytes: report.committedBytes,
    planLimitBytes: report.planLimitBytes,
  };
}

export async function reconcileAllSites(
  deps: ReconcileDeps,
): Promise<SiteReconcileResult[]> {
  const siteIds = await deps.directory.listSiteIds();
  const results: SiteReconcileResult[] = [];
  for (const siteId of siteIds) {
    try {
      const r = await reconcileOneSite(siteId, deps);
      if (r) results.push(r);
    } catch (err) {
      console.error(
        `[quotaEnforce] reconcile failed for ${siteId}: ${
          (err as Error).message
        }`,
      );
    }
  }
  return results;
}

/* --------------------------------------------------------------------- */
/*  Scheduled + HTTPS entrypoints                                        */
/* --------------------------------------------------------------------- */

/** Daily reconcile at 03:45 UTC (separated from chunkGc's 02:15 slot). */
export const reconcileQuota = onSchedule(
  { schedule: '45 3 * * *', timeoutSeconds: 540, memory: '512MiB' },
  async () => {
    const deps: ReconcileDeps = {
      directory: getDefaultDirectory(),
      quota: getDefaultQuotaStore(),
      metrics: getDefaultStorageMetrics(),
    };
    const results = await reconcileAllSites(deps);
    const fired = results.flatMap((r) =>
      r.crossings.map((t) => ({ siteId: r.siteId, threshold: t })),
    );
    console.log(
      `[quotaEnforce] reconcile complete: sites=${results.length} alarms_fired=${fired.length}`,
    );
  },
);

export const preUploadCheck = onRequest(
  { timeoutSeconds: 30, memory: '256MiB' },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'method_not_allowed' });
      return;
    }
    if (!requireInternalSecret(req, res)) return;
    const body = req.body as Partial<PreUploadRequest> | undefined;
    const result = await runPreUploadCheck(
      {
        siteId: body?.siteId ?? '',
        reservationId: body?.reservationId ?? '',
        requestedBytes:
          typeof body?.requestedBytes === 'number' ? body.requestedBytes : 0,
      },
      {
        quota: getDefaultQuotaStore(),
        directory: getDefaultDirectory(),
      },
    );
    res.status(result.status).json(result.body);
  },
);

/* --------------------------------------------------------------------- */
/*  Production wiring                                                    */
/* --------------------------------------------------------------------- */

function getDefaultDirectory(): SiteDirectory {
  const db = admin.firestore();
  return {
    async listSiteIds() {
      const snap = await db.collection('sites').listDocuments();
      return snap.map((d) => d.id);
    },
    async readTier(siteId: string) {
      const snap = await db.collection('sites').doc(siteId).get();
      const raw = snap.exists ? (snap.data() as { plan?: string }).plan : undefined;
      if (
        raw === 'free' ||
        raw === 'starter' ||
        raw === 'pro' ||
        raw === 'enterprise'
      ) {
        return raw;
      }
      return 'free';
    },
  };
}

function getDefaultQuotaStore(): QuotaStore {
  const db = admin.firestore();
  const quotaDoc = (siteId: string) =>
    db.collection('sites').doc(siteId).collection('roost').doc('quota');
  const pendingCol = (siteId: string) =>
    db
      .collection('sites')
      .doc(siteId)
      .collection('roost')
      .doc('quota')
      .collection('pending');

  return {
    async read(siteId: string) {
      const [doc, pendingSnap] = await Promise.all([
        quotaDoc(siteId).get(),
        pendingCol(siteId).get(),
      ]);
      if (!doc.exists) return null;
      const data = doc.data() as {
        tier?: PlanTier;
        usedBytes?: number;
        lastAlarmLevel?: AlarmLevel;
      };
      const tier = data.tier ?? 'free';
      const usedBytes = data.usedBytes ?? 0;
      const pendingBytes = pendingSnap.docs.reduce(
        (n, d) => n + ((d.data() as { bytes?: number }).bytes ?? 0),
        0,
      );
      return {
        state: { tier, usedBytes, pendingBytes },
        lastAlarmLevel: (data.lastAlarmLevel as AlarmLevel) ?? 0,
      };
    },
    async reservePending(siteId, reservationId, bytes, now) {
      await pendingCol(siteId).doc(reservationId).set({
        bytes,
        reservedAt: now,
      });
    },
    async releasePending(siteId, reservationId) {
      await pendingCol(siteId).doc(reservationId).delete();
    },
    async rewrite(siteId, state, now) {
      const cutoff = new Date(now.getTime() - PENDING_TTL_MS);
      // prune expired reservations in the same read window
      const expired = await pendingCol(siteId)
        .where('reservedAt', '<', cutoff)
        .get();
      const batch = db.batch();
      for (const d of expired.docs) batch.delete(d.ref);
      batch.set(
        quotaDoc(siteId),
        {
          tier: state.tier,
          usedBytes: state.usedBytes,
          planLimitBytes: PLAN_LIMITS_BYTES[state.tier],
          lastReconciledAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      await batch.commit();
    },
    async recordAlarms(siteId, currentLevel, crossings, now) {
      const batch = db.batch();
      batch.set(
        quotaDoc(siteId),
        { lastAlarmLevel: currentLevel, lastAlarmAt: now },
        { merge: true },
      );
      for (const threshold of crossings) {
        batch.set(
          db
            .collection('sites')
            .doc(siteId)
            .collection('quota_alarms')
            .doc(),
          {
            threshold,
            firedAt: now,
          },
        );
      }
      await batch.commit();
    },
  };
}

function getDefaultStorageMetrics(): StorageMetrics {
  return {
    async usedBytes(_siteId: string) {
      throw new Error(
        'R2 storage metrics not wired — blocked on wave 0.5 (cloudflare r2 setup)',
      );
    },
  };
}

// keep ALARM_LEVELS re-exported for consumers that want to show the
// threshold legend in the dashboard without importing the lib directly.
export { ALARM_LEVELS };
