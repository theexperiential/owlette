/**
 * @jest-environment jsdom
 *
 * Unit tests for the inline-sparkline hooks. The regression these guard against:
 * the cloud function moved metrics_history from daily (`YYYY-MM-DD`) to hourly
 * (`YYYY-MM-DD-HH`) buckets, but the reader kept querying only the daily bucket
 * — so prod sparklines went blank while the e2e suite (which seeds a daily
 * fixture) stayed green. These tests cover the hourly-only path explicitly.
 */
import { renderHook, waitFor } from '@testing-library/react';

// Override the global `{ db: null }` mock from jest.setup.js — the hooks
// early-return when db is null, which would skip the snapshot effect.
jest.mock('@/lib/firebase', () => ({ db: {} }));

// The hooks issue a single `documentId() in [...]` query listener over the
// metrics_history collection. `onSnapshot` synchronously emits a fake query
// snapshot built from `queryDocs`; `forEach` walks them in array order (we
// supply ascending doc ids to mirror Firestore's documentId ordering).
let queryDocs: Array<{ id: string; data: () => Record<string, unknown> }> = [];
const unsubscribe = jest.fn();

jest.mock('firebase/firestore', () => ({
  collection: jest.fn(() => ({})),
  query: jest.fn(() => ({})),
  where: jest.fn(() => ({})),
  documentId: jest.fn(() => '__name__'),
  onSnapshot: jest.fn(
    (_q: unknown, onNext: (snap: { forEach: (cb: (doc: unknown) => void) => void }) => void) => {
      onNext({ forEach: (cb: (doc: unknown) => void) => queryDocs.forEach(cb) });
      return unsubscribe;
    }
  ),
}));

import { useSparklineData, useAllSparklineData } from '@/hooks/useSparklineData';

const sample = (t: number, c: number, m: number, d: number, g?: number) => ({
  t,
  c,
  m,
  d,
  ...(g !== undefined ? { g } : {}),
});

const bucketDoc = (id: string, samples: unknown[]) => ({ id, data: () => ({ samples }) });

beforeEach(() => {
  queryDocs = [];
  unsubscribe.mockClear();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('useAllSparklineData — hourly bucket reads (prod regression)', () => {
  it('returns non-empty series from an HOURLY-only bucket', async () => {
    // The exact prod scenario: only YYYY-MM-DD-HH docs exist, no daily doc.
    queryDocs = [
      bucketDoc('2026-05-24-17', [sample(100, 10, 20, 90, 50), sample(160, 12, 22, 90, 0)]),
    ];

    const { result } = renderHook(() => useAllSparklineData('node-pa', 'INF-CONTROL'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.cpu).toEqual([{ t: 100, v: 10 }, { t: 160, v: 12 }]);
    expect(result.current.memory).toEqual([{ t: 100, v: 20 }, { t: 160, v: 22 }]);
    expect(result.current.disk).toEqual([{ t: 100, v: 90 }, { t: 160, v: 90 }]);
    // GPU keeps only samples with g > 0 (parity with the prior daily reader).
    expect(result.current.gpu).toEqual([{ t: 100, v: 50 }]);
  });

  it('still reads the legacy/e2e DAILY bucket as a fallback', async () => {
    queryDocs = [bucketDoc('2026-05-24', [sample(50, 5, 6, 7)])];

    const { result } = renderHook(() => useAllSparklineData('node-pa', 'INF-CONTROL'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.cpu).toEqual([{ t: 50, v: 5 }]);
    expect(result.current.disk).toEqual([{ t: 50, v: 7 }]);
  });

  it('merges current + previous hour buckets: sorted, deduped (hourly wins), gpu-filtered', async () => {
    // Provided in ascending doc-id order so the later (current-hour) doc wins
    // any timestamp collision — t=300 appears in both with different cpu.
    queryDocs = [
      bucketDoc('2026-05-24-16', [sample(300, 99, 5, 5), sample(100, 10, 5, 5, 0)]),
      bucketDoc('2026-05-24-17', [sample(200, 20, 5, 5), sample(300, 30, 5, 5)]),
    ];

    const { result } = renderHook(() => useAllSparklineData('node-pa', 'INF-CONTROL'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Sorted ascending by t, t=300 deduped to the current-hour (cpu=30) value.
    expect(result.current.cpu).toEqual([
      { t: 100, v: 10 },
      { t: 200, v: 20 },
      { t: 300, v: 30 },
    ]);
    // No GPU sample had g > 0.
    expect(result.current.gpu).toEqual([]);
  });

  it('keeps only the most recent 60 samples', async () => {
    const seventy = Array.from({ length: 70 }, (_, i) => sample(i + 1, i + 1, 0, 0));
    queryDocs = [bucketDoc('2026-05-24-17', seventy)];

    const { result } = renderHook(() => useAllSparklineData('node-pa', 'INF-CONTROL'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.cpu).toHaveLength(60);
    expect(result.current.cpu[0]).toEqual({ t: 11, v: 11 });
    expect(result.current.cpu[59]).toEqual({ t: 70, v: 70 });
  });

  it('resolves to empty (not loading) when no buckets exist', async () => {
    queryDocs = [];

    const { result } = renderHook(() => useAllSparklineData('node-pa', 'INF-CONTROL'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.cpu).toEqual([]);
    expect(result.current.memory).toEqual([]);
    expect(result.current.disk).toEqual([]);
    expect(result.current.gpu).toEqual([]);
  });

  it('stays in loading while machine ids are unresolved', () => {
    queryDocs = [bucketDoc('2026-05-24-17', [sample(100, 10, 20, 90)])];

    const { result } = renderHook(() => useAllSparklineData(null, null));
    expect(result.current.loading).toBe(true);
    expect(result.current.cpu).toEqual([]);
  });
});

describe('useSparklineData (single metric)', () => {
  it('extracts one metric series from an hourly bucket', async () => {
    queryDocs = [bucketDoc('2026-05-24-17', [sample(100, 10, 20, 90, 50)])];

    const { result } = renderHook(() => useSparklineData('node-pa', 'INF-CONTROL', 'cpu'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.data).toEqual([{ t: 100, v: 10 }]);
  });
});
