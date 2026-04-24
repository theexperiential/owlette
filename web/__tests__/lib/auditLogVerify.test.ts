/** @jest-environment node */
import {
  GENESIS_HASH,
  canonicalJson,
  computeChainHash,
  verifyRecord,
  type AuditRecord,
} from '@/lib/auditLogVerify';

function buildRecord(
  event: AuditRecord['event'],
  previousHash: string,
  recordedAt: number,
): AuditRecord {
  const payload = canonicalJson(event);
  return {
    event,
    recordedAt,
    previousHash,
    hash: computeChainHash(previousHash, recordedAt, payload),
  };
}

function makeEvent(overrides: Partial<AuditRecord['event']> = {}): AuditRecord['event'] {
  return {
    kind: 'api_key_used',
    siteId: 'site-1',
    actor: 'apiKey:k1',
    occurredAt: 1700000000000,
    attributes: { endpoint: '/api/chunks/check' },
    ...overrides,
  };
}

describe('canonicalJson', () => {
  it('produces stable output regardless of insertion order', () => {
    const a = canonicalJson({ b: 1, a: 2, c: { y: 1, x: 2 } });
    const b = canonicalJson({ c: { x: 2, y: 1 }, a: 2, b: 1 });
    expect(a).toBe(b);
  });

  it('preserves array order (arrays are not sorted)', () => {
    expect(canonicalJson(['b', 'a'])).toBe('["b","a"]');
  });
});

describe('verifyRecord', () => {
  it('returns ok for a well-formed genesis record (no predecessor)', () => {
    const record = buildRecord(makeEvent(), GENESIS_HASH, 1700000001000);
    const result = verifyRecord(record);
    expect(result.ok).toBe(true);
    expect(result.isGenesis).toBe(true);
    expect(result.hashValid).toBe(true);
  });

  it('returns ok for a non-genesis record when predecessor is provided and linked', () => {
    const genesis = buildRecord(makeEvent(), GENESIS_HASH, 1700000001000);
    const second = buildRecord(makeEvent({ occurredAt: 1700000002000 }), genesis.hash, 1700000002500);
    const result = verifyRecord(second, genesis);
    expect(result.ok).toBe(true);
    expect(result.isGenesis).toBe(false);
    expect(result.linkageValid).toBe(true);
  });

  it('detects hash tampering in the event body', () => {
    const record = buildRecord(makeEvent(), GENESIS_HASH, 1700000001000);
    const tampered: AuditRecord = {
      ...record,
      event: { ...record.event, actor: 'attacker:forged' },
    };
    const result = verifyRecord(tampered);
    expect(result.ok).toBe(false);
    expect(result.hashValid).toBe(false);
    expect(result.reason).toBe('hash_mismatch');
  });

  it('detects recordedAt tampering', () => {
    const record = buildRecord(makeEvent(), GENESIS_HASH, 1700000001000);
    const tampered: AuditRecord = { ...record, recordedAt: record.recordedAt + 1 };
    const result = verifyRecord(tampered);
    expect(result.ok).toBe(false);
    expect(result.hashValid).toBe(false);
  });

  it('detects broken chain linkage', () => {
    const genesis = buildRecord(makeEvent(), GENESIS_HASH, 1700000001000);
    const detached: AuditRecord = {
      ...buildRecord(makeEvent({ occurredAt: 2 }), GENESIS_HASH, 1700000002000),
    };
    const result = verifyRecord(detached, genesis);
    expect(result.ok).toBe(false);
    expect(result.linkageValid).toBe(false);
    expect(result.reason).toBe('previousHash_mismatch');
  });

  it('ok without predecessor check when predecessor is null', () => {
    const genesis = buildRecord(makeEvent(), GENESIS_HASH, 1700000001000);
    const second = buildRecord(makeEvent({ occurredAt: 2 }), genesis.hash, 1700000002000);
    // No predecessor provided — linkage isn't checked, only internal hash.
    const result = verifyRecord(second, null);
    expect(result.ok).toBe(true);
    expect(result.linkageValid).toBeUndefined();
  });
});
