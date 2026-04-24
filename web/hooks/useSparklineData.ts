'use client';

/**
 * useSparklineData Hook
 *
 * Provides real-time sparkline data for a specific metric type.
 * Uses Firestore snapshot listener for live updates.
 *
 * Returns the last 60 samples (1 hour at 1-min resolution) for
 * displaying inline sparklines in machine cards.
 */

import { useState, useEffect } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useDemoContext } from '@/contexts/DemoContext';
import type { SparklineDataPoint, MetricColor } from '@/components/charts';

type SparklineMetricType = 'cpu' | 'memory' | 'disk' | 'gpu';

// Map metric type to abbreviated key in Firestore
const metricKeyMap: Record<SparklineMetricType, string> = {
  cpu: 'c',
  memory: 'm',
  disk: 'd',
  gpu: 'g',
};

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

  useEffect(() => {
    if (!currentKey || !db || !siteId || !machineId) return;

    // Get today's bucket ID
    const bucketId = new Date().toISOString().split('T')[0];

    // Listen to today's metrics history bucket
    const docRef = doc(
      db,
      'sites',
      siteId,
      'machines',
      machineId,
      'metrics_history',
      bucketId
    );

    const unsubscribe = onSnapshot(
      docRef,
      (snapshot) => {
        if (!snapshot.exists()) {
          setState({ data: [], loadedKey: currentKey });
          return;
        }

        const docData = snapshot.data();
        const samples = docData?.samples || [];

        // Get the value key for this metric type
        const valueKey = metricKeyMap[metricType];

        // Extract the last 60 samples (1 hour of data)
        const recentSamples = samples
          .slice(-60)
          .map((s: Record<string, number>) => ({
            t: s.t,
            v: s[valueKey] ?? 0,
          }))
          .filter((s: SparklineDataPoint) => s.v !== undefined && s.v !== null);

        setState({ data: recentSamples, loadedKey: currentKey });
      },
      (error) => {
        console.error('Error listening to sparkline data:', error);
        setState({ data: [], loadedKey: currentKey });
      }
    );

    return () => unsubscribe();
  }, [currentKey, siteId, machineId, metricType]);

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

  useEffect(() => {
    // Demo mode is handled entirely at render (see below) — the synthesized
    // topology is pure and cheap to recompute, so we don't stuff it into state.
    if (demo) return;
    if (!currentKey || !db || !siteId || !machineId) return;

    // Get today's bucket ID
    const bucketId = new Date().toISOString().split('T')[0];

    // Listen to today's metrics history bucket
    const docRef = doc(
      db,
      'sites',
      siteId,
      'machines',
      machineId,
      'metrics_history',
      bucketId
    );

    const unsubscribe = onSnapshot(
      docRef,
      (snapshot) => {
        if (!snapshot.exists()) {
          setState({ cpu: [], memory: [], disk: [], gpu: [], loadedKey: currentKey });
          return;
        }

        const docData = snapshot.data();
        const samples = docData?.samples || [];

        // Get last 60 samples — single pass extracting all metrics
        const recentSamples = samples.slice(-60);
        const cpu: SparklineDataPoint[] = [];
        const memory: SparklineDataPoint[] = [];
        const disk: SparklineDataPoint[] = [];
        const gpu: SparklineDataPoint[] = [];

        for (const s of recentSamples) {
          const t = s.t;
          cpu.push({ t, v: s.c ?? 0 });
          memory.push({ t, v: s.m ?? 0 });
          disk.push({ t, v: s.d ?? 0 });
          if (s.g > 0) gpu.push({ t, v: s.g });
        }

        // Single setState — one re-render instead of five
        setState({ cpu, memory, disk, gpu, loadedKey: currentKey });
      },
      (error) => {
        console.error('Error listening to sparkline data:', error);
        // Mark loaded even on error so the spinner clears.
        setState({ cpu: [], memory: [], disk: [], gpu: [], loadedKey: currentKey });
      }
    );

    return () => unsubscribe();
  }, [currentKey, siteId, machineId, demo]);

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
