/**
 * Time-series downsampling for metrics charts. Used by useHistoricalMetrics for
 * both the in-loop memory trim and the final display reduction.
 *
 * INVARIANT: downsample uniformly over TIME, never over array index.
 *
 * Index stepping was a real bug. Samples stream oldest-first, so each in-loop
 * trim re-thinned only the accumulated old data while new samples arrived at
 * full density — after k trims the oldest region held ~(1/3)^k of its samples.
 * The gap-marker threshold (median interval, dominated by the dense recent
 * half) then flanked every sparse old point with nulls, and Recharts draws
 * nothing for an isolated point between nulls under dot={false}. month/year/all
 * charts appeared to start halfway through the range.
 *
 * Slot sampling over a fixed [domainStart, domainEnd] has no such bias, and
 * re-trimming trimmed data is a no-op: at most one sample per slot either way.
 */

/** Minimal shape both helpers need; ChartDataPoint satisfies it. */
export interface TimedPoint {
  time: number; // milliseconds
}

/**
 * Reduce time-ascending `samples` to at most `targetCount + 1` points by
 * keeping the first sample in each of `targetCount` equal slots across
 * [domainStart, domainEnd]. The last sample is always kept so the line reaches
 * "now"; empty slots keep nothing, leaving real gaps for insertGapMarkers.
 */
export function downsampleTimeUniform<T extends TimedPoint>(
  samples: T[],
  targetCount: number,
  domainStart: number,
  domainEnd: number
): T[] {
  if (samples.length <= targetCount) return samples;

  const span = domainEnd - domainStart;
  if (span <= 0 || targetCount <= 0) return samples.slice(-Math.max(1, targetCount));

  const slotWidth = span / targetCount;
  const result: T[] = [];
  let lastSlot = -1;

  for (const sample of samples) {
    const slot = Math.min(
      targetCount - 1,
      Math.max(0, Math.floor((sample.time - domainStart) / slotWidth))
    );
    if (slot !== lastSlot) {
      result.push(sample);
      lastSlot = slot;
    }
  }

  const lastSample = samples[samples.length - 1];
  if (result[result.length - 1] !== lastSample) {
    result.push(lastSample);
  }

  return result;
}

/**
 * Break the line across offline periods rather than interpolating: insert
 * `makeGapPoint` (an all-null point of the caller's chart shape) wherever
 * consecutive samples exceed 3x the median interval, floored at 5 minutes.
 */
export function insertGapMarkers<T extends TimedPoint>(
  samples: T[],
  makeGapPoint: (time: number) => T
): T[] {
  if (samples.length < 2) return samples;

  const intervals: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    intervals.push(samples[i].time - samples[i - 1].time);
  }

  const sorted = [...intervals].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const gapThreshold = Math.max(median * 3, 5 * 60 * 1000); // At least 5 minutes

  const result: T[] = [];
  for (let i = 0; i < samples.length; i++) {
    if (i > 0 && samples[i].time - samples[i - 1].time > gapThreshold) {
      // A null at the gap's start breaks the segment.
      result.push(makeGapPoint(samples[i - 1].time + 1));
    }
    result.push(samples[i]);
  }
  return result;
}
