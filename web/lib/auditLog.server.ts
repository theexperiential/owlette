/**
 * audit log writer (security-boundary-migration wave 1.3).
 *
 * Writes structured authorization-decision records to
 * `sites/{siteId}/audit_log/{entryId}`. Every privileged action — whether
 * mediated by a user session, an api key, or a system actor (cortex, jobs)
 * — produces exactly one entry per (correlationId, outcome) pair. The
 * `correlationId` is the join key tying an audit decision to any related
 * state writes the action produced (the same id is stamped onto command
 * docs, deployment docs, etc. so an investigator can pivot from a state
 * mutation to its authorization context and back).
 *
 * Two write surfaces:
 *   - `writeAuditEntry(siteId, entry)` — fire-and-forget; the returned
 *     promise is `void` and resolves immediately. Failures are logged but
 *     never thrown. Default for `deny` and `error` outcomes.
 *   - `writeAuditEntryBlocking(siteId, entry)` — returns `Promise<void>`
 *     that callers MUST await. Wave 2.1 (`authorizedHandler`) will use
 *     this for `allow` outcomes so a failed audit fails the request closed
 *     (503) rather than silently letting a privileged action through with
 *     no record. Both surfaces share the same internal write logic.
 *
 * `enforcementBypassed: true` indicates a kill-switch was active at
 * decision time. We surface this at warn level to server logs in addition
 * to the audit row so ops can see kill-switch usage in real time without
 * needing to query firestore.
 */

import crypto from 'crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import logger from '@/lib/logger';

/* -------------------------------------------------------------------------- */
/*  capability + actor types                                                  */
/* -------------------------------------------------------------------------- */

// NOTE: imports from `@/lib/capabilities` will replace these once wave 1.2 lands.
// The placeholder shapes match the schema specified in plan.md exactly so the
// swap is a no-op for callers; only the import statement changes.
export type Capability =
  | 'MACHINE_EXEC_COMMAND'
  | 'MACHINE_CONFIG_WRITE'
  | 'MACHINE_REMOVE'
  | 'DEPLOYMENT_MANAGE'
  | 'DISTRIBUTION_MANAGE'
  | 'UNINSTALL_TRIGGER'
  | 'PRESET_MANAGE'
  | 'SITE_MEMBER_MANAGE'
  | 'WEBHOOK_MANAGE'
  | 'USER_ROLE_MANAGE'
  | 'USER_DELETE'
  | 'SYSTEM_PRESET_MANAGE'
  | 'INSTALLER_MANAGE'
  | 'GLOBAL_SETTINGS_WRITE'
  | 'USER_SELF_PREFS'
  | 'USER_SELF_DELETE';

export type Role = 'member' | 'admin' | 'superadmin';

export type SystemActorName =
  | 'cortex_autonomous'
  | 'cortex_provisioning'
  | 'scheduled_cleanup';

export type UserActor = {
  type: 'user';
  userId: string;
  role: Role;
};

export type SystemActor = {
  type: 'system';
  name: SystemActorName;
};

export type AuditActor = UserActor | SystemActor;

/* -------------------------------------------------------------------------- */
/*  audit entry shape                                                         */
/* -------------------------------------------------------------------------- */

export type AuditTargetKind =
  | 'site'
  | 'machine'
  | 'deployment'
  | 'distribution'
  | 'user'
  | 'process'
  | 'preset'
  | 'installer';

export interface AuditTarget {
  kind: AuditTargetKind;
  id: string;
  /** Optional — set when the target is scoped to a specific machine. */
  machineId?: string;
}

export type AuditOutcome = 'allow' | 'deny' | 'error';

export interface AuditEntry {
  /** Stable join key tying this decision to any related state writes. */
  correlationId: string;
  actor: AuditActor;
  capability: Capability;
  target: AuditTarget;
  outcome: AuditOutcome;
  metadata?: Record<string, unknown>;
  /** Required when `outcome === 'deny'` so triage tools can group denies. */
  denyReason?: string;
  /** Required when `outcome === 'error'` for the same reason. */
  errorCode?: string;
  /** True when a kill switch was active at decision time. */
  enforcementBypassed?: boolean;
  /** Stamped server-side at write time; callers should not pre-fill. */
  timestamp: Timestamp;
}

/**
 * Caller-facing entry shape — `timestamp` is filled by the writer.
 */
export type AuditEntryInput = Omit<AuditEntry, 'timestamp'>;

const AUDIT_LOG_COLLECTION = 'audit_log';

/* -------------------------------------------------------------------------- */
/*  correlation id                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Generate a fresh correlation id. URL-safe, 22 hex chars (88 bits of
 * entropy — collision-resistant well past audit log retention windows).
 * The same id can be embedded into any state docs the action produces so
 * an investigator can pivot from a state row to its audit row.
 */
export function generateCorrelationId(): string {
  return crypto.randomBytes(11).toString('hex');
}

/* -------------------------------------------------------------------------- */
/*  writers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Fire-and-forget audit write. Never throws; never blocks. Use for
 * `deny` and `error` outcomes where the caller already knows the response
 * it wants to send and an audit failure should not change that.
 */
export function writeAuditEntry(siteId: string, entry: AuditEntryInput): void {
  void writeAuditEntryInternal(siteId, entry).catch((err) => {
    logger.error('audit log write failed (fire-and-forget)', {
      context: 'auditLog',
      data: {
        siteId,
        correlationId: entry.correlationId,
        capability: entry.capability,
        outcome: entry.outcome,
        error: err instanceof Error ? err.message : String(err),
      },
    });
  });
}

/**
 * Awaitable audit write. Resolves on successful firestore commit, rejects
 * on failure. Wave 2.1 uses this for `allow` outcomes so a failed audit
 * fails the request closed (503) rather than silently letting a
 * privileged action through with no record.
 */
export async function writeAuditEntryBlocking(
  siteId: string,
  entry: AuditEntryInput,
): Promise<void> {
  await writeAuditEntryInternal(siteId, entry);
}

async function writeAuditEntryInternal(
  siteId: string,
  entry: AuditEntryInput,
): Promise<void> {
  if (!siteId) {
    throw new Error('writeAuditEntry: siteId is required');
  }

  // Surface kill-switch bypass at warn level too — ops shouldn't need to
  // tail firestore to see when capability/rate-limit enforcement is off.
  if (entry.enforcementBypassed) {
    logger.warn('authorization enforcement bypassed', {
      context: 'auditLog',
      data: {
        siteId,
        correlationId: entry.correlationId,
        actor: redactActorForLog(entry.actor),
        capability: entry.capability,
        outcome: entry.outcome,
        target: entry.target,
        metadata: entry.metadata,
      },
    });
  }

  const db = getAdminDb();
  const docRef = db
    .collection('sites')
    .doc(siteId)
    .collection(AUDIT_LOG_COLLECTION)
    .doc();

  // Use FieldValue.serverTimestamp() at write time so the persisted
  // timestamp is authoritative server time, not whatever the request
  // handler thought "now" was. The in-memory AuditEntry type still
  // claims `Timestamp` because that's what reads will see.
  const payload: Record<string, unknown> = {
    correlationId: entry.correlationId,
    actor: entry.actor,
    capability: entry.capability,
    target: stripUndefined({ ...entry.target } as Record<string, unknown>),
    outcome: entry.outcome,
    timestamp: FieldValue.serverTimestamp(),
  };
  if (entry.metadata !== undefined) payload.metadata = entry.metadata;
  if (entry.denyReason !== undefined) payload.denyReason = entry.denyReason;
  if (entry.errorCode !== undefined) payload.errorCode = entry.errorCode;
  if (entry.enforcementBypassed !== undefined) {
    payload.enforcementBypassed = entry.enforcementBypassed;
  }

  await docRef.set(payload);
}

/** Drop `undefined`-valued keys — firestore admin sdk rejects them. */
function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(obj) as Array<keyof T>) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}

/**
 * Redact actor identity for log lines (audit row keeps the full record).
 * Keeps the type + role/name but trims user ids to a short prefix so logs
 * don't leak full uids on every kill-switch flip.
 */
function redactActorForLog(actor: AuditActor): Record<string, unknown> {
  if (actor.type === 'user') {
    return {
      type: 'user',
      role: actor.role,
      userIdPrefix: actor.userId.slice(0, 6),
    };
  }
  return { type: 'system', name: actor.name };
}

/* -------------------------------------------------------------------------- */
/*  ttl cleanup (placeholder)                                                 */
/* -------------------------------------------------------------------------- */

/**
 * 90-day ttl cleanup for audit log entries. Stubbed for milestone a — the
 * full implementation lands in wave 5.3 (or a later milestone) once the
 * scheduled-cleanup system actor is wired up. Intentionally a no-op that
 * logs so accidental wiring is loud rather than silent.
 */
export async function cleanupExpiredAuditEntries(): Promise<void> {
  logger.info('TODO: implement TTL cleanup in wave 5.3 or later', {
    context: 'auditLog',
  });
}
