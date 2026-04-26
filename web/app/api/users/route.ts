/**
 * GET /api/users
 *
 * List platform users. Cursor-paginated per AIP-158. Soft-deleted users are
 * excluded by default; pass `?includeDeleted=true` to surface them.
 *
 * Auth:
 *   - api key with `user=*:read` scope (superadmin-only at minting)
 *   - session / id-token from a superadmin user
 *
 * Query params:
 *   - page_size (1..100, default 20)
 *   - page_token (opaque — uid of the doc to start after)
 *   - role  (filter: 'member' | 'admin' | 'superadmin')
 *   - site  (filter: only users where `sites[]` contains this siteId)
 *   - includeDeleted=true (default false)
 *
 * Response:
 *   { users: UserView[], nextPageToken: string }
 *
 * api-sprint wave 3 track 3B (users-api).
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { problemFromError, problemValidation } from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import { applyAuthDeprecations, requirePlatformAuthAndScope } from '../_shared';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const VALID_ROLES = new Set(['member', 'admin', 'superadmin']);

interface UserDoc {
  email?: string;
  role?: string;
  sites?: string[];
  displayName?: string;
  firstName?: string;
  lastName?: string;
  createdAt?: number | { toMillis?: () => number };
  deletedAt?: number;
}

function timestampToIso(value: unknown): string | null {
  if (typeof value === 'number') return new Date(value).toISOString();
  if (
    value &&
    typeof value === 'object' &&
    typeof (value as { toMillis?: () => number }).toMillis === 'function'
  ) {
    try {
      return new Date(
        (value as { toMillis: () => number }).toMillis(),
      ).toISOString();
    } catch {
      return null;
    }
  }
  return null;
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requirePlatformAuthAndScope(request, 'user', 'read');
    if (!auth.ok) return auth.response;

    const sp = request.nextUrl.searchParams;

    const pageSizeRaw = Number(sp.get('page_size') ?? DEFAULT_PAGE_SIZE);
    if (sp.has('page_size') && !Number.isFinite(pageSizeRaw)) {
      return problemValidation('page_size must be a positive integer', {
        'query.page_size': ['must be a finite number'],
      });
    }
    const pageSize = Math.min(
      Math.max(
        1,
        Number.isFinite(pageSizeRaw) ? Math.floor(pageSizeRaw) : DEFAULT_PAGE_SIZE,
      ),
      MAX_PAGE_SIZE,
    );

    const pageToken = sp.get('page_token');
    const includeDeleted = sp.get('includeDeleted') === 'true';

    const roleFilter = sp.get('role');
    if (roleFilter && !VALID_ROLES.has(roleFilter)) {
      return problemValidation('role filter is invalid', {
        'query.role': [`must be one of ${[...VALID_ROLES].join(', ')}`],
      });
    }

    const siteFilter = sp.get('site');

    const db = getAdminDb();
    const usersCol = db.collection('users');

    let query: FirebaseFirestore.Query = usersCol;
    if (roleFilter) {
      query = query.where('role', '==', roleFilter);
    }
    if (siteFilter) {
      query = query.where('sites', 'array-contains', siteFilter);
    }

    // Order by uid (doc id) for stable cursor pagination — there is no
    // guaranteed indexable field across all user shapes (legacy users may
    // have no createdAt). Doc id is always present and lexicographically
    // stable.
    query = query.orderBy('__name__').limit(pageSize + 1);

    if (pageToken) {
      const cursorSnap = await usersCol.doc(pageToken).get();
      if (cursorSnap.exists) query = query.startAfter(cursorSnap);
    }

    const snap = await query.get();
    const docs = snap.docs.slice(0, pageSize);
    const nextPageToken =
      snap.docs.length > pageSize ? snap.docs[pageSize].id : '';

    const users = docs
      .map((d) => {
        const data = d.data() as UserDoc;
        const deletedAt =
          typeof data.deletedAt === 'number' ? data.deletedAt : null;
        if (!includeDeleted && deletedAt !== null) return null;

        const sites = Array.isArray(data.sites)
          ? data.sites.filter((s): s is string => typeof s === 'string')
          : [];

        return {
          uid: d.id,
          email: typeof data.email === 'string' ? data.email : null,
          role: typeof data.role === 'string' ? data.role : 'member',
          sites,
          displayName:
            typeof data.displayName === 'string' ? data.displayName : null,
          firstName:
            typeof data.firstName === 'string' ? data.firstName : null,
          lastName: typeof data.lastName === 'string' ? data.lastName : null,
          createdAt: timestampToIso(data.createdAt),
          deletedAt,
        };
      })
      .filter((u): u is NonNullable<typeof u> => u !== null);

    return applyAuthDeprecations(
      NextResponse.json({ users, nextPageToken }),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'users:GET');
  }
}
