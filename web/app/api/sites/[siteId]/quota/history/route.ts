/**
 * GET /api/sites/{siteId}/quota/history?period=30d
 *      → Daily usage rollup derived from `sites/{siteId}/usage_events`.
 *        Each day bucket includes: date (YYYY-MM-DD UTC),
 *        storageBytesAvg (avg of storage_snapshot events that day),
 *        classAOps, classBOps, egressBytes.
 *
 * `period` accepts `7d`, `14d`, `30d`, `60d`, `90d`. Default: 30d.
 *
 * roost public api wave 3.7.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { Timestamp } from 'firebase-admin/firestore';
import { timestampToMs } from '@/lib/firestoreTime.server';
import {
  problemFromError,
  problemValidation,
} from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import {
  applyAuthDeprecations,
  requireSiteAuthAndScope,
} from '../../../../_shared';

interface RouteParams {
  params: Promise<{ siteId: string }>;
}

const VALID_PERIODS: Record<string, number> = {
  '7d': 7,
  '14d': 14,
  '30d': 30,
  '60d': 60,
  '90d': 90,
};

interface DailyBucket {
  date: string;
  storageBytesAvg: number | null;
  storageSnapshotSamples: number;
  storageBytesTotal: number;
  classAOps: number;
  classBOps: number;
  egressBytes: number;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { siteId } = await params;

    const periodParam = request.nextUrl.searchParams.get('period') ?? '30d';
    const days = VALID_PERIODS[periodParam];
    if (!days) {
      return problemValidation(
        `period must be one of ${Object.keys(VALID_PERIODS).join(', ')}`,
        { 'query.period': [`unsupported period '${periodParam}'`] },
      );
    }

    const auth = await requireSiteAuthAndScope(request, siteId, 'read');
    if (!auth.ok) return auth.response;

    const db = getAdminDb();
    const now = Date.now();
    // Start of the UTC day (days - 1) ago — inclusive span of `days` buckets.
    const today = new Date(now);
    const startUtcDay = Date.UTC(
      today.getUTCFullYear(),
      today.getUTCMonth(),
      today.getUTCDate() - (days - 1),
    );

    const eventsSnap = await db
      .collection('sites')
      .doc(siteId)
      .collection('usage_events')
      .where('timestamp', '>=', Timestamp.fromMillis(startUtcDay))
      .where('timestamp', '<', Timestamp.fromMillis(now))
      .get();

    // Pre-seed the bucket map so days with no events still appear as zeros.
    const buckets = new Map<string, DailyBucket>();
    for (let i = 0; i < days; i++) {
      const d = new Date(startUtcDay + i * 24 * 60 * 60 * 1000);
      const date = d.toISOString().slice(0, 10);
      buckets.set(date, {
        date,
        storageBytesAvg: null,
        storageSnapshotSamples: 0,
        storageBytesTotal: 0,
        classAOps: 0,
        classBOps: 0,
        egressBytes: 0,
      });
    }

    for (const eventDoc of eventsSnap.docs) {
      const evt = eventDoc.data() as {
        kind?: string;
        bytes?: number;
        count?: number;
        timestamp?: unknown;
      };
      const ts = timestampToMs(evt.timestamp);
      if (!ts) continue;
      const date = new Date(ts).toISOString().slice(0, 10);
      const bucket = buckets.get(date);
      if (!bucket) continue;

      const bytes = typeof evt.bytes === 'number' ? Math.max(0, evt.bytes) : 0;
      const count = typeof evt.count === 'number' ? Math.max(0, evt.count) : 1;

      switch (evt.kind) {
        case 'storage_snapshot':
          bucket.storageBytesTotal += bytes;
          bucket.storageSnapshotSamples += 1;
          break;
        case 'class_a_op':
          bucket.classAOps += count;
          break;
        case 'class_b_op':
          bucket.classBOps += count;
          break;
        case 'egress':
          bucket.egressBytes += bytes;
          break;
      }
    }

    const daily = Array.from(buckets.values()).map((b) => ({
      date: b.date,
      storageBytesAvg:
        b.storageSnapshotSamples > 0
          ? Math.round(b.storageBytesTotal / b.storageSnapshotSamples)
          : null,
      classAOps: b.classAOps,
      classBOps: b.classBOps,
      egressBytes: b.egressBytes,
    }));

    return applyAuthDeprecations(
      NextResponse.json({
        siteId,
        period: periodParam,
        days,
        daily,
      }),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'v2/sites/[siteId]/quota/history:GET');
  }
}
