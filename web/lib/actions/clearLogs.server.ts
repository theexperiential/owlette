/**
 * clearLogs action core (security-boundary-migration wave 3.11).
 *
 * Mirrors `handleClearLogs` (web/app/logs/page.tsx:529-594): deletes log
 * entries from `sites/{siteId}/logs` in batches of 500 (Firestore's per-
 * batch limit). Optional filters mirror the UI's filter dropdowns
 * (action / machine / level) so a user clearing a *filtered view*
 * deletes only the matching entries, not the whole collection.
 *
 * Public API Wave 2.8:
 *   Destructive log clearing is gated by the site-scoped `SITE_LOGS_MANAGE`
 *   capability, requires an idempotency key at the route boundary, and
 *   requires `all: true` for unfiltered whole-site clears.
 *
 * firestore path: `sites/{siteId}/logs/*`
 */

import { Timestamp } from 'firebase-admin/firestore';
import type {
  CollectionReference,
  Firestore,
  Query,
  QueryDocumentSnapshot,
} from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import logger from '@/lib/logger';

const FIRESTORE_BATCH_LIMIT = 500;
const SITE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const VALID_LEVELS = new Set(['debug', 'info', 'warning', 'error', 'critical']);

export interface ClearLogsContext {
  siteId: string;
  /** Inject a Firestore instance — tests pass a mock; production omits. */
  db?: Firestore;
}

export interface ClearLogsInput {
  /** Match the `action` field exactly. Omit for all actions. */
  action?: string;
  /** Match the `machineId` field exactly. Omit for all machines. */
  machineId?: string;
  /** Match the `level` field exactly. Omit for all levels. */
  level?: string;
  /** Inclusive lower timestamp bound (epoch ms). Omit for no lower bound. */
  sinceMs?: number;
  /** Inclusive upper timestamp bound (epoch ms). Omit for no upper bound. */
  untilMs?: number;
}

export interface ClearLogsResult {
  siteId: string;
  deletedCount: number;
  filters: ClearLogsInput;
}

export class ClearLogsValidationError extends Error {
  field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = 'ClearLogsValidationError';
    this.field = field;
  }
}

// Hard cap iterations defensively — a site shouldn't have unbounded logs, but a
// runaway query is the kind of thing we'd rather surface than hang on.
const MAX_ITERATIONS = 1000; // 1000 * 500 = 500k entries — well above any realistic site

export async function clearLogs(
  ctx: ClearLogsContext,
  input: ClearLogsInput = {},
): Promise<ClearLogsResult> {
  if (typeof ctx.siteId !== 'string' || !SITE_ID_RE.test(ctx.siteId)) {
    throw new ClearLogsValidationError(
      'siteId',
      'siteId must be 1-128 chars: letters, digits, underscore, hyphen',
    );
  }
  if (input.action !== undefined && typeof input.action !== 'string') {
    throw new ClearLogsValidationError('action', 'action must be a string when provided');
  }
  if (input.machineId !== undefined && typeof input.machineId !== 'string') {
    throw new ClearLogsValidationError('machineId', 'machineId must be a string when provided');
  }
  if (input.level !== undefined) {
    if (typeof input.level !== 'string' || !VALID_LEVELS.has(input.level)) {
      throw new ClearLogsValidationError(
        'level',
        `level must be one of: ${Array.from(VALID_LEVELS).join(', ')}`,
      );
    }
  }
  for (const field of ['sinceMs', 'untilMs'] as const) {
    const v = input[field];
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) {
      throw new ClearLogsValidationError(
        field,
        `${field} must be a non-negative epoch-ms number when provided`,
      );
    }
  }
  if (input.sinceMs !== undefined && input.untilMs !== undefined && input.sinceMs > input.untilMs) {
    throw new ClearLogsValidationError('sinceMs', 'sinceMs must be <= untilMs');
  }

  const db = ctx.db ?? getAdminDb();
  const logsCol = db.collection('sites').doc(ctx.siteId).collection('logs');

  // Two index-free strategies:
  //  - No date window: equality filters server-side + batch-delete loop (every
  //    fetched doc matches, so re-querying from the front terminates). This is
  //    the unchanged legacy path.
  //  - Date window: constrain by timestamp range only (single-field index, same
  //    as the GET handler) and cursor-paginate, applying action/machine/level in
  //    memory. Avoids the composite indexes an equality+range query would need.
  const deletedCount =
    input.sinceMs !== undefined || input.untilMs !== undefined
      ? await clearByTimestampWindow(db, logsCol, input)
      : await clearByEqualityFilters(db, logsCol, input);

  if (deletedCount > 0) {
    logger.info(`clearLogs: deleted ${deletedCount} entries from sites/${ctx.siteId}/logs`, {
      context: 'clearLogs',
      data: { siteId: ctx.siteId, filters: input, deletedCount },
    });
  }

  return {
    siteId: ctx.siteId,
    deletedCount,
    filters: input,
  };
}

/**
 * No date window: equality filters applied server-side, deleted in batches of
 * 500. Every fetched doc matches all filters, so deleting and re-querying from
 * the front always makes progress and terminates.
 */
async function clearByEqualityFilters(
  db: Firestore,
  logsCol: CollectionReference,
  input: ClearLogsInput,
): Promise<number> {
  let q: Query = logsCol;
  if (input.action !== undefined) q = q.where('action', '==', input.action);
  if (input.machineId !== undefined) q = q.where('machineId', '==', input.machineId);
  if (input.level !== undefined) q = q.where('level', '==', input.level);

  let deletedCount = 0;
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const snap = await q.limit(FIRESTORE_BATCH_LIMIT).get();
    if (snap.empty) break;

    const batch = db.batch();
    for (const doc of snap.docs) batch.delete(doc.ref);
    await batch.commit();
    deletedCount += snap.size;

    if (snap.size < FIRESTORE_BATCH_LIMIT) break;
  }
  return deletedCount;
}

/**
 * Date window: order by timestamp + apply the range server-side (single-field
 * index), cursor-paginate, and match action/machine/level in memory so we never
 * need composite indexes. The cursor advances past non-matching docs, so the
 * loop terminates even when most rows in the window don't match the filters.
 */
async function clearByTimestampWindow(
  db: Firestore,
  logsCol: CollectionReference,
  input: ClearLogsInput,
): Promise<number> {
  let cursor: QueryDocumentSnapshot | null = null;
  let deletedCount = 0;
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let q: Query = logsCol.orderBy('timestamp', 'desc');
    if (input.sinceMs !== undefined) {
      q = q.where('timestamp', '>=', Timestamp.fromMillis(input.sinceMs));
    }
    if (input.untilMs !== undefined) {
      q = q.where('timestamp', '<=', Timestamp.fromMillis(input.untilMs));
    }
    q = q.limit(FIRESTORE_BATCH_LIMIT);
    if (cursor) q = q.startAfter(cursor);

    const snap = await q.get();
    if (snap.empty) break;
    cursor = snap.docs[snap.docs.length - 1];

    const batch = db.batch();
    let matched = 0;
    for (const doc of snap.docs) {
      const d = doc.data();
      if (input.action !== undefined && d.action !== input.action) continue;
      if (input.machineId !== undefined && d.machineId !== input.machineId) continue;
      if (input.level !== undefined && d.level !== input.level) continue;
      batch.delete(doc.ref);
      matched++;
    }
    if (matched > 0) {
      await batch.commit();
      deletedCount += matched;
    }
    if (snap.size < FIRESTORE_BATCH_LIMIT) break;
  }
  return deletedCount;
}
