/**
 * GET /api/users/deletions
 *
 * List user-deletion events sourced from the platform audit log. Surfaces
 * both self-service deletions (`USER_SELF_DELETE`, written by
 * `/api/users/me`) and superadmin-initiated deletions (`USER_DELETE`, written
 * by `/api/users/{uid}`). Both land in `global/audit_log/entries`, so a single
 * `capability in [...]` query covers them.
 *
 * Auth:
 *   - api key with `user=*:read` scope (superadmin-only at minting)
 *   - session / id-token from a superadmin user
 *
 * Query params:
 *   - limit (1..200, default 50)
 *
 * Response:
 *   { deletions: DeletionView[] }  // newest-first
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
 * Convert a Firestore Timestamp to an ISO string. Audit entries store
 * `timestamp` via `FieldValue.serverTimestamp()`, which resolves to a
 * Timestamp exposing `.toDate()`. Null-safe — returns null for missing or
 * malformed values.
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

/**
 * Parse the optional `limit` query param. Defaults to 50, clamps to 1..200.
 * Non-numeric or sub-1 values fall back to the default.
 */
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
