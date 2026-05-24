'use client';

/**
 * useSparklineData Hook
 *
 * Provides real-time sparkline data for a specific metric type.
 * Uses Firestore snapshot listeners for live updates.
 *
 * Returns the last 60 samples (~1 hour at 1-min resolution) for displaying
 * inline sparklines in machine cards.
 *
 * Bucket shapes (mirrors useHistoricalMetrics):
 * - The cloud function writes hourly UTC buckets: metrics_history/{YYYY-MM-DD-HH}.
 * - Legacy data and the e2e fixtures use a daily bucket: metrics_history/{YYYY-MM-DD}.
 * We subscribe to the current + previous hour buckets (so the window stays full
 * across the top of the hour) plus today's daily bucket, then merge and keep the
 * most recent 60 samples. Listeners re-subscribe at each hour boundary so the
 * data doesn't freeze on a stale bucket when a tab stays open.
 */

import { useState, useEffect } from 'react';
import { collection, query, where, documentId, onSnapshot, type Firestore } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useDemoContext } from '@/contexts/DemoContext';
import { formatHourBucketId, formatDayBucketId } from '@/lib/metricsHistoryBuckets';
import type { SparklineDataPoint, MetricColor } from '@/components/charts';

type SparklineMetricType = 'cpu' | 'memory' | 'disk' | 'gpu';

// Map metric type to abbreviated key in Firestore
const metricKeyMap: Record<SparklineMetricType, 'c' | 'm' | 'd' | 'g'> = {
  cpu: 'c',
  memory: 'm',
  disk: 'd',
  gpu: 'g',
};

const HOUR_MS = 60 * 60 * 1000;
const MAX_SAMPLES = 60;

/** Raw sample as stored in a metrics_history bucket (abbreviated keys). */
interface RawSample {
  t: number;
  c?: number;
  m?: number;
  d?: number;
  g?: number;
}

function currentHourEpoch(): number {
  return Math.floor(Date.now() / HOUR_MS);
}

function msUntilNextHour(): number {
  return HOUR_MS - (Date.now() % HOUR_MS);
}

/**
 * Re-derive an hour epoch at every UTC hour boundary so subscriptions that
 * close over a bucket id get torn down and recreated for the new hour. Inert
 * (no timer) when `active` is false.
 */
function useHourEpoch(active: boolean): number {
  const [epoch, setEpoch] = useState<number>(() => currentHourEpoch());
  useEffect(() => {
    if (!active) return;
    // +2s buffer so we're safely inside the new hour before recomputing ids.
    const timer = setTimeout(() => setEpoch(currentHourEpoch()), msUntilNextHour() + 2000);
    return () => clearTimeout(timer);
  }, [active, epoch]);
  return epoch;
}

/**
 * Subscribe to the metrics_history buckets that can hold the last hour of
 * samples — current + previous hourly buckets plus today's legacy daily bucket
 * — merge them (deduped by timestamp), and deliver the most recent 60 samples
 * sorted ascending by time. Returns an unsubscribe.
 *
 * A single `documentId() in [...]` query listener covers all three buckets
 * (one listener per machine, not three), mirroring how useHistoricalMetrics
 * reads this collection. Only the current-hour doc actually changes minute to
 * minute, so steady-state update traffic is unchanged.
 */
function subscribeLastHourSamples(
  database: Firestore,
  siteId: string,
  machineId: string,
  onSamples: (samples: RawSample[]) => void,
): () => void {
  const now = new Date();
  const bucketIds = [
    formatHourBucketId(new Date(now.getTime() - HOUR_MS)), // previous hour
    formatHourBucketId(now),                               // current hour
    formatDayBucketId(now),                                // legacy / e2e daily
  ];

  const historyRef = collection(database, 'sites', siteId, 'machines', machineId, 'metrics_history');
  const bucketsQuery = query(historyRef, where(documentId(), 'in', bucketIds));

  return onSnapshot(
    bucketsQuery,
    (snapshot) => {
      // Dedupe by timestamp (a sample maps to exactly one bucket in practice;
      // this is defensive against daily/hourly overlap). Query results iterate
      // in documentId order, so the daily bucket ("YYYY-MM-DD") is visited
      // before the hourly ones ("YYYY-MM-DD-HH") — hourly wins any tie. Then
      // sort and keep the last 60.
      const byTime = new Map<number, RawSample>();
      snapshot.forEach((docSnap) => {
        const samples = (docSnap.data()?.samples ?? []) as RawSample[];
        for (const s of samples) {
          if (s && typeof s.t === 'number') byTime.set(s.t, s);
        }
      });
      const merged = Array.from(byTime.values())
        .sort((a, b) => a.t - b.t)
        .slice(-MAX_SAMPLES);
      onSamples(merged);
    },
    (error) => {
      console.error('Error listening to sparkline data:', error);
      onSamples([]);
    },
  );
}

interface UseSparklineDataResult {
  data: SparklineDataPoint[];
  loading: boolean;
}

/**
 * Hook to get sparkline data for a specific metric
 *
 * @param siteId - The site ID
 * @param machineId - The machine ID
 * @param metricType - The metric type (cpu, memory, disk, gpu)
 * @returns Sparkline data array and loading state
 */
export function useSparklineData(
  siteId: string | null,
  machineId: string | null,
  metricType: SparklineMetricType
): UseSparklineDataResult {
  // loadedKey pins data to the (siteId, machineId, metricType) it was loaded
  // for, so `loading` can be derived at render without a sync setState on key
  // change. Parents that haven't resolved IDs yet stay in loading naturally
  // because loadedKey is null until the first snapshot lands.
  const [state, setState] = useState<{
    data: SparklineDataPoint[];
    loadedKey: string | null;
  }>({ data: [], loadedKey: null });

  const currentKey = db && siteId && machineId ? `${siteId}/${machineId}/${metricType}` : null;
  const hourEpoch = useHourEpoch(currentKey !== null);

  useEffect(() => {
    if (!currentKey || !db || !siteId || !machineId) return;

    const valueKey = metricKeyMap[metricType];
    const unsubscribe = subscribeLastHourSamples(db, siteId, machineId, (samples) => {
      const data = samples
        .map((s) => ({ t: s.t, v: s[valueKey] ?? 0 }))
        .filter((s) => s.v !== undefined && s.v !== null);
      setState({ data, loadedKey: currentKey });
    });

    return () => unsubscribe();
    // hourEpoch re-subscribes the listeners at each hour boundary.
  }, [currentKey, siteId, machineId, metricType, hourEpoch]);

  const matched = currentKey !== null && state.loadedKey === currentKey;
  const data = matched ? state.data : EMPTY_SPARKLINE;
  // loading=true whenever db is configured but we haven't loaded current key —
  // includes the "IDs haven't resolved" state so the sparkline doesn't flash.
  const loading = !!db && !matched;
  return { data, loading };
}

/** Stable empty array so consumers' memo/effect deps don't churn. */
const EMPTY_SPARKLINE: SparklineDataPoint[] = [];

/**
 * Hook to get all sparkline data for a machine in one call
 * More efficient than calling useSparklineData 4 times
 *
 * @param siteId - The site ID
 * @param machineId - The machine ID
 * @returns Object with sparkline data for each metric type
 */
interface AllSparklineState {
  cpu: SparklineDataPoint[];
  memory: SparklineDataPoint[];
  disk: SparklineDataPoint[];
  gpu: SparklineDataPoint[];
  loading: boolean;
}

export function useAllSparklineData(
  siteId: string | null,
  machineId: string | null
): AllSparklineState {
  const demo = useDemoContext();
  // Track the (siteId, machineId) the snapshot was loaded for so we can derive
  // loading at render without a sync setState on key change.
  const [state, setState] = useState<{
    cpu: SparklineDataPoint[];
    memory: SparklineDataPoint[];
    disk: SparklineDataPoint[];
    gpu: SparklineDataPoint[];
    loadedKey: string | null;
  }>({ cpu: [], memory: [], disk: [], gpu: [], loadedKey: null });

  const currentKey = !demo && db && siteId && machineId ? `${siteId}/${machineId}` : null;
  const hourEpoch = useHourEpoch(currentKey !== null);

  useEffect(() => {
    // Demo mode is handled entirely at render (see below) — the synthesized
    // topology is pure and cheap to recompute, so we don't stuff it into state.
    if (demo) return;
    if (!currentKey || !db || !siteId || !machineId) return;

    const unsubscribe = subscribeLastHourSamples(db, siteId, machineId, (samples) => {
      const cpu: SparklineDataPoint[] = [];
      const memory: SparklineDataPoint[] = [];
      const disk: SparklineDataPoint[] = [];
      const gpu: SparklineDataPoint[] = [];

      for (const s of samples) {
        cpu.push({ t: s.t, v: s.c ?? 0 });
        memory.push({ t: s.t, v: s.m ?? 0 });
        disk.push({ t: s.t, v: s.d ?? 0 });
        if ((s.g ?? 0) > 0) gpu.push({ t: s.t, v: s.g as number });
      }

      // Single setState — one re-render instead of five
      setState({ cpu, memory, disk, gpu, loadedKey: currentKey });
    });

    return () => unsubscribe();
    // hourEpoch re-subscribes the listeners at each hour boundary.
  }, [currentKey, siteId, machineId, demo, hourEpoch]);

  if (demo && machineId) return { ...demo.getSparklineData(machineId) };
  // Surface only data that matches the currently-requested key. If db isn't
  // configured, loading stays false — there's nothing to wait for. When IDs
  // haven't resolved yet (currentKey is null), stay in loading so the card
  // doesn't flash a "no data" state before the real subscription attaches.
  const matched = currentKey !== null && state.loadedKey === currentKey;
  return {
    cpu: matched ? state.cpu : EMPTY_SPARKLINE,
    memory: matched ? state.memory : EMPTY_SPARKLINE,
    disk: matched ? state.disk : EMPTY_SPARKLINE,
    gpu: matched ? state.gpu : EMPTY_SPARKLINE,
    loading: !demo && !!db && !matched,
  };
}

/**
 * Map metric type to chart color
 */
export function getSparklineColor(metricType: SparklineMetricType): MetricColor {
  return metricType as MetricColor;
}
