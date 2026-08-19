/**
 * GET /api/users/{uid}/talons — every talon this user authored, fleet-wide.
 *
 * The soft-delete counterpart to `/api/sites/{siteId}/talons/authored`.
 * `DELETE /api/users/{uid}` already refuses to orphan the SITES a user owns
 * (`?successorUid=`), but says nothing about the automations they wrote — and
 * a talon with a hoot output resolves its author's site access on every run,
 * so soft-deleting the author stops it dead. This is the count the delete
 * confirmation needs in order to name that consequence.
 *
 * One collection-group query rather than a walk of `users/{uid}.sites[]`: a
 * superadmin's membership array can be empty while they author talons across
 * the fleet, which would under-report exactly the accounts whose departure
 * costs the most.
 *
 * Auth: same as the rest of `/api/users/*` reads — superadmin session, or an
 * api key with `user=*:read`.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { problemFromError, problemValidation } from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import { listTalonsAuthoredByAcrossSites } from '@/lib/talons/store.server';
import { applyAuthDeprecations, requirePlatformAuthAndScope } from '../../../_shared';

export const runtime = 'nodejs';

const UID_RE = /^[A-Za-z0-9_-]{1,128}$/;

type RouteParams = { uid: string };

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<RouteParams> },
) {
  try {
    const { uid } = await params;
    if (!UID_RE.test(uid)) {
      return problemValidation('uid must be 1-128 chars', {
        'path.uid': ['letters, digits, underscore, hyphen only'],
      });
    }

    const auth = await requirePlatformAuthAndScope(request, 'user', 'read');
    if (!auth.ok) return auth.response;

    const talons = await listTalonsAuthoredByAcrossSites(getAdminDb(), uid);

    // Per-site tally so the confirmation can say "3 on the lobby, 1 on the
    // atrium" instead of one undifferentiated number.
    const countBySite = new Map<string, number>();
    for (const talon of talons) {
      countBySite.set(talon.siteId, (countBySite.get(talon.siteId) ?? 0) + 1);
    }

    return applyAuthDeprecations(
      NextResponse.json({
        uid,
        count: talons.length,
        sites: [...countBySite.entries()].map(([siteId, count]) => ({ siteId, count })),
        talons,
      }),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'users/[uid]/talons:GET');
  }
}
