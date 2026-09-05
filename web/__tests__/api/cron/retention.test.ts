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

/** A backlog document. Timestamp fields carry the mocked `Timestamp` shape. */
type BacklogDoc = { id: string } & Record<string, unknown>;

/**
 * Apply a recorded `where(field, op, value)` to a backlog document, so a cutoff
 * can be tested rather than assumed: a doc still inside its window has to
 * survive the sweep, which is only observable if the stub filters.
 *
 * Documents that don't carry the compared field pass straight through — the
 * logs and metrics fixtures identify themselves by id alone, and the metrics
 * query compares `__name__` against a plain string cutoff.
 */
function matchesCutoff(doc: BacklogDoc, where: unknown[] | undefined): boolean {
  if (!where) return true;
  const [field, op, value] = where as [string, string, { __ts?: number } | string];
  const fieldValue = doc[field] as { __ts?: number } | undefined;
  const cutoff = typeof value === 'object' ? value.__ts : undefined;
  if (fieldValue?.__ts === undefined || cutoff === undefined) return true;
  // Loud on purpose: retention only ever deletes STRICTLY older than the
  // cutoff, and a silent pass here would hide a route switched to '<='.
  if (op !== '<') throw new Error(`unexpected retention operator: ${op}`);
  return fieldValue.__ts < cutoff;
}

/**
 * Chainable query stub; terminal `.get()` yields `docs` and every subcollection
 * call is recorded so tests can assert the query shape.
 *
 * `docs` is a live backlog — each `.get()` CONSUMES a page, so repeated queries
 * drain. A stub that re-served the same page made a one-page-per-site
 * implementation indistinguishable from a draining one; that bug reached dev.
 * Documents the recorded `where` excludes are left in the backlog, so a test
 * can assert what SURVIVED as well as what went.
 */
function collectionStub(name: string, backlog: BacklogDoc[]) {
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
      // Compact in place: matched docs move into the page, the rest stay in the
      // backlog under their original identity (tests hold a reference to it).
      const page: BacklogDoc[] = [];
      let kept = 0;
      for (const doc of backlog) {
        if (page.length < pageSize && matchesCutoff(doc, entry.where)) page.push(doc);
        else backlog[kept++] = doc;
      }
      backlog.length = kept;

      return {
        empty: page.length === 0,
        size: page.length,
        docs: page.map(d => ({ id: d.id, ref: docRef(d.id) })),
      };
    },
  };
  return q;
}

let siteLogs: BacklogDoc[] = [];
let siteTalonRuns: BacklogDoc[] = [];
let machineBuckets: BacklogDoc[] = [];
let machines: Array<{ id: string }> = [];

const DAY_MS = 24 * 60 * 60 * 1000;

/** A `startedAt` in the mocked `Timestamp` shape, `days` days in the past. */
function startedDaysAgo(days: number) {
  return { startedAt: { __ts: Date.now() - days * DAY_MS } };
}

const mockDb = {
  collection: (name: string) => {
    if (name === 'sites') return { get: mockSitesGet };
    return collectionStub(name, []);
  },
  // BulkWriter, not db.batch(): a 400-delete batch fails in real Firestore with
  // "Transaction too big".
  bulkWriter: () => ({
    delete: mockWriterDelete,
    onWriteError: mockOnWriteError,
    close: mockWriterClose,
  }),
};

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => mockDb,
}));

import {
  GET,
  METRICS_RETENTION_DAYS,
  LOGS_RETENTION_DAYS,
  TALON_RUNS_RETENTION_DAYS,
} from '@/app/api/cron/retention/route';

function siteDoc(id: string) {
  return {
    id,
    ref: {
      collection: (name: string) => {
        if (name === 'logs') return collectionStub('logs', siteLogs);
        if (name === 'talon_runs') return collectionStub('talon_runs', siteTalonRuns);
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
    siteTalonRuns = [];
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
    expect(body.deleted).toEqual({ metrics: 0, logs: 0, talonRuns: 0 });
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
    expect(body.deleted).toEqual({ metrics: 3, logs: 2, talonRuns: 0 });
    expect(mockWriterDelete).toHaveBeenCalledTimes(5);
    expect(body.retentionDays).toEqual({
      metrics: METRICS_RETENTION_DAYS,
      logs: LOGS_RETENTION_DAYS,
      talonRuns: TALON_RUNS_RETENTION_DAYS,
    });
  });

  it('uses a YYYY-MM-DD cutoff that sorts correctly against both bucket id shapes', async () => {
    mockSitesGet.mockResolvedValue({ docs: [siteDoc('site-a')] });
    machines = [{ id: 'm1' }];

    const body = await (await GET(request('cron-secret'))).json();
    const cutoff: string = body.cutoffs.metricsBucket;

    // Contract from lib/metricsHistoryBuckets.ts: hourly ids are the daily id plus
    // '-HH', so lexicographic order must sort pre-cutoff hours below the cutoff
    // and same-day hours at or above it.
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
    // 900 stale logs: more than one 400-doc page, less than the 2000 budget. A
    // one-page-per-site implementation deletes 400 and still reports
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

  it('prunes talon runs past the window and leaves one inside it', async () => {
    // Literal day counts, NOT TALON_RUNS_RETENTION_DAYS ± 1: relative fixtures
    // slide with the constant, so a window quietly lowered to 100 days would
    // still pass. 400 is a privacy commitment — pin it here.
    siteTalonRuns = [
      { id: 'run-ancient', ...startedDaysAgo(500) },
      { id: 'run-stale', ...startedDaysAgo(401) },
      // Negative control: inside the window. A sweep that ignores the cutoff —
      // or shortens it — deletes this and breaks the retention promise.
      { id: 'run-young', ...startedDaysAgo(399) },
    ];
    mockSitesGet.mockResolvedValue({ docs: [siteDoc('site-a')] });

    const body = await (await GET(request('cron-secret'))).json();

    expect(body.deleted.talonRuns).toBe(2);
    expect(siteTalonRuns.map(r => r.id)).toEqual(['run-young']);
    expect(mockWriterDelete).toHaveBeenCalledTimes(2);
    expect(body.truncated).toBe(false);
    expect(body.cutoffs.talonRuns).toEqual(expect.any(String));
  });

  it('prunes talon runs by startedAt', async () => {
    siteTalonRuns = [{ id: 'run-stale', ...startedDaysAgo(500) }];
    mockSitesGet.mockResolvedValue({ docs: [siteDoc('site-a')] });

    await GET(request('cron-secret'));

    const runsQuery = queryLog.find(q => q.collection === 'talon_runs');
    expect(runsQuery?.where?.[0]).toBe('startedAt');
    expect(runsQuery?.where?.[1]).toBe('<');
  });

  it('drains talon runs across multiple pages in one run', async () => {
    // Same shape as the logs page test: more than one 400-doc page, inside the
    // 2000 budget, so a one-page-per-site loop would under-delete silently.
    siteTalonRuns = Array.from({ length: 900 }, (_, i) => ({
      id: `run${i}`,
      ...startedDaysAgo(500),
    }));
    mockSitesGet.mockResolvedValue({ docs: [siteDoc('site-a')] });

    const body = await (await GET(request('cron-secret'))).json();

    expect(body.deleted.talonRuns).toBe(900);
    expect(body.truncated).toBe(false);
    expect(siteTalonRuns).toHaveLength(0);
  });

  it('never sweeps talon config collections', async () => {
    siteTalonRuns = [{ id: 'run-stale', ...startedDaysAgo(500) }];
    machines = [{ id: 'm1' }];
    mockSitesGet.mockResolvedValue({ docs: [siteDoc('site-a')] });

    await GET(request('cron-secret'));

    // `talons` and `talon_secrets` are configuration, not history: an idle talon
    // is still armed and its signing secret has no expiry.
    const swept = queryLog.map(q => q.collection);
    expect(swept).toContain('talon_runs');
    expect(swept).not.toContain('talons');
    expect(swept).not.toContain('talon_secrets');
  });
});
