/** @jest-environment node */

/**
 * Talon-tap placement tests for `POST /api/agent/alert`.
 *
 * The route taps the talon matcher for every authorized event it accepts —
 * EXCEPT display events. Display talons are fired by the firestore trigger in
 * `functions/src/talonLogEvents.ts` off the agent's `sites/{siteId}/logs`
 * write, which every agent performs whether or not it also posts here. Tapping
 * in both places would double-run every display talon on an agent new enough
 * to send the alert (3.0.0+, when `send_display_alert` regained its call
 * sites).
 *
 * These tests pin that asymmetry: display in, no tap; process in, tap.
 */

import { createMockRequest } from '../helpers/utils';

// --- Mocks (declared before importing the route) -----------------------------

const tapTalonMatcherMock = jest.fn();
const fireWebhooksMock = jest.fn().mockResolvedValue(undefined);
const mockVerifyIdToken = jest.fn();
const pendingDisplayAdd = jest.fn().mockResolvedValue(undefined);
const pendingProcessAdd = jest.fn().mockResolvedValue(undefined);
const siteLogsAdd = jest.fn().mockResolvedValue(undefined);

const siteDocRef = {
  get: async () => ({ data: () => ({ name: 'test site' }) }),
  collection: (name: string) => {
    if (name === 'logs') return { add: siteLogsAdd };
    // `machines` — read by the local-Hoot probe on the process branch.
    if (name === 'machines') {
      return { doc: () => ({ get: async () => ({ exists: false, data: () => undefined }) }) };
    }
    throw new Error(`unexpected subcollection: ${name}`);
  },
};

const mockDb = {
  collection: jest.fn((name: string) => {
    if (name === 'pending_display_alerts') return { add: pendingDisplayAdd };
    if (name === 'pending_process_alerts') return { add: pendingProcessAdd };
    if (name === 'sites') return { doc: () => siteDocRef };
    throw new Error(`unexpected collection: ${name}`);
  }),
};

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: jest.fn(() => ({ __op: 'serverTimestamp' })) },
}));

jest.mock('@/lib/firebase-admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: (...args: unknown[]) => mockVerifyIdToken(...args) }),
  getAdminDb: () => mockDb,
}));

jest.mock('@/lib/withRateLimit', () => ({
  withRateLimit: (h: unknown) => h,
}));

// No Upstash in unit tests: both limiters resolve to null upstream, which the
// route reads as "limiter unavailable, let it through". Mirrored explicitly so
// the test doesn't depend on the ambient env.
jest.mock('@/lib/rateLimit', () => ({
  checkRateLimit: jest.fn(async () => ({ success: true })),
  processAlertRateLimit: null,
  getDisplayAlertRateLimit: () => null,
}));

jest.mock('@/lib/webhookSender.server', () => ({
  fireWebhooks: (...args: unknown[]) => fireWebhooksMock(...args),
}));

jest.mock('@/lib/adminUtils.server', () => ({
  getSiteAlertRecipients: jest.fn(async () => []),
  getMachineTimezone: jest.fn(async () => 'UTC'),
  getSiteLabel: jest.fn(async (siteId: string) => siteId),
}));

jest.mock('@/lib/resendClient.server', () => ({
  getResend: () => null,
  FROM_EMAIL: 'noreply@mail.owlette.app',
  ENV_LABEL: 'test',
}));

jest.mock('@/app/api/unsubscribe/route', () => ({
  generateUnsubscribeToken: () => 'unsub-token',
}));

// The matcher itself is covered by `__tests__/lib/talons/matcher.test.ts`;
// here only whether the route reaches it matters.
jest.mock('@/lib/talons/matcher.server', () => ({
  tapTalonMatcher: (...args: unknown[]) => tapTalonMatcherMock(...args),
}));

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

import { POST as alertPOST } from '@/app/api/agent/alert/route';

// --- Helpers -----------------------------------------------------------------

const SITE = 'site-a';
const MACHINE = 'machine-1';

function post(body: Record<string, unknown>) {
  return alertPOST(
    createMockRequest('http://localhost/api/agent/alert', {
      method: 'POST',
      headers: { Authorization: 'Bearer fake-token' },
      body: { siteId: SITE, machineId: MACHINE, agentVersion: '3.0.0', ...body },
    }),
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockVerifyIdToken.mockResolvedValue({
    role: 'agent',
    site_id: SITE,
    machine_id: MACHINE,
  });
  delete process.env.CORTEX_INTERNAL_SECRET;
});

// --- Tests -------------------------------------------------------------------

describe('POST /api/agent/alert — talon tap', () => {
  it.each([
    // one from each routing tier: email+webhook, webhook-only, dashboard-only
    ['display_monitor_removed'],
    ['display_drift'],
    ['display_apply_succeeded'],
  ])('does not tap the matcher for %s (logs trigger is the single source)', async (eventType) => {
    const res = await post({
      eventType,
      data: { monitor: { edidHash: 'abc', friendlyName: 'DELL P2415Q', port: 'DP' } },
    });

    expect(res.status).toBe(200);
    expect(tapTalonMatcherMock).not.toHaveBeenCalled();
  });

  it('still routes the display event it declined to tap', async () => {
    const res = await post({ eventType: 'display_drift', data: { changes: ['refreshHz'] } });

    expect(await res.json()).toMatchObject({ success: true, webhookFired: true });
    expect(fireWebhooksMock).toHaveBeenCalledWith(
      SITE,
      'test site',
      'display.drift',
      expect.objectContaining({ machine: { id: MACHINE, name: MACHINE } }),
    );
  });

  it('taps the matcher for a process event', async () => {
    const res = await post({
      eventType: 'process_crash',
      processName: 'TouchDesigner.exe',
      errorMessage: 'exited unexpectedly',
    });

    expect(res.status).toBe(200);
    expect(tapTalonMatcherMock).toHaveBeenCalledTimes(1);
    expect(tapTalonMatcherMock).toHaveBeenCalledWith(mockDb, SITE, {
      kind: 'event',
      eventType: 'process_crash',
      machineId: MACHINE,
    });
  });

  it('taps the matcher for a connection failure', async () => {
    const res = await post({ errorCode: 'CONN_FAIL', errorMessage: 'no route to host' });

    expect(res.status).toBe(200);
    expect(tapTalonMatcherMock).toHaveBeenCalledTimes(1);
    expect(tapTalonMatcherMock).toHaveBeenCalledWith(mockDb, SITE, {
      kind: 'event',
      eventType: 'connection_failure',
      machineId: MACHINE,
    });
  });

  it('taps the matcher for an unregistered display_* event (generic branch)', async () => {
    // `display_apply_acked` has no `DISPLAY_EVENT_ROUTING` entry, so it is not
    // a display event by the route's definition and no talon can subscribe to
    // it. The tap is harmless (the matcher short-circuits an event outside the
    // catalog) — asserted here so the skip stays scoped to the ten routed
    // types rather than the `display_` prefix.
    const res = await post({ eventType: 'display_apply_acked', data: { applyId: 'a1' } });

    expect(res.status).toBe(200);
    expect(tapTalonMatcherMock).toHaveBeenCalledWith(mockDb, SITE, {
      kind: 'event',
      eventType: 'display_apply_acked',
      machineId: MACHINE,
    });
  });
});
