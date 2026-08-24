/**
 * @jest-environment jsdom
 *
 * Live auto-refresh for the metrics detail chart. The panel used to fetch once on mount and
 * then sit frozen for as long as it stayed open, so an hour chart left up drifted further and
 * further behind "now". These guards pin the cadence (hour: 2m, day: 5m, week+: never), the
 * hidden-tab skip, and the requirement that a refresh repaints in place — no loading spinner,
 * and no error message thrown over a chart that is already good.
 */
import { renderHook, act, waitFor } from '@testing-library/react';
import { formatHourBucketId } from '@/lib/metricsHistoryBuckets';

// Overrides jest.setup.js's `{ db: null }` — the hook early-returns on a null db.
jest.mock('@/lib/firebase', () => ({ db: {} }));

/** cpu value the next fetch will see; bumped to prove a refresh actually re-reads. */
let currentCpu = 10;
/** when set, the next getDocs rejects — stands in for a transient Firestore blip. */
let failNextFetch = false;

const getDocs = jest.fn(async () => {
  if (failNextFetch) throw new Error('firestore unavailable');
  // One hourly bucket holding a sample 30s old, rebuilt per call against the (faked) clock.
  const now = Date.now();
  const doc = {
    id: formatHourBucketId(new Date(now)),
    data: () => ({
      samples: [{ t: Math.floor(now / 1000) - 30, c: currentCpu, m: 20, d: 30 }],
    }),
  };
  return { forEach: (cb: (d: unknown) => void) => [doc].forEach(cb) };
});

jest.mock('firebase/firestore', () => ({
  collection: jest.fn(() => ({})),
  query: jest.fn(() => ({})),
  where: jest.fn(() => ({})),
  orderBy: jest.fn(() => ({})),
  documentId: jest.fn(() => '__name__'),
  getDocs: (...args: unknown[]) => getDocs(...(args as [])),
}));

import { useHistoricalMetrics } from '@/hooks/useHistoricalMetrics';
import type { TimeRange } from '@/components/charts';

/** Each fetch issues exactly two reads: the day `in` query and the hourly range query. */
const READS_PER_FETCH = 2;
const fetchCount = () => getDocs.mock.calls.length / READS_PER_FETCH;

const MINUTE = 60 * 1000;

function renderChart(range: TimeRange) {
  const loadingSeen: boolean[] = [];
  const view = renderHook(() => {
    const r = useHistoricalMetrics('site-a', 'TEC-C3A', range);
    loadingSeen.push(r.loading);
    return r;
  });
  return { ...view, loadingSeen };
}

async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  getDocs.mockClear();
  currentCpu = 10;
  failNextFetch = false;
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('useHistoricalMetrics — auto-refresh cadence', () => {
  it('refreshes the hour chart every 2 minutes, indefinitely', async () => {
    const { result } = renderChart('1h');
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchCount()).toBe(1);

    // Nothing before the interval elapses.
    await advance(MINUTE);
    expect(fetchCount()).toBe(1);

    await advance(MINUTE);
    expect(fetchCount()).toBe(2);

    // Keeps going — this is a repeating interval, not a one-shot catch-up.
    await advance(2 * MINUTE);
    await advance(2 * MINUTE);
    expect(fetchCount()).toBe(4);
  });

  it('refreshes the day chart every 5 minutes, not every 2', async () => {
    const { result } = renderChart('1d');
    await waitFor(() => expect(result.current.loading).toBe(false));

    await advance(2 * MINUTE);
    expect(fetchCount()).toBe(1);

    await advance(3 * MINUTE);
    expect(fetchCount()).toBe(2);
  });

  it.each<TimeRange>(['1w', '1m', '1y', 'all'])('never auto-refreshes %s', async (range) => {
    const { result } = renderChart(range);
    await waitFor(() => expect(result.current.loading).toBe(false));
    const initial = getDocs.mock.calls.length;

    await advance(30 * MINUTE);
    expect(getDocs.mock.calls.length).toBe(initial);
  });

  it('skips the poll while the tab is hidden', async () => {
    const { result } = renderChart('1h');
    await waitFor(() => expect(result.current.loading).toBe(false));

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    await advance(6 * MINUTE);
    expect(fetchCount()).toBe(1);

    // Back in view: the visibility handler catches up past the 30s staleness gate.
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(fetchCount()).toBe(2);
  });
});

describe('useHistoricalMetrics — background refresh repaints in place', () => {
  it('swaps in new data without ever raising loading again', async () => {
    const { result, loadingSeen } = renderChart('1h');
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data?.at(-1)?.cpu).toBe(10);

    loadingSeen.length = 0;
    currentCpu = 77;
    await advance(2 * MINUTE);

    await waitFor(() => expect(result.current.data?.at(-1)?.cpu).toBe(77));
    // A spinner here would blank the whole panel body every two minutes.
    expect(loadingSeen).not.toContain(true);
  });

  it('keeps the last good chart when a background refresh fails', async () => {
    const { result } = renderChart('1h');
    await waitFor(() => expect(result.current.loading).toBe(false));
    const good = result.current.data;

    // The hook logs the swallowed failure; keep the suite output clean.
    jest.spyOn(console, 'error').mockImplementation(() => {});
    failNextFetch = true;
    await advance(2 * MINUTE);

    expect(result.current.error).toBeNull();
    expect(result.current.data).toBe(good);

    // Recovers on the next tick.
    failNextFetch = false;
    currentCpu = 42;
    await advance(2 * MINUTE);
    await waitFor(() => expect(result.current.data?.at(-1)?.cpu).toBe(42));
  });
});
