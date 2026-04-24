/**
 * GET /api/sites/{siteId}
 *      → Site detail: id, name, plan, timezone, owner, createdAt.
 *
 * Read-only in v2. Go through the dashboard for site management.
 *
 * roost public api wave 3.5.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { Timestamp } from 'firebase-admin/firestore';
import {
  problem,
  problemFromError,
  ProblemType,
} from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import {
  applyAuthDeprecations,
  requireSiteAuthAndScope,
} from '../../_shared';

interface RouteParams {
  params: Promise<{ siteId: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { siteId } = await params;
    const auth = await requireSiteAuthAndScope(request, siteId, 'read');
    if (!auth.ok) return auth.response;

    const db = getAdminDb();
    const siteSnap = await db.collection('sites').doc(siteId).get();
    if (!siteSnap.exists) {
      return problem({
        type: ProblemType.NotFound,
        title: 'site not found',
        status: 404,
        detail: `site ${siteId} not found`,
        instance: `/api/sites/${siteId}`,
      });
    }

    const data = siteSnap.data() ?? {};

    return applyAuthDeprecations(
      NextResponse.json({
        id: siteId,
        name: typeof data.name === 'string' ? data.name : siteId,
        plan: typeof data.plan === 'string' ? data.plan : null,
        timezone: typeof data.timezone === 'string' ? data.timezone : null,
        owner: typeof data.owner === 'string' ? data.owner : null,
        createdAt: timestampToIso(data.createdAt),
      }),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'v2/sites/[siteId]:GET');
  }
}

function timestampToIso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Timestamp) return v.toDate().toISOString();
  if (v && typeof v === 'object' && 'toDate' in v && typeof (v as { toDate: () => Date }).toDate === 'function') {
    return (v as { toDate: () => Date }).toDate().toISOString();
  }
  if (typeof v === 'number') return new Date(v).toISOString();
  return null;
}
