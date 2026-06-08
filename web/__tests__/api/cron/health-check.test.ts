/** @jest-environment node */

import { NextRequest } from 'next/server';

// --- Mocks (declared before importing the route) -----------------------------

const machineRefSet = jest.fn().mockResolvedValue(undefined);
const emailSend = jest.fn().mockResolvedValue({ error: null });
const fireWebhooksMock = jest.fn().mockResolvedValue(undefined);
const getSiteAlertRecipientsMock = jest.fn();

const mockMachinesGet = jest.fn();
const mockSitesGet = jest.fn();
const mockSiteGet = jest.fn(async () => ({ data: () => ({ name: 'node-pa' }) }));

const siteDocRef = {
  collection: jest.fn((name: string) => {
    if (name !== 'machines') throw new Error(`unexpected subcollection: ${name}`);
    return { get: mockMachinesGet };
  }),
  get: mockSiteGet,
};
const sitesCollection = {
  get: mockSitesGet,
  doc: jest.fn((id: string) => {
    if (id !== 'node-pa') throw new Error(`unexpected site doc: ${id}`);
    return siteDocRef;
  }),
};
const mockDb = {
  collection: jest.fn((name: string) => {
    if (name !== 'sites') throw new Error(`unexpected collection: ${name}`);
    return sitesCollection;
  }),
};

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: jest.fn(() => ({ __op: 'serverTimestamp' })),
    delete: jest.fn(() => ({ __op: 'delete' })),
  },
}));

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => mockDb,
}));

jest.mock('@/lib/adminUtils.server', () => ({
  getSiteAlertRecipients: (...args: unknown[]) => getSiteAlertRecipientsMock(...args),
}));

jest.mock('@/lib/resendClient.server', () => ({
  getResend: () => ({ emails: { send: emailSend } }),
  FROM_EMAIL: 'noreply@mail.owlette.app',
}));

jest.mock('@/app/api/unsubscribe/route', () => ({
  generateUnsubscribeToken: () => 'unsub-token',
}));

jest.mock('@/lib/webhookSender.server', () => ({
  fireWebhooks: (...args: unknown[]) => fireWebhooksMock(...args),
}));

import { GET, classifyMachineHealth } from '@/app/api/cron/health-check/route';
import type { MachineHealthSnapshot } from '@/app/api/cron/health-check/route';

// --- Helpers -----------------------------------------------------------------

const MIN = 60 * 1000;
const NOW = 1_700_000_000_000; // fixed reference for the pure-function tests

function snapshot(overrides: Partial<MachineHealthSnapshot> = {}): MachineHealthSnapshot {
  return {
    online: true,
    lastHeartbeatMs: NOW - 10 * MIN, // stale by default
    lastCronAlertAtMs: 0,
    staleSinceMs: 0,
    rebooting: false,
    shuttingDown: false,
    rebootScheduledAtSec: 0,
    shutdownScheduledAtSec: 0,
    ...overrides,
  };
}

const ts = (ms: number) => ({ toMillis: () => ms });

function machineDoc(id: string, data: Record<string, unknown>) {
  return { id, data: () => data, ref: { set: machineRefSet } };
}

function request(secret?: string) {
  return new NextRequest('http://localhost/api/cron/health-check', {
    headers: secret ? { 'x-cron-secret': secret } : {},
  });
}

// --- Pure decision logic (Fix A + B) -----------------------------------------

describe('classifyMachineHealth', () => {
  it('ignores machines the agent reports offline', () => {
    expect(classifyMachineHealth(snapshot({ online: false }), NOW)).toEqual({
      action: 'ignore',
      reason: 'offline-flag',
    });
  });

  it('treats a fresh heartbeat as ok', () => {
    expect(classifyMachineHealth(snapshot({ lastHeartbeatMs: NOW - 60 * 1000 }), NOW)).toEqual({
      action: 'ok',
    });
  });

  it('treats a heartbeat exactly at the threshold as ok (boundary)', () => {
    expect(classifyMachineHealth(snapshot({ lastHeartbeatMs: NOW - 3 * MIN }), NOW)).toEqual({
      action: 'ok',
    });
  });

  it('suppresses a stale machine inside its announced reboot window', () => {
    const m = snapshot({
      rebooting: true,
      rebootScheduledAtSec: Math.floor((NOW - 2 * MIN) / 1000),
    });
    expect(classifyMachineHealth(m, NOW)).toEqual({ action: 'ignore', reason: 'planned-downtime' });
  });

  it('suppresses a stale machine inside its announced shutdown window', () => {
    const m = snapshot({
      shuttingDown: true,
      shutdownScheduledAtSec: Math.floor((NOW - 2 * MIN) / 1000),
    });
    expect(classifyMachineHealth(m, NOW)).toEqual({ action: 'ignore', reason: 'planned-downtime' });
  });

  it('alerts once a reboot window has elapsed (machine never came back)', () => {
    // Flag still set but scheduled 20 min ago — past the 15 min upper bound. Confirmed stale.
    const m = snapshot({
      lastHeartbeatMs: NOW - 20 * MIN,
      rebooting: true,
      rebootScheduledAtSec: Math.floor((NOW - 20 * MIN) / 1000),
      staleSinceMs: NOW - 16 * MIN,
    });
    expect(classifyMachineHealth(m, NOW)).toEqual({ action: 'alert', heartbeatAgeMinutes: 20 });
  });

  it('does NOT suppress when the in-progress flag is unset even if the anchor lingers', () => {
    // shutdown-cancel clears `shuttingDown` but can leave `shutdownScheduledAt` behind.
    const m = snapshot({
      shuttingDown: false,
      shutdownScheduledAtSec: Math.floor((NOW - 2 * MIN) / 1000),
      staleSinceMs: NOW - 6 * MIN,
    });
    expect(classifyMachineHealth(m, NOW)).toEqual({ action: 'alert', heartbeatAgeMinutes: 10 });
  });

  it('does NOT suppress a far-future scheduled instant (clock skew) even with the flag set', () => {
    const m = snapshot({
      rebooting: true,
      rebootScheduledAtSec: Math.floor((NOW + 60 * MIN) / 1000), // below the lower bound
      staleSinceMs: NOW - 6 * MIN,
    });
    expect(classifyMachineHealth(m, NOW)).toEqual({ action: 'alert', heartbeatAgeMinutes: 10 });
  });

  it('ignores a machine still within the alert cooldown', () => {
    const m = snapshot({ lastCronAlertAtMs: NOW - 30 * MIN, staleSinceMs: NOW - 30 * MIN });
    expect(classifyMachineHealth(m, NOW)).toEqual({ action: 'ignore', reason: 'cooldown' });
  });

  it('debounces the first stale observation instead of alerting', () => {
    expect(classifyMachineHealth(snapshot({ staleSinceMs: 0 }), NOW)).toEqual({ action: 'debounce' });
  });

  it('keeps debouncing until stale is confirmed for long enough', () => {
    const m = snapshot({ lastHeartbeatMs: NOW - 4 * MIN, staleSinceMs: NOW - 2 * MIN });
    expect(classifyMachineHealth(m, NOW)).toEqual({ action: 'debounce' });
  });

  it('alerts once staleness is confirmed across scans', () => {
    const m = snapshot({ lastHeartbeatMs: NOW - 10 * MIN, staleSinceMs: NOW - 6 * MIN });
    expect(classifyMachineHealth(m, NOW)).toEqual({ action: 'alert', heartbeatAgeMinutes: 10 });
  });

  it('re-alerts after the cooldown lapses for a persistently down machine', () => {
    const m = snapshot({
      lastHeartbeatMs: NOW - 70 * MIN,
      lastCronAlertAtMs: NOW - 70 * MIN,
      staleSinceMs: NOW - 70 * MIN,
    });
    expect(classifyMachineHealth(m, NOW)).toEqual({ action: 'alert', heartbeatAgeMinutes: 70 });
  });
});

// --- GET handler wiring (seconds->ms extraction + side effects) --------------

describe('GET /api/cron/health-check', () => {
  const originalSecret = process.env.CRON_SECRET;
  const now = Date.now();
  const sec = (ms: number) => Math.floor(ms / 1000);

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CRON_SECRET = 'cron-secret';
    mockSitesGet.mockResolvedValue({ size: 1, docs: [{ id: 'node-pa' }] });
    getSiteAlertRecipientsMock.mockResolvedValue([
      { userId: 'u1', email: 'admin@node-pa.test', ccEmails: [], mutedMachines: [] },
    ]);
  });

  afterAll(() => {
    process.env.CRON_SECRET = originalSecret;
  });

  it('rejects a request without the cron secret', async () => {
    const res = await GET(request());
    expect(res.status).toBe(401);
    expect(mockSitesGet).not.toHaveBeenCalled();
  });

  it('emails for a machine that is confirmed-stale and online', async () => {
    mockMachinesGet.mockResolvedValue({
      size: 1,
      docs: [
        machineDoc('INF-RENDER-SPARE', {
          online: true,
          lastHeartbeat: ts(now - 10 * MIN),
          machine_timezone: 'America/New_York',
          health: { staleSince: ts(now - 6 * MIN) },
        }),
      ],
    });

    const res = await GET(request('cron-secret'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.alertsSent).toBe(1);
    expect(emailSend).toHaveBeenCalledTimes(1);
    // dedup stamp written
    expect(machineRefSet).toHaveBeenCalledWith(
      { health: { lastCronAlertAt: { __op: 'serverTimestamp' } } },
      { merge: true }
    );
  });

  it('does NOT email a stale machine inside its scheduled reboot window', async () => {
    mockMachinesGet.mockResolvedValue({
      size: 1,
      docs: [
        machineDoc('INF-RENDER-SPARE', {
          online: true,
          lastHeartbeat: ts(now - 10 * MIN),
          rebootScheduledAt: sec(now - 2 * MIN), // Unix seconds, inside grace
          rebooting: true,
        }),
      ],
    });

    const res = await GET(request('cron-secret'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.alertsSent).toBe(0);
    expect(emailSend).not.toHaveBeenCalled();
    expect(machineRefSet).not.toHaveBeenCalled();
  });

  it('debounces a first-seen stale machine (records staleSince, no email)', async () => {
    mockMachinesGet.mockResolvedValue({
      size: 1,
      docs: [
        machineDoc('INF-FLEX-3', {
          online: true,
          lastHeartbeat: ts(now - 5 * MIN),
          // no health.staleSince yet
        }),
      ],
    });

    const res = await GET(request('cron-secret'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.alertsSent).toBe(0);
    expect(emailSend).not.toHaveBeenCalled();
    expect(machineRefSet).toHaveBeenCalledWith(
      { health: { staleSince: { __op: 'serverTimestamp' } } },
      { merge: true }
    );
  });

  it('does NOT email a stale machine inside its scheduled shutdown window', async () => {
    mockMachinesGet.mockResolvedValue({
      size: 1,
      docs: [
        machineDoc('INF-RENDER-SPARE', {
          online: true,
          lastHeartbeat: ts(now - 10 * MIN),
          shutdownScheduledAt: sec(now - 2 * MIN), // Unix seconds, inside grace
          shuttingDown: true,
          health: { staleSince: ts(now - 6 * MIN) },
        }),
      ],
    });

    const res = await GET(request('cron-secret'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.alertsSent).toBe(0);
    expect(emailSend).not.toHaveBeenCalled();
  });

  it('DOES email when the scheduled instant is far-future (clock skew) despite the flag', async () => {
    mockMachinesGet.mockResolvedValue({
      size: 1,
      docs: [
        machineDoc('INF-RENDER-SPARE', {
          online: true,
          lastHeartbeat: ts(now - 10 * MIN),
          rebootScheduledAt: sec(now + 60 * MIN), // far future -> below the lower bound
          rebooting: true,
          health: { staleSince: ts(now - 6 * MIN) },
        }),
      ],
    });

    const res = await GET(request('cron-secret'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.alertsSent).toBe(1);
    expect(emailSend).toHaveBeenCalledTimes(1);
  });

  it('clears health.staleSince when a previously-stale machine recovers', async () => {
    mockMachinesGet.mockResolvedValue({
      size: 1,
      docs: [
        machineDoc('INF-FLEX-3', {
          online: true,
          lastHeartbeat: ts(now - 30 * 1000), // fresh again
          health: { staleSince: ts(now - 6 * MIN) }, // had a stale marker
        }),
      ],
    });

    const res = await GET(request('cron-secret'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.alertsSent).toBe(0);
    expect(emailSend).not.toHaveBeenCalled();
    expect(machineRefSet).toHaveBeenCalledWith(
      { health: { staleSince: { __op: 'delete' } } },
      { merge: true }
    );
  });
});
