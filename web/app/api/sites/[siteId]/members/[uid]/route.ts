/**
 * DELETE /api/sites/{siteId}/members/{uid}
 *
 * Removes siteId from `users/{uid}.sites[]` via `arrayRemove`. Refuses the site
 * owner — ownership transfer is user-DELETE with `?successorUid=<uid>`.
 *
 * Authored talons survive the removal (they are site-owned), but a talon with a
 * hoot output re-resolves its AUTHOR's site access every run, so it starts
 * failing silently. Hence `talonCount` always in the response, and
 * `?talonSuccessorUid=<uid>` to move them BEFORE the membership write.
 * Reassignment is never implicit — silently rewriting authorship on someone
 * else's automations is worse than an orphan the operator was told about.
 *
 * Idempotent: a non-member returns 200 with `wasMember: false`.
 * Auth: `requireSiteAuthAndScope(req, siteId, 'admin')`.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import {
  problem,
  problemFromError,
  problemNotFound,
  problemValidation,
  ProblemType,
} from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import { withIdempotency } from '@/lib/idempotency';
import { emitMutation } from '@/lib/auditLogClient';
import { authorizedSiteHandler, type SiteHandlerContext } from '@/lib/authorizedHandler.server';
import { Capability, hasCapability } from '@/lib/capabilities';
import {
  countTalonsAuthoredBy,
  reassignTalons,
  TalonStoreError,
} from '@/lib/talons/store.server';
import { auditActorIdentifier } from '@/app/api/_shared';
import { talonStoreProblem } from '../../talons/route';
import {
  applyAuthDeprecations,
  readAndParseJsonBody,
  requireSiteAuthAndScope,
} from '../../../../_shared';

// The talon store pulls in `node:crypto` for webhook secret minting.
export const runtime = 'nodejs';

const UID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;

type RouteParams = { siteId: string; uid: string };

export const DELETE = authorizedSiteHandler<RouteParams>({
  capability: 'SITE_MEMBER_MANAGE',
  siteIdParam: 'path',
  targetKind: 'user',
  targetIdParam: 'uid',
})(async (request: NextRequest, ctx: SiteHandlerContext, routeContext) => {
  try {
    const { siteId, uid } = await routeContext.params;
    if (!UID_REGEX.test(uid)) {
      return problemValidation('uid must be 1-128 chars', {
        'path.uid': ['letters, digits, underscore, hyphen only'],
      });
    }

    const talonSuccessorUid = request.nextUrl.searchParams.get('talonSuccessorUid');
    if (talonSuccessorUid !== null && !UID_REGEX.test(talonSuccessorUid)) {
      return problemValidation('talonSuccessorUid is malformed', {
        'query.talonSuccessorUid': ['must match user-id format'],
      });
    }

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
        const db = getAdminDb();

        const [siteSnap, userSnap] = await Promise.all([
          db.collection('sites').doc(siteId).get(),
          db.collection('users').doc(uid).get(),
        ]);

        if (!siteSnap.exists) {
          return problemNotFound(`site ${siteId} not found`);
        }
        if (!userSnap.exists) {
          return problemNotFound(`user ${uid} not found`);
        }

        const siteData = siteSnap.data() ?? {};
        const ownerUid =
          typeof siteData.owner === 'string' ? siteData.owner : null;

        if (ownerUid === uid) {
          return problem({
            type: ProblemType.Conflict,
            title: 'cannot remove site owner',
            status: 409,
            detail:
              'the site owner cannot be removed via this endpoint; transfer ownership first via DELETE /api/users/{uid}?successorUid=<uid>',
            instance: `/api/sites/${siteId}/members/${uid}`,
            code: 'cannot_remove_owner',
          });
        }

        const userData = userSnap.data() ?? {};
        const sites = Array.isArray(userData.sites)
          ? (userData.sites as unknown[]).filter(
              (s): s is string => typeof s === 'string',
            )
          : [];
        const wasMember = sites.includes(siteId);

        // Read before the write so the reported count is the one that was true
        // when the decision was made.
        const talonCount = await countTalonsAuthoredBy(db, siteId, uid);

        // Reassign first; a failure aborts the removal. Better a member still
        // on the site than automations pointing at someone who isn't.
        let reassignedTalonIds: string[] = [];
        if (talonSuccessorUid && talonCount > 0) {
          // The wrapper authorized SITE_MEMBER_MANAGE, not TALON_MANAGE. Same
          // role grants both today, but gate the talon mutation as a talon
          // mutation or a future matrix split silently widens this endpoint.
          if (!hasCapability(ctx.actor, Capability.TALON_MANAGE, siteId)) {
            return problem({
              type: ProblemType.Forbidden,
              title: 'forbidden',
              status: 403,
              detail: 'reassigning talons requires the TALON_MANAGE capability on this site',
              instance: `/api/sites/${siteId}/members/${uid}`,
              code: 'talon_manage_required',
            });
          }

          const result = await reassignTalons(
            db,
            {
              siteId,
              actor: ctx.actor,
              auditActor: auditActorIdentifier(auth.auth),
              via: 'ui',
              endpoint: request.nextUrl.pathname,
              method: 'DELETE',
            },
            talonSuccessorUid,
            { fromUid: uid },
          );
          reassignedTalonIds = result.reassignedTalonIds;
        }

        if (wasMember) {
          await db.collection('users').doc(uid).update({
            sites: FieldValue.arrayRemove(siteId),
          });
        }

        emitMutation({
          kind: 'site_member_mutated',
          siteId,
          actor: auth.auth.keyContext
            ? `apiKey:${auth.auth.keyContext.keyId}`
            : `user:${auth.userId}`,
          targetId: uid,
          attributes: {
            endpoint: `/api/sites/${siteId}/members/${uid}`,
            method: 'DELETE',
            verb: 'member_removed',
            wasMember,
            talonCount,
            reassignedTalonCount: reassignedTalonIds.length,
            talonSuccessorUid: talonSuccessorUid ?? null,
          },
        });

        return applyAuthDeprecations(
          NextResponse.json({
            siteId,
            uid,
            wasMember,
            talonCount,
            reassignedTalonIds,
          }),
          auth.scopeCheck,
        );
      },
    );
  } catch (err) {
    // A rejected successor is a bad request against this endpoint, not a 500.
    if (err instanceof TalonStoreError) {
      return talonStoreProblem(err, request.nextUrl.pathname);
    }
    return problemFromError(err, 'sites/[siteId]/members/[uid]:DELETE');
  }
});
