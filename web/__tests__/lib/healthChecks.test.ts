/** @jest-environment node */

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const mockMachineGet = jest.fn();
const mockWebhookGet = jest.fn();
const mockSystemGet = jest.fn();

const mockMachineQuery = {
  orderBy: jest.fn(() => mockMachineQuery),
  limit: jest.fn(() => mockMachineQuery),
  get: mockMachineGet,
};

const mockWebhookQuery = {
  where: jest.fn(() => mockWebhookQuery),
  limit: jest.fn(() => mockWebhookQuery),
  get: mockWebhookGet,
};

const mockDb = {
  collectionGroup: jest.fn(() => mockMachineQuery),
  collection: jest.fn((name: string) => {
    if (name === 'webhook_deliveries') return mockWebhookQuery;
    if (name === 'system_status') {
      return {
        doc: jest.fn(() => ({ get: mockSystemGet })),
      };
    }
    return {
      doc: jest.fn(() => ({ get: jest.fn() })),
    };
  }),
};

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => mockDb,
}));

import {
  agentRegistryHealth,
  apiHealth,
  cortexChatHealth,
  dashboardHealth,
  firestoreHealth,
  r2UploadsHealth,
  runStatusHealthChecks,
  webhookDeliveryHealth,
} from '@/lib/healthChecks.server';

function response(status: number): Response {
  return new Response('', { status });
}

function querySnapshot(docs: Array<{ id: string; data: Record<string, unknown> }>) {
  return {
    docs: docs.map((doc) => ({
      id: doc.id,
      data: () => doc.data,
    })),
  };
}

describe('status health checks', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockImplementation((url: string) => {
      if (url.endsWith('/api/whoami')) return Promise.resolve(response(401));
      return Promise.resolve(response(200));
    });
    mockMachineGet.mockResolvedValue(querySnapshot([
      { id: 'machine-1', data: { lastHeartbeat: { toMillis: () => 1_000_000 } } },
    ]));
    mockWebhookGet.mockResolvedValue(querySnapshot([]));
    mockSystemGet.mockResolvedValue({ exists: true });
  });

  it('marks the dashboard healthy on a 2xx response', async () => {
    mockFetch.mockResolvedValueOnce(response(200));

    const result = await dashboardHealth({ baseUrl: 'https://example.test' });

    expect(result.component).toBe('dashboard');
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
  });

  it('marks the dashboard degraded on a server response', async () => {
    mockFetch.mockResolvedValueOnce(response(503));

    const result = await dashboardHealth({ baseUrl: 'https://example.test' });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('503');
  });

  it('marks the dashboard degraded when fetch throws', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network down'));

    const result = await dashboardHealth({ baseUrl: 'https://example.test' });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('network down');
  });

  it('checks both /api/version and /api/whoami for API liveness', async () => {
    mockFetch
      .mockResolvedValueOnce(response(200))
      .mockResolvedValueOnce(response(401));

    const result = await apiHealth({ baseUrl: 'https://example.test' });

    expect(result.ok).toBe(true);
    expect(result.metadata).toEqual({ version_status: 200, whoami_status: 401 });
  });

  it('marks the API degraded when either probe returns 5xx', async () => {
    mockFetch
      .mockResolvedValueOnce(response(200))
      .mockResolvedValueOnce(response(503));

    const result = await apiHealth({ baseUrl: 'https://example.test' });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('whoami=503');
  });

  it('marks the API degraded when a probe throws', async () => {
    mockFetch.mockRejectedValueOnce(new Error('api unreachable'));

    const result = await apiHealth({ baseUrl: 'https://example.test' });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('api unreachable');
  });

  it('uses the newest machine heartbeat for agent registry health', async () => {
    const result = await agentRegistryHealth({ now: () => 1_000_000 + 60_000 });

    expect(result.ok).toBe(true);
    expect(result.metadata).toMatchObject({ latest_machine_id: 'machine-1' });
  });

  it('marks agent registry degraded when the latest heartbeat is stale', async () => {
    const result = await agentRegistryHealth({ now: () => 1_000_000 + 10 * 60_000 });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('stale');
  });

  it('marks agent registry degraded when Firestore throws', async () => {
    mockMachineGet.mockRejectedValueOnce(new Error('index unavailable'));

    const result = await agentRegistryHealth();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('index unavailable');
  });

  it('passes webhook delivery when the recent success rate is high enough', async () => {
    mockWebhookGet.mockResolvedValueOnce(querySnapshot([
      { id: 'a', data: { state: 'succeeded', createdAt: 1 } },
      { id: 'b', data: { lastStatus: 204, createdAt: 2 } },
    ]));

    const result = await webhookDeliveryHealth({ now: () => 3_600_000 });

    expect(result.ok).toBe(true);
    expect(result.metadata).toMatchObject({ sample_size: 2, success_count: 2 });
  });

  it('marks webhook delivery degraded when recent success rate is too low', async () => {
    mockWebhookGet.mockResolvedValueOnce(querySnapshot([
      { id: 'a', data: { state: 'succeeded', createdAt: 1 } },
      { id: 'b', data: { lastStatus: 500, createdAt: 2 } },
    ]));

    const result = await webhookDeliveryHealth({ now: () => 3_600_000 });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('below');
  });

  it('marks webhook delivery degraded when Firestore throws', async () => {
    mockWebhookGet.mockRejectedValueOnce(new Error('delivery query failed'));

    const result = await webhookDeliveryHealth();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('delivery query failed');
  });

  it('checks Firestore with a small heartbeat read', async () => {
    const result = await firestoreHealth();

    expect(result.component).toBe('firestore');
    expect(result.ok).toBe(true);
    expect(result.metadata).toEqual({ heartbeat_doc_exists: true });
  });

  it('marks Firestore degraded when the heartbeat read is slow', async () => {
    const nowSpy = jest
      .spyOn(Date, 'now')
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_601);

    const result = await firestoreHealth();

    expect(result.ok).toBe(false);
    expect(result.error).toContain('601ms');
    nowSpy.mockRestore();
  });

  it('marks Firestore degraded when the heartbeat read throws', async () => {
    mockSystemGet.mockRejectedValueOnce(new Error('read failed'));

    const result = await firestoreHealth();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('read failed');
  });

  it('keeps uninstrumented R2 and Cortex checks explicitly marked as placeholders', async () => {
    await expect(r2UploadsHealth()).resolves.toMatchObject({
      component: 'r2_uploads',
      ok: true,
      metadata: { placeholder: true },
    });
    await expect(cortexChatHealth()).resolves.toMatchObject({
      component: 'cortex_chat',
      ok: true,
      metadata: { placeholder: true },
    });
  });

  it('runs the seven planned status components', async () => {
    const results = await runStatusHealthChecks({ baseUrl: 'https://example.test' });

    expect(results.map((entry) => entry.component)).toEqual([
      'dashboard',
      'api',
      'agent_registry',
      'webhook_delivery',
      'r2_uploads',
      'firestore',
      'cortex_chat',
    ]);
  });
});
