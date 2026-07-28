/**
 * Time-series downsampling for metrics charts (single source of truth)
 *
 * Used by useHistoricalMetrics for both its in-loop memory trim and the final
 * display reduction. The core invariant: downsampling must be uniform over
 * TIME, not over array index.
 *
 * Why that matters: samples stream in oldest-first, and the in-loop trim used
 * to re-downsample the accumulated (oldest) data every time the buffer filled,
 * while newer samples kept arriving at full density. After k trims the oldest
 * region held ~(1/3)^k of its samples. The final index-stepped downsample then
 * preserved that recency bias, and the gap-marker pass — whose threshold is the
 * median interval, dominated by the dense recent half — flanked every sparse
 * old point with nulls. Recharts draws nothing for an isolated point between
 * nulls (lines render with dot={false}), so month/year/all charts appeared to
 * start halfway through the range even though every bucket existed in
 * Firestore.
 *
 * Slot sampling over a fixed [domainStart, domainEnd] has no such bias: each
 * slot keeps its first sample, so a region's survival doesn't depend on how
 * many trims it lived through — re-trimming already-trimmed data is a no-op
 * (at most one sample per slot either way).
 */

/** Minimal shape both helpers need. ChartDataPoint satisfies this. */
export interface TimedPoint {
  time: number; // milliseconds
}

/**
 * Reduce `samples` (sorted ascending by time) to at most `targetCount + 1`
 * points, uniformly over the [domainStart, domainEnd] time window: the window
 * is divided into `targetCount` equal slots and the first sample in each slot
 * is kept. The last sample is always included so the line reaches "now".
 *
 * Slots where the machine was offline simply keep nothing — genuine gaps
 * survive for insertGapMarkers to mark.
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
 * Insert gap markers where consecutive samples are too far apart, so Recharts
 * breaks the line instead of interpolating across offline periods. The gap
 * point is produced by `makeGapPoint` (callers supply an all-null point of
 * their chart's shape). Threshold = 3x the median interval between consecutive
 * points (robust to outliers), floored at 5 minutes.
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
      // Null marker at the start of the gap breaks the line segment.
      result.push(makeGapPoint(samples[i - 1].time + 1));
    }
    result.push(samples[i]);
  }
  return result;
}
