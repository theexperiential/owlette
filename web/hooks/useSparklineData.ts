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
  const [data, setData] = useState<SparklineDataPoint[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!db || !siteId || !machineId) {
      setLoading(false);
      setData([]);
      return;
    }

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
          setData([]);
          setLoading(false);
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

        setData(recentSamples);
        setLoading(false);
      },
      (error) => {
        console.error('Error listening to sparkline data:', error);
        setData([]);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [siteId, machineId, metricType]);

  return { data, loading };
}

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

const EMPTY_SPARKLINE_STATE: AllSparklineState = {
  cpu: [], memory: [], disk: [], gpu: [], loading: true,
};

export function useAllSparklineData(
  siteId: string | null,
  machineId: string | null
): AllSparklineState {
  const demo = useDemoContext();
  const [state, setState] = useState<AllSparklineState>(
    demo && machineId ? { ...demo.getSparklineData(machineId) } : EMPTY_SPARKLINE_STATE
  );

  useEffect(() => {
    if (demo && machineId) {
      setState({ ...demo.getSparklineData(machineId) });
      return;
    }

    if (!db || !siteId || !machineId) {
      setState(prev => prev.loading ? { ...prev, loading: false } : prev);
      return;
    }

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
          setState({ cpu: [], memory: [], disk: [], gpu: [], loading: false });
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
        setState({ cpu, memory, disk, gpu, loading: false });
      },
      (error) => {
        console.error('Error listening to sparkline data:', error);
        setState(prev => prev.loading ? { ...prev, loading: false } : prev);
      }
    );

    return () => unsubscribe();
  }, [siteId, machineId, demo]);

  return state;
}

/**
 * Map metric type to chart color
 */
export function getSparklineColor(metricType: SparklineMetricType): MetricColor {
  return metricType as MetricColor;
}
