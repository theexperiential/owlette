/** @jest-environment node */

import { NextRequest } from 'next/server';
import type { HealthCheckResult } from '@/lib/healthChecks.server';

const mockRunStatusHealthChecks = jest.fn();
const mockSetInstatusComponentStatus = jest.fn();
const mockStatusSet = jest.fn().mockResolvedValue(undefined);
const mockStatusGet = jest.fn();
const mockCaptureMessage = jest.fn();

const mockStatusCollection = {
  orderBy: jest.fn(() => mockStatusCollection),
  limit: jest.fn(() => mockStatusCollection),
  get: mockStatusGet,
  doc: jest.fn(() => ({ set: mockStatusSet })),
};

const mockDb = {
  collection: jest.fn(() => mockStatusCollection),
};

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: jest.fn(() => ({ __op: 'serverTimestamp' })),
  },
}));

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => mockDb,
}));

jest.mock('@/lib/healthChecks.server', () => {
  const actual = jest.requireActual('@/lib/healthChecks.server');
  return {
    ...actual,
    runStatusHealthChecks: (...args: unknown[]) => mockRunStatusHealthChecks(...args),
  };
});

jest.mock('@/lib/instatusClient', () => {
  const actual = jest.requireActual('@/lib/instatusClient');
  return {
    ...actual,
    setInstatusComponentStatus: (...args: unknown[]) => mockSetInstatusComponentStatus(...args),
  };
});

jest.mock('@sentry/nextjs', () => ({
  captureMessage: (...args: unknown[]) => mockCaptureMessage(...args),
}));

import {
  GET,
  computeComponentStatusUpdates,
} from '@/app/api/cron/status-ping/route';

function health(component: HealthCheckResult['component'], ok: boolean): HealthCheckResult {
  return {
    component,
    ok,
    latency_ms: 12,
    checked_at: '2026-04-28T00:00:00.000Z',
  };
}

function pingDoc(id: string, results: HealthCheckResult[]) {
  return {
    id,
    data: () => ({ observedAtMs: Number(id) || 1, checkedAt: 'x', results }),
  };
}

function querySnapshot(docs: Array<ReturnType<typeof pingDoc>>) {
  return { docs };
}

function request(secret?: string) {
  return new NextRequest('http://localhost/api/cron/status-ping', {
    headers: secret ? { 'x-cron-secret': secret } : {},
  });
}

describe('computeComponentStatusUpdates', () => {
  it('does not post on the first failure', () => {
    const updates = computeComponentStatusUpdates(
      [health('api', false)],
      [health('api', true)],
      [health('api', true)],
    );

    expect(updates).toEqual([]);
  });

  it('posts degraded on the second consecutive failure', () => {
    const updates = computeComponentStatusUpdates(
      [health('api', false)],
      [health('api', false)],
      [health('api', true)],
    );

    expect(updates).toEqual([
      {
        component: 'api',
        previousOk: false,
        currentOk: false,
        status: 'DEGRADEDPERFORMANCE',
        reason: 'second_consecutive_failure',
      },
    ]);
  });

  it('posts operational when a component recovers', () => {
    const updates = computeComponentStatusUpdates(
      [health('api', true)],
      [health('api', false)],
      [health('api', false)],
    );

    expect(updates).toEqual([
      {
        component: 'api',
        previousOk: false,
        currentOk: true,
        status: 'OPERATIONAL',
        reason: 'recovered',
      },
    ]);
  });
});

describe('GET /api/cron/status-ping', () => {
  const originalSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.OWLETTE_STATUS_BASE_URL;
    process.env.CRON_SECRET = 'cron-secret';
    mockStatusGet.mockResolvedValue(querySnapshot([]));
    mockRunStatusHealthChecks.mockResolvedValue([health('api', true)]);
    mockSetInstatusComponentStatus.mockResolvedValue({
      component: 'api',
      status: 'OPERATIONAL',
      ok: true,
    });
  });

  afterAll(() => {
    process.env.CRON_SECRET = originalSecret;
  });

  it('rejects missing cron secret before running checks', async () => {
    const res = await GET(request());

    expect(res.status).toBe(401);
    expect(mockRunStatusHealthChecks).not.toHaveBeenCalled();
  });

  it('writes a status ping for a valid cron request', async () => {
    const res = await GET(request('cron-secret'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toEqual({
      component: 'api',
      ok: true,
      latency_ms: 12,
    });
    expect(body.statusPage.configured).toBe(false);
    expect(mockStatusSet).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        results: [health('api', true)],
      }),
    );
    expect(mockSetInstatusComponentStatus).not.toHaveBeenCalled();
  });

  it('uses OWLETTE_STATUS_BASE_URL when configured', async () => {
    process.env.OWLETTE_STATUS_BASE_URL = 'https://status-target.example';

    const res = await GET(request('cron-secret'));

    expect(res.status).toBe(200);
    expect(mockRunStatusHealthChecks).toHaveBeenCalledWith({
      baseUrl: 'https://status-target.example',
    });
  });

  it('publishes degraded after two consecutive API failures', async () => {
    mockStatusGet.mockResolvedValueOnce(querySnapshot([
      pingDoc('2', [health('api', false)]),
      pingDoc('1', [health('api', true)]),
    ]));
    mockRunStatusHealthChecks.mockResolvedValueOnce([health('api', false)]);
    mockSetInstatusComponentStatus.mockResolvedValueOnce({
      component: 'api',
      status: 'DEGRADEDPERFORMANCE',
      ok: true,
    });

    const res = await GET(request('cron-secret'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.updates).toHaveLength(1);
    expect(mockSetInstatusComponentStatus).toHaveBeenCalledWith('api', 'DEGRADEDPERFORMANCE');
    // Sentry is scoped to alert_delivery — an api degrade still publishes to Instatus
    // but does NOT page Sentry (avoids noise from the pre-existing api probe failures).
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  it('raises Sentry for an alert_delivery degrade (scoped to that component)', async () => {
    mockStatusGet.mockResolvedValueOnce(querySnapshot([
      pingDoc('2', [health('alert_delivery', false)]),
      pingDoc('1', [health('alert_delivery', true)]),
    ]));
    mockRunStatusHealthChecks.mockResolvedValueOnce([health('alert_delivery', false)]);
    mockSetInstatusComponentStatus.mockResolvedValueOnce({
      component: 'alert_delivery',
      status: 'DEGRADEDPERFORMANCE',
      ok: true,
    });

    const res = await GET(request('cron-secret'));

    expect(res.status).toBe(200);
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'status.alert_delivery_degraded',
      expect.objectContaining({
        level: 'error',
        tags: expect.objectContaining({ status_component: 'alert_delivery' }),
      }),
    );
  });

  it('does not publish degraded on a single transient failure', async () => {
    mockStatusGet.mockResolvedValueOnce(querySnapshot([
      pingDoc('2', [health('api', true)]),
      pingDoc('1', [health('api', true)]),
    ]));
    mockRunStatusHealthChecks.mockResolvedValueOnce([health('api', false)]);

    const res = await GET(request('cron-secret'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.updates).toEqual([]);
    expect(mockSetInstatusComponentStatus).not.toHaveBeenCalled();
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  it('publishes operational when a component recovers', async () => {
    mockStatusGet.mockResolvedValueOnce(querySnapshot([
      pingDoc('2', [health('api', false)]),
      pingDoc('1', [health('api', false)]),
    ]));
    mockRunStatusHealthChecks.mockResolvedValueOnce([health('api', true)]);
    mockSetInstatusComponentStatus.mockResolvedValueOnce({
      component: 'api',
      status: 'OPERATIONAL',
      ok: true,
    });

    const res = await GET(request('cron-secret'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.updates).toHaveLength(1);
    expect(mockSetInstatusComponentStatus).toHaveBeenCalledWith('api', 'OPERATIONAL');
  });

  it('records ping results even when status-page publish fails', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockStatusGet.mockResolvedValueOnce(querySnapshot([
      pingDoc('2', [health('api', false)]),
      pingDoc('1', [health('api', true)]),
    ]));
    mockRunStatusHealthChecks.mockResolvedValueOnce([health('api', false)]);
    mockSetInstatusComponentStatus.mockRejectedValueOnce(new Error('instatus unavailable'));

    const res = await GET(request('cron-secret'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockStatusSet).toHaveBeenCalled();
    expect(body.statusPage.publish).toMatchObject({
      attempted: 1,
      succeeded: 0,
      failed: 1,
      skipped: 0,
      failedComponents: ['api'],
    });
    expect(warnSpy).toHaveBeenCalledWith(
      '[cron/status-ping] Instatus publish failed',
      expect.objectContaining({ component: 'api', ok: false }),
    );
    warnSpy.mockRestore();
  });
});
