/**
 * Passkey Management API
 *
 * PATCH  /api/passkeys/:credentialId - Rename passkey
 * DELETE /api/passkeys/:credentialId - Delete passkey
 */

import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { ApiAuthError, requireSessionUser } from '@/lib/apiAuth.server';
import {
  renamePasskey,
  deletePasskey,
} from '@/lib/webauthn.server';

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

    await renamePasskey(userId, credentialId, friendlyName.trim());

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof ApiAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[Passkey Rename] Error:', error);
    return NextResponse.json(
      { error: 'Failed to rename passkey' },
      { status: 500 }
    );
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

    await deletePasskey(userId, credentialId);

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof ApiAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[Passkey Delete] Error:', error);
    return NextResponse.json(
      { error: 'Failed to delete passkey' },
      { status: 500 }
    );
  }
}, {
  strategy: 'auth',
  identifier: 'ip',
});
