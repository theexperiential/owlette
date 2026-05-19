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

import type { Firestore, Query } from 'firebase-admin/firestore';
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

  const db = ctx.db ?? getAdminDb();
  const logsCol = db.collection('sites').doc(ctx.siteId).collection('logs');

  // Build query with the same filters the UI applies.
  let q: Query = logsCol;
  if (input.action !== undefined) q = q.where('action', '==', input.action);
  if (input.machineId !== undefined) q = q.where('machineId', '==', input.machineId);
  if (input.level !== undefined) q = q.where('level', '==', input.level);

  // Loop: fetch a batch-sized chunk, delete it, repeat until empty. Firestore
  // doesn't have a streaming-delete primitive; iterating in chunks of 500
  // matches the batch limit and the legacy hook's pattern. Each iteration is
  // committed individually so a failure mid-flight leaves the *committed*
  // chunks already deleted (idempotent retry will pick up the remainder).
  let deletedCount = 0;
  // Hard cap iterations defensively — a site shouldn't have unbounded logs,
  // but a runaway query is the kind of thing we'd rather surface than hang on.
  const MAX_ITERATIONS = 1000; // 1000 * 500 = 500k log entries — well above any realistic site
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const snap = await q.limit(FIRESTORE_BATCH_LIMIT).get();
    if (snap.empty) break;

    const batch = db.batch();
    for (const doc of snap.docs) {
      batch.delete(doc.ref);
    }
    await batch.commit();
    deletedCount += snap.size;

    // If we got fewer than the limit, no more to fetch — short-circuit.
    if (snap.size < FIRESTORE_BATCH_LIMIT) break;
  }

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
