/**
 * GET /api/sites/{siteId}/quota
 *      → Current quota snapshot for a site:
 *        { usedBytes, pendingBytes, limitBytes, fractionUsed,
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
import { timestampToIso } from '@/lib/firestoreTime.server';
import { problemFromError } from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import { SITE_STORAGE_BYTES } from '@/lib/roostStorage';
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
    const usedBytes = typeof data.usedBytes === 'number' ? data.usedBytes : 0;
    const pendingBytes = pendingSnap.docs.reduce(
      (sum, d) => sum + (typeof (d.data() as { bytes?: number }).bytes === 'number' ? (d.data() as { bytes: number }).bytes : 0),
      0,
    );

    // Prefer the cached planLimitBytes written by quotaEnforce's reconcile
    // (it honors one-off grants), else fall back to the standard allowance.
    const limitBytes = typeof data.planLimitBytes === 'number'
      ? data.planLimitBytes
      : SITE_STORAGE_BYTES;
    const committedBytes = Math.max(0, usedBytes + pendingBytes);
    // No ratio to take when a site's cap is zero — mirrors the
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
        usedBytes,
        pendingBytes,
        committedBytes,
        limitBytes,
        fractionUsed,
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

