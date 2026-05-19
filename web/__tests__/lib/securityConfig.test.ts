/** @jest-environment node */

/**
 * Unit tests for `web/lib/securityConfig.server.ts` — the kill-switch config
 * reader. Covers:
 *   - firestore doc read parses both flag fields
 *   - 5-second in-memory ttl cache behavior
 *   - env-var fallback when firestore throws
 *   - auto-expiry: stale `*_expiresAt` re-enables the flag
 *   - flip-state-change emits a warn-level metric
 */

let getDocResult: { exists: boolean; data: unknown } | Error = { exists: false, data: undefined };
const getMock = jest.fn(() => {
  if (getDocResult instanceof Error) return Promise.reject(getDocResult);
  const r = getDocResult;
  return Promise.resolve({ exists: r.exists, data: () => r.data });
});

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: () => ({
      doc: () => ({ get: getMock }),
    }),
  }),
}));

const warnSpy = jest.fn();
const errorSpy = jest.fn();
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    debug: () => {},
    info: () => {},
    warn: (...args: unknown[]) => warnSpy(...args),
    error: (...args: unknown[]) => errorSpy(...args),
  },
}));

import { securityConfig, CACHE_TTL_MS } from '@/lib/securityConfig.server';

beforeEach(() => {
  warnSpy.mockClear();
  errorSpy.mockClear();
  getMock.mockClear();
  getDocResult = { exists: false, data: undefined };
  securityConfig.__resetCacheForTests();
  delete process.env.ENABLE_CAPABILITY_ENFORCEMENT;
  delete process.env.ENABLE_RATE_LIMIT_ENFORCEMENT;
});

describe('securityConfig.read', () => {
  it('returns both flags as true when document does not exist', async () => {
    getDocResult = { exists: false, data: undefined };
    const cfg = await securityConfig.read();
    expect(cfg.capability_enforcement).toBe(true);
    expect(cfg.rate_limit_enforcement).toBe(true);
  });

  it('returns the stored values when document exists', async () => {
    getDocResult = {
      exists: true,
      data: {
        capability_enforcement: false,
        rate_limit_enforcement: false,
        capability_enforcement_expiresAt: { toMillis: () => Date.now() + 1_000_000 },
        rate_limit_enforcement_expiresAt: { toMillis: () => Date.now() + 1_000_000 },
      },
    };
    const cfg = await securityConfig.read();
    expect(cfg.capability_enforcement).toBe(false);
    expect(cfg.rate_limit_enforcement).toBe(false);
  });

  it('caches the read for the ttl window (does not re-call firestore)', async () => {
    getDocResult = { exists: true, data: { capability_enforcement: true, rate_limit_enforcement: true } };
    await securityConfig.read();
    await securityConfig.read();
    await securityConfig.read();
    expect(getMock).toHaveBeenCalledTimes(1);
  });

  it('re-fetches firestore after the cache ttl elapses', async () => {
    jest.useFakeTimers();
    try {
      getDocResult = { exists: true, data: { capability_enforcement: true, rate_limit_enforcement: true } };
      await securityConfig.read();
      expect(getMock).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(CACHE_TTL_MS + 1);
      await securityConfig.read();
      expect(getMock).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('falls back to env vars on firestore failure (default-on)', async () => {
    getDocResult = new Error('firestore unavailable');
    const cfg = await securityConfig.read();
    expect(cfg.capability_enforcement).toBe(true);
    expect(cfg.rate_limit_enforcement).toBe(true);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('honors env-var overrides when firestore is down', async () => {
    process.env.ENABLE_CAPABILITY_ENFORCEMENT = 'false';
    process.env.ENABLE_RATE_LIMIT_ENFORCEMENT = '0';
    getDocResult = new Error('firestore unavailable');
    const cfg = await securityConfig.read();
    expect(cfg.capability_enforcement).toBe(false);
    expect(cfg.rate_limit_enforcement).toBe(false);
  });

  it('treats `false`/`0`/`no` as the disabled signal', async () => {
    for (const value of ['false', '0', 'no', 'False', 'NO']) {
      process.env.ENABLE_CAPABILITY_ENFORCEMENT = value;
      getDocResult = new Error('firestore unavailable');
      securityConfig.__resetCacheForTests();
      const cfg = await securityConfig.read();
      expect(cfg.capability_enforcement).toBe(false);
    }
  });

  it('auto-expiry: stale capability_enforcement expiresAt re-enables flag', async () => {
    const pastMs = Date.now() - 1000;
    getDocResult = {
      exists: true,
      data: {
        capability_enforcement: false,
        rate_limit_enforcement: false,
        capability_enforcement_expiresAt: pastMs,
        rate_limit_enforcement_expiresAt: { toMillis: () => Date.now() + 1_000_000 },
      },
    };
    const cfg = await securityConfig.read();
    // Capability expired -> re-enabled regardless of stored false.
    expect(cfg.capability_enforcement).toBe(true);
    // Rate limit still active.
    expect(cfg.rate_limit_enforcement).toBe(false);
  });

  it('auto-expiry: stale rate_limit_enforcement expiresAt re-enables flag', async () => {
    const futureMs = Date.now() + 1_000_000;
    getDocResult = {
      exists: true,
      data: {
        capability_enforcement: false,
        rate_limit_enforcement: false,
        capability_enforcement_expiresAt: { toMillis: () => futureMs },
        rate_limit_enforcement_expiresAt: { toMillis: () => Date.now() - 1000 },
      },
    };
    const cfg = await securityConfig.read();
    expect(cfg.capability_enforcement).toBe(false);
    expect(cfg.rate_limit_enforcement).toBe(true);
  });

  it('warns when a flag flips state between reads', async () => {
    jest.useFakeTimers();
    try {
      getDocResult = { exists: true, data: { capability_enforcement: true, rate_limit_enforcement: true } };
      await securityConfig.read();
      expect(warnSpy).not.toHaveBeenCalled();

      jest.advanceTimersByTime(CACHE_TTL_MS + 1);
      getDocResult = {
        exists: true,
        data: {
          capability_enforcement: false,
          rate_limit_enforcement: true,
          capability_enforcement_expiresAt: { toMillis: () => Date.now() + 100_000 },
        },
      };
      await securityConfig.read();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [msg] = warnSpy.mock.calls[0];
      expect(msg).toMatch(/enforcement flag changed/i);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not warn when no flags change between reads', async () => {
    jest.useFakeTimers();
    try {
      getDocResult = { exists: true, data: { capability_enforcement: true, rate_limit_enforcement: true } };
      await securityConfig.read();
      jest.advanceTimersByTime(CACHE_TTL_MS + 1);
      await securityConfig.read();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});
