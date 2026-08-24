/**
 * GET /api/users/deletions — user-deletion events from the platform audit log.
 *
 * Covers both `USER_SELF_DELETE` (written by /api/users/me) and `USER_DELETE`
 * (written by /api/users/{uid}); both land in `global/audit_log/entries`, so one
 * `capability in [...]` query serves both.
 *
 * Auth: api key with `user=*:read` (superadmin-only at minting), or a
 * superadmin session / id-token.
 * Query: limit (1..200, default 50). Returns { deletions: DeletionView[] },
 * newest first.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { problemFromError } from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import { Capability } from '@/lib/capabilities';
import { applyAuthDeprecations, requirePlatformAuthAndScope } from '../../_shared';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const DELETION_CAPABILITIES = [
  Capability.USER_SELF_DELETE,
  Capability.USER_DELETE,
];

/**
 * Firestore Timestamp -> ISO string. Audit entries write `timestamp` via
 * `FieldValue.serverTimestamp()`, which resolves to a Timestamp with
 * `.toDate()`. Returns null for missing or malformed values.
 */
function timestampToIso(value: unknown): string | null {
  if (
    value &&
    typeof value === 'object' &&
    typeof (value as { toDate?: () => Date }).toDate === 'function'
  ) {
    try {
      return (value as { toDate: () => Date }).toDate().toISOString();
    } catch {
      return null;
    }
  }
  return null;
}

/** `limit` query param: default 50, clamped 1..200; junk falls back to 50. */
function parseLimit(raw: string | null): number {
  if (raw === null) return DEFAULT_LIMIT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_LIMIT;
  return Math.min(Math.floor(parsed), MAX_LIMIT);
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requirePlatformAuthAndScope(request, 'user', 'read');
    if (!auth.ok) return auth.response;

    const limit = parseLimit(request.nextUrl.searchParams.get('limit'));

    const snap = await getAdminDb()
      .collection('global')
      .doc('audit_log')
      .collection('entries')
      .where('capability', 'in', DELETION_CAPABILITIES)
      .orderBy('timestamp', 'desc')
      .limit(limit)
      .get();

    const deletions = snap.docs.map((doc) => {
      const data = doc.data() as {
        target?: { id?: string };
        actor?: { userId?: string };
        capability?: string;
        outcome?: string;
        timestamp?: unknown;
        denyReason?: string;
        metadata?: { deletedCounts?: unknown };
      };
      return {
        id: doc.id,
        uid: data.target?.id ?? null,
        actorUid: data.actor?.userId ?? null,
        capability: data.capability,
        outcome: data.outcome,
        timestamp: timestampToIso(data.timestamp),
        denyReason: data.denyReason ?? null,
        counts: data.metadata?.deletedCounts ?? null,
      };
    });

    return applyAuthDeprecations(
      NextResponse.json({ deletions }),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'users/deletions:GET');
  }
}
