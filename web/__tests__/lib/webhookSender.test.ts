/** @jest-environment node */

const mockUpdate = jest.fn().mockResolvedValue(undefined);
const mockGet = jest.fn();

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: () => ({
      where: jest.fn().mockReturnThis(),
      get: mockGet,
    }),
  }),
}));

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

import { fireWebhooks, testWebhook } from '@/lib/webhookSender.server';
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

describe('webhookSender', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
      expect(opts.headers['X-Owlette-Event']).toBe('process.crashed');
      expect(opts.headers['User-Agent']).toBe('Owlette-Webhooks/1.0');
      expect(opts.headers['X-Owlette-Signature']).toMatch(/^sha256=[a-f0-9]{64}$/);

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
      const signatureHeader = opts.headers['X-Owlette-Signature'];
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

  describe('testWebhook', () => {
    it('sends test payload and returns status', async () => {
      mockFetch.mockResolvedValue({ status: 200 });

      const result = await testWebhook('https://hooks.example.com/test', 'secret123');

      expect(result).toEqual({ status: 200 });
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://hooks.example.com/test');
      expect(opts.headers['X-Owlette-Event']).toBe('test');

      const body = JSON.parse(opts.body);
      expect(body.event).toBe('test');
      expect(body.site).toEqual({ id: 'test', name: 'Test' });
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

      expect(opts.headers['X-Owlette-Signature']).toBe(`sha256=${expectedSig}`);
    });
  });
});
