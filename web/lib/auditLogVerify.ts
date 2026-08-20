/**
 * Web-side audit-log hash verification, mirroring functions/src/lib/auditLogLogic.ts. The two
 * must stay byte-compatible: same canonical JSON, same sha-256-hex format, same GENESIS_HASH.
 */
import { createHash } from 'crypto';

export const GENESIS_HASH = '0'.repeat(64);

export interface AuditRecord {
  event: {
    kind: string;
    siteId: string;
    actor: string;
    target?: string;
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
  /** hash === sha256(previousHash | recordedAt | canonicalJson(event)) */
  hashValid: boolean;
  /** Set only when a predecessor was supplied and its hash matches this record's previousHash. */
  linkageValid?: boolean;
  /** previousHash === GENESIS_HASH — the site's first-ever record. */
  isGenesis: boolean;
  reason?: string;
}

/** Internal integrity, plus linkage when a predecessor is supplied. Without one, a non-genesis
 * record's linkage is NOT checked. */
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
