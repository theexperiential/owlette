/** @jest-environment node */

import { NextRequest } from 'next/server';

const runTrialLifecycleMock = jest.fn();

jest.mock('@/lib/billing/trialLifecycle.server', () => ({
  runTrialLifecycle: (...args: unknown[]) => runTrialLifecycleMock(...args),
}));

import { GET } from '@/app/api/cron/billing-trial-lifecycle/route';

const SUMMARY = {
  processed: 12,
  expired: 2,
  emailsSent: { day10: 3, day13: 1, expired: 2 },
  alertCutoffs: 1,
  errors: 0,
};

function request(secret?: string) {
  return new NextRequest('http://localhost/api/cron/billing-trial-lifecycle', {
    headers: secret ? { 'x-cron-secret': secret } : {},
  });
}

describe('GET /api/cron/billing-trial-lifecycle', () => {
  const originalSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CRON_SECRET = 'cron-secret';
    runTrialLifecycleMock.mockResolvedValue(SUMMARY);
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    process.env.CRON_SECRET = originalSecret;
  });

  it('rejects a missing cron secret before touching any account', async () => {
    const res = await GET(request());
    expect(res.status).toBe(401);
    expect(runTrialLifecycleMock).not.toHaveBeenCalled();
  });

  it('rejects a wrong cron secret', async () => {
    const res = await GET(request('nope'));
    expect(res.status).toBe(401);
    expect(runTrialLifecycleMock).not.toHaveBeenCalled();
  });

  it('rejects every request when CRON_SECRET is unset (never open by default)', async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(request('anything'));
    expect(res.status).toBe(401);
    expect(runTrialLifecycleMock).not.toHaveBeenCalled();
  });

  it('runs the sweep and returns its summary', async () => {
    const res = await GET(request('cron-secret'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(runTrialLifecycleMock).toHaveBeenCalledTimes(1);
    expect(body).toEqual({ ok: true, ...SUMMARY });
  });

  it('reports partial failures in the summary rather than failing the run', async () => {
    runTrialLifecycleMock.mockResolvedValue({ ...SUMMARY, errors: 3 });

    const res = await GET(request('cron-secret'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.errors).toBe(3);
  });

  it('answers 500 without leaking the underlying error when the sweep throws', async () => {
    runTrialLifecycleMock.mockRejectedValue(new Error('firestore exploded: projects/secret-proj'));

    const res = await GET(request('cron-secret'));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(JSON.stringify(body)).not.toContain('secret-proj');
  });
});
