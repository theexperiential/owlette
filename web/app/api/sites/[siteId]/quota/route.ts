/**
 * GET /api/sites/{siteId}/quota
 *      → Current quota snapshot for a site:
 *        { tier, usedBytes, pendingBytes, limitBytes, fractionUsed,
 *          lastAlarmLevel, alarms[] }
 *
 * Reads the `sites/{siteId}/roost/quota` doc written by quotaEnforce
 * (functions/src/quotaEnforce.ts), sums its `pending` subcollection, and
 * surfaces recent alarm firings from `sites/{siteId}/quota_alarms`.
 *
 * roost public api wave 3.7.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { Timestamp } from 'firebase-admin/firestore';
import { problemFromError } from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import {
  applyAuthDeprecations,
  requireSiteAuthAndScope,
} from '../../../_shared';

interface RouteParams {
  params: Promise<{ siteId: string }>;
}

/** Mirror of quotaLogic.PLAN_LIMITS_BYTES — web imports can't reach functions/. */
const PLAN_LIMITS_BYTES: Record<string, number | null> = {
  free: 5 * 1024 ** 3,
  starter: 25 * 1024 ** 3,
  pro: 100 * 1024 ** 3,
  enterprise: null, // byo-bucket; no owlette-side cap
};

const MAX_ALARMS_RETURNED = 20;

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { siteId } = await params;
    const auth = await requireSiteAuthAndScope(request, siteId, 'read');
    if (!auth.ok) return auth.response;

    const db = getAdminDb();
    const siteRef = db.collection('sites').doc(siteId);
    const quotaRef = siteRef.collection('roost').doc('quota');

    const [quotaSnap, pendingSnap, alarmsSnap] = await Promise.all([
      quotaRef.get(),
      quotaRef.collection('pending').get(),
      siteRef
        .collection('quota_alarms')
        .orderBy('firedAt', 'desc')
        .limit(MAX_ALARMS_RETURNED)
        .get(),
    ]);

    const data = quotaSnap.exists ? quotaSnap.data() ?? {} : {};
    const tier = typeof data.tier === 'string' ? data.tier : 'free';
    const usedBytes = typeof data.usedBytes === 'number' ? data.usedBytes : 0;
    const pendingBytes = pendingSnap.docs.reduce(
      (sum, d) => sum + (typeof (d.data() as { bytes?: number }).bytes === 'number' ? (d.data() as { bytes: number }).bytes : 0),
      0,
    );

    const limitFromPlan = PLAN_LIMITS_BYTES[tier];
    // Prefer the cached planLimitBytes on the doc if set (honors one-off
    // grants), else fall back to tier default.
    const rawLimit = typeof data.planLimitBytes === 'number' ? data.planLimitBytes : limitFromPlan;
    const limitBytes = rawLimit === null || rawLimit === undefined ? null : rawLimit;
    const committedBytes = Math.max(0, usedBytes + pendingBytes);
    const fractionUsed = limitBytes && limitBytes > 0
      ? Math.min(1, committedBytes / limitBytes)
      : null;

    const alarms = alarmsSnap.docs.map((d) => {
      const a = d.data();
      return {
        id: d.id,
        threshold: typeof a.threshold === 'number' ? a.threshold : null,
        firedAt: timestampToIso(a.firedAt),
      };
    });

    return applyAuthDeprecations(
      NextResponse.json({
        siteId,
        tier,
        usedBytes,
        pendingBytes,
        committedBytes,
        limitBytes,
        fractionUsed,
        unlimited: limitBytes === null,
        lastAlarmLevel: typeof data.lastAlarmLevel === 'number' ? data.lastAlarmLevel : 0,
        lastAlarmAt: timestampToIso(data.lastAlarmAt),
        lastReconciledAt: timestampToIso(data.lastReconciledAt),
        alarms,
      }),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'v2/sites/[siteId]/quota:GET');
  }
}

function timestampToIso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Timestamp) return v.toDate().toISOString();
  if (typeof v === 'number') return new Date(v).toISOString();
  if (typeof v === 'string') {
    const parsed = Date.parse(v);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }
  if (v && typeof v === 'object' && 'toDate' in v && typeof (v as { toDate: () => Date }).toDate === 'function') {
    return (v as { toDate: () => Date }).toDate().toISOString();
  }
  return null;
}
