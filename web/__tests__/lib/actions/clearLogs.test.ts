/** @jest-environment node */

/**
 * Unit tests for `clearLogs` action core (security-boundary-migration
 * wave 3.11).
 */

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: jest.fn(),
}));

import type { Firestore } from 'firebase-admin/firestore';
import {
  ClearLogsValidationError,
  clearLogs,
} from '@/lib/actions/clearLogs.server';

const mockWhere = jest.fn();
const mockOrderBy = jest.fn();
const mockStartAfter = jest.fn();
const mockLimit = jest.fn();
const mockGet = jest.fn();
const mockQuery = {
  where: (...args: unknown[]) => {
    mockWhere(...args);
    return mockQuery;
  },
  orderBy: (...args: unknown[]) => {
    mockOrderBy(...args);
    return mockQuery;
  },
  startAfter: (...args: unknown[]) => {
    mockStartAfter(...args);
    return mockQuery;
  },
  limit: (n: number) => {
    mockLimit(n);
    return mockQuery;
  },
  get: () => mockGet(),
};
const mockSiteDoc = { collection: jest.fn(() => mockQuery) };
const mockSitesCollection = { doc: jest.fn(() => mockSiteDoc) };
const mockBatchInstances: Array<{
  delete: jest.Mock;
  commit: jest.Mock;
}> = [];
const mockDb = {
  collection: jest.fn(() => mockSitesCollection),
  batch: jest.fn(() => {
    const batch = {
      delete: jest.fn(),
      commit: jest.fn().mockResolvedValue(undefined),
    };
    mockBatchInstances.push(batch);
    return batch;
  }),
};

function snapFor(ids: string[]) {
  return {
    empty: ids.length === 0,
    size: ids.length,
    docs: ids.map((id) => ({ id, ref: { path: `sites/site-a/logs/${id}` } })),
  };
}

// Date-scoped path reads doc.data() to filter action/machine/level in memory.
function snapForData(
  rows: Array<{ id: string; action?: string; machineId?: string; level?: string }>,
) {
  return {
    empty: rows.length === 0,
    size: rows.length,
    docs: rows.map((r) => ({
      id: r.id,
      ref: { path: `sites/site-a/logs/${r.id}` },
      data: () => r,
    })),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockBatchInstances.length = 0;
});

describe('clearLogs', () => {
  it('deletes matching log entries in batches', async () => {
    mockGet.mockResolvedValueOnce(snapFor(['log-1', 'log-2']));

    const result = await clearLogs(
      { siteId: 'site-a', db: mockDb as unknown as Firestore },
      {},
    );

    expect(result).toEqual({ siteId: 'site-a', deletedCount: 2, filters: {} });
    expect(mockDb.collection).toHaveBeenCalledWith('sites');
    expect(mockSitesCollection.doc).toHaveBeenCalledWith('site-a');
    expect(mockSiteDoc.collection).toHaveBeenCalledWith('logs');
    expect(mockLimit).toHaveBeenCalledWith(500);
    expect(mockBatchInstances).toHaveLength(1);
    expect(mockBatchInstances[0].delete).toHaveBeenCalledTimes(2);
    expect(mockBatchInstances[0].commit).toHaveBeenCalledTimes(1);
  });

  it('applies action, machine, and level filters', async () => {
    mockGet.mockResolvedValueOnce(snapFor([]));

    const result = await clearLogs(
      { siteId: 'site-a', db: mockDb as unknown as Firestore },
      { action: 'process_started', machineId: 'machine-a', level: 'warning' },
    );

    expect(result.deletedCount).toBe(0);
    expect(mockWhere).toHaveBeenCalledWith('action', '==', 'process_started');
    expect(mockWhere).toHaveBeenCalledWith('machineId', '==', 'machine-a');
    expect(mockWhere).toHaveBeenCalledWith('level', '==', 'warning');
    expect(mockDb.batch).not.toHaveBeenCalled();
  });

  it('continues fetching while full batches are returned', async () => {
    mockGet
      .mockResolvedValueOnce(snapFor(Array.from({ length: 500 }, (_, i) => `log-${i}`)))
      .mockResolvedValueOnce(snapFor(['log-500']));

    const result = await clearLogs(
      { siteId: 'site-a', db: mockDb as unknown as Firestore },
      {},
    );

    expect(result.deletedCount).toBe(501);
    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(mockBatchInstances).toHaveLength(2);
  });

  it('rejects invalid site ids and levels', async () => {
    await expect(
      clearLogs({ siteId: 'bad site', db: mockDb as unknown as Firestore }),
    ).rejects.toMatchObject({ field: 'siteId' });

    await expect(
      clearLogs(
        { siteId: 'site-a', db: mockDb as unknown as Firestore },
        { level: 'verbose' },
      ),
    ).rejects.toBeInstanceOf(ClearLogsValidationError);
  });

  it('date-scoped clear orders by timestamp, ranges, and filters in memory', async () => {
    mockGet.mockResolvedValueOnce(
      snapForData([
        { id: 'a', action: 'process_crashed', level: 'error' },
        { id: 'b', action: 'agent_started', level: 'info' },
      ]),
    );

    const result = await clearLogs(
      { siteId: 'site-a', db: mockDb as unknown as Firestore },
      { sinceMs: 1000, untilMs: 2000, level: 'error' },
    );

    // Only doc 'a' matches level=error; 'b' is filtered out in memory.
    expect(result.deletedCount).toBe(1);
    expect(mockOrderBy).toHaveBeenCalledWith('timestamp', 'desc');
    expect(mockWhere).toHaveBeenCalledWith('timestamp', '>=', expect.anything());
    expect(mockWhere).toHaveBeenCalledWith('timestamp', '<=', expect.anything());
    expect(mockBatchInstances).toHaveLength(1);
    expect(mockBatchInstances[0].delete).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid since/until bounds', async () => {
    await expect(
      clearLogs(
        { siteId: 'site-a', db: mockDb as unknown as Firestore },
        { sinceMs: 5000, untilMs: 1000 },
      ),
    ).rejects.toMatchObject({ field: 'sinceMs' });

    await expect(
      clearLogs(
        { siteId: 'site-a', db: mockDb as unknown as Firestore },
        { sinceMs: -1 },
      ),
    ).rejects.toBeInstanceOf(ClearLogsValidationError);
  });
});
