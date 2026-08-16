/**
 * DELETE /api/sites/{siteId}/members/{uid}
 *
 * Remove a user from a site by removing siteId from `users/{uid}.sites[]`
 * via `arrayRemove`. Refuses to remove the site owner — the user-DELETE
 * flow with `?successorUid=<uid>` is the path for ownership transfer.
 *
 * Talons the departing member authored: the removal touches nothing under
 * `sites/{siteId}`, so their talons survive it — but a talon with a hoot
 * output re-resolves its AUTHOR's site access on every run, so it starts
 * failing silently the moment they lose access. Two affordances, neither of
 * which changes the existing contract:
 *
 *   - `talonCount` is always in the response, so a client that removes a
 *     member blind still learns what it just broke;
 *   - `?talonSuccessorUid=<uid>` moves those talons to a successor *before*
 *     the membership write, so the automation never has a moment where its
 *     author has no access.
 *
 * Reassignment deliberately does not happen implicitly: silently rewriting
 * authorship on someone else's automations is worse than an orphan an
 * operator was told about.
 *
 * True-idempotent: removing a user who isn't a member returns 200 with
 * `wasMember: false` (the arrayRemove is a no-op).
 *
 * Auth: `requireSiteAuthAndScope(req, siteId, 'admin')`.
 *
 * api-sprint wave 3 track 3B (users-api / site-members).
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

        // Read before the write: once `sites[]` no longer carries this site the
        // count is still correct (talons are site-owned), but reading first
        // keeps the number the caller is told about the one that was true when
        // the decision was made.
        const talonCount = await countTalonsAuthoredBy(db, siteId, uid);

        // Reassign first. A failure here aborts the removal — better a member
        // who is still on the site than automations pointing at someone who
        // isn't.
        let reassignedTalonIds: string[] = [];
        if (talonSuccessorUid && talonCount > 0) {
          // The wrapper authorized SITE_MEMBER_MANAGE, not TALON_MANAGE. Today
          // the same role grants both, but rewriting talon authorship is a
          // talon mutation and must be gated as one — otherwise a future
          // matrix split would let member-management quietly become talon
          // management.
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
    // A rejected successor (deleted, not a member, under-privileged) has to
    // read as a bad request against this endpoint, not a 500.
    if (err instanceof TalonStoreError) {
      return talonStoreProblem(err, request.nextUrl.pathname);
    }
    return problemFromError(err, 'sites/[siteId]/members/[uid]:DELETE');
  }
});
