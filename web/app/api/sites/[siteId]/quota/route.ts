/**
 * GET /api/sites/{siteId}/quota
 *      → Current quota snapshot for a site:
 *        { tier, usedBytes, pendingBytes, limitBytes, fractionUsed,
 *          roostAvailable, lastAlarmLevel, alarms[] }
 *
 * Reads the `sites/{siteId}/roost/quota` doc written by quotaEnforce
 * (functions/src/quotaEnforce.ts), sums its `pending` subcollection, and
 * surfaces recent alarm firings from `sites/{siteId}/quota_alarms`.
 *
 * roost public api wave 3.7; migrated to the two-tier billing model in
 * billing-system wave 0.7.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { timestampToIso } from '@/lib/firestoreTime.server';
import { problemFromError } from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import { getSiteTier, TIER_STORAGE_BYTES } from '@/lib/siteTier';
import {
  applyAuthDeprecations,
  requireSiteAuthAndScope,
} from '../../../_shared';

interface RouteParams {
  params: Promise<{ siteId: string }>;
}

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
    // Same narrowing the dashboard gate and functions' `resolveSiteTier`
    // apply, so all three agree on what an unstamped doc resolves to.
    const tier = getSiteTier({ tier: data.tier as string | undefined });
    const usedBytes = typeof data.usedBytes === 'number' ? data.usedBytes : 0;
    const pendingBytes = pendingSnap.docs.reduce(
      (sum, d) => sum + (typeof (d.data() as { bytes?: number }).bytes === 'number' ? (d.data() as { bytes: number }).bytes : 0),
      0,
    );

    // Prefer the cached planLimitBytes written by quotaEnforce's reconcile
    // (it honors one-off grants), else fall back to the tier's inclusion.
    const limitBytes = typeof data.planLimitBytes === 'number'
      ? data.planLimitBytes
      : TIER_STORAGE_BYTES[tier];
    const committedBytes = Math.max(0, usedBytes + pendingBytes);
    // No ratio to take when the tier carries no storage — mirrors the
    // `planLimitBytes <= 0` short-circuit in quotaLogic.reportQuota, which
    // returns NaN there (not JSON-representable, so `null` over the wire).
    const fractionUsed = limitBytes > 0
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
        // Replaces the old `unlimited` flag: the two-tier model has no
        // uncapped plan, so the question clients actually need answered is
        // whether roost is part of this tier at all.
        roostAvailable: limitBytes > 0,
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

