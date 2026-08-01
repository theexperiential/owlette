/** @jest-environment node */

const mockUpdate = jest.fn().mockResolvedValue(undefined);
const mockGet = jest.fn();

/**
 * Docs the billing gate (wave 2.6) reads, keyed by path. Seeded per test;
 * an unseeded path reads as "does not exist", which is the fail-open path
 * (`sites/{id}` with no owner → deliver).
 */
const billingDocs = new Map<string, Record<string, unknown>>();
/** Paths whose read should throw — exercises the fail-open posture. */
const billingReadFailures = new Set<string>();
/** Every `collection(...).doc(...)` path the gate touched, in order. */
const billingDocReads: string[] = [];

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (path: string) => ({
      // Subscription query path — `sites/{id}/webhooks`.
      where: jest.fn().mockReturnThis(),
      get: mockGet,
      // Billing-gate path — `sites` / `customers` doc reads.
      doc: (id: string) => {
        const full = `${path}/${id}`;
        return {
          get: async () => {
            billingDocReads.push(full);
            if (billingReadFailures.has(full)) {
              throw new Error(`simulated firestore outage on ${full}`);
            }
            const data = billingDocs.get(full);
            return { exists: data !== undefined, data: () => data };
          },
        };
      },
    }),
  }),
}));

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

import { fireWebhooks, testWebhook } from '@/lib/webhookSender.server';
import { createWebhookBillingCache } from '@/lib/billing/webhookDelivery.server';
import crypto from 'crypto';

function makeWebhookDoc(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wh-1',
    ref: { update: mockUpdate },
    data: () => ({
      url: 'https://hooks.example.com/abc',
      secret: 'test-secret-123',
      failCount: 0,
      ...overrides,
    }),
  };
}

const HOUR = 60 * 60 * 1000;

describe('webhookSender', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    billingDocs.clear();
    billingReadFailures.clear();
    billingDocReads.length = 0;
  });

  describe('fireWebhooks', () => {
    it('returns 0 when no webhooks match', async () => {
      mockGet.mockResolvedValue({ empty: true, docs: [] });

      const result = await fireWebhooks('site1', 'My Site', 'process.crashed', {
        machine: { id: 'm1', name: 'Machine 1' },
      });

      expect(result).toBe(0);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('delivers payload to matching webhooks and returns success count', async () => {
      const doc = makeWebhookDoc();
      mockGet.mockResolvedValue({ empty: false, docs: [doc] });
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      const result = await fireWebhooks('site1', 'My Site', 'process.crashed', {
        machine: { id: 'm1', name: 'Machine 1' },
      });

      expect(result).toBe(1);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://hooks.example.com/abc');
      expect(opts.method).toBe('POST');
      expect(opts.headers['Content-Type']).toBe('application/json');
      expect(opts.headers['X-owlette-Event']).toBe('process.crashed');
      expect(opts.headers['User-Agent']).toBe('owlette-Webhooks/1.0');
      expect(opts.headers['X-owlette-Signature']).toMatch(/^sha256=[a-f0-9]{64}$/);

      // Verify payload structure
      const body = JSON.parse(opts.body);
      expect(body.event).toBe('process.crashed');
      expect(body.site).toEqual({ id: 'site1', name: 'My Site' });
      expect(body.data.machine).toEqual({ id: 'm1', name: 'Machine 1' });
      expect(body.timestamp).toBeDefined();
    });

    it('sends correct HMAC-SHA256 signature', async () => {
      const secret = 'my-secret-key';
      const doc = makeWebhookDoc({ secret });
      mockGet.mockResolvedValue({ empty: false, docs: [doc] });
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      await fireWebhooks('s1', 'Site', 'machine.offline', { machine: { id: 'm1' } });

      const [, opts] = mockFetch.mock.calls[0];
      const signatureHeader = opts.headers['X-owlette-Signature'];
      const expectedSig = crypto
        .createHmac('sha256', secret)
        .update(opts.body)
        .digest('hex');

      expect(signatureHeader).toBe(`sha256=${expectedSig}`);
    });

    it('resets failCount on successful delivery', async () => {
      const doc = makeWebhookDoc({ failCount: 5 });
      mockGet.mockResolvedValue({ empty: false, docs: [doc] });
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      await fireWebhooks('s1', 'Site', 'process.crashed', {});

      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ failCount: 0, lastStatus: 200 })
      );
    });

    it('increments failCount on non-2xx response', async () => {
      const doc = makeWebhookDoc({ failCount: 3 });
      mockGet.mockResolvedValue({ empty: false, docs: [doc] });
      mockFetch.mockResolvedValue({ ok: false, status: 500 });

      const result = await fireWebhooks('s1', 'Site', 'process.crashed', {});

      expect(result).toBe(0);
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ failCount: 4, lastStatus: 500 })
      );
    });

    it('increments failCount on network error', async () => {
      const doc = makeWebhookDoc({ failCount: 2 });
      mockGet.mockResolvedValue({ empty: false, docs: [doc] });
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await fireWebhooks('s1', 'Site', 'process.crashed', {});

      expect(result).toBe(0);
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ failCount: 3, lastStatus: 0 })
      );
    });

    it('auto-disables webhook after 10 consecutive failures', async () => {
      const doc = makeWebhookDoc({ failCount: 9 });
      mockGet.mockResolvedValue({ empty: false, docs: [doc] });
      mockFetch.mockResolvedValue({ ok: false, status: 502 });

      await fireWebhooks('s1', 'Site', 'process.crashed', {});

      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ failCount: 10, enabled: false })
      );
    });

    it('auto-disables on network error at threshold', async () => {
      const doc = makeWebhookDoc({ failCount: 9 });
      mockGet.mockResolvedValue({ empty: false, docs: [doc] });
      mockFetch.mockRejectedValue(new Error('timeout'));

      await fireWebhooks('s1', 'Site', 'machine.offline', {});

      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ failCount: 10, enabled: false })
      );
    });

    it('does not set enabled:false when failCount is below threshold', async () => {
      const doc = makeWebhookDoc({ failCount: 7 });
      mockGet.mockResolvedValue({ empty: false, docs: [doc] });
      mockFetch.mockResolvedValue({ ok: false, status: 404 });

      await fireWebhooks('s1', 'Site', 'process.crashed', {});

      const updateArg = mockUpdate.mock.calls[0][0];
      expect(updateArg.failCount).toBe(8);
      expect(updateArg.enabled).toBeUndefined();
    });

    it('delivers to multiple webhooks independently', async () => {
      const doc1 = makeWebhookDoc();
      const doc2 = {
        ...makeWebhookDoc({ url: 'https://other.example.com/hook' }),
        id: 'wh-2',
        ref: { update: jest.fn().mockResolvedValue(undefined) },
      };
      // Fix: doc2.data needs to return the overridden url
      doc2.data = () => ({
        url: 'https://other.example.com/hook',
        secret: 'test-secret-123',
        failCount: 0,
      });

      mockGet.mockResolvedValue({ empty: false, docs: [doc1, doc2] });
      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200 })
        .mockResolvedValueOnce({ ok: false, status: 500 });

      const result = await fireWebhooks('s1', 'Site', 'process.crashed', {});

      expect(result).toBe(1); // only first succeeded
      expect(mockFetch).toHaveBeenCalledTimes(2);
      // First webhook: success, failCount reset
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ failCount: 0 })
      );
      // Second webhook: failure, failCount incremented
      expect(doc2.ref.update).toHaveBeenCalledWith(
        expect.objectContaining({ failCount: 1 })
      );
    });
  });

  /* ---------------------------------------------------------------- */
  /*  billing-system wave 2.6 — delivery pauses on a locked-out account */
  /* ---------------------------------------------------------------- */

  describe('fireWebhooks billing gate', () => {
    let debugSpy: jest.SpyInstance;
    let errorSpy: jest.SpyInstance;

    beforeEach(() => {
      debugSpy = jest.spyOn(console, 'debug').mockImplementation(() => {});
      errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const doc = makeWebhookDoc();
      mockGet.mockResolvedValue({ empty: false, docs: [doc] });
      mockFetch.mockResolvedValue({ ok: true, status: 200 });
      billingDocs.set('sites/site1', { owner: 'owner-1' });
    });

    afterEach(() => {
      debugSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('expired owner → nothing delivered, nothing queued, no failure recorded', async () => {
      billingDocs.set('customers/owner-1', {
        subscriptionStatus: null,
        trialEndsAt: Date.now() - HOUR,
      });

      const result = await fireWebhooks('site1', 'My Site', 'process.crashed', {});

      expect(result).toBe(0);
      expect(mockFetch).not.toHaveBeenCalled();
      // The subscription doc must be untouched: no failCount bump, no
      // lastTriggered, nothing that could creep toward the 10-strike
      // auto-disable while the account waits to convert.
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(debugSpy).toHaveBeenCalledWith(
        '[webhooks] delivery paused for site site1: account expired'
      );
    });

    it('canceled owner → paused, and the log names the cause', async () => {
      billingDocs.set('customers/owner-1', {
        subscriptionStatus: 'canceled',
        trialEndsAt: Date.now() + 30 * 24 * HOUR,
      });

      expect(await fireWebhooks('site1', 'My Site', 'process.crashed', {})).toBe(0);
      expect(mockFetch).not.toHaveBeenCalled();
      expect(debugSpy).toHaveBeenCalledWith(
        '[webhooks] delivery paused for site site1: account canceled'
      );
    });

    it('active owner → delivers', async () => {
      billingDocs.set('customers/owner-1', {
        subscriptionStatus: 'active',
        trialEndsAt: Date.now() - 30 * 24 * HOUR,
      });

      expect(await fireWebhooks('site1', 'My Site', 'process.crashed', {})).toBe(1);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('trialing owner → delivers (the trial runs at the pro feature level)', async () => {
      billingDocs.set('customers/owner-1', {
        subscriptionStatus: null,
        trialEndsAt: Date.now() + HOUR,
      });

      expect(await fireWebhooks('site1', 'My Site', 'process.crashed', {})).toBe(1);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('past_due owner → delivers (Stripe dunning owns the recovery window)', async () => {
      billingDocs.set('customers/owner-1', {
        subscriptionStatus: 'past_due',
        trialEndsAt: Date.now() - 30 * 24 * HOUR,
      });

      expect(await fireWebhooks('site1', 'My Site', 'process.crashed', {})).toBe(1);
    });

    it('no customers doc (pre-go-live account) → delivers', async () => {
      expect(await fireWebhooks('site1', 'My Site', 'process.crashed', {})).toBe(1);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('ownerless site → delivers without reading customers at all', async () => {
      billingDocs.set('sites/site1', { name: 'legacy site' });

      expect(await fireWebhooks('site1', 'My Site', 'process.crashed', {})).toBe(1);
      expect(billingDocReads).toEqual(['sites/site1']);
    });

    it('fails OPEN — a customers read error still delivers', async () => {
      billingReadFailures.add('customers/owner-1');

      expect(await fireWebhooks('site1', 'My Site', 'process.crashed', {})).toBe(1);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalled();
    });

    it('fails OPEN — a site read error still delivers', async () => {
      billingReadFailures.add('sites/site1');

      expect(await fireWebhooks('site1', 'My Site', 'process.crashed', {})).toBe(1);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('sites with no matching subscription never pay for the billing reads', async () => {
      mockGet.mockResolvedValue({ empty: true, docs: [] });

      expect(await fireWebhooks('site1', 'My Site', 'process.crashed', {})).toBe(0);
      expect(billingDocReads).toEqual([]);
    });

    it('a shared cache collapses a batch to one site + one customer read', async () => {
      billingDocs.set('customers/owner-1', {
        subscriptionStatus: null,
        trialEndsAt: Date.now() - HOUR,
      });
      const cache = createWebhookBillingCache();

      for (let i = 0; i < 3; i++) {
        await fireWebhooks('site1', 'My Site', 'machine.offline', {}, { billingCache: cache });
      }

      expect(mockFetch).not.toHaveBeenCalled();
      expect(billingDocReads).toEqual(['sites/site1', 'customers/owner-1']);
    });

    it('a shared cache reuses the customer read across sites under one owner', async () => {
      billingDocs.set('sites/site1', { owner: 'owner-1' });
      billingDocs.set('sites/site2', { owner: 'owner-1' });
      billingDocs.set('customers/owner-1', {
        subscriptionStatus: null,
        trialEndsAt: Date.now() - HOUR,
      });
      const cache = createWebhookBillingCache();

      await fireWebhooks('site1', 'A', 'machine.offline', {}, { billingCache: cache });
      await fireWebhooks('site2', 'B', 'machine.offline', {}, { billingCache: cache });

      expect(mockFetch).not.toHaveBeenCalled();
      expect(billingDocReads).toEqual(['sites/site1', 'customers/owner-1', 'sites/site2']);
    });

    it('without a cache the decision is re-read every call — conversion restores delivery', async () => {
      // No cache: this is the single-event-per-request path (agent/alert,
      // alerts/trigger). The customer converts between the two calls and the
      // second one delivers, with nothing redeployed and nothing to expire.
      billingDocs.set('customers/owner-1', {
        subscriptionStatus: null,
        trialEndsAt: Date.now() - HOUR,
      });
      expect(await fireWebhooks('site1', 'My Site', 'process.crashed', {})).toBe(0);

      billingDocs.set('customers/owner-1', {
        subscriptionStatus: 'active',
        trialEndsAt: Date.now() - HOUR,
      });
      expect(await fireWebhooks('site1', 'My Site', 'process.crashed', {})).toBe(1);
    });

    it('a cache pins the decision for its own batch only', async () => {
      // Documents the memo's blast radius: within one run the answer is
      // fixed (that is the point — one read per owner), so a conversion
      // lands on the next run rather than mid-batch. Runs are minutes apart.
      billingDocs.set('customers/owner-1', {
        subscriptionStatus: null,
        trialEndsAt: Date.now() - HOUR,
      });
      const batch = createWebhookBillingCache();
      expect(await fireWebhooks('site1', 'S', 'machine.offline', {}, { billingCache: batch })).toBe(0);

      billingDocs.set('customers/owner-1', {
        subscriptionStatus: 'active',
        trialEndsAt: Date.now() - HOUR,
      });
      // same batch → still paused
      expect(await fireWebhooks('site1', 'S', 'machine.offline', {}, { billingCache: batch })).toBe(0);
      // next batch → delivers
      const nextBatch = createWebhookBillingCache();
      expect(await fireWebhooks('site1', 'S', 'machine.offline', {}, { billingCache: nextBatch })).toBe(1);
    });
  });

  describe('testWebhook', () => {
    it('sends test payload and returns status', async () => {
      mockFetch.mockResolvedValue({ status: 200 });

      const result = await testWebhook('https://hooks.example.com/test', 'secret123');

      expect(result).toEqual({ status: 200 });
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://hooks.example.com/test');
      expect(opts.headers['X-owlette-Event']).toBe('test');

      const body = JSON.parse(opts.body);
      expect(body.event).toBe('process.crashed');
      expect(body.site).toEqual({ id: 'test', name: 'Test Site' });
    });

    it('returns status 0 and error message on network failure', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await testWebhook('https://hooks.example.com/test', 'secret123');

      expect(result).toEqual({ status: 0, error: 'ECONNREFUSED' });
    });

    it('includes correct HMAC signature', async () => {
      const secret = 'verify-me';
      mockFetch.mockResolvedValue({ status: 200 });

      await testWebhook('https://example.com', secret);

      const [, opts] = mockFetch.mock.calls[0];
      const expectedSig = crypto
        .createHmac('sha256', secret)
        .update(opts.body)
        .digest('hex');

      expect(opts.headers['X-owlette-Signature']).toBe(`sha256=${expectedSig}`);
    });
  });
});
