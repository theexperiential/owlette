/**
 * OwletteClient — header injection, error typing, retry policy.
 * Uses a fake `fetch` passed via the constructor so tests run hermetic.
 */

import { OwletteClient, OwletteApiError, DEFAULT_ROOST_VERSION } from '../src/lib/client';

interface Call {
  url: string;
  init: RequestInit;
}

function makeFakeFetch(
  handler: (call: Call) => Promise<{ status: number; body: unknown }>,
): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fake: typeof fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const call: Call = { url, init };
    calls.push(call);
    const { status, body } = await handler(call);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(),
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    } as Response;
  };
  return { fetch: fake, calls };
}

describe('OwletteClient headers', () => {
  it('injects Authorization + Roost-Version + Idempotency-Key on POST', async () => {
    const { fetch, calls } = makeFakeFetch(async () => ({ status: 200, body: { ok: true } }));
    const client = new OwletteClient({ token: 'owk_live_testtoken', fetch });

    await client.request('/api/roosts', { method: 'POST', body: { siteId: 's' } });
    expect(calls).toHaveLength(1);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer owk_live_testtoken');
    expect(headers['Roost-Version']).toBe(DEFAULT_ROOST_VERSION);
    expect(headers['Idempotency-Key']).toMatch(/^node-sdk-/);
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('does NOT inject Idempotency-Key on GET', async () => {
    const { fetch, calls } = makeFakeFetch(async () => ({ status: 200, body: { sites: [] } }));
    const client = new OwletteClient({ token: 'owk_live_x', fetch });
    await client.request('/api/sites');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBeUndefined();
  });

  it('injects Idempotency-Key on DELETE', async () => {
    const { fetch, calls } = makeFakeFetch(async () => ({ status: 200, body: { ok: true } }));
    const client = new OwletteClient({ token: 'owk_live_x', fetch });
    await client.request('/api/sites/site-1/deployments/deploy-1', {
      method: 'DELETE',
      body: {},
    });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toMatch(/^node-sdk-/);
  });

  it('honors an explicit Idempotency-Key', async () => {
    const { fetch, calls } = makeFakeFetch(async () => ({ status: 200, body: {} }));
    const client = new OwletteClient({ token: 'owk_live_x', fetch });
    await client.request('/api/roosts', {
      method: 'POST',
      body: {},
      idempotencyKey: 'my-key',
    });
    expect((calls[0]!.init.headers as Record<string, string>)['Idempotency-Key']).toBe('my-key');
  });

  it('translates query params correctly', async () => {
    const { fetch, calls } = makeFakeFetch(async () => ({ status: 200, body: {} }));
    const client = new OwletteClient({ token: 'owk_live_x', fetch, apiUrl: 'https://api.test' });
    await client.request('/api/roosts', {
      query: { siteId: 'site-1', limit: 5, includeDeleted: undefined },
    });
    expect(calls[0]!.url).toBe('https://api.test/api/roosts?siteId=site-1&limit=5');
  });
});

describe('OwletteClient error translation', () => {
  it('throws OwletteApiError with status + code + requestId on 400', async () => {
    const { fetch } = makeFakeFetch(async () => ({
      status: 400,
      body: {
        type: 'https://owlette.app/problems/validation-failed',
        title: 'validation failed',
        status: 400,
        detail: 'siteId is required',
        code: 'validation_failed',
        requestId: 'req-abc',
      },
    }));
    const client = new OwletteClient({ token: 'owk_live_x', fetch, retry: { maxAttempts: 1 } });
    await expect(client.request('/api/roosts', { method: 'POST', body: {} })).rejects.toMatchObject({
      name: 'OwletteApiError',
      status: 400,
      code: 'validation_failed',
      requestId: 'req-abc',
    });
  });

  it('preserves problem fields on the thrown error', async () => {
    const { fetch } = makeFakeFetch(async () => ({
      status: 403,
      body: { code: 'scope_insufficient', required: { resource: 'roost', id: 'r1', permission: 'write' } },
    }));
    const client = new OwletteClient({ token: 'owk_live_x', fetch, retry: { maxAttempts: 1 } });
    try {
      await client.request('/api/roosts', { method: 'POST', body: {} });
      throw new Error('should have thrown');
    } catch (err) {
      if (!(err instanceof OwletteApiError)) throw err;
      expect(err.code).toBe('scope_insufficient');
      expect(err.problem.required).toEqual({ resource: 'roost', id: 'r1', permission: 'write' });
    }
  });
});

describe('OwletteClient retry policy', () => {
  it('retries 429 until success', async () => {
    let attempts = 0;
    const { fetch, calls } = makeFakeFetch(async () => {
      attempts += 1;
      if (attempts < 3) return { status: 429, body: { retryAfter: 0.001 } };
      return { status: 200, body: { done: true } };
    });
    const client = new OwletteClient({
      token: 'owk_live_x',
      fetch,
      retry: { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 5, jitter: 0 },
    });
    const res = await client.request<{ done: true }>('/api/sites');
    expect(res.data.done).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it('does NOT retry 400', async () => {
    const { fetch, calls } = makeFakeFetch(async () => ({ status: 400, body: { detail: 'bad' } }));
    const client = new OwletteClient({
      token: 'owk_live_x',
      fetch,
      retry: { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 5, jitter: 0 },
    });
    await expect(client.request('/api/sites')).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(1);
  });

  it('stops after maxAttempts', async () => {
    const { fetch, calls } = makeFakeFetch(async () => ({ status: 500, body: { detail: 'oops' } }));
    const client = new OwletteClient({
      token: 'owk_live_x',
      fetch,
      retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5, jitter: 0 },
    });
    await expect(client.request('/api/sites')).rejects.toMatchObject({ status: 500 });
    expect(calls).toHaveLength(3);
  });

  it('noRetry skips the policy entirely', async () => {
    const { fetch, calls } = makeFakeFetch(async () => ({ status: 500, body: {} }));
    const client = new OwletteClient({ token: 'owk_live_x', fetch });
    await expect(client.request('/api/sites', { noRetry: true })).rejects.toBeDefined();
    expect(calls).toHaveLength(1);
  });
});
