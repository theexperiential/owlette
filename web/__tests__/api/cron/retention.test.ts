/** @jest-environment node */

import { NextRequest } from 'next/server';

const mockWriterDelete = jest.fn(() => Promise.resolve());
const mockWriterClose = jest.fn().mockResolvedValue(undefined);
const mockOnWriteError = jest.fn();
const mockSitesGet = jest.fn();

/** Records every query built against a subcollection, for assertions. */
const queryLog: Array<{ collection: string; where?: unknown[]; limit?: number }> = [];

jest.mock('firebase-admin/firestore', () => ({
  FieldPath: { documentId: () => '__name__' },
  Timestamp: {
    fromDate: (d: Date) => ({ __ts: d.getTime(), toDate: () => d }),
  },
}));

function docRef(id: string) {
  return { id, __ref: true };
}

/**
 * Builds a chainable query stub whose terminal `.get()` yields `docs`.
 * Each subcollection call is recorded so tests can assert the query shape.
 */
/**
 * `docs` is a live backlog: each `.get()` serves the next page and CONSUMES it,
 * so repeated queries drain rather than returning the same page forever. The
 * original stub returned an identical page on every call, which made a
 * one-page-per-site implementation indistinguishable from a draining one — the
 * exact bug that reached dev.
 */
function collectionStub(name: string, backlog: Array<{ id: string }>) {
  const entry: { collection: string; where?: unknown[]; limit?: number } = { collection: name };
  queryLog.push(entry);
  let pageSize = Number.MAX_SAFE_INTEGER;
  const q = {
    where: (...args: unknown[]) => {
      entry.where = args;
      return q;
    },
    orderBy: () => q,
    limit: (n: number) => {
      entry.limit = n;
      pageSize = n;
      return q;
    },
    get: async () => {
      const page = backlog.splice(0, pageSize);
      return {
        empty: page.length === 0,
        size: page.length,
        docs: page.map(d => ({ id: d.id, ref: docRef(d.id) })),
      };
    },
  };
  return q;
}

let siteLogs: Array<{ id: string }> = [];
let machineBuckets: Array<{ id: string }> = [];
let machines: Array<{ id: string }> = [];

const mockDb = {
  collection: (name: string) => {
    if (name === 'sites') return { get: mockSitesGet };
    return collectionStub(name, []);
  },
  // Deletion goes through BulkWriter, not db.batch() — a batched commit of 400
  // deletes fails in real Firestore with "Transaction too big".
  bulkWriter: () => ({
    delete: mockWriterDelete,
    onWriteError: mockOnWriteError,
    close: mockWriterClose,
  }),
};

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => mockDb,
}));

import { GET, METRICS_RETENTION_DAYS, LOGS_RETENTION_DAYS } from '@/app/api/cron/retention/route';

function siteDoc(id: string) {
  return {
    id,
    ref: {
      collection: (name: string) => {
        if (name === 'logs') return collectionStub('logs', siteLogs);
        if (name === 'machines') {
          return {
            get: async () => ({
              docs: machines.map(m => ({
                id: m.id,
                ref: {
                  collection: () => collectionStub('metrics_history', machineBuckets),
                },
              })),
            }),
          };
        }
        return collectionStub(name, []);
      },
    },
  };
}

function request(secret?: string) {
  return new NextRequest('http://localhost/api/cron/retention', {
    headers: secret ? { 'x-cron-secret': secret } : {},
  });
}

describe('GET /api/cron/retention', () => {
  const originalSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    jest.clearAllMocks();
    queryLog.length = 0;
    siteLogs = [];
    machineBuckets = [];
    machines = [];
    process.env.CRON_SECRET = 'cron-secret';
    mockSitesGet.mockResolvedValue({ docs: [] });
  });

  afterAll(() => {
    process.env.CRON_SECRET = originalSecret;
  });

  it('rejects a missing cron secret before reading anything', async () => {
    const res = await GET(request());
    expect(res.status).toBe(401);
    expect(mockSitesGet).not.toHaveBeenCalled();
  });

  it('rejects a wrong cron secret', async () => {
    const res = await GET(request('nope'));
    expect(res.status).toBe(401);
    expect(mockSitesGet).not.toHaveBeenCalled();
  });

  it('reports zero deletions when nothing is past retention', async () => {
    mockSitesGet.mockResolvedValue({ docs: [siteDoc('site-a')] });

    const res = await GET(request('cron-secret'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.deleted).toEqual({ metrics: 0, logs: 0 });
    expect(body.truncated).toBe(false);
    expect(mockWriterDelete).not.toHaveBeenCalled();
  });

  it('deletes stale logs and metric buckets and reports the counts', async () => {
    siteLogs = [{ id: 'log1' }, { id: 'log2' }];
    machines = [{ id: 'm1' }];
    machineBuckets = [{ id: '2020-01-01-00' }, { id: '2020-01-01-01' }, { id: '2020-01-02' }];
    mockSitesGet.mockResolvedValue({ docs: [siteDoc('site-a')] });

    const res = await GET(request('cron-secret'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.deleted).toEqual({ metrics: 3, logs: 2 });
    expect(mockWriterDelete).toHaveBeenCalledTimes(5);
    expect(body.retentionDays).toEqual({
      metrics: METRICS_RETENTION_DAYS,
      logs: LOGS_RETENTION_DAYS,
    });
  });

  it('uses a YYYY-MM-DD cutoff that sorts correctly against both bucket id shapes', async () => {
    mockSitesGet.mockResolvedValue({ docs: [siteDoc('site-a')] });
    machines = [{ id: 'm1' }];

    const body = await (await GET(request('cron-secret'))).json();
    const cutoff: string = body.cutoffs.metricsBucket;

    // Contract from lib/metricsHistoryBuckets.ts: hourly ids are the daily id
    // plus '-HH'. Lexicographic ordering must place the hour before the cutoff
    // date below it, and the hour on the cutoff date at or above it.
    expect(cutoff).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const dayBefore = '2000-01-01';
    expect(`${dayBefore}-23` < cutoff).toBe(true);
    expect(`${cutoff}-00` < cutoff).toBe(false);
    expect(dayBefore < cutoff).toBe(true);
  });

  it('stops at the per-run ceiling and flags truncated', async () => {
    // One site holding far more than the 2000-doc whole-run budget.
    siteLogs = Array.from({ length: 5000 }, (_, i) => ({ id: `log${i}` }));
    mockSitesGet.mockResolvedValue({ docs: [siteDoc('site-a')] });

    const body = await (await GET(request('cron-secret'))).json();

    expect(body.truncated).toBe(true);
    expect(body.deleted.logs).toBe(2000);
  });

  it('drains a site across multiple pages in one run', async () => {
    // 900 stale logs > one 400-doc page but < the 2000 budget, so a correct
    // implementation clears all of them and reports truncated:false. A
    // one-page-per-site implementation would delete 400 and still claim
    // truncated:false — stale data left behind under an all-clear.
    siteLogs = Array.from({ length: 900 }, (_, i) => ({ id: `log${i}` }));
    mockSitesGet.mockResolvedValue({ docs: [siteDoc('site-a')] });

    const body = await (await GET(request('cron-secret'))).json();

    expect(body.deleted.logs).toBe(900);
    expect(body.truncated).toBe(false);
    expect(siteLogs).toHaveLength(0);
  });

  it('drains metrics buckets across pages too', async () => {
    machines = [{ id: 'm1' }];
    machineBuckets = Array.from({ length: 750 }, (_, i) => ({
      id: `2020-01-01-${String(i).padStart(2, '0')}`,
    }));
    mockSitesGet.mockResolvedValue({ docs: [siteDoc('site-a')] });

    const body = await (await GET(request('cron-secret'))).json();

    expect(body.deleted.metrics).toBe(750);
    expect(body.truncated).toBe(false);
  });
});
