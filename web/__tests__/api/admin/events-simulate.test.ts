/** @jest-environment node */

import { NextRequest } from 'next/server';
import * as mockAuthorizedHandler from '../helpers/authorized-handler-mock';

jest.mock('@/lib/withRateLimit', () => ({
  withRateLimit: <H,>(handler: H): H => handler,
}));
jest.mock('@/lib/logger', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  __esModule: true,
}));
jest.mock('@/lib/authorizedHandler.server', () => mockAuthorizedHandler);

jest.mock('@/lib/apiAuth.server', () => {
  class _ApiAuthError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  return {
    requireAdminOrIdToken: jest.fn().mockResolvedValue('test-admin'),
    assertUserHasSiteAccess: jest
      .fn()
      .mockResolvedValue({ siteId: 'site-1', siteData: { name: 'Test Site' } }),
    ApiAuthError: _ApiAuthError,
  };
});

const mockFireWebhooks = jest.fn().mockResolvedValue(0);
jest.mock('@/lib/webhookSender.server', () => ({
  fireWebhooks: (...args: unknown[]) => mockFireWebhooks(...args),
}));

// getResend returns null when RESEND_API_KEY is unset; the simulator handles
// that branch gracefully and skips the email send. That's the desired test
// posture — focus assertions on the webhook dispatch path.
jest.mock('@/lib/resendClient.server', () => ({
  getResend: jest.fn().mockReturnValue(null),
  FROM_EMAIL: 'test@example.com',
  ENV_LABEL: 'TEST',
  isProduction: false,
}));

jest.mock('@/lib/adminUtils.server', () => ({
  getSiteAlertEmailsWithCc: jest.fn().mockResolvedValue({ to: [], cc: [] }),
  getSiteAlertRecipients: jest.fn().mockResolvedValue([]),
}));

jest.mock('@/app/api/unsubscribe/route', () => ({
  generateUnsubscribeToken: jest.fn().mockReturnValue('test-token'),
}));

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: () => ({
      doc: () => ({
        get: jest.fn().mockResolvedValue({
          exists: true,
          data: () => ({ name: 'Test Site' }),
        }),
        set: jest.fn().mockResolvedValue(undefined),
      }),
    }),
  }),
}));

import { POST } from '@/app/api/admin/events/simulate/route';
import { DISPLAY_EVENT_ROUTING } from '@/lib/alerts/displayEventRouting';

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/admin/events/simulate', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/admin/events/simulate — display events', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFireWebhooks.mockResolvedValue(0);
  });

  const webhookEligibleEvents = Object.entries(DISPLAY_EVENT_ROUTING)
    .filter(([, route]) => route.webhook)
    .map(([eventType, route]) => ({
      eventType,
      webhookEventName: route.webhookEventName,
    }));

  it.each(webhookEligibleEvents)(
    'fires webhook with dotted name for $eventType',
    async ({ eventType, webhookEventName }) => {
      const res = await POST(
        makeRequest({
          siteId: 'site-1',
          event: eventType,
          data: { machineId: 'm1', machineName: 'Machine One' },
        }),
      );
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.event).toBe(eventType);
      expect(mockFireWebhooks).toHaveBeenCalledTimes(1);

      const [siteId, siteName, eventName, payload] = mockFireWebhooks.mock.calls[0];
      expect(siteId).toBe('site-1');
      expect(siteName).toBe('Test Site');
      expect(eventName).toBe(webhookEventName);
      expect(payload).toMatchObject({
        machine: { id: 'm1', name: 'Machine One' },
        simulated: true,
      });
    },
  );

  const dashboardOnlyEvents = Object.entries(DISPLAY_EVENT_ROUTING)
    .filter(([, route]) => !route.webhook && !route.email)
    .map(([eventType]) => ({ eventType }));

  it.each(dashboardOnlyEvents)(
    'does NOT fire webhook for dashboard-only $eventType',
    async ({ eventType }) => {
      const res = await POST(
        makeRequest({
          siteId: 'site-1',
          event: eventType,
          data: { machineId: 'm1', machineName: 'Machine One' },
        }),
      );
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.event).toBe(eventType);
      expect(json.webhooksFired).toBe(0);
      expect(mockFireWebhooks).not.toHaveBeenCalled();
    },
  );

  it('passes through monitor and changes fields on display_drift', async () => {
    const monitor = { friendlyName: 'Center Wall', id: 'mon-1', port: 'DP-2' };
    const changes = ['resolution.width', 'resolution.height'];

    await POST(
      makeRequest({
        siteId: 'site-1',
        event: 'display_drift',
        data: {
          machineId: 'm1',
          machineName: 'Machine One',
          monitor,
          changes,
        },
      }),
    );

    expect(mockFireWebhooks).toHaveBeenCalledTimes(1);
    const payload = mockFireWebhooks.mock.calls[0][3];
    expect(payload).toMatchObject({
      machine: { id: 'm1', name: 'Machine One' },
      monitor,
      changes,
      simulated: true,
    });
  });

  it('passes through applyId on display_apply_failed', async () => {
    await POST(
      makeRequest({
        siteId: 'site-1',
        event: 'display_apply_failed',
        data: {
          machineId: 'm1',
          machineName: 'Machine One',
          applyId: 'apply-abc-123',
        },
      }),
    );

    expect(mockFireWebhooks).toHaveBeenCalledTimes(1);
    const payload = mockFireWebhooks.mock.calls[0][3];
    expect(payload).toMatchObject({
      machine: { id: 'm1', name: 'Machine One' },
      applyId: 'apply-abc-123',
      simulated: true,
    });
  });

  it('reports webhooksFired count from fireWebhooks return value', async () => {
    mockFireWebhooks.mockResolvedValueOnce(3);

    const res = await POST(
      makeRequest({
        siteId: 'site-1',
        event: 'display_drift',
        data: { machineId: 'm1', machineName: 'Machine One' },
      }),
    );
    const json = await res.json();

    expect(json.webhooksFired).toBe(3);
  });
});
