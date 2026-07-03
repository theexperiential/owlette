/** @jest-environment node */

import {
  tokenTimestampToMillis,
  isTokenSuperseded,
  isTokenExpired,
  isTokenDead,
  isTokenLive,
} from '@/lib/agentTokens';

describe('agentTokens lifecycle predicates', () => {
  const now = 1_000_000_000_000;
  const ms = (v: number) => ({ toMillis: () => v });

  describe('tokenTimestampToMillis', () => {
    it('parses Timestamp-like, number, and Date', () => {
      expect(tokenTimestampToMillis(ms(123))).toBe(123);
      expect(tokenTimestampToMillis(123)).toBe(123);
      expect(tokenTimestampToMillis(new Date(123))).toBe(123);
    });

    it('returns undefined for absent / unparseable / non-finite values', () => {
      expect(tokenTimestampToMillis(undefined)).toBeUndefined();
      expect(tokenTimestampToMillis(null)).toBeUndefined();
      expect(tokenTimestampToMillis('nope')).toBeUndefined();
      expect(tokenTimestampToMillis(NaN)).toBeUndefined();
      expect(tokenTimestampToMillis({})).toBeUndefined();
    });
  });

  it('a plain token is live, not superseded, not dead', () => {
    const t = {};
    expect(isTokenSuperseded(t)).toBe(false);
    expect(isTokenDead(t, now)).toBe(false);
    expect(isTokenLive(t, now)).toBe(true);
  });

  it('superseded past its grace window is dead and hidden from the live list', () => {
    const t = { supersededAt: now - 10, retiresAt: ms(now - 1) };
    expect(isTokenSuperseded(t)).toBe(true);
    expect(isTokenDead(t, now)).toBe(true);
    expect(isTokenLive(t, now)).toBe(false);
  });

  it('superseded WITHIN grace is neither dead (still retryable) nor live (successor exists)', () => {
    const t = { supersededBy: 'succ-hash', retiresAt: ms(now + 1000) };
    expect(isTokenDead(t, now)).toBe(false);
    expect(isTokenLive(t, now)).toBe(false);
  });

  it('superseded without a retiresAt is treated as dead (matches refresh-route rejection)', () => {
    const t = { supersededAt: now };
    expect(isTokenDead(t, now)).toBe(true);
    expect(isTokenLive(t, now)).toBe(false);
  });

  it('expired token is dead and hidden from the live list', () => {
    const t = { expiresAt: ms(now - 1) };
    expect(isTokenExpired(t, now)).toBe(true);
    expect(isTokenDead(t, now)).toBe(true);
    expect(isTokenLive(t, now)).toBe(false);
  });

  it('a future expiry is still live', () => {
    const t = { expiresAt: ms(now + 100_000) };
    expect(isTokenExpired(t, now)).toBe(false);
    expect(isTokenDead(t, now)).toBe(false);
    expect(isTokenLive(t, now)).toBe(true);
  });

  it('expiry boundary matches the refresh route exactly (strict <, falsy-0 = absent)', () => {
    // Refresh route rejects only when `expiresAt && expiresAt < now`, so a
    // token expiring at exactly `now` is still valid and must not be pruned.
    expect(isTokenExpired({ expiresAt: ms(now) }, now)).toBe(false);
    expect(isTokenDead({ expiresAt: ms(now) }, now)).toBe(false);
    expect(isTokenLive({ expiresAt: ms(now) }, now)).toBe(true);
    expect(isTokenExpired({ expiresAt: ms(now - 1) }, now)).toBe(true);
    // A falsy 0 epoch is treated as "no expiry" (matches the route's `&&`).
    expect(isTokenExpired({ expiresAt: ms(0) }, now)).toBe(false);
    expect(isTokenLive({ expiresAt: ms(0) }, now)).toBe(true);
  });
});
