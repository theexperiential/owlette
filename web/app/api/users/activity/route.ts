/**
 * GET /api/users/activity
 *
 * Last-seen source for platform users. Returns Firebase Auth sign-in metadata
 * keyed by uid — the authoritative source for "last active" since Firestore
 * user docs don't track sign-in timestamps.
 *
 * Auth:
 *   - api key with `user=*:read` scope (superadmin-only at minting)
 *   - session / id-token from a superadmin user
 *
 * Response:
 *   { activity: Record<uid, { lastSignInTime, lastRefreshTime, disabled }> }
 *
 * Added for the user-management "last seen" column.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { problemFromError } from '@/lib/apiErrors';
import { getAdminAuth, getAdminDb } from '@/lib/firebase-admin';
import { applyAuthDeprecations, requirePlatformAuthAndScope } from '../../_shared';

// Firebase Admin `getUsers` throws if given more than 100 identifiers.
const GET_USERS_BATCH_SIZE = 100;

interface UserActivity {
  lastSignInTime: string | null;
  lastRefreshTime: string | null;
  disabled: boolean;
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requirePlatformAuthAndScope(request, 'user', 'read');
    if (!auth.ok) return auth.response;

    const snap = await getAdminDb().collection('users').select().get();
    const uids = snap.docs.map((d) => d.id);

    if (uids.length === 0) {
      return applyAuthDeprecations(
        NextResponse.json({ activity: {} }),
        auth.scopeCheck,
      );
    }

    const activity: Record<string, UserActivity> = {};
    const adminAuth = getAdminAuth();

    for (let i = 0; i < uids.length; i += GET_USERS_BATCH_SIZE) {
      const chunk = uids.slice(i, i + GET_USERS_BATCH_SIZE);
      const { users } = await adminAuth.getUsers(chunk.map((uid) => ({ uid })));
      // `users` is unordered — key by record.uid, not by input index.
      for (const record of users) {
        activity[record.uid] = {
          lastSignInTime: record.metadata.lastSignInTime || null,
          lastRefreshTime: record.metadata.lastRefreshTime || null,
          disabled: record.disabled,
        };
      }
    }

    return applyAuthDeprecations(
      NextResponse.json({ activity }),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'users/activity:GET');
  }
}
