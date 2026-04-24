/** @jest-environment node */

import { Timestamp } from 'firebase-admin/firestore';
import { timestampToIso, timestampToMs } from '@/lib/firestoreTime.server';

describe('timestampToMs', () => {
  it('returns null for null / undefined', () => {
    expect(timestampToMs(null)).toBeNull();
    expect(timestampToMs(undefined)).toBeNull();
  });

  it('passes through a plain Unix-ms number', () => {
    expect(timestampToMs(1_700_000_000_000)).toBe(1_700_000_000_000);
  });

  it('rejects a non-finite number', () => {
    expect(timestampToMs(Number.NaN)).toBeNull();
    expect(timestampToMs(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('converts a JS Date', () => {
    const d = new Date('2026-04-24T01:02:03.456Z');
    expect(timestampToMs(d)).toBe(d.getTime());
  });

  it('converts a firebase-admin Timestamp instance', () => {
    const ts = Timestamp.fromMillis(1_700_000_001_234);
    expect(timestampToMs(ts)).toBe(1_700_000_001_234);
  });

  it('parses an ISO-8601 string', () => {
    const iso = '2026-04-24T01:02:03.789Z';
    expect(timestampToMs(iso)).toBe(Date.parse(iso));
  });

  it('returns null for an unparseable string', () => {
    expect(timestampToMs('not a date')).toBeNull();
  });

  it('handles a duck-typed toMillis()', () => {
    const thing = { toMillis: () => 42_000 };
    expect(timestampToMs(thing)).toBe(42_000);
  });

  it('handles a duck-typed toDate() when toMillis absent', () => {
    const thing = { toDate: () => new Date(123_456) };
    expect(timestampToMs(thing)).toBe(123_456);
  });

  it('prefers toMillis over toDate when both exist', () => {
    const thing = {
      toMillis: () => 111,
      toDate: () => new Date(222),
    };
    expect(timestampToMs(thing)).toBe(111);
  });

  it('handles plain { seconds, nanoseconds } (cache rehydration)', () => {
    expect(timestampToMs({ seconds: 1_700_000_000, nanoseconds: 500_000_000 })).toBe(
      1_700_000_000_500,
    );
  });

  it('handles { seconds } without nanoseconds', () => {
    expect(timestampToMs({ seconds: 1_700_000_000 })).toBe(1_700_000_000_000);
  });

  it('handles legacy admin { _seconds, _nanoseconds }', () => {
    expect(timestampToMs({ _seconds: 1_700_000_000, _nanoseconds: 999_000_000 })).toBe(
      1_700_000_000_999,
    );
  });

  it('returns null for unknown object shapes', () => {
    expect(timestampToMs({ foo: 'bar' })).toBeNull();
    expect(timestampToMs([1, 2, 3])).toBeNull();
  });

  it('rejects a toMillis() that returns non-finite', () => {
    const thing = { toMillis: () => Number.NaN };
    expect(timestampToMs(thing)).toBeNull();
  });
});

describe('timestampToIso', () => {
  it('returns null when the underlying ms conversion returns null', () => {
    expect(timestampToIso(null)).toBeNull();
    expect(timestampToIso({ foo: 'bar' })).toBeNull();
    expect(timestampToIso('garbage')).toBeNull();
  });

  it('round-trips a Date through ISO', () => {
    const d = new Date('2026-04-24T12:34:56.000Z');
    expect(timestampToIso(d)).toBe('2026-04-24T12:34:56.000Z');
  });

  it('converts a firebase-admin Timestamp to ISO', () => {
    const ts = Timestamp.fromDate(new Date('2026-01-01T00:00:00.000Z'));
    expect(timestampToIso(ts)).toBe('2026-01-01T00:00:00.000Z');
  });

  it('converts a plain { seconds } to ISO', () => {
    expect(timestampToIso({ seconds: 1_700_000_000 })).toBe(
      new Date(1_700_000_000_000).toISOString(),
    );
  });

  it('converts legacy { _seconds } to ISO', () => {
    expect(timestampToIso({ _seconds: 1_700_000_000 })).toBe(
      new Date(1_700_000_000_000).toISOString(),
    );
  });

  it('normalises an ISO string through the parse round-trip', () => {
    const iso = '2026-04-24T01:02:03.789Z';
    expect(timestampToIso(iso)).toBe(iso);
  });
});
