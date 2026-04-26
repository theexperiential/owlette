/**
 * GET  /api/sites/{siteId}/members
 *      → List members of a site. Membership lives only on
 *        `users/{uid}.sites[]` per
 *        [`dev/active/api-sprint/reference/membership-decision.md`](../../../../../../dev/active/api-sprint/reference/membership-decision.md);
 *        we resolve it by querying `users where sites array-contains {siteId}`,
 *        plus surfacing the site `owner` even if they're not in that array
 *        (an owner is always an effective member).
 *
 * POST /api/sites/{siteId}/members  body `{uid, role}`
 *      → Add a member. Validates the user exists. If `role === 'admin'`,
 *        also adds siteId to `users/{uid}.sites[]` via `arrayUnion`. The
 *        per-site role is derived from global role + ownership at read
 *        time, so add-with-role is just sugar for the membership write.
 *
 * Auth (both verbs): `requireSiteAuthAndScope(req, siteId, 'admin')`.
 *   - api key with `site=<siteId>:admin` scope
 *   - session / id-token where the caller is a site admin (per the
 *     dashboard's `isSiteAdmin` rule: superadmin OR admin-with-access)
 *
 * Idempotency: POST requires it.
 *
 * api-sprint wave 3 track 3B (users-api / site-members).
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import {
  problemFromError,
  problemNotFound,
  problemValidation,
} from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import { withIdempotency } from '@/lib/idempotency';
import { emitMutation } from '@/lib/auditLogClient';
import {
  applyAuthDeprecations,
  readAndParseJsonBody,
  requireSiteAuthAndScope,
} from '../../../_shared';

const UID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;
const VALID_ADD_ROLES = new Set(['member', 'admin']);

interface RouteParams {
  params: Promise<{ siteId: string }>;
}

interface AddMemberBody {
  uid?: unknown;
  role?: unknown;
}

interface UserDoc {
  email?: string;
  role?: string;
  sites?: string[];
  displayName?: string;
  deletedAt?: number;
}

/**
 * Per-site role derivation. The api-sprint plan defines the per-site role
 * as: 'owner' if the user owns the site, else 'superadmin' if they're a
 * platform superadmin, else 'admin' if their global role is 'admin' AND
 * the siteId is in their `sites[]`, else 'member'.
 *
 * Owner-status is orthogonal to the standard global-role hierarchy — an
 * owner is always returned with role 'owner' so callers can identify the
 * site's owner without a separate read.
 */
function derivePerSiteRole(
  user: { uid: string; role: string },
  siteOwnerUid: string | null,
): 'owner' | 'superadmin' | 'admin' | 'member' {
  if (siteOwnerUid && user.uid === siteOwnerUid) return 'owner';
  if (user.role === 'superadmin') return 'superadmin';
  if (user.role === 'admin') return 'admin';
  return 'member';
}

/* --------------------------------------------------------------------- */
/*  GET — list members                                                   */
/* --------------------------------------------------------------------- */

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { siteId } = await params;
    const auth = await requireSiteAuthAndScope(request, siteId, 'admin');
    if (!auth.ok) return auth.response;

    const db = getAdminDb();

    const [siteSnap, membersSnap] = await Promise.all([
      db.collection('sites').doc(siteId).get(),
      db
        .collection('users')
        .where('sites', 'array-contains', siteId)
        .get(),
    ]);

    if (!siteSnap.exists) {
      return problemNotFound(`site ${siteId} not found`);
    }
    const siteData = siteSnap.data() ?? {};
    const ownerUid =
      typeof siteData.owner === 'string' ? siteData.owner : null;

    const seen = new Set<string>();
    const members: Array<{
      uid: string;
      email: string | null;
      role: 'owner' | 'superadmin' | 'admin' | 'member';
      globalRole: string;
      sites: string[];
      displayName: string | null;
    }> = [];

    for (const doc of membersSnap.docs) {
      const data = doc.data() as UserDoc;
      if (typeof data.deletedAt === 'number') continue;
      const globalRole =
        typeof data.role === 'string' ? data.role : 'member';
      const sites = Array.isArray(data.sites)
        ? data.sites.filter((s): s is string => typeof s === 'string')
        : [];
      members.push({
        uid: doc.id,
        email: typeof data.email === 'string' ? data.email : null,
        role: derivePerSiteRole({ uid: doc.id, role: globalRole }, ownerUid),
        globalRole,
        sites,
        displayName:
          typeof data.displayName === 'string' ? data.displayName : null,
      });
      seen.add(doc.id);
    }

    // Surface the site owner if they aren't already in the membership query
    // (e.g. a superadmin who owns a site without being explicitly assigned).
    if (ownerUid && !seen.has(ownerUid)) {
      const ownerSnap = await db.collection('users').doc(ownerUid).get();
      if (ownerSnap.exists) {
        const data = ownerSnap.data() as UserDoc;
        if (typeof data.deletedAt !== 'number') {
          const globalRole =
            typeof data.role === 'string' ? data.role : 'member';
          members.push({
            uid: ownerUid,
            email: typeof data.email === 'string' ? data.email : null,
            role: 'owner',
            globalRole,
            sites: Array.isArray(data.sites)
              ? data.sites.filter((s): s is string => typeof s === 'string')
              : [],
            displayName:
              typeof data.displayName === 'string' ? data.displayName : null,
          });
        }
      }
    }

    return applyAuthDeprecations(
      NextResponse.json({ members }),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/members:GET');
  }
}

/* --------------------------------------------------------------------- */
/*  POST — add member                                                    */
/* --------------------------------------------------------------------- */

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { siteId } = await params;
    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;

    const auth = await requireSiteAuthAndScope(request, siteId, 'admin');
    if (!auth.ok) return auth.response;

    return await withIdempotency(
      request,
      {
        userId: auth.userId,
        environment: auth.auth.keyContext?.environment ?? 'unknown',
      },
      parsed.raw,
      async () => {
        const body = parsed.body as AddMemberBody;
        const targetUid = body.uid;
        if (typeof targetUid !== 'string' || !UID_REGEX.test(targetUid)) {
          return problemValidation('uid is required and must be valid', {
            'body.uid': ['must be 1-128 chars: letters, digits, underscore, hyphen'],
          });
        }
        const requestedRole = body.role;
        if (
          typeof requestedRole !== 'string' ||
          !VALID_ADD_ROLES.has(requestedRole)
        ) {
          return problemValidation(
            'role is required and must be admin or member',
            { 'body.role': ['must be one of: admin, member'] },
          );
        }

        const db = getAdminDb();
        const userRef = db.collection('users').doc(targetUid);
        const userSnap = await userRef.get();
        if (!userSnap.exists) {
          return problemNotFound(`user ${targetUid} not found`);
        }
        const userData = userSnap.data() ?? {};
        if (typeof userData.deletedAt === 'number') {
          return problemValidation(
            'cannot add a soft-deleted user as a member',
            { 'body.uid': ['user is soft-deleted'] },
          );
        }

        // Add siteId to user.sites[] (idempotent via arrayUnion).
        await userRef.update({
          sites: FieldValue.arrayUnion(siteId),
        });

        // The per-site role is derived from global role at read time.
        // The dashboard model treats `role: 'admin'` as the only way to
        // produce a per-site `'admin'` view; since site membership is the
        // only explicit write, an `admin` add-request is satisfied as
        // long as the target's global role is already admin or
        // superadmin. If the target is a `member`, we keep their global
        // role unchanged — promoting member→admin is the explicit
        // `/promote` endpoint, not an implicit side-effect of adding to
        // a site.
        const targetGlobalRole =
          typeof userData.role === 'string' ? userData.role : 'member';
        const roleHonored =
          requestedRole === 'admin'
            ? targetGlobalRole === 'admin' || targetGlobalRole === 'superadmin'
            : true;

        emitMutation({
          kind: 'site_member_mutated',
          siteId,
          actor: auth.auth.keyContext
            ? `apiKey:${auth.auth.keyContext.keyId}`
            : `user:${auth.userId}`,
          targetId: targetUid,
          attributes: {
            endpoint: `/api/sites/${siteId}/members`,
            method: 'POST',
            verb: 'member_added',
            requestedRole,
            roleHonored,
            globalRole: targetGlobalRole,
          },
        });

        return applyAuthDeprecations(
          NextResponse.json({
            uid: targetUid,
            siteId,
            requestedRole,
            roleHonored,
            globalRole: targetGlobalRole,
          }),
          auth.scopeCheck,
        );
      },
    );
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/members:POST');
  }
}
