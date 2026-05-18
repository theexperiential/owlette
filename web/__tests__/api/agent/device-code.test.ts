/** @jest-environment node */
import { NextRequest } from 'next/server';

jest.mock('@/lib/withRateLimit', () => ({
  withRateLimit: <H,>(handler: H): H => handler,
}));

jest.mock('@/lib/logger', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  __esModule: true,
}));

jest.mock('@/lib/pairPhrases', () => ({
  generatePairPhrase: jest.fn().mockReturnValue('test-pair-phrase'),
  normalizePairPhrase: jest.fn((p: string) => (p ? p.toLowerCase().trim() : null)),
}));

const mockGetSession = jest.fn();
jest.mock('@/lib/sessionManager.server', () => ({
  getSessionFromRequest: (...args: unknown[]) => mockGetSession(...args),
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: jest.fn().mockReturnValue('SERVER_TIMESTAMP'),
    delete: jest.fn().mockReturnValue('__DELETE__'),
  },
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
    requireSession: (...args: unknown[]) => mockRequireSession(...args),
    assertUserHasSiteAccess: (...args: unknown[]) =>
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
    collection: (_name: string) => ({
      doc: (_id: string) => mockDocRef,
      where: (..._args: unknown[]) => ({
        limit: (_n: number) => ({
          get: mockWhereGet,
        }),
      }),
    }),
    runTransaction: (fn: (tx: unknown) => Promise<unknown>) => mockRunTransaction(fn),
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
  body: Record<string, unknown>,
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
    // Default: no session → anonymous installer call → interactive flow
    mockGetSession.mockResolvedValue({ userId: null, expiresAt: null });
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

  it('persists deviceCode and wrapVersion on interactive (anonymous) start', async () => {
    const req = makeRequest('/api/agent/auth/device-code', {
      machineId: 'test-machine',
      version: '2.5.9',
    });

    await generatePOST(req);

    const written = mockDocSet.mock.calls[0]![0] as Record<string, unknown>;
    expect(written.wrapVersion).toBe('v1');
    expect(typeof written.deviceCode).toBe('string');
    expect((written.deviceCode as string).length).toBeGreaterThan(40);
    expect(written.preauthorizedIntent).toBeUndefined();
  });

  it('marks dashboard-originated codes as preauthorizedIntent and omits deviceCode', async () => {
    mockGetSession.mockResolvedValue({
      userId: 'user-123',
      expiresAt: Date.now() + 60_000,
    });

    const req = makeRequest('/api/agent/auth/device-code', {});
    await generatePOST(req);

    const written = mockDocSet.mock.calls[0]![0] as Record<string, unknown>;
    expect(written.preauthorizedIntent).toBe(true);
    expect(written.deviceCode).toBeUndefined();
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
    mockRunTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
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

  it('returns 200 with plaintext tokens when polling a pre-authorised doc by phrase', async () => {
    mockDocGet.mockResolvedValue({ exists: true });
    const futureTime = Date.now() + 600_000;
    mockTransactionGet.mockResolvedValue({
      exists: true,
      data: () => ({
        status: 'authorized',
        preauthorized: true,
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

  it('rejects phrase-based polling for an interactive (v1) doc', async () => {
    mockDocGet.mockResolvedValue({ exists: true });
    const futureTime = Date.now() + 600_000;
    mockTransactionGet.mockResolvedValue({
      exists: true,
      data: () => ({
        status: 'authorized',
        wrapVersion: 'v1',
        encryptedCredentials: 'AAAA',
        siteId: 'site-1',
        expiresAt: { toMillis: () => futureTime },
      }),
    });

    const req = makeRequest('/api/agent/auth/device-code/poll', {
      pairPhrase: 'test-pair-phrase',
    });
    const { status, body } = await parseResponse(await pollPOST(req));

    expect(status).toBe(403);
    expect(body.error).toContain('device code');
    expect(mockTransactionDelete).not.toHaveBeenCalled();
  });

  it('returns 200 with encrypted blob when polling a v1 doc by deviceCode', async () => {
    mockWhereGet.mockResolvedValue({
      empty: false,
      docs: [{ ref: { ...mockDocRef, id: 'test-pair-phrase' } }],
    });
    const futureTime = Date.now() + 600_000;
    mockTransactionGet.mockResolvedValue({
      exists: true,
      data: () => ({
        status: 'authorized',
        wrapVersion: 'v1',
        encryptedCredentials: 'ENC',
        expiresAt: { toMillis: () => futureTime },
      }),
    });

    const req = makeRequest('/api/agent/auth/device-code/poll', {
      deviceCode: 'opaque-device-code',
    });
    const { status, body } = await parseResponse(await pollPOST(req));

    expect(status).toBe(200);
    expect(body.wrapVersion).toBe('v1');
    expect(body.encryptedCredentials).toBe('ENC');
    expect(body.phrase).toBe('test-pair-phrase');
    expect(mockTransactionDelete).toHaveBeenCalled();
  });

  it('rejects phrase-based polling for a legacy doc that is not preauthorised', async () => {
    mockDocGet.mockResolvedValue({ exists: true });
    const futureTime = Date.now() + 600_000;
    mockTransactionGet.mockResolvedValue({
      exists: true,
      data: () => ({
        status: 'authorized',
        // no wrapVersion, no preauthorized flag
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

    expect(status).toBe(403);
    expect(body.error).toContain('device code');
    expect(mockTransactionDelete).not.toHaveBeenCalled();
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
    mockRunTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
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
    const { normalizePairPhrase } = jest.requireMock('@/lib/pairPhrases');
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
    const { ApiAuthError } = jest.requireMock('@/lib/apiAuth.server');
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

  it('authorizes interactive (v1) docs by encrypting credentials and wiping plaintext fields', async () => {
    const futureTime = Date.now() + 600_000;
    mockTransactionGet.mockResolvedValue({
      exists: true,
      data: () => ({
        status: 'pending',
        machineId: 'test-machine',
        version: '2.5.9',
        wrapVersion: 'v1',
        deviceCode: 'a'.repeat(86), // base64url of 64 random bytes
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

    const update = mockTransactionUpdate.mock.calls[0]![1] as Record<string, unknown>;
    expect(update.status).toBe('authorized');
    expect(update.wrapVersion).toBe('v1');
    expect(typeof update.encryptedCredentials).toBe('string');
    // Plaintext credential fields and the cleartext deviceCode must all
    // be wiped — they are set to the FieldValue.delete() sentinel
    // ('__DELETE__' in the test mock), not a live string.
    expect(update.accessToken).toBe('__DELETE__');
    expect(update.refreshToken).toBe('__DELETE__');
    expect(update.deviceCode).toBe('__DELETE__');
  });

  it('authorizes pre-authorised docs (no deviceCode on doc) with plaintext + preauthorized flag', async () => {
    const futureTime = Date.now() + 600_000;
    mockTransactionGet.mockResolvedValue({
      exists: true,
      data: () => ({
        status: 'pending',
        machineId: null,
        version: '2.5.9',
        wrapVersion: 'v1',
        preauthorizedIntent: true,
        // deviceCode absent — dashboard origin
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
    const update = mockTransactionUpdate.mock.calls[0]![1] as Record<string, unknown>;
    expect(update.status).toBe('authorized');
    expect(update.preauthorized).toBe(true);
    expect(typeof update.accessToken).toBe('string');
    expect(typeof update.refreshToken).toBe('string');
    expect(update.encryptedCredentials).toBeUndefined();
  });
});
