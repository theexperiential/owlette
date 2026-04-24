/**
 * Audit-log hash verification helpers for the web side.
 *
 * Mirrors the pure logic in `functions/src/lib/auditLogLogic.ts`. Keep
 * these two files byte-compatible — they hash the same canonical JSON
 * representation and share the sha-256-hex format + GENESIS_HASH
 * sentinel.
 */
import { createHash } from 'crypto';

export const GENESIS_HASH = '0'.repeat(64);

export interface AuditRecord {
  event: {
    kind: string;
    siteId: string;
    actor: string;
    occurredAt: number;
    attributes: Record<string, unknown>;
  };
  recordedAt: number;
  previousHash: string;
  hash: string;
}

function sortForCanonical(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(sortForCanonical);
  const sorted: Record<string, unknown> = {};
  const keys = Object.keys(v as Record<string, unknown>).sort();
  for (const k of keys) sorted[k] = sortForCanonical((v as Record<string, unknown>)[k]);
  return sorted;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortForCanonical(value));
}

export function computeChainHash(
  previousHash: string,
  recordedAt: number,
  canonicalPayload: string,
): string {
  const input = `${previousHash}|${recordedAt}|${canonicalPayload}`;
  return createHash('sha256').update(input).digest('hex');
}

export interface RecordVerifyResult {
  ok: boolean;
  /** True if hash field matches hash(previousHash | recordedAt | canonicalJson(event)) */
  hashValid: boolean;
  /** Set when a predecessor record is also provided and its hash matches this record's previousHash. */
  linkageValid?: boolean;
  /** Set to true when previousHash === GENESIS_HASH (this is the site's first-ever record). */
  isGenesis: boolean;
  reason?: string;
}

/**
 * Verify a single record's internal integrity, optionally verifying its
 * linkage to a supplied predecessor. If no predecessor is provided and
 * the record is not the genesis record, linkage is NOT checked.
 */
export function verifyRecord(
  record: AuditRecord,
  predecessor?: AuditRecord | null,
): RecordVerifyResult {
  const isGenesis = record.previousHash === GENESIS_HASH;
  const expectedHash = computeChainHash(
    record.previousHash,
    record.recordedAt,
    canonicalJson(record.event),
  );
  const hashValid = expectedHash === record.hash;

  if (!hashValid) {
    return { ok: false, hashValid: false, isGenesis, reason: 'hash_mismatch' };
  }

  if (predecessor) {
    const linkageValid = predecessor.hash === record.previousHash;
    if (!linkageValid) {
      return {
        ok: false,
        hashValid,
        linkageValid: false,
        isGenesis,
        reason: 'previousHash_mismatch',
      };
    }
    return { ok: true, hashValid, linkageValid: true, isGenesis };
  }

  return { ok: true, hashValid, isGenesis };
}
