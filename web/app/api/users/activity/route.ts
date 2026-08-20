/**
 * GET /api/users/activity — `{ activity: Record<uid, { lastSignInTime,
 * lastRefreshTime, disabled }> }` straight from Firebase Auth, which is the
 * authoritative "last active": Firestore user docs carry no sign-in timestamps.
 *
 * Auth: `user=*:read` api key (superadmin-only at minting), or a superadmin
 * session / id-token.
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
