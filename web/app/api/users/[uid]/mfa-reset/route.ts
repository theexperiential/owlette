/**
 * POST /api/users/{uid}/mfa-reset
 *
 * Superadmin-operated account recovery: strip every second factor off ANOTHER
 * user's account and put them straight back into mandatory 2FA setup.
 *
 * WHY THIS EXISTS. A user who loses their last factor and their backup codes
 * is in a closed loop: they cannot sign in, so they cannot reach /verify-2fa,
 * so they cannot reach the remove-factor UI, so they cannot recover.
 * `/api/mfa/disable` is deliberately not a way out — read its header: it acts
 * on the CALLER'S OWN account and demands live proof of possession, which is
 * precisely what this user has lost. Before this route the only fix was
 * hand-editing Firestore.
 *
 * WHAT IT DOES, IN THIS ORDER:
 *   1. delete every credential under `users/{uid}/passkeys`
 *   2. recompute the factor inventory through `applyMfaFactorChange` with
 *      `recountPasskeys`, clearing the TOTP leg and its secret / backup codes
 *      in the SAME write
 *   3. revoke every trusted-device record (a reset that leaves a 30-day trust
 *      cookie alive is not a reset)
 *   4. emit a mutation audit row naming the acting superadmin and the target
 *
 * ORDERING IS DELIBERATE — credentials first, inventory second. A crash
 * between the two leaves credentials deleted while the user doc still claims
 * factors, i.e. the account stays locked out: exactly the state it was already
 * in, no regression, and a retry of this same route finishes the job. The
 * reverse order would be far worse: the account would report zero factors and
 * be signable-into while live WebAuthn credentials still sat in the
 * subcollection, so an operator resetting a STOLEN device would believe they
 * had revoked it when they had not. Step 2 uses `recountPasskeys` rather than
 * an explicit zero for the same reason — the tally is read from the
 * subcollection inside the transaction that writes it, so if a credential
 * delete silently failed the inventory tells the truth instead of a convenient
 * lie.
 *
 * Steps 3 and 4 are best-effort tails: trusted-device records are inert once
 * the account holds no factors (trust is only consulted when MFA is required),
 * so a revocation failure must not fail a reset that has already landed. The
 * count is reported in the response and the audit row either way.
 *
 * The inventory (`users/{uid}.mfaFactors` and the two flags derived from it)
 * is written exclusively through `lib/mfaFactors.server.ts` — this route must
 * never write those fields itself.
 *
 * Response (200):
 *   {
 *     "uid": "...",
 *     "clearedTotp": boolean,       // target held TOTP before the reset
 *     "deletedPasskeys": number,
 *     "trustedDevicesRevoked": number,
 *     "enrolled": false,            // factor inventory after the reset
 *     "setupRequired": true
 *   }
 *
 * Failure modes: 400 malformed uid or soft-deleted target, 403 non-superadmin
 * or self-reset, 404 unknown user, plus the standard auth / scope / rate-limit
 * problems the platform wrapper emits.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import {
  problemForbidden,
  problemFromError,
  problemNotFound,
  problemValidation,
} from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import {
  authorizedPlatformHandler,
  type PlatformHandlerContext,
} from '@/lib/authorizedHandler.server';
import { Capability } from '@/lib/capabilities';
import { applyAuthDeprecations } from '../../../_shared';
import { applyMfaFactorChange, readMfaFactors } from '@/lib/mfaFactors.server';
import { revokeAllTrustedDevices } from '@/lib/deviceTrust.server';
import { emitMutation } from '@/lib/auditLogClient';

const UID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Max delete ops per Firestore batch. Firestore caps a batch at 500 writes;
 * 100 matches the repo-wide cascade convention (`deviceTrust.server.ts`,
 * `deleteOwnAccount.server.ts`).
 */
const DELETE_BATCH_SIZE = 100;

type RouteParams = { uid: string };

function auditActor(ctx: PlatformHandlerContext): string {
  return ctx.auth.keyContext
    ? `apiKey:${ctx.auth.keyContext.keyId}`
    : `user:${ctx.actor.userId}`;
}

/**
 * Delete every WebAuthn credential under the target's `passkeys`
 * subcollection, chunked into batches. Returns how many documents were
 * removed. Errors PROPAGATE: a half-revoked credential set must abort the
 * reset before the inventory is rewritten (see the ordering note in the
 * header) rather than be swallowed.
 */
async function deleteAllPasskeys(
  db: FirebaseFirestore.Firestore,
  uid: string,
): Promise<number> {
  const snap = await db
    .collection('users')
    .doc(uid)
    .collection('passkeys')
    .get();
  if (snap.empty) return 0;

  const refs = snap.docs.map((doc) => doc.ref);
  for (let i = 0; i < refs.length; i += DELETE_BATCH_SIZE) {
    const batch = db.batch();
    for (const ref of refs.slice(i, i + DELETE_BATCH_SIZE)) {
      batch.delete(ref);
    }
    await batch.commit();
  }
  return refs.length;
}

export const POST = authorizedPlatformHandler<RouteParams>({
  // The same capability gate the sibling role routes use — superadmin-only —
  // and deliberately NOT `USER_DELETE`: that capability is what
  // `GET /api/users/deletions` queries on, so borrowing it would file every
  // factor reset in the account-deletions feed as though the user had been
  // removed.
  capability: Capability.USER_ROLE_MANAGE,
  targetKind: 'user',
  // Record the reset uid as the audit target so the wrapper's row names the
  // account whose security state changed, not the platform sentinel.
  targetIdParam: 'uid',
  // `admin` rather than the `write` its promote / demote siblings ask for: an
  // api key that can strip anyone's second factor is materially more dangerous
  // than one that can change a role, and the strong scope is one that
  // superadmin-grade keys already hold.
  apiKeyScope: { resource: 'user', permission: 'admin' },
})(async (_request: NextRequest, ctx: PlatformHandlerContext, routeContext) => {
  try {
    const { uid } = await routeContext!.params;
    if (!UID_REGEX.test(uid)) {
      return problemValidation('uid must be 1-128 chars', {
        'path.uid': ['letters, digits, underscore, hyphen only'],
      });
    }

    // Self-reset is refused. A superadmin who has genuinely lost their own
    // factors cannot sign in and so cannot reach this route at all; the only
    // caller who CAN reach it for themselves is one already holding a live
    // session, and for them the supported path is `/api/mfa/disable`, which
    // demands live proof of possession. Allowing self-service here would turn
    // a hijacked-but-authenticated superadmin session into a way to shed 2FA
    // without ever proving possession — the exact invariant the enrollment
    // gate and the disable route exist to hold. A locked-out superadmin is
    // recovered by another superadmin, which is why `MIN_SUPERADMINS` keeps
    // more than one of them on the platform.
    if (uid === ctx.actor.userId) {
      return problemForbidden(
        'cannot reset your own second factors here; use account settings, or ask another superadmin',
      );
    }

    const db = getAdminDb();
    const userRef = db.collection('users').doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      return problemNotFound(`user ${uid} not found`);
    }
    const userData = userSnap.data() ?? {};

    // A soft-deleted account must not be touched: the delete cascade
    // deliberately leaves the mandatory-setup nag off for deleted users (see
    // the documented exception in `lib/userDeleteCascade.server.ts`), and
    // routing one through the inventory module would re-arm it.
    if (typeof userData.deletedAt === 'number') {
      return problemValidation(
        'cannot reset factors on a soft-deleted user; restore the account first',
        { 'path.uid': ['user is soft-deleted'] },
      );
    }

    // Read the inventory before we change it, purely so the audit row and the
    // response can say what was actually taken away. No-op-safe: a user who
    // already holds nothing runs the identical path and reports zeroes.
    const before = await readMfaFactors(uid, { db });

    // (1) Credentials first — see the ordering note in the header.
    const deletedPasskeys = await deleteAllPasskeys(db, uid);

    // (2) One write for the whole inventory. `recountPasskeys` reads the
    // subcollection inside the transaction that writes the tally, so the
    // stored count can never disagree with the credentials that survive. The
    // module owns the two derived flags and re-arms mandatory setup on a drop
    // to zero factors, which is exactly the outcome this route wants: the
    // target is put back into setup, not left open.
    const after = await applyMfaFactorChange(
      uid,
      { totp: false, recountPasskeys: true },
      {
        db,
        extraUpdate: {
          mfaSecret: FieldValue.delete(),
          backupCodes: [],
          mfaEnrolledAt: FieldValue.delete(),
          // Legacy flag maintained alongside the passkeys subcollection by
          // `deletePasskey`; left stale it would make the account still look
          // like it held a credential.
          passkeyEnrolled: false,
          mfaResetAt: FieldValue.serverTimestamp(),
          mfaResetBy: ctx.actor.userId,
        },
      },
    );

    // (3) Trusted devices. Best-effort tail: the records are inert now that
    // the account holds no factors, so a failure here must not fail a reset
    // that has already landed — it is reported instead.
    let trustedDevicesRevoked = 0;
    try {
      trustedDevicesRevoked = await revokeAllTrustedDevices(uid);
    } catch (revokeError) {
      console.error('[MFA Reset] failed to revoke trusted devices', revokeError);
    }

    // (4) Audit. The wrapper already wrote a capability row; this is the loud
    // one that names both parties and what was destroyed, so an investigator
    // reading the mutation feed sees "superadmin X stripped 2FA off user Y"
    // without joining two logs. Platform-tenant mutation (siteId = '').
    emitMutation({
      kind: 'user_mutated',
      siteId: '',
      actor: auditActor(ctx),
      targetId: uid,
      attributes: {
        endpoint: '/api/users/[uid]/mfa-reset',
        method: 'POST',
        verb: 'mfa_force_reset',
        actorUid: ctx.actor.userId,
        targetUid: uid,
        targetEmail: typeof userData.email === 'string' ? userData.email : null,
        clearedTotp: before.totp,
        deletedPasskeys,
        trustedDevicesRevoked,
        stillEnrolled: after.mfaEnrolled,
        setupReArmed: after.requiresMfaSetup,
      },
    });

    return applyAuthDeprecations(
      NextResponse.json({
        uid,
        clearedTotp: before.totp,
        deletedPasskeys,
        trustedDevicesRevoked,
        enrolled: after.mfaEnrolled,
        setupRequired: after.requiresMfaSetup,
      }),
      ctx.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'users/[uid]/mfa-reset:POST');
  }
});
