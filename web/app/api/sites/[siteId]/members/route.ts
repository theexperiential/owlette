/**
 * GET  /api/sites/{siteId}/members — membership lives only on `users/{uid}.sites[]`
 *      (dev/active/api-sprint/reference/membership-decision.md), so we query
 *      `users where sites array-contains {siteId}` and additionally surface the
 *      site `owner`, who is always an effective member.
 *
 * POST /api/sites/{siteId}/members  `{uid, role}` — adds siteId to
 *      `users/{uid}.sites[]` via arrayUnion after validating the user exists.
 *      Per-site role is derived from global role + ownership at read time, so
 *      add-with-role is just sugar for that membership write. Idempotency-Key
 *      required.
 *
 * Auth (both verbs): `requireSiteAuthAndScope(req, siteId, 'admin')` — an api key
 * with `site=<siteId>:admin`, or a session/id-token whose caller is a site admin
 * (superadmin OR admin-with-access, matching the dashboard's `isSiteAdmin`).
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
import { authorizedSiteHandler } from '@/lib/authorizedHandler.server';
import {
  applyAuthDeprecations,
  readAndParseJsonBody,
  requireSiteAuthAndScope,
} from '../../../_shared';

const UID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;
const VALID_ADD_ROLES = new Set(['member', 'admin']);

type RouteParams = { siteId: string };

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
 * Per-site role: 'owner' when they own the site, else 'superadmin', else 'admin'
 * for a global admin, else 'member'. Owner is orthogonal to the global hierarchy
 * so callers can identify a site's owner without a second read.
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

export const GET = authorizedSiteHandler<RouteParams>({
  capability: 'SITE_MEMBER_MANAGE',
  siteIdParam: 'path',
  apiKeyPermission: 'read',
})(async (request: NextRequest, _ctx, routeContext) => {
  try {
    const { siteId } = await routeContext.params;
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
});

export const POST = authorizedSiteHandler<RouteParams>({
  capability: 'SITE_MEMBER_MANAGE',
  siteIdParam: 'path',
  targetKind: 'user',
})(async (request: NextRequest, _ctx, routeContext) => {
  try {
    const { siteId } = await routeContext.params;
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

        // Per-site role is derived from global role at read time, and membership is
        // the only explicit write, so an `admin` request is honored only when the
        // target is already admin/superadmin. Promoting member→admin is the explicit
        // /promote endpoint, never a side-effect of adding someone to a site.
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
});
