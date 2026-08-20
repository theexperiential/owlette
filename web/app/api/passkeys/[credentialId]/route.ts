/**
 * Passkey Management API
 *
 * PATCH  /api/passkeys/:credentialId - Rename passkey
 * DELETE /api/passkeys/:credentialId - Delete passkey
 *
 * REMOVAL IS NEVER REFUSED. A passkey is a second factor, and deleting the last
 * one is an allowed outcome: `applyMfaFactorChange` re-arms `requiresMfaSetup`
 * so the account lands straight back in mandatory setup rather than being held
 * hostage by a credential the user no longer has. That also means DELETE is not
 * behind the enrollment gate the register/* routes carry — the gate exists to
 * stop an unchallenged session from ADDING a factor it can then step up with.
 *
 * The inventory (`users/{uid}.mfaFactors`, `mfaEnrolled`, `requiresMfaSetup`)
 * is updated exclusively through `applyMfaFactorChange` — see
 * `lib/mfaFactors.server.ts`; this route must never write those fields itself.
 */

import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { ApiAuthError, assertActiveUser, requireSessionUser } from '@/lib/apiAuth.server';
import {
  renamePasskey,
  deletePasskey,
} from '@/lib/webauthn.server';
import { apiError } from '@/lib/apiErrorResponse';
import { emitMutation } from '@/lib/auditLogClient';
import { applyMfaFactorChange } from '@/lib/mfaFactors.server';
import {
  revokeAllTrustedDevices,
  DEVICE_TRUST_COOKIE,
  deviceTrustCookieOptions,
} from '@/lib/deviceTrust.server';

function getCredentialIdFromUrl(request: NextRequest): string {
  const url = new URL(request.url);
  const segments = url.pathname.split('/');
  // /api/passkeys/{credentialId} -> last segment
  return decodeURIComponent(segments[segments.length - 1]);
}

// PATCH - Rename passkey
export const PATCH = withRateLimit(async (request: NextRequest) => {
  try {
    const credentialId = getCredentialIdFromUrl(request);
    const body = await request.json();
    const { userId, friendlyName } = body;

    if (!userId || typeof userId !== 'string') {
      return NextResponse.json({ error: 'Invalid user ID' }, { status: 400 });
    }

    if (!friendlyName || typeof friendlyName !== 'string' || friendlyName.length > 50) {
      return NextResponse.json(
        { error: 'Invalid friendly name (max 50 characters)' },
        { status: 400 }
      );
    }

    await requireSessionUser(request, userId);
    await assertActiveUser(userId);

    await renamePasskey(userId, credentialId, friendlyName.trim());

    // Audit. A rename touches no factor inventory, but the audit scanner works
    // at file granularity — an unrecorded PATCH sitting next to an audited
    // DELETE would read as covered when it isn't.
    emitMutation({
      kind: 'user_mutated',
      siteId: '',
      actor: `user:${userId}`,
      targetId: userId,
      attributes: {
        endpoint: '/api/passkeys/[credentialId]',
        method: 'PATCH',
        verb: 'passkey_renamed',
        credentialId,
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof ApiAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return apiError(error, 'passkeys/rename');
  }
}, {
  strategy: 'auth',
  identifier: 'ip',
});

// DELETE - Delete passkey
export const DELETE = withRateLimit(async (request: NextRequest) => {
  try {
    const credentialId = getCredentialIdFromUrl(request);
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get('userId');

    if (!userId) {
      return NextResponse.json({ error: 'Missing userId' }, { status: 400 });
    }

    await requireSessionUser(request, userId);
    await assertActiveUser(userId);

    await deletePasskey(userId, credentialId);

    // Refresh the denormalized factor inventory. `recountPasskeys` — never an
    // explicit count — is the only value that cannot drift: it is read from the
    // subcollection inside the same transaction that writes the tally.
    const factorsAfter = await applyMfaFactorChange(userId, {
      recountPasskeys: true,
    });

    // Last factor gone: mirror /api/mfa/disable and purge every trusted-device
    // record, so a later re-enroll cannot inherit trust granted against the
    // credential that was just removed. The records are already inert while
    // `mfaEnrolled` is false (trust is only consulted when MFA is required), so
    // a revocation failure must never fail the delete — log and carry on.
    let trustedDevicesRevoked = 0;
    const clearedLastFactor = !factorsAfter.mfaEnrolled;
    if (clearedLastFactor) {
      try {
        trustedDevicesRevoked = await revokeAllTrustedDevices(userId);
      } catch (revokeError) {
        console.error(
          '[Passkey Delete] failed to revoke trusted devices',
          revokeError,
        );
      }
    }

    // Audit. Removing a factor is a security-state change on the account, and
    // it is the half of the pair that tells an investigator a credential
    // disappeared. Platform-tenant mutation (siteId = '').
    emitMutation({
      kind: 'user_mutated',
      siteId: '',
      actor: `user:${userId}`,
      targetId: userId,
      attributes: {
        endpoint: '/api/passkeys/[credentialId]',
        method: 'DELETE',
        verb: 'passkey_removed',
        credentialId,
        passkeyCount: factorsAfter.factors.passkeys,
        lastFactorRemoved: clearedLastFactor,
        trustedDevicesRevoked,
      },
    });

    const response = NextResponse.json({ success: true });
    if (clearedLastFactor) {
      // Expire the client copy too — the server-side records are gone.
      response.cookies.set(DEVICE_TRUST_COOKIE, '', {
        ...deviceTrustCookieOptions(),
        maxAge: 0,
      });
    }
    return response;
  } catch (error) {
    if (error instanceof ApiAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return apiError(error, 'passkeys/delete');
  }
}, {
  strategy: 'auth',
  identifier: 'ip',
});
