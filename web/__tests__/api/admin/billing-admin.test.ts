/** @jest-environment node */
/**
 * Superadmin billing routes (billing-system tasks 4.1 + 4.2).
 *
 * Drives the REAL `authorizedPlatformHandler` — only `resolveAuth` is stubbed
 * — so the superadmin gate is genuinely exercised: the 403 arm depends on the
 * `users/{uid}` doc's `role`, exactly as it does in production. The
 * aggregation and the override body are mocked out; their arithmetic is
 * covered in `__tests__/lib/billing/billingOps.test.ts` and
 * `billingOverride.test.ts`.
 */

const auditSetCalls: Array<{ path: string; payload: Record<string, unknown> }> = [];

let userRole: 'superadmin' | 'admin' | 'member' = 'superadmin';
let resolveAuthUserId = 'uid_super';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock('@/lib/firebase-admin', () => {
  const buildDoc = (path: string): unknown => ({
    collection: (sub: string) => buildCol(`${path}/${sub}`),
    get: () => {
      if (path.startsWith('users/')) {
        return Promise.resolve({ exists: true, data: () => ({ role: userRole, sites: [] }) });
      }
      return Promise.resolve({ exists: false, data: () => undefined });
    },
    set: (payload: Record<string, unknown>) => {
      if (path.startsWith('global/audit_log/entries/')) {
        auditSetCalls.push({ path, payload });
      }
      return Promise.resolve();
    },
  });
  const buildCol = (path: string): unknown => ({
    doc: (id?: string) => buildDoc(`${path}/${id ?? 'auto'}`),
  });
  return { getAdminDb: () => ({ collection: (top: string) => buildCol(top) }) };
});

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__SERVER_TS__' },
  Timestamp: { now: () => ({ toMillis: () => 0 }) },
}));

jest.mock('@/lib/apiAuth.server', () => {
  const actual = jest.requireActual('@/lib/apiAuth.server');
  return {
    ...actual,
    resolveAuth: jest.fn(async () => ({ userId: resolveAuthUserId, keyContext: null })),
  };
});

jest.mock('@/lib/securityConfig.server', () => ({
  securityConfig: {
    read: jest.fn(async () => ({
      capability_enforcement: true,
      rate_limit_enforcement: true,
      lastUpdated: 0,
      expiresAt: 0,
    })),
  },
}));

jest.mock('@/lib/rateLimit.server', () => ({
  checkRateLimit: jest.fn(async () => ({ ok: true })),
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { debug: () => {}, info: () => {}, warn: jest.fn(), error: jest.fn() },
}));

const mockEmitMutation = jest.fn();
jest.mock('@/lib/auditLogClient', () => ({
  emitApiKeyUsed: jest.fn(),
  emitMutation: (...args: unknown[]) => mockEmitMutation(...args),
  scopeFingerprint: jest.fn(() => 'fp'),
}));

const mockListCustomers = jest.fn();
const mockBuildOverview = jest.fn();
jest.mock('@/lib/billing/billingOps.server', () => ({
  CUSTOMER_LIST_DEFAULT_LIMIT: 100,
  CUSTOMER_LIST_MAX_LIMIT: 500,
  listBillingCustomers: (...args: unknown[]) => mockListCustomers(...args),
  buildBillingOverview: (...args: unknown[]) => mockBuildOverview(...args),
}));

const mockApplyOverride = jest.fn();
jest.mock('@/lib/billing/billingOverride.server', () => {
  const actual = jest.requireActual('@/lib/billing/billingOverride.server');
  return {
    ...actual,
    applyBillingOverride: (...args: unknown[]) => mockApplyOverride(...args),
  };
});

jest.mock('@/lib/resendClient.server', () => ({
  getResend: () => null,
  FROM_EMAIL: 'noreply@example.com',
  isProduction: false,
}));

/* Imports come AFTER mocks */
import { NextRequest } from 'next/server';
import { GET as customersGET } from '@/app/api/admin/billing/customers/route';
import { POST as overridePOST } from '@/app/api/admin/billing/customers/[uid]/route';
import { GET as overviewGET } from '@/app/api/admin/billing/overview/route';

const LIST_BODY = { customers: [], matched: 0, total: 0, truncated: false };
const OVERVIEW_BODY = {
  generatedAt: 1,
  customers: { total: 0, byState: {}, byTier: {}, comped: 0 },
  mrr: { projectedUsd: 0, accounts: 0, withUsage: 0, latestPeriod: null },
  conversion: { converted: 0, expired: 0, rate: null },
  storage: { alertThreshold: 0.9, topAccounts: [], approachingOverage: [] },
};
const APPLIED = {
  kind: 'applied',
  uid: 'uid_customer',
  operation: 'extend_trial',
  previousBillingState: 'expired',
  billingState: 'trialing',
  trialEndsAt: 1767225600000,
  subscriptionTier: null,
  comped: false,
  clearedTrialEmailMarkers: ['expired'],
  clearedAlertMute: true,
};

function getRequest(url: string): NextRequest {
  return new NextRequest(url);
}

function postRequest(uid: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/admin/billing/customers/${uid}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const params = (uid: string) => ({ params: Promise.resolve({ uid }) });

beforeEach(() => {
  auditSetCalls.length = 0;
  userRole = 'superadmin';
  resolveAuthUserId = 'uid_super';
  mockListCustomers.mockResolvedValue(LIST_BODY);
  mockBuildOverview.mockResolvedValue(OVERVIEW_BODY);
  mockApplyOverride.mockResolvedValue(APPLIED);
});

/* ─── GET /api/admin/billing/customers ─────────────────────────────────── */

describe('GET /api/admin/billing/customers', () => {
  it('returns the list to a superadmin and writes an allow audit', async () => {
    const res = await customersGET(getRequest('http://localhost/api/admin/billing/customers'));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(LIST_BODY);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(auditSetCalls).toHaveLength(1);
    expect(auditSetCalls[0].payload).toMatchObject({
      capability: 'BILLING_MANAGE',
      outcome: 'allow',
    });
  });

  it('passes the search, state, and limit through to the aggregation', async () => {
    await customersGET(
      getRequest('http://localhost/api/admin/billing/customers?q=ana&state=expired&limit=25'),
    );

    expect(mockListCustomers).toHaveBeenCalledWith({
      query: 'ana',
      state: 'expired',
      limit: 25,
    });
  });

  it('defaults the limit when none is supplied', async () => {
    await customersGET(getRequest('http://localhost/api/admin/billing/customers'));
    expect(mockListCustomers).toHaveBeenCalledWith({
      query: undefined,
      state: undefined,
      limit: 100,
    });
  });

  it.each(['admin', 'member'] as const)('rejects a %s with 403', async (role) => {
    userRole = role;

    const res = await customersGET(getRequest('http://localhost/api/admin/billing/customers'));

    expect(res.status).toBe(403);
    expect(mockListCustomers).not.toHaveBeenCalled();
  });

  it('rejects an unknown billing state', async () => {
    const res = await customersGET(
      getRequest('http://localhost/api/admin/billing/customers?state=lapsed'),
    );

    expect(res.status).toBe(400);
    expect(mockListCustomers).not.toHaveBeenCalled();
  });

  it.each(['0', '501', 'abc', '2.5'])('rejects limit=%s', async (limit) => {
    const res = await customersGET(
      getRequest(`http://localhost/api/admin/billing/customers?limit=${limit}`),
    );

    expect(res.status).toBe(400);
    expect(mockListCustomers).not.toHaveBeenCalled();
  });
});

/* ─── POST /api/admin/billing/customers/{uid} ──────────────────────────── */

describe('POST /api/admin/billing/customers/{uid}', () => {
  it('applies an extension and emits one billing_mutated event', async () => {
    const res = await overridePOST(
      postRequest('uid_customer', { operation: 'extend_trial', days: 14 }),
      params('uid_customer'),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      uid: 'uid_customer',
      operation: 'extend_trial',
      previousBillingState: 'expired',
      billingState: 'trialing',
      clearedTrialEmailMarkers: ['expired'],
      clearedAlertMute: true,
    });

    expect(mockApplyOverride).toHaveBeenCalledWith(
      'uid_customer',
      { operation: 'extend_trial', days: 14 },
      'uid_super',
    );

    expect(mockEmitMutation).toHaveBeenCalledTimes(1);
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'billing_mutated',
        siteId: '',
        actor: 'user:uid_super',
        targetId: 'uid_customer',
        attributes: expect.objectContaining({
          endpoint: '/api/admin/billing/customers/uid_customer',
          method: 'POST',
          operation: 'extend_trial',
          from: 'expired',
          to: 'trialing',
        }),
      }),
    );
  });

  it('records the comp reason in the audit attributes', async () => {
    mockApplyOverride.mockResolvedValue({
      ...APPLIED,
      operation: 'set_tier',
      subscriptionTier: 'pro',
      comped: true,
      clearedTrialEmailMarkers: [],
      clearedAlertMute: false,
    });

    await overridePOST(
      postRequest('uid_customer', { operation: 'set_tier', tier: 'pro', note: 'conf sponsor' }),
      params('uid_customer'),
    );

    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        attributes: expect.objectContaining({ note: 'conf sponsor', comped: true }),
      }),
    );
  });

  it.each(['admin', 'member'] as const)('rejects a %s with 403 and mutates nothing', async (role) => {
    userRole = role;

    const res = await overridePOST(
      postRequest('uid_customer', { operation: 'force_expire' }),
      params('uid_customer'),
    );

    expect(res.status).toBe(403);
    expect(mockApplyOverride).not.toHaveBeenCalled();
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it('404s when the account has no billing customer', async () => {
    mockApplyOverride.mockResolvedValue({ kind: 'not_found', uid: 'ghost' });

    const res = await overridePOST(
      postRequest('ghost', { operation: 'force_expire' }),
      params('ghost'),
    );

    expect(res.status).toBe(404);
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it('400s an unparseable body before touching the customer doc', async () => {
    const res = await overridePOST(
      postRequest('uid_customer', { operation: 'refund' }),
      params('uid_customer'),
    );

    expect(res.status).toBe(400);
    expect(mockApplyOverride).not.toHaveBeenCalled();
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it('400s a rejection raised inside the transaction', async () => {
    mockApplyOverride.mockResolvedValue({
      kind: 'invalid_input',
      field: 'body.days',
      message: 'no trial clock yet',
    });

    const res = await overridePOST(
      postRequest('uid_customer', { operation: 'extend_trial', days: 7 }),
      params('uid_customer'),
    );

    expect(res.status).toBe(400);
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it('400s a malformed uid', async () => {
    const res = await overridePOST(
      postRequest('bad uid!', { operation: 'force_expire' }),
      params('bad uid!'),
    );

    expect(res.status).toBe(400);
    expect(mockApplyOverride).not.toHaveBeenCalled();
  });
});

/* ─── GET /api/admin/billing/overview ──────────────────────────────────── */

describe('GET /api/admin/billing/overview', () => {
  it('returns the aggregation to a superadmin', async () => {
    const res = await overviewGET(getRequest('http://localhost/api/admin/billing/overview'));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(OVERVIEW_BODY);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(mockBuildOverview).toHaveBeenCalledTimes(1);
  });

  it.each(['admin', 'member'] as const)('rejects a %s with 403', async (role) => {
    userRole = role;

    const res = await overviewGET(getRequest('http://localhost/api/admin/billing/overview'));

    expect(res.status).toBe(403);
    expect(mockBuildOverview).not.toHaveBeenCalled();
  });
});
