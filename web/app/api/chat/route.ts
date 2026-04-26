/**
 * GET /api/chat — list conversations the caller can access.
 *
 * api-sprint wave 3 — track 3A (cortex-api / chat noun).
 *
 * Filters to conversations whose `siteId` is in the caller's effective access
 * set. For api-key callers, the access set is also intersected with the
 * `chat=<siteId>:read` (or wildcard) scopes the key carries — a key scoped
 * to one site cannot list conversations on others, even if the user behind
 * the key has access. Session/id-token callers fall through to the canonical
 * site-membership read (`getUserSiteIds`).
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  problemFromError,
  problemUnauthorized,
} from '@/lib/apiErrors';
import {
  ApiAuthError,
  resolveAuth,
} from '@/lib/apiAuth.server';
import { getUserSiteIds } from '@/lib/apiHelpers.server';
import {
  listConversations,
  serializeConversationSummary,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from '@/lib/chatStorage.server';
import { getAdminDb } from '@/lib/firebase-admin';

export async function GET(request: NextRequest) {
  try {
    let auth;
    try {
      auth = await resolveAuth(request);
    } catch (err) {
      if (err instanceof ApiAuthError) return problemUnauthorized();
      throw err;
    }

    const accessibleSiteIds = await resolveReadableSiteIds(auth.userId, auth.keyContext);
    if (accessibleSiteIds.length === 0) {
      return NextResponse.json({ ok: true, data: { conversations: [], nextPageToken: '' } });
    }

    const pageSizeRaw = Number(
      request.nextUrl.searchParams.get('page_size') ??
        request.nextUrl.searchParams.get('limit') ??
        DEFAULT_PAGE_SIZE,
    );
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(
        1,
        Number.isFinite(pageSizeRaw) ? Math.floor(pageSizeRaw) : DEFAULT_PAGE_SIZE,
      ),
    );
    const pageToken =
      request.nextUrl.searchParams.get('page_token') ??
      request.nextUrl.searchParams.get('cursor') ??
      '';
    const includeDeleted = request.nextUrl.searchParams.get('includeDeleted') === 'true';
    const ownerOnly = request.nextUrl.searchParams.get('owner') === 'me';

    const result = await listConversations({
      siteIds: accessibleSiteIds,
      ownerUid: ownerOnly ? auth.userId : undefined,
      pageSize,
      pageToken,
      includeDeleted,
    });

    return NextResponse.json({
      ok: true,
      data: {
        conversations: result.conversations.map(serializeConversationSummary),
        nextPageToken: result.nextPageToken,
      },
    });
  } catch (err) {
    return problemFromError(err, 'chat:GET');
  }
}

/**
 * Resolve the set of site ids whose chat conversations the caller may read.
 *
 * - Session/id-token callers: their site-membership list (`getUserSiteIds`),
 *   plus any sites they own (resolved via a `where('owner','==',uid)` read on
 *   the `sites` collection). Superadmins fall back to "every site referenced
 *   by their key/membership" — we deliberately do not return a wildcard set
 *   here because the underlying list helper enforces a site-id filter to keep
 *   query plans sane.
 * - Api-key callers with scoped keys: intersection of their site-membership
 *   list with the `chat` scopes on the key. A wildcard chat scope (`chat=*`)
 *   widens the intersection back to the full membership list.
 * - Api-key callers with legacy keys (`scopes` empty/absent): treated like
 *   session callers — full membership list, no scope intersection.
 */
async function resolveReadableSiteIds(
  userId: string,
  keyContext: Awaited<ReturnType<typeof resolveAuth>>['keyContext'],
): Promise<string[]> {
  const membership = await getUserSiteIds(userId);
  const ownedSites = await readOwnedSiteIds(userId);
  const membershipSet = new Set<string>([...membership, ...ownedSites]);

  if (!keyContext || keyContext.isLegacy || !keyContext.scopes) {
    return [...membershipSet];
  }

  const chatScopes = keyContext.scopes.filter(
    (s) => s.resource === 'chat' && s.permissions.includes('read'),
  );
  if (chatScopes.length === 0) return [];
  if (chatScopes.some((s) => s.id === '*')) return [...membershipSet];

  const allowed = new Set(chatScopes.map((s) => s.id));
  return [...membershipSet].filter((siteId) => allowed.has(siteId));
}

async function readOwnedSiteIds(userId: string): Promise<string[]> {
  try {
    const db = getAdminDb();
    const snap = await db.collection('sites').where('owner', '==', userId).get();
    return snap.docs.map((d) => d.id);
  } catch {
    // Owner-lookup failures degrade gracefully: the caller still sees their
    // membership list. The list filter is a defence-in-depth narrowing — it
    // never grants access beyond the underlying scope/membership check.
    return [];
  }
}
