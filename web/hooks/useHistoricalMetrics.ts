'use client';

/**
 * useHistoricalMetrics Hook
 *
 * Fetches historical metrics data from Firestore for a specific machine.
 * Used by MetricsDetailPanel to display charts with Day/Week/Month/Year/All ranges.
 *
 * Data structure in Firestore:
 * sites/{siteId}/machines/{machineId}/metrics_history/{YYYY-MM-DD}
 *   samples: [{ t, c, m, d, g, ct, gt }, ...]
 *   meta: { lastSample, sampleCount, resolution }
 */

import { useState, useEffect, useCallback } from 'react';
import { collection, getDocs } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import type { TimeRange } from '@/components/charts';

/**
 * Raw sample from Firestore (abbreviated keys)
 */
export interface MetricsSample {
  t: number;   // timestamp (unix seconds)
  c: number;   // cpu percent
  m: number;   // memory percent
  d: number;   // disk percent
  g?: number;  // gpu percent (optional)
  ct?: number; // cpu temperature (optional)
  gt?: number; // gpu temperature (optional)
}

/**
 * Chart-ready data point (expanded keys, millisecond timestamps)
 */
export interface ChartDataPoint {
  time: number;     // timestamp in milliseconds
  cpu: number | null;
  memory: number | null;
  disk: number | null;
  gpu?: number | null;
  cpuTemp?: number | null;
  gpuTemp?: number | null;
}

interface UseHistoricalMetricsResult {
  data: ChartDataPoint[] | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

/**
 * Calculate the start date for a time range
 */
function getStartDate(range: TimeRange): Date {
  const now = new Date();

  switch (range) {
    case '1h':
      return new Date(now.getTime() - 60 * 60 * 1000);
    case '1d':
      return new Date(now.getTime() - 24 * 60 * 60 * 1000);
    case '1w':
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    case '1m':
      return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    case '1y':
      return new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
    case 'all':
      return new Date(0); // Beginning of time
    default:
      return new Date(now.getTime() - 24 * 60 * 60 * 1000);
  }
}

/**
 * Get list of date bucket IDs to query (YYYY-MM-DD format)
 */
function getBucketIds(start: Date, end: Date): string[] {
  const ids: string[] = [];
  const current = new Date(start);
  current.setUTCHours(0, 0, 0, 0);

  while (current <= end) {
    ids.push(current.toISOString().split('T')[0]);
    current.setDate(current.getDate() + 1);
  }

  return ids;
}

/**
 * Downsample data for performance (max points per range)
 */
function downsampleForDisplay(
  samples: ChartDataPoint[],
  targetCount: number
): ChartDataPoint[] {
  if (samples.length <= targetCount) return samples;

  const step = Math.ceil(samples.length / targetCount);
  const result: ChartDataPoint[] = [];

  for (let i = 0; i < samples.length; i += step) {
    result.push(samples[i]);
  }

  // Always include the last sample
  if (result[result.length - 1] !== samples[samples.length - 1]) {
    result.push(samples[samples.length - 1]);
  }

  return result;
}

/**
 * Insert null-value gap markers where consecutive samples are too far apart.
 * This causes Recharts to break the line instead of interpolating across offline periods.
 * Gap threshold = 3x the median interval between consecutive points.
 */
function insertGapMarkers(samples: ChartDataPoint[]): ChartDataPoint[] {
  if (samples.length < 2) return samples;

  // Calculate all intervals
  const intervals: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    intervals.push(samples[i].time - samples[i - 1].time);
  }

  // Use median interval to determine gap threshold (robust to outliers)
  const sorted = [...intervals].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const gapThreshold = Math.max(median * 3, 5 * 60 * 1000); // At least 5 minutes

  const result: ChartDataPoint[] = [];
  for (let i = 0; i < samples.length; i++) {
    if (i > 0 && samples[i].time - samples[i - 1].time > gapThreshold) {
      // Insert a null marker at the midpoint of the gap
      result.push({
        time: samples[i - 1].time + 1,
        cpu: null,
        memory: null,
        disk: null,
        gpu: null,
        cpuTemp: null,
        gpuTemp: null,
      });
    }
    result.push(samples[i]);
  }
  return result;
}

/**
 * Maximum data points to display per time range
 * Balances chart performance with data density
 */
const MAX_POINTS: Record<TimeRange, number> = {
  '1h': 120,  // Show all points for 1 hour (no downsampling)
  '1d': 200,
  '1w': 300,
  '1m': 400,
  '1y': 500,
  'all': 600,
};

export function useHistoricalMetrics(
  siteId: string | null,
  machineId: string | null,
  timeRange: TimeRange
): UseHistoricalMetricsResult {
  const [data, setData] = useState<ChartDataPoint[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    if (!db || !siteId || !machineId) {
      setLoading(false);
      setData(null);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // Calculate date range
      const now = new Date();
      const startDate = getStartDate(timeRange);
      const startTimestamp = Math.floor(startDate.getTime() / 1000);

      // Get bucket IDs to query
      const bucketIds = getBucketIds(startDate, now);

      // Fetch all relevant buckets
      const historyRef = collection(
        db,
        'sites',
        siteId,
        'machines',
        machineId,
        'metrics_history'
      );

      const allSamples: ChartDataPoint[] = [];

      // Fetch each bucket document
      const snapshot = await getDocs(historyRef);

      snapshot.forEach((doc) => {
        const bucketId = doc.id;

        // Skip buckets outside our range
        if (!bucketIds.includes(bucketId)) return;

        const docData = doc.data();
        const samples = docData.samples || [];

        // Filter samples within time range and convert to chart format
        for (const sample of samples as MetricsSample[]) {
          if (sample.t >= startTimestamp) {
            allSamples.push({
              time: sample.t * 1000, // Convert to milliseconds
              cpu: sample.c,
              memory: sample.m,
              disk: sample.d,
              gpu: sample.g,
              cpuTemp: sample.ct,
              gpuTemp: sample.gt,
            });
          }
        }
      });

      // Sort by timestamp
      allSamples.sort((a, b) => a.time - b.time);

      // Downsample for performance
      const maxPoints = MAX_POINTS[timeRange];
      const downsampled = downsampleForDisplay(allSamples, maxPoints);
      const finalData = insertGapMarkers(downsampled);

      setData(finalData);
    } catch (e: unknown) {
      console.error('Failed to fetch historical metrics:', e);
      setError(e instanceof Error ? e.message : 'Failed to load chart data');
    } finally {
      setLoading(false);
    }
  }, [siteId, machineId, timeRange]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { data, loading, error, refetch: fetchData };
}
