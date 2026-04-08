/** @jest-environment node */
import { NextRequest } from 'next/server';

jest.mock('@/lib/withRateLimit', () => ({
  withRateLimit: (handler: any) => handler,
}));

jest.mock('@/lib/logger', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  __esModule: true,
}));

jest.mock('@/lib/pairPhrases', () => ({
  generatePairPhrase: jest.fn().mockReturnValue('test-pair-phrase'),
  normalizePairPhrase: jest.fn((p: string) => (p ? p.toLowerCase().trim() : null)),
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: jest.fn().mockReturnValue('SERVER_TIMESTAMP') },
  Timestamp: {
    fromDate: jest.fn((d: Date) => ({ toMillis: () => d.getTime() })),
  },
}));

const mockRequireSession = jest.fn().mockResolvedValue('user-123');
const mockAssertUserHasSiteAccess = jest
  .fn()
  .mockResolvedValue({ siteId: 'site-1', siteData: {} });

jest.mock('@/lib/apiAuth.server', () => {
  class _ApiAuthError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  return {
    requireSession: (...args: any[]) => mockRequireSession(...args),
    assertUserHasSiteAccess: (...args: any[]) =>
      mockAssertUserHasSiteAccess(...args),
    ApiAuthError: _ApiAuthError,
  };
});

const mockDocGet = jest.fn();
const mockDocSet = jest.fn();
const mockWhereGet = jest.fn();
const mockTransactionGet = jest.fn();
const mockTransactionSet = jest.fn();
const mockTransactionUpdate = jest.fn();
const mockTransactionDelete = jest.fn();
const mockRunTransaction = jest.fn();
const mockCreateCustomToken = jest.fn().mockResolvedValue('mock-custom-token');
const mockSetCustomUserClaims = jest.fn().mockResolvedValue(undefined);

const mockDocRef = {
  get: mockDocGet,
  set: mockDocSet,
};

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (name: string) => ({
      doc: (id: string) => mockDocRef,
      where: (...args: any[]) => ({
        limit: (n: number) => ({
          get: mockWhereGet,
        }),
      }),
    }),
    runTransaction: (fn: any) => mockRunTransaction(fn),
  }),
  getAdminAuth: () => ({
    createCustomToken: mockCreateCustomToken,
    setCustomUserClaims: mockSetCustomUserClaims,
  }),
}));

import { POST as generatePOST } from '@/app/api/agent/auth/device-code/route';
import { POST as pollPOST } from '@/app/api/agent/auth/device-code/poll/route';
import { POST as authorizePOST } from '@/app/api/agent/auth/device-code/authorize/route';

function makeRequest(
  path: string,
  body: Record<string, any>,
): NextRequest {
  return new NextRequest(new URL(`http://localhost${path}`), {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

async function parseResponse(res: Response) {
  return { status: res.status, body: await res.json() };
}

describe('POST /api/agent/auth/device-code (generate)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDocGet.mockResolvedValue({ exists: false });
    mockDocSet.mockResolvedValue(undefined);
  });

  it('returns pairing phrase, deviceCode, and URLs on success', async () => {
    const req = makeRequest('/api/agent/auth/device-code', {
      machineId: 'test-machine',
      version: '2.5.9',
    });

    const { status, body } = await parseResponse(await generatePOST(req));

    expect(status).toBe(200);
    expect(body.pairPhrase).toBe('test-pair-phrase');
    expect(body.deviceCode).toBeDefined();
    expect(body.verificationUri).toMatch(/\/add$/);
    expect(body.pairingUrl).toContain('/add?code=');
    expect(body.expiresIn).toBe(600);
    expect(body.interval).toBe(5);
    expect(mockDocSet).toHaveBeenCalledTimes(1);
  });

  it('returns 500 after 5 collision attempts', async () => {
    mockDocGet.mockResolvedValue({ exists: true });

    const req = makeRequest('/api/agent/auth/device-code', {
      machineId: 'test-machine',
      version: '2.5.9',
    });

    const { status, body } = await parseResponse(await generatePOST(req));

    expect(status).toBe(500);
    expect(body.error).toContain('unique pairing phrase');
    expect(mockDocGet).toHaveBeenCalledTimes(5);
  });
});

describe('POST /api/agent/auth/device-code/poll', () => {
  const mockTransaction = {
    get: mockTransactionGet,
    set: mockTransactionSet,
    update: mockTransactionUpdate,
    delete: mockTransactionDelete,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockRunTransaction.mockImplementation(async (fn: any) =>
      fn(mockTransaction),
    );
  });

  it('returns 400 when neither deviceCode nor pairPhrase provided', async () => {
    const req = makeRequest('/api/agent/auth/device-code/poll', {});
    const { status, body } = await parseResponse(await pollPOST(req));

    expect(status).toBe(400);
    expect(body.error).toContain('Missing required field');
  });

  it('returns 404 for invalid pairPhrase', async () => {
    mockDocGet.mockResolvedValue({ exists: false });

    const req = makeRequest('/api/agent/auth/device-code/poll', {
      pairPhrase: 'bad-phrase-here',
    });
    const { status, body } = await parseResponse(await pollPOST(req));

    expect(status).toBe(404);
    expect(body.error).toContain('Invalid pairing phrase');
  });

  it('returns 404 for invalid deviceCode', async () => {
    mockWhereGet.mockResolvedValue({ empty: true });

    const req = makeRequest('/api/agent/auth/device-code/poll', {
      deviceCode: 'invalid-code',
    });
    const { status, body } = await parseResponse(await pollPOST(req));

    expect(status).toBe(404);
    expect(body.error).toContain('Invalid device code');
  });

  it('returns 202 with pending status', async () => {
    mockDocGet.mockResolvedValue({ exists: true });
    const futureTime = Date.now() + 600_000;
    mockTransactionGet.mockResolvedValue({
      exists: true,
      data: () => ({
        status: 'pending',
        expiresAt: { toMillis: () => futureTime },
      }),
    });

    const req = makeRequest('/api/agent/auth/device-code/poll', {
      pairPhrase: 'test-pair-phrase',
    });
    const { status, body } = await parseResponse(await pollPOST(req));

    expect(status).toBe(202);
    expect(body.status).toBe('pending');
  });

  it('returns 200 with tokens when authorized', async () => {
    mockDocGet.mockResolvedValue({ exists: true });
    const futureTime = Date.now() + 600_000;
    mockTransactionGet.mockResolvedValue({
      exists: true,
      data: () => ({
        status: 'authorized',
        accessToken: 'mock-access-token',
        refreshToken: 'mock-refresh-token',
        siteId: 'site-1',
        expiresAt: { toMillis: () => futureTime },
      }),
    });

    const req = makeRequest('/api/agent/auth/device-code/poll', {
      pairPhrase: 'test-pair-phrase',
    });
    const { status, body } = await parseResponse(await pollPOST(req));

    expect(status).toBe(200);
    expect(body.accessToken).toBe('mock-access-token');
    expect(body.refreshToken).toBe('mock-refresh-token');
    expect(body.expiresIn).toBe(3600);
    expect(body.siteId).toBe('site-1');
    expect(mockTransactionDelete).toHaveBeenCalled();
  });

  it('returns 410 when device code is expired', async () => {
    mockDocGet.mockResolvedValue({ exists: true });
    const pastTime = Date.now() - 1000;
    mockTransactionGet.mockResolvedValue({
      exists: true,
      data: () => ({
        status: 'pending',
        expiresAt: { toMillis: () => pastTime },
      }),
    });

    const req = makeRequest('/api/agent/auth/device-code/poll', {
      pairPhrase: 'test-pair-phrase',
    });
    const { status, body } = await parseResponse(await pollPOST(req));

    expect(status).toBe(410);
    expect(body.error).toBe('expired');
    expect(mockTransactionDelete).toHaveBeenCalled();
  });
});

describe('POST /api/agent/auth/device-code/authorize', () => {
  const mockTransaction = {
    get: mockTransactionGet,
    set: mockTransactionSet,
    update: mockTransactionUpdate,
    delete: mockTransactionDelete,
  };

  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireSession.mockResolvedValue('user-123');
    mockAssertUserHasSiteAccess.mockResolvedValue({
      siteId: 'site-1',
      siteData: {},
    });
    mockRunTransaction.mockImplementation(async (fn: any) =>
      fn(mockTransaction),
    );
    process.env.NEXT_PUBLIC_FIREBASE_API_KEY = 'test-api-key';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        idToken: 'mock-id-token',
        refreshToken: 'mock-refresh',
      }),
    });
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('returns 400 when pairPhrase is missing', async () => {
    const req = makeRequest('/api/agent/auth/device-code/authorize', {
      siteId: 'site-1',
    });
    const { status, body } = await parseResponse(await authorizePOST(req));

    expect(status).toBe(400);
    expect(body.error).toContain('Missing required fields');
  });

  it('returns 400 when siteId is missing', async () => {
    const req = makeRequest('/api/agent/auth/device-code/authorize', {
      pairPhrase: 'test-pair-phrase',
    });
    const { status, body } = await parseResponse(await authorizePOST(req));

    expect(status).toBe(400);
    expect(body.error).toContain('Missing required fields');
  });

  it('returns 400 for invalid phrase format', async () => {
    const { normalizePairPhrase } = require('@/lib/pairPhrases');
    normalizePairPhrase.mockReturnValueOnce(null);

    const req = makeRequest('/api/agent/auth/device-code/authorize', {
      pairPhrase: 'bad',
      siteId: 'site-1',
    });
    const { status, body } = await parseResponse(await authorizePOST(req));

    expect(status).toBe(400);
    expect(body.error).toContain('Invalid pairing phrase format');
  });

  it('returns 401 when not authenticated', async () => {
    const { ApiAuthError } = require('@/lib/apiAuth.server');
    mockRequireSession.mockRejectedValueOnce(
      new ApiAuthError(401, 'Unauthorized'),
    );

    const req = makeRequest('/api/agent/auth/device-code/authorize', {
      pairPhrase: 'test-pair-phrase',
      siteId: 'site-1',
    });
    const { status, body } = await parseResponse(await authorizePOST(req));

    expect(status).toBe(401);
    expect(body.error).toBe('Unauthorized');
  });

  it('returns 404 when phrase not found in Firestore', async () => {
    mockTransactionGet.mockResolvedValue({ exists: false });

    const req = makeRequest('/api/agent/auth/device-code/authorize', {
      pairPhrase: 'test-pair-phrase',
      siteId: 'site-1',
    });
    const { status, body } = await parseResponse(await authorizePOST(req));

    expect(status).toBe(404);
    expect(body.error).toContain('not found');
  });

  it('returns 409 when phrase already authorized', async () => {
    const futureTime = Date.now() + 600_000;
    mockTransactionGet.mockResolvedValue({
      exists: true,
      data: () => ({
        status: 'authorized',
        expiresAt: { toMillis: () => futureTime },
      }),
    });

    const req = makeRequest('/api/agent/auth/device-code/authorize', {
      pairPhrase: 'test-pair-phrase',
      siteId: 'site-1',
    });
    const { status, body } = await parseResponse(await authorizePOST(req));

    expect(status).toBe(409);
    expect(body.error).toContain('already been used');
  });

  it('authorizes successfully and returns machineId', async () => {
    const futureTime = Date.now() + 600_000;
    mockTransactionGet.mockResolvedValue({
      exists: true,
      data: () => ({
        status: 'pending',
        machineId: 'test-machine',
        version: '2.5.9',
        expiresAt: { toMillis: () => futureTime },
      }),
    });

    const req = makeRequest('/api/agent/auth/device-code/authorize', {
      pairPhrase: 'test-pair-phrase',
      siteId: 'site-1',
    });
    const { status, body } = await parseResponse(await authorizePOST(req));

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.machineId).toBe('test-machine');
    expect(mockCreateCustomToken).toHaveBeenCalled();
    expect(mockTransactionSet).toHaveBeenCalled();
    expect(mockTransactionUpdate).toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});
