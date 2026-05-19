/**
 * Pure logic for the roost audit log sink (wave 2b.7).
 *
 * The audit log is **append-only, hash-chained, and tamper-evident**.
 * Every record embeds `hash(previousHash || canonicalPayload)` so a
 * verifier can walk a site's chain and prove no record was silently
 * modified or deleted. The first record in a chain uses GENESIS_HASH
 * as its previous-hash sentinel.
 *
 * This file does NOT write to firestore — it builds records the handler
 * can persist. Verification is also here so any consumer (dashboard,
 * external auditor script) can run it with no firebase deps.
 */

import { createHash } from 'crypto';

/* --------------------------------------------------------------------- */
/*  Event taxonomy                                                       */
/* --------------------------------------------------------------------- */

/**
 * Stable set of event types the audit log records. Adding a new kind
 * requires extending both this union AND the shape validator — the
 * two live together on purpose.
 */
export const AUDIT_EVENT_KINDS = [
  'signed_url_issued',
  'distribution_started',
  'version_pointer_changed',
  'api_key_used',
  'gc_run',
  'api_key_mutated',
  'chunk_mutated',
  'deployment_mutated',
  'distribution_mutated',
  'process_mutated',
  'roost_mutated',
  'machine_command_dispatched',
  'user_mutated',
  'site_mutated',
  'site_member_mutated',
  'installer_mutated',
  'webhook_mutated',
  'chat_mutated',
] as const;

export type AuditEventKind = (typeof AUDIT_EVENT_KINDS)[number];

export const PLATFORM_AUDIT_SITE_ID = '__platform__';

export interface AuditEvent {
  kind: AuditEventKind;
  siteId: string;
  /**
   * User / API-key / service identifier that initiated the event.
   * `service:chunkGc` or `apiKey:owk_abc…hash` for automated actors.
   */
  actor: string;
  /** unix ms when the audited operation happened, NOT when recorded. */
  occurredAt: number;
  /** Optional mutated resource id, sent by the web mutation audit client. */
  target?: string;
  /**
   * Kind-specific attributes — intentionally open-ended as long as the
   * entire payload is JSON-serialisable. Nested structure is fine;
   * canonical JSON handles it.
   */
  attributes: Record<string, unknown>;
}

/* --------------------------------------------------------------------- */
/*  Canonicalisation                                                     */
/* --------------------------------------------------------------------- */

/**
 * Shape-check a raw incoming event. Returns the validated event or an
 * error string. Strict — unknown fields or missing required fields are
 * rejected so the chain never ingests garbage.
 */
export function canonicaliseEvent(
  raw: Partial<AuditEvent> | undefined,
): { ok: true; event: AuditEvent } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, reason: 'event_not_object' };
  }
  if (!isAuditEventKind(raw.kind)) {
    return { ok: false, reason: 'invalid_kind' };
  }
  if (typeof raw.siteId !== 'string') {
    return { ok: false, reason: 'siteId_required' };
  }
  if (!raw.actor || typeof raw.actor !== 'string') {
    return { ok: false, reason: 'actor_required' };
  }
  if (
    typeof raw.occurredAt !== 'number' ||
    !isFinite(raw.occurredAt) ||
    raw.occurredAt <= 0
  ) {
    return { ok: false, reason: 'occurredAt_required' };
  }
  const attributes = raw.attributes ?? {};
  if (typeof attributes !== 'object' || attributes === null || Array.isArray(attributes)) {
    return { ok: false, reason: 'attributes_must_be_object' };
  }
  if (raw.target !== undefined && typeof raw.target !== 'string') {
    return { ok: false, reason: 'target_must_be_string' };
  }

  return {
    ok: true,
    event: {
      kind: raw.kind,
      siteId: raw.siteId || PLATFORM_AUDIT_SITE_ID,
      actor: raw.actor,
      occurredAt: raw.occurredAt,
      ...(raw.target !== undefined ? { target: raw.target } : {}),
      attributes,
    },
  };
}

function isAuditEventKind(x: unknown): x is AuditEventKind {
  return AUDIT_EVENT_KINDS.includes(x as AuditEventKind);
}

/**
 * Produce a canonical JSON representation — keys sorted recursively.
 *
 * The chain hashes this string, so any two verifiers starting from the
 * same record must compute the same bytes. JSON.stringify alone is not
 * stable across property-insertion order, so we sort.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortForCanonical(value));
}

function sortForCanonical(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(sortForCanonical);
  const sorted: Record<string, unknown> = {};
  const keys = Object.keys(v as Record<string, unknown>).sort();
  for (const k of keys) {
    sorted[k] = sortForCanonical((v as Record<string, unknown>)[k]);
  }
  return sorted;
}

/* --------------------------------------------------------------------- */
/*  Hash chain                                                           */
/* --------------------------------------------------------------------- */

/**
 * Sentinel previous-hash for the first record in a site's chain.
 * 64 zeros matches the output width of SHA-256-hex so chain verifiers
 * can compare without special-casing the first record.
 */
export const GENESIS_HASH = '0'.repeat(64);

/**
 * Hash input is the concatenation of previous-hash, recorded-at
 * timestamp, and canonical-event-payload. Separators are non-ambiguous
 * characters never emitted by canonical JSON.
 */
export function computeChainHash(
  previousHash: string,
  recordedAt: number,
  canonicalPayload: string,
): string {
  const input = `${previousHash}|${recordedAt}|${canonicalPayload}`;
  return createHash('sha256').update(input).digest('hex');
}

export interface AuditRecord {
  event: AuditEvent;
  /** unix ms when the sink wrote the record (NOT event.occurredAt). */
  recordedAt: number;
  previousHash: string;
  /** SHA-256 hex of `previousHash | recordedAt | canonicalJson(event)`. */
  hash: string;
}

/** Produce the next record in the chain. */
export function buildAuditRecord(
  event: AuditEvent,
  previousHash: string,
  recordedAt: number,
): AuditRecord {
  const payload = canonicalJson(event);
  const hash = computeChainHash(previousHash, recordedAt, payload);
  return { event, recordedAt, previousHash, hash };
}

/**
 * Verify a sequence of records:
 *   - records[0].previousHash === GENESIS_HASH (if flagged as chain start)
 *   - each record's hash matches its derivation
 *   - each record's previousHash matches the prior record's hash
 *
 * Returns `{ ok: true }` or the index of the first failing record.
 */
export function verifyChain(
  records: readonly AuditRecord[],
  opts: { assertGenesis?: boolean } = {},
): { ok: true } | { ok: false; brokenAt: number; reason: string } {
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const expectedPrev = i === 0
      ? (opts.assertGenesis ? GENESIS_HASH : r.previousHash)
      : records[i - 1].hash;
    if (r.previousHash !== expectedPrev) {
      return { ok: false, brokenAt: i, reason: 'previousHash_mismatch' };
    }
    const expectedHash = computeChainHash(
      r.previousHash,
      r.recordedAt,
      canonicalJson(r.event),
    );
    if (r.hash !== expectedHash) {
      return { ok: false, brokenAt: i, reason: 'hash_mismatch' };
    }
  }
  return { ok: true };
}

/* --------------------------------------------------------------------- */
/*  Retention                                                            */
/* --------------------------------------------------------------------- */

/** SOX + HIPAA both want ≥7 years. 7*365 days; leap years don't matter
 *  for coarse retention bookkeeping. */
export const AUDIT_RETENTION_DAYS = 7 * 365;
