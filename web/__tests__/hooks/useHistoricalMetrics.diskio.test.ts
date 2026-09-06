/**
 * @jest-environment jsdom
 *
 * Per-volume disk IO expansion inside useHistoricalMetrics' sample transform.
 *
 * `web/__tests__/lib/diskIOUtils.test.ts` covers the key grammar; this file covers the only
 * place those keys are produced — `sample.dios[]` → `{id}_io_read` / `_io_write` / `_io_busy`
 * (+ the `_pct` pair), the `mb` bandwidth denominator and its `Math.min(100, …)` clamp, and
 * the drive-letter filter. The v1 aggregate shape (`sample.dio`, `diskIO_*` keys) is covered
 * only as a rejection: it was replaced by the per-volume rewrite and must produce nothing.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { formatHourBucketId } from '@/lib/metricsHistoryBuckets';

// Overrides jest.setup.js's `{ db: null }` — the hook early-returns on a null db.
jest.mock('@/lib/firebase', () => ({ db: {} }));

/** Samples the next fetch will find in the single hourly bucket. */
let bucketSamples: unknown[] = [];

const getDocs = jest.fn(async () => {
  // One hourly bucket, rebuilt per call so its id always matches "now". The day `in` query
  // sees it too, but DAY_BUCKET_ID_RE rejects the hourly id, so it lands exactly once.
  const doc = {
    id: formatHourBucketId(new Date()),
    data: () => ({ samples: bucketSamples }),
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
import type { ChartDataPoint, MetricsSample } from '@/hooks/useHistoricalMetrics';

type DiskIOEntry = NonNullable<MetricsSample['dios']>[number];

/** A minimal in-window sample; `secondsAgo` keeps it inside the 1h query window. */
function sampleAt(secondsAgo: number, extra: Partial<MetricsSample> = {}): MetricsSample {
  return {
    t: Math.floor(Date.now() / 1000) - secondsAgo,
    c: 10,
    m: 20,
    d: 30,
    ...extra,
  };
}

/** Render the hook over `samples` and hand back the resolved chart series. */
async function renderPoints(samples: MetricsSample[]): Promise<ChartDataPoint[]> {
  bucketSamples = samples;
  const { result } = renderHook(() => useHistoricalMetrics('site-a', 'TEC-C3A', '1h'));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.error).toBeNull();
  expect(result.current.data).not.toBeNull();
  return result.current.data as ChartDataPoint[];
}

/** Every disk-IO key the transform emitted onto a point, sorted for stable comparison. */
const ioKeys = (point: ChartDataPoint) =>
  Object.keys(point)
    .filter((k) => k.includes('_io_'))
    .sort();

beforeEach(() => {
  getDocs.mockClear();
  bucketSamples = [];
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('dios[] → per-volume series keys', () => {
  it('maps every volume in the array to its own read/write/busy series', async () => {
    const points = await renderPoints([
      sampleAt(60, {
        dios: [
          { i: 'C:', rb: 1_000, wb: 500, bu: 25 },
          { i: 'L:', rb: 4_096, wb: 0, bu: 7.5 },
        ],
      }),
    ]);

    expect(points).toHaveLength(1);
    const p = points[0];

    expect(p['C:_io_read']).toBe(1_000);
    expect(p['C:_io_write']).toBe(500);
    expect(p['C:_io_busy']).toBe(25);

    expect(p['L:_io_read']).toBe(4_096);
    expect(p['L:_io_write']).toBe(0);
    expect(p['L:_io_busy']).toBe(7.5);

    // No `_pct` pair without `mb` — see the bandwidth-denominator suite.
    expect(ioKeys(p)).toEqual([
      'C:_io_busy',
      'C:_io_read',
      'C:_io_write',
      'L:_io_busy',
      'L:_io_read',
      'L:_io_write',
    ]);
  });

  it('keeps each volume independent across a multi-sample series', async () => {
    const points = await renderPoints([
      sampleAt(180, { dios: [{ i: 'C:', rb: 1, wb: 2, bu: 3 }] }),
      sampleAt(120, {
        dios: [
          { i: 'C:', rb: 10, wb: 20, bu: 30 },
          { i: 'D:', rb: 100, wb: 200, bu: 40 },
        ],
      }),
      sampleAt(60, { dios: [{ i: 'D:', rb: 1_000, wb: 2_000, bu: 50 }] }),
    ]);

    expect(points).toHaveLength(3);
    expect(points.map((p) => p['C:_io_read'])).toEqual([1, 10, undefined]);
    expect(points.map((p) => p['D:_io_write'])).toEqual([undefined, 200, 2_000]);
    // A volume absent from a sample leaves its key off that point entirely — Recharts skips
    // undefined, so the line breaks rather than reading a stale value forward.
    expect('D:_io_read' in points[0]).toBe(false);
  });

  it('emits `_io_busy` verbatim — it is PercentDiskTime, not derived from rb/mb', async () => {
    const points = await renderPoints([
      // rb/mb would derive 90%; bu says 12. The two must not be confused.
      sampleAt(60, { dios: [{ i: 'C:', rb: 900, wb: 0, bu: 12, mb: 1_000 }] }),
    ]);

    expect(points[0]['C:_io_busy']).toBe(12);
    expect(points[0]['C:_io_read_pct']).toBe(90);
  });

  it('drops non-drive-letter volume ids (legacy HarddiskVolumeN samples)', async () => {
    const points = await renderPoints([
      sampleAt(60, {
        dios: [
          { i: 'Z:', rb: 1, wb: 1, bu: 1 },
          { i: 'HarddiskVolume2', rb: 2, wb: 2, bu: 2 },
          { i: 'PhysicalDrive0', rb: 3, wb: 3, bu: 3 },
          { i: 'c:', rb: 4, wb: 4, bu: 4 },
          { i: 'CC:', rb: 5, wb: 5, bu: 5 },
        ],
      }),
    ]);

    expect(ioKeys(points[0])).toEqual(['Z:_io_busy', 'Z:_io_read', 'Z:_io_write']);
  });
});

describe('percent-of-bandwidth derivation and clamp', () => {
  it('derives read/write pct as a share of `mb`', async () => {
    const points = await renderPoints([
      sampleAt(60, { dios: [{ i: 'C:', rb: 250_000, wb: 500_000, bu: 40, mb: 1_000_000 }] }),
    ]);

    expect(points[0]['C:_io_read_pct']).toBe(25);
    expect(points[0]['C:_io_write_pct']).toBe(50);
    // Raw bytes/sec ride alongside for tooltips — the derivation never replaces them.
    expect(points[0]['C:_io_read']).toBe(250_000);
    expect(points[0]['C:_io_write']).toBe(500_000);
  });

  it('clamps a rate that exceeds the estimated max bandwidth to 100', async () => {
    // `mb` is a ratcheting hardware-class estimate, so a burst can legitimately exceed the
    // current estimate. Without Math.min these would be 300 and 150 and blow out the 0-100
    // axis the disk-IO lines share with every other percent series.
    const points = await renderPoints([
      sampleAt(60, { dios: [{ i: 'C:', rb: 3_000_000, wb: 1_500_000, bu: 99, mb: 1_000_000 }] }),
    ]);

    expect(points[0]['C:_io_read_pct']).toBe(100);
    expect(points[0]['C:_io_write_pct']).toBe(100);
  });

  it('clamps exactly at the boundary, not below it', async () => {
    const points = await renderPoints([
      sampleAt(60, { dios: [{ i: 'C:', rb: 1_000_000, wb: 999_999, bu: 50, mb: 1_000_000 }] }),
    ]);

    expect(points[0]['C:_io_read_pct']).toBe(100);
    expect(points[0]['C:_io_write_pct']).toBeCloseTo(99.9999, 4);
  });
});

describe('`mb` division guard', () => {
  // The guard is `if (dio.mb && dio.mb > 0)` — falsy (0, undefined, NaN) and non-positive
  // denominators skip the derivation entirely rather than emitting Infinity/NaN/negative
  // percentages into the chart series.
  it.each<[string, number | undefined]>([
    ['absent', undefined],
    ['zero', 0],
    ['negative', -1],
    ['NaN', Number.NaN],
  ])('omits the _pct pair when mb is %s', async (_label, mb) => {
    const dio = { i: 'C:', rb: 250_000, wb: 500_000, bu: 40 } as DiskIOEntry;
    if (mb !== undefined) dio.mb = mb;

    const points = await renderPoints([sampleAt(60, { dios: [dio] })]);
    const p = points[0];

    expect('C:_io_read_pct' in p).toBe(false);
    expect('C:_io_write_pct' in p).toBe(false);
    expect(p['C:_io_read_pct']).toBeUndefined();
    expect(p['C:_io_write_pct']).toBeUndefined();

    // Bytes/sec and busy% still land — a missing denominator degrades the chart to the
    // hidden throughput axis, it does not drop the volume.
    expect(p['C:_io_read']).toBe(250_000);
    expect(p['C:_io_write']).toBe(500_000);
    expect(p['C:_io_busy']).toBe(40);

    // No unguarded division leaked through.
    expect(Object.values(p).some((v) => typeof v === 'number' && !Number.isFinite(v))).toBe(false);
  });
});

describe('samples without per-volume disk IO', () => {
  it('produces no disk-IO keys and no crash when `dios` is absent', async () => {
    const points = await renderPoints([sampleAt(120), sampleAt(60, { g: 55 })]);

    expect(points).toHaveLength(2);
    for (const p of points) {
      expect(ioKeys(p)).toEqual([]);
    }
    // The rest of the transform is unaffected.
    expect(points[0].cpu).toBe(10);
    expect(points[1].gpu).toBe(55);
  });

  it('ignores the retired v1 aggregate shape (`sample.dio`)', async () => {
    // Pre-rewrite history docs still carry `dio`; the reader must not resurrect the
    // `diskIO_read/write/busy` keys, which diskIOUtils now rejects outright.
    const legacy = {
      ...sampleAt(60),
      dio: { rb: 1_000, wb: 500, bu: 25 },
    } as unknown as MetricsSample;

    const points = await renderPoints([legacy]);
    const p = points[0];

    expect(ioKeys(p)).toEqual([]);
    expect(p.diskIO_read).toBeUndefined();
    expect(p.diskIO_write).toBeUndefined();
    expect(p.diskIO_busy).toBeUndefined();
  });

  it('leaves gap markers free of disk-IO keys so the lines break across offline periods', async () => {
    // Dense trio then a long silence: median interval 10s → 5-minute gap floor → one marker.
    const points = await renderPoints([
      sampleAt(3_000, { dios: [{ i: 'C:', rb: 1, wb: 1, bu: 1, mb: 100 }] }),
      sampleAt(2_990, { dios: [{ i: 'C:', rb: 2, wb: 2, bu: 2, mb: 100 }] }),
      sampleAt(2_980, { dios: [{ i: 'C:', rb: 3, wb: 3, bu: 3, mb: 100 }] }),
      sampleAt(100, { dios: [{ i: 'C:', rb: 4, wb: 4, bu: 4, mb: 100 }] }),
    ]);

    expect(points).toHaveLength(5);
    const gap = points[3];
    expect(gap.cpu).toBeNull();
    expect(ioKeys(gap)).toEqual([]);
    expect(points[4]['C:_io_read']).toBe(4);
  });
});
