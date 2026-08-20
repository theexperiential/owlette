/**
 * PATCH  /api/passkeys/:credentialId — rename
 * DELETE /api/passkeys/:credentialId — delete
 *
 * REMOVAL IS NEVER REFUSED. Deleting the last factor is an allowed outcome:
 * `applyMfaFactorChange` re-arms `requiresMfaSetup` so the account lands back in
 * mandatory setup rather than being held hostage by a lost credential. DELETE is
 * therefore not behind the register/* enrollment gate, which exists to stop an
 * unchallenged session ADDING a factor it can then step up with.
 *
 * The inventory (`mfaFactors`, `mfaEnrolled`, `requiresMfaSetup`) is written
 * exclusively through `applyMfaFactorChange` — never by this route.
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
  return decodeURIComponent(segments[segments.length - 1]);
}

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

    // Audit even though a rename touches no factor inventory: the audit scanner
    // works at file granularity, so an unrecorded PATCH beside an audited DELETE
    // would read as covered when it isn't.
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

    // `recountPasskeys` — never an explicit count — is the only value that can't
    // drift: it's read from the subcollection inside the tally's own transaction.
    const factorsAfter = await applyMfaFactorChange(userId, {
      recountPasskeys: true,
    });

    // Last factor gone: mirror /api/mfa/disable and purge trusted-device records
    // so a later re-enroll can't inherit trust from the removed credential. They
    // are already inert while `mfaEnrolled` is false, so a revocation failure must
    // never fail the delete.
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

    // Removing a factor is a security-state change, and this is the half of the
    // pair that tells an investigator a credential disappeared. Platform tenant.
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
