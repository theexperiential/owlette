/** @jest-environment node */

/**
 * Refresh token rotation tests for /api/agent/auth/refresh.
 *
 * The endpoint rotates the refresh token on every successful refresh and
 * leaves the old token usable for a 5-minute grace window (so a client
 * retry after a lost response doesn't kill the session). After grace the
 * old token must be rejected.
 *
 * Constants pulled from the route:
 *   REFRESH_TOKEN_GRACE_MS = 5 * 60 * 1000
 */

import crypto from 'crypto';
import { createMockRequest } from '../helpers/utils';

const mockSetCustomUserClaims = jest.fn();
const mockCreateCustomToken = jest.fn();
const mockRunTransaction = jest.fn();

interface StoredToken {
  siteId: string;
  machineId: string;
  version: string;
  createdBy: string;
  agentUid: string;
  supersededAt?: number;
  supersededBy?: string;
  retiresAt?: number;
  expiresAt?: number;
}

const tokenStore = new Map<string, StoredToken>();

function tokenRef(hash: string) {
  return {
    hash,
    async get() {
      const data = tokenStore.get(hash);
      return {
        exists: !!data,
        data: () =>
          data
            ? {
                ...data,
                expiresAt: data.expiresAt
                  ? { toMillis: () => data.expiresAt as number }
                  : undefined,
                retiresAt: data.retiresAt
                  ? { toMillis: () => data.retiresAt as number }
                  : undefined,
              }
            : undefined,
      };
    },
  };
}

jest.mock('@/lib/firebase-admin', () => ({
  getAdminAuth: () => ({
    setCustomUserClaims: (...a: unknown[]) => mockSetCustomUserClaims(...a),
    createCustomToken: (...a: unknown[]) => mockCreateCustomToken(...a),
  }),
  getAdminDb: () => ({
    collection: (name: string) => ({
      doc: (id: string) =>
        name === 'agent_refresh_tokens'
          ? tokenRef(id)
          : { get: async () => ({ exists: false, data: () => undefined }) },
    }),
    runTransaction: (cb: (tx: unknown) => Promise<unknown>) => {
      mockRunTransaction(cb);
      // Simulate: read source token, check supersession/expiry, write new
      // token, mark old superseded. The callback drives all those.
      const tx = {
        async get(ref: { hash: string }) {
          const data = tokenStore.get(ref.hash);
          return {
            exists: !!data,
            data: () =>
              data
                ? {
                    ...data,
                    expiresAt: data.expiresAt
                      ? { toMillis: () => data.expiresAt as number }
                      : undefined,
                    retiresAt: data.retiresAt
                      ? { toMillis: () => data.retiresAt as number }
                      : undefined,
                  }
                : undefined,
          };
        },
        delete(ref: { hash: string }) {
          tokenStore.delete(ref.hash);
        },
        update(ref: { hash: string }, payload: Record<string, unknown>) {
          const existing = tokenStore.get(ref.hash);
          if (!existing) return;
          tokenStore.set(ref.hash, {
            ...existing,
            supersededAt:
              typeof payload.supersededAt === 'number'
                ? (payload.supersededAt as number)
                : Date.now(),
            supersededBy:
              typeof payload.supersededBy === 'string'
                ? (payload.supersededBy as string)
                : existing.supersededBy,
            retiresAt:
              payload.retiresAt &&
              typeof (payload.retiresAt as { toMillis?: () => number }).toMillis ===
                'function'
                ? (payload.retiresAt as { toMillis: () => number }).toMillis()
                : existing.retiresAt,
          });
        },
        set(ref: { hash: string }, payload: Record<string, unknown>) {
          tokenStore.set(ref.hash, {
            siteId: (payload.siteId as string) ?? 'site-a',
            machineId: (payload.machineId as string) ?? 'm-1',
            version: (payload.version as string) ?? '2.11.3',
            createdBy: (payload.createdBy as string) ?? 'installer',
            agentUid: (payload.agentUid as string) ?? 'agent-uid',
          });
        },
      };
      return cb(tx);
    },
  }),
}));

jest.mock('@/lib/withRateLimit', () => ({
  withRateLimit: (h: unknown) => h,
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

// Stub the Firebase REST token-exchange call.
global.fetch = jest.fn(async () => ({
  ok: true,
  json: async () => ({ idToken: 'new-id-token' }),
})) as unknown as typeof fetch;

import { POST as refreshPOST } from '@/app/api/agent/auth/refresh/route';

function hashOf(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function seedToken(token: string, machineId = 'm-1') {
  tokenStore.set(hashOf(token), {
    siteId: 'site-a',
    machineId,
    version: '2.11.3',
    createdBy: 'installer',
    agentUid: 'agent-uid-1',
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  tokenStore.clear();
  process.env.NEXT_PUBLIC_FIREBASE_API_KEY = 'test-firebase-key';
  mockCreateCustomToken.mockResolvedValue('fake-custom-token');
  mockSetCustomUserClaims.mockResolvedValue(undefined);
});

function refreshReq(token: string, machineId = 'm-1') {
  return createMockRequest('http://localhost/api/agent/auth/refresh', {
    method: 'POST',
    body: { refreshToken: token, machineId },
  });
}

describe('POST /api/agent/auth/refresh — rotation', () => {
  it('first refresh rotates: response carries a NEW refreshToken', async () => {
    seedToken('original-refresh-token');

    const res = await refreshPOST(refreshReq('original-refresh-token'));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.accessToken).toBe('new-id-token');
    expect(typeof body.refreshToken).toBe('string');
    expect(body.refreshToken.length).toBeGreaterThan(40);
    expect(body.refreshToken).not.toBe('original-refresh-token');
    expect(body.expiresIn).toBe(3600);
  });

  it('original token is marked superseded after first refresh', async () => {
    seedToken('original-refresh-token');
    await refreshPOST(refreshReq('original-refresh-token'));

    const stored = tokenStore.get(hashOf('original-refresh-token'));
    expect(stored).toBeTruthy();
    expect(typeof stored!.supersededAt).toBe('number');
    expect(typeof stored!.retiresAt).toBe('number');
  });

  it('original token still works WITHIN the 5-min grace window', async () => {
    seedToken('original-refresh-token');
    // First rotation: marks original superseded with retiresAt = now + 5min.
    const r1 = await refreshPOST(refreshReq('original-refresh-token'));
    expect(r1.status).toBe(200);

    // Manually shrink the original's retiresAt so we KNOW we're still in
    // grace (this is what the route writes — we don't fake time here).
    const stored = tokenStore.get(hashOf('original-refresh-token'));
    expect(stored).toBeTruthy();
    // Already inside grace (retiresAt > now). Try again with the SAME token.
    const r2 = await refreshPOST(refreshReq('original-refresh-token'));
    // The grace-window path: superseded but retiresAt is in the future,
    // so the route should accept and issue another rotation.
    expect(r2.status).toBe(200);
  });

  it('original token is REJECTED past the 5-min grace window', async () => {
    seedToken('original-refresh-token');
    await refreshPOST(refreshReq('original-refresh-token'));

    // Fast-forward the superseded retiresAt into the past.
    const hash = hashOf('original-refresh-token');
    const stored = tokenStore.get(hash);
    if (!stored) throw new Error('seed missing');
    stored.retiresAt = Date.now() - 1; // grace already elapsed
    tokenStore.set(hash, stored);

    const res = await refreshPOST(refreshReq('original-refresh-token'));
    expect(res.status).toBe(401);
  });

  it('machine_id_mismatch when refresh token machineId differs from claim', async () => {
    seedToken('bound-to-m1', 'm-1');
    const res = await refreshPOST(refreshReq('bound-to-m1', 'm-attacker'));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/Machine ID mismatch/);
  });

  it('expired refresh token rejected (when expiresAt set and in past)', async () => {
    const hash = hashOf('expired-token');
    tokenStore.set(hash, {
      siteId: 'site-a',
      machineId: 'm-1',
      version: '2.11.3',
      createdBy: 'installer',
      agentUid: 'agent-uid-1',
      expiresAt: Date.now() - 1000,
    });

    const res = await refreshPOST(refreshReq('expired-token'));
    expect(res.status).toBe(401);
    // The expired token should be deleted by the route.
    expect(tokenStore.has(hash)).toBe(false);
  });
});
