/** @jest-environment node */

/**
 * Cron edge for the daily usage report (billing-system waves 2.3 + 2.4).
 *
 * The sweep itself is covered in `__tests__/lib/billing/usageReport.test.ts`;
 * this pins the four things the route owns: the shared-secret gate, that the
 * gate runs BEFORE any work, that an unconfigured Stripe is a 200 rather than
 * a page-at-3am, and that a whole-sweep fault is a 500.
 */

const mockRunUsageReport = jest.fn();

jest.mock('@/lib/billing/usageReport.server', () => ({
  runUsageReport: (...args: unknown[]) => mockRunUsageReport(...args),
}));

import { NextRequest } from 'next/server';
import { GET } from '@/app/api/cron/billing-usage-report/route';

function request(secret?: string) {
  return new NextRequest('http://localhost/api/cron/billing-usage-report', {
    headers: secret ? { 'x-cron-secret': secret } : {},
  });
}

const SUMMARY = {
  ok: true,
  period: '2026-08-01',
  mode: 'test',
  customers: { scanned: 2, eligible: 1, failed: 0 },
  meterEvents: { sent: 3, alreadyReported: 0 },
  totals: { activeMachines: 4, coreMachines: 0, proMachines: 4, storageOverageGb: 0 },
  failures: [],
};

describe('GET /api/cron/billing-usage-report', () => {
  const originalSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CRON_SECRET = 'cron-secret';
    mockRunUsageReport.mockResolvedValue(SUMMARY);
  });

  afterAll(() => {
    process.env.CRON_SECRET = originalSecret;
  });

  it('rejects a missing cron secret before doing any work', async () => {
    const res = await GET(request());
    expect(res.status).toBe(401);
    expect(mockRunUsageReport).not.toHaveBeenCalled();
  });

  it('rejects a wrong cron secret', async () => {
    const res = await GET(request('nope'));
    expect(res.status).toBe(401);
    expect(mockRunUsageReport).not.toHaveBeenCalled();
  });

  it('rejects everything when CRON_SECRET is unset, rather than opening up', async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(request('anything'));
    expect(res.status).toBe(401);
    expect(mockRunUsageReport).not.toHaveBeenCalled();
  });

  it('runs the sweep and returns its summary', async () => {
    const res = await GET(request('cron-secret'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual(SUMMARY);
    expect(mockRunUsageReport).toHaveBeenCalledTimes(1);
  });

  it('answers 200 when stripe is unconfigured', async () => {
    mockRunUsageReport.mockResolvedValue({ ...SUMMARY, skipped: 'unconfigured' });

    const res = await GET(request('cron-secret'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.skipped).toBe('unconfigured');
  });

  it('answers 500 when the whole sweep faults', async () => {
    mockRunUsageReport.mockRejectedValue(new Error('firestore unavailable'));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    const res = await GET(request('cron-secret'));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ error: 'Usage report failed' });
    consoleError.mockRestore();
  });
});
