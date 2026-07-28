/**
 * Tests for lib/metricsDownsample.ts — time-uniform chart downsampling.
 *
 * The regression suite at the bottom replays the useHistoricalMetrics
 * streaming pipeline (oldest-first buckets, in-loop trim, final display
 * reduction, gap markers) that used to render month/year charts with only
 * their most recent half visible.
 */

import { downsampleTimeUniform, insertGapMarkers } from '@/lib/metricsDownsample';

interface Point {
  time: number;
  cpu: number | null;
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** `count` samples starting at `start`, one every `intervalMs`. */
function makeSeries(start: number, count: number, intervalMs: number): Point[] {
  return Array.from({ length: count }, (_, i) => ({
    time: start + i * intervalMs,
    cpu: 10,
  }));
}

const makeGap = (time: number): Point => ({ time, cpu: null });

describe('downsampleTimeUniform', () => {
  const start = Date.UTC(2026, 5, 28);

  it('returns input unchanged when at or under the target count', () => {
    const samples = makeSeries(start, 100, MINUTE);
    expect(downsampleTimeUniform(samples, 100, start, start + HOUR)).toBe(samples);
    expect(downsampleTimeUniform(samples, 200, start, start + HOUR)).toBe(samples);
  });

  it('reduces uniform data to roughly the target count', () => {
    const samples = makeSeries(start, 10_000, MINUTE);
    const result = downsampleTimeUniform(samples, 400, start, start + 10_000 * MINUTE);
    expect(result.length).toBeGreaterThanOrEqual(400);
    expect(result.length).toBeLessThanOrEqual(401);
  });

  it('always includes the last sample', () => {
    const samples = makeSeries(start, 5_000, MINUTE);
    const result = downsampleTimeUniform(samples, 300, start, start + 5_000 * MINUTE);
    expect(result[result.length - 1]).toBe(samples[samples.length - 1]);
  });

  it('spreads kept samples uniformly over time, not array index', () => {
    // Non-uniform density: first half of the window at 1 sample/10min, second
    // half at 1 sample/min. An index-stepped downsample would keep ~10x more
    // points in the dense half; a time-uniform one keeps them near-equal per
    // unit time (the sparse half keeps everything it has).
    const span = 10 * DAY;
    const sparse = makeSeries(start, (5 * DAY) / (10 * MINUTE), 10 * MINUTE);
    const dense = makeSeries(start + 5 * DAY, (5 * DAY) / MINUTE, MINUTE);
    const result = downsampleTimeUniform([...sparse, ...dense], 400, start, start + span);

    const firstHalf = result.filter((p) => p.time < start + 5 * DAY).length;
    const secondHalf = result.length - firstHalf;
    // 400 slots over 10 days = 36min slots. Sparse half: one 10-min sample per
    // slot -> ~200 kept. Dense half: capped at one per slot -> ~200 kept.
    expect(firstHalf).toBeGreaterThanOrEqual(190);
    expect(secondHalf).toBeGreaterThanOrEqual(190);
    expect(Math.abs(firstHalf - secondHalf)).toBeLessThanOrEqual(20);
  });

  it('is idempotent: re-trimming already-trimmed data changes nothing', () => {
    const samples = makeSeries(start, 21_600, 2 * MINUTE); // 30 days @ 2min
    const domainEnd = start + 30 * DAY;
    const once = downsampleTimeUniform(samples, 5_000, start, domainEnd);
    const twice = downsampleTimeUniform(once, 5_000, start, domainEnd);
    expect(twice).toEqual(once);
  });

  it('preserves genuine offline gaps instead of fabricating points', () => {
    // 2 days of data, then 3 days offline, then 2 days of data.
    const before = makeSeries(start, (2 * DAY) / MINUTE, MINUTE);
    const after = makeSeries(start + 5 * DAY, (2 * DAY) / MINUTE, MINUTE);
    const result = downsampleTimeUniform([...before, ...after], 400, start, start + 7 * DAY);
    const inGap = result.filter(
      (p) => p.time > start + 2 * DAY && p.time < start + 5 * DAY
    );
    expect(inGap).toHaveLength(0);
  });

  it('handles degenerate inputs', () => {
    expect(downsampleTimeUniform([], 100, start, start + HOUR)).toEqual([]);
    const one = makeSeries(start, 1, MINUTE);
    expect(downsampleTimeUniform(one, 100, start, start + HOUR)).toBe(one);
    // Zero-width domain: fall back to the most recent points rather than NaN slots.
    const samples = makeSeries(start, 500, MINUTE);
    const collapsed = downsampleTimeUniform(samples, 100, start, start);
    expect(collapsed.length).toBeLessThanOrEqual(100);
    expect(collapsed[collapsed.length - 1]).toBe(samples[samples.length - 1]);
  });
});

describe('insertGapMarkers', () => {
  const start = Date.UTC(2026, 6, 1);

  it('inserts no markers into evenly spaced data', () => {
    const samples = makeSeries(start, 100, MINUTE);
    expect(insertGapMarkers(samples, makeGap)).toHaveLength(100);
  });

  it('inserts a null marker inside a gap larger than 3x the median interval', () => {
    const before = makeSeries(start, 50, MINUTE);
    const after = makeSeries(start + 50 * MINUTE + 2 * HOUR, 50, MINUTE);
    const result = insertGapMarkers([...before, ...after], makeGap);
    expect(result).toHaveLength(101);
    const marker = result[50];
    expect(marker.cpu).toBeNull();
    expect(marker.time).toBe(before[before.length - 1].time + 1);
  });

  it('never flags gaps under the 5-minute floor', () => {
    // 10s cadence with one 3-minute gap: 3min > 3x median but < 5min floor.
    const before = makeSeries(start, 30, 10 * 1000);
    const after = makeSeries(before[before.length - 1].time + 3 * MINUTE, 30, 10 * 1000);
    expect(insertGapMarkers([...before, ...after], makeGap)).toHaveLength(60);
  });

  it('passes through short arrays untouched', () => {
    expect(insertGapMarkers([], makeGap)).toEqual([]);
    const one = makeSeries(start, 1, MINUTE);
    expect(insertGapMarkers(one, makeGap)).toBe(one);
  });
});

describe('regression: month-view streaming pipeline keeps the whole range visible', () => {
  // Mirrors useHistoricalMetrics: samples arrive oldest-first, the buffer is
  // trimmed to MAX_FETCHED_SAMPLES whenever it exceeds 2x that, then the final
  // pass reduces to MAX_POINTS and inserts gap markers.
  const MAX_FETCHED_SAMPLES = 5_000;
  const MAX_POINTS = 400;

  function runPipeline(all: Point[], domainStart: number, domainEnd: number): Point[] {
    const buffer: Point[] = [];
    for (const sample of all) {
      buffer.push(sample);
      if (buffer.length > MAX_FETCHED_SAMPLES * 2) {
        buffer.sort((a, b) => a.time - b.time);
        buffer.splice(
          0,
          buffer.length,
          ...downsampleTimeUniform(buffer, MAX_FETCHED_SAMPLES, domainStart, domainEnd)
        );
      }
    }
    buffer.sort((a, b) => a.time - b.time);
    const downsampled = downsampleTimeUniform(buffer, MAX_POINTS, domainStart, domainEnd);
    return insertGapMarkers(downsampled, makeGap);
  }

  it('represents every part of a fully-populated month evenly, with no isolated points', () => {
    const start = Date.UTC(2026, 5, 28);
    const span = 30 * DAY;
    // 30 days at 2-min cadence (~21,600 samples) — the volume that triggered
    // two in-loop trims and rendered only the back half of the month.
    const samples = makeSeries(start, span / (2 * MINUTE), 2 * MINUTE);
    const final = runPipeline(samples, start, start + span);

    const real = final.filter((p) => p.cpu !== null);
    expect(final.length - real.length).toBe(0); // continuous data -> no gap markers

    // Every decile of the month is represented within ~2x of the mean.
    const deciles = new Array<number>(10).fill(0);
    for (const p of real) {
      deciles[Math.min(9, Math.floor(((p.time - start) / span) * 10))]++;
    }
    const mean = real.length / 10;
    for (const count of deciles) {
      expect(count).toBeGreaterThan(mean / 2);
      expect(count).toBeLessThan(mean * 2);
    }

    // No real point is flanked by nulls/edges on both sides (such points are
    // invisible with dot={false} — the visual symptom of the original bug).
    for (let i = 0; i < final.length; i++) {
      if (final[i].cpu === null) continue;
      const prevBreak = i === 0 || final[i - 1].cpu === null;
      const nextBreak = i === final.length - 1 || final[i + 1].cpu === null;
      expect(prevBreak && nextBreak).toBe(false);
    }
  });

  it('survives year-scale volume (~12 trims) without starving old data', () => {
    const start = Date.UTC(2026, 3, 29);
    const span = 90 * DAY; // retention-capped "year" view
    const samples = makeSeries(start, span / (2 * MINUTE), 2 * MINUTE);
    const final = runPipeline(samples, start, start + span);

    const real = final.filter((p) => p.cpu !== null);
    const firstQuarter = real.filter((p) => p.time < start + span / 4).length;
    expect(firstQuarter).toBeGreaterThan(real.length / 8);
  });
});
