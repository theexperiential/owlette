/**
 * Regression tests for the API-key list view model.
 *
 * Two defects, one root cause — the route returned stored values raw:
 *
 *  1. "created Invalid Date" in the dashboard. `createdAt` is written with
 *     FieldValue.serverTimestamp() (a Firestore Timestamp) while `lastUsedAt`
 *     is written with Date.now() (a number). Serialised raw, the Timestamp
 *     reaches the browser as {_seconds, _nanoseconds}, and `new Date(that)`
 *     is Invalid Date — which is why "last used" rendered and "created" did
 *     not, and why only keys predating the serverTimestamp() switch showed a
 *     real date.
 *
 *  2. No "expired" anywhere. `expired`/`retired` were declared on the UI type
 *     but never returned, so they were always undefined and an expired key
 *     rendered under a heading that called it active — while the API itself
 *     rejected that key with token_expired.
 */

import {
  buildApiKeyListItem,
  toEpochMillis,
} from '@/lib/apiKeyTypes';

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

describe('toEpochMillis', () => {
  it('passes a plain number through — how lastUsedAt is stored', () => {
    expect(toEpochMillis(NOW)).toBe(NOW);
  });

  it('converts a live Firestore Timestamp — how createdAt is stored', () => {
    // Admin SDK Timestamps expose toMillis(); this is the shape the route sees.
    const timestamp = { toMillis: () => NOW, _seconds: NOW / 1000, _nanoseconds: 0 };
    expect(toEpochMillis(timestamp)).toBe(NOW);
  });

  it('converts a Timestamp that has already been through JSON', () => {
    // {_seconds,_nanoseconds} — the shape that reached the browser and
    // produced "Invalid Date". No toMillis() survives serialisation.
    expect(toEpochMillis({ _seconds: 1_700_000_000, _nanoseconds: 500_000_000 })).toBe(
      1_700_000_000_500
    );
  });

  it('accepts the unprefixed spelling too', () => {
    expect(toEpochMillis({ seconds: 1_700_000_000, nanoseconds: 0 })).toBe(NOW);
  });

  it('accepts a Date', () => {
    expect(toEpochMillis(new Date(NOW))).toBe(NOW);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a FieldValue sentinel', { isEqual: () => false }],
    ['a string', '2026-01-01'],
    ['NaN', NaN],
  ])('returns null rather than a nonsense date for %s', (_label, value) => {
    expect(toEpochMillis(value)).toBeNull();
  });

  it('never yields a value that renders as Invalid Date', () => {
    // The actual user-visible symptom, asserted directly.
    for (const stored of [NOW, { toMillis: () => NOW }, { _seconds: NOW / 1000 }]) {
      const ms = toEpochMillis(stored);
      expect(ms).not.toBeNull();
      expect(Number.isNaN(new Date(ms as number).getTime())).toBe(false);
    }
  });
});

describe('buildApiKeyListItem', () => {
  const base = {
    name: 'uploader',
    keyPrefix: 'owk_live_eytQgY',
    environment: 'live',
    scopes: [{ resource: 'installer', id: '*', permissions: ['write'] }],
    createdAt: { toMillis: () => NOW - 30 * DAY },
    lastUsedAt: NOW - DAY,
  };

  it('normalises mixed storage shapes into numbers the UI can render', () => {
    const item = buildApiKeyListItem('k1', { ...base, expiresAt: NOW + 30 * DAY }, NOW);
    expect(item.createdAt).toBe(NOW - 30 * DAY);
    expect(item.lastUsedAt).toBe(NOW - DAY);
    expect(item.expiresAt).toBe(NOW + 30 * DAY);
  });

  it('marks a key past its expiry as expired', () => {
    const item = buildApiKeyListItem('k1', { ...base, expiresAt: NOW - 1 }, NOW);
    expect(item.expired).toBe(true);
  });

  it('does not mark a live key as expired', () => {
    const item = buildApiKeyListItem('k1', { ...base, expiresAt: NOW + 1 }, NOW);
    expect(item.expired).toBe(false);
  });

  it('treats the exact expiry instant as expired', () => {
    // The API rejects at <=, so the badge must agree rather than showing
    // "active" for a key the server refuses.
    expect(buildApiKeyListItem('k1', { ...base, expiresAt: NOW }, NOW).expired).toBe(true);
  });

  it('is not expired when no expiry is recorded', () => {
    const item = buildApiKeyListItem('k1', base, NOW);
    expect(item.expiresAt).toBeNull();
    expect(item.expired).toBe(false);
  });

  it('marks a rotated key retired only once its grace window closes', () => {
    const rotated = { ...base, expiresAt: NOW + DAY, rotatedAt: NOW - 2 * DAY };
    expect(
      buildApiKeyListItem('k1', { ...rotated, retiresAt: NOW - 1 }, NOW).retired
    ).toBe(true);
    expect(
      buildApiKeyListItem('k1', { ...rotated, retiresAt: NOW + DAY }, NOW).retired
    ).toBe(false);
  });

  it('does not call an un-rotated key retired', () => {
    const item = buildApiKeyListItem('k1', { ...base, retiresAt: NOW - DAY }, NOW);
    expect(item.retired).toBe(false);
  });

  it('degrades to nulls for a malformed record instead of throwing', () => {
    const item = buildApiKeyListItem('k1', {}, NOW);
    expect(item).toMatchObject({
      id: 'k1',
      name: null,
      keyPrefix: null,
      environment: null,
      scopes: null,
      expiresAt: null,
      createdAt: null,
      expired: false,
      retired: false,
    });
  });

  it('rejects an unrecognised environment rather than passing it through', () => {
    const item = buildApiKeyListItem('k1', { ...base, environment: 'staging' }, NOW);
    expect(item.environment).toBeNull();
  });
});
