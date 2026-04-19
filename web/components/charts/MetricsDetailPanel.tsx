'use client';

/**
 * MetricsDetailPanel Component
 *
 * Expanded chart view for detailed metric analysis.
 * Replaces the top stats cards when a sparkline is clicked.
 * Supports per-NIC network metrics with TX/RX utilization lines.
 */

import { useState, useMemo, useEffect, useCallback } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Tooltip as UITooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { X, ToggleLeft, ToggleRight, Monitor, HardDrive, ArrowDownUp } from 'lucide-react';
import { TimeRangeSelector, type TimeRange } from './TimeRangeSelector';
import { ChartTooltip, metricConfig, type MetricType } from './ChartTooltip';
import {
  serializeTabs,
  deserializeTabs,
  initialMetricToState,
  type TabSelection,
} from './metricsTabs';
import { useHistoricalMetrics } from '@/hooks/useHistoricalMetrics';
import { getNicColors, getDiskColors, getGpuColors, formatThroughput } from '@/lib/networkUtils';
import { DISK_IO_COLORS, formatDiskIO, isDiskIOKey, parseDiskIOKey } from '@/lib/diskIOUtils';
import { useAuth } from '@/contexts/AuthContext';
import { cn } from '@/lib/utils';
import { LoadingWord } from '@/components/LoadingWord';

interface MetricsDetailPanelProps {
  machineId: string;
  machineName?: string;
  siteId: string;
  initialMetric?: MetricType;
  onClose: () => void;
  /** Static GPU profile entries keyed by UUID — used to render friendly
   *  names in toggle labels, chart lines, stats grid, and tooltip while
   *  keeping the UUID as the stable chart-data key. */
  gpus?: ReadonlyArray<{ id: string; name?: string }>;
}

// Pure tab-state helpers (serializeTabs / deserializeTabs / initialMetricToState)
// and the DiskIOChannel / TabSelection types live in ./metricsTabs so the
// dashboard can import them without pulling Recharts into the main bundle.

// Reserved horizontal space for the Recharts YAxis. Also used as left padding
// on the stats grid so the stat cards align flush with the chart's plot area
// (the "0" on the x-axis) for a crisp visual edge.
const CHART_Y_AXIS_WIDTH = 40;

function getISOWeek(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Drive-letter shape: `C:`, `L:`, etc. Filters out raw `HarddiskVolumeN`
 *  partitions that have no drive-letter mapping. */
function isDriveLetter(id: string): boolean {
  return /^[A-Z]:$/.test(id);
}

export function MetricsDetailPanel({
  machineId,
  machineName,
  siteId,
  initialMetric = 'cpu',
  onClose,
  gpus,
}: MetricsDetailPanelProps) {
  // UUID → friendly-name lookup for GPU labels. Chart keys stay UUID-based
  // (stable, unique, unaffected by driver-induced name changes) while the
  // user sees "NVIDIA GeForce RTX 2080 Ti" everywhere a label would show.
  const gpuLabels = useMemo(() => {
    const m = new Map<string, string>();
    if (gpus) for (const g of gpus) if (g.name) m.set(g.id, g.name);
    return m;
  }, [gpus]);
  const resolveGpuLabel = useCallback(
    (id: string) => gpuLabels.get(id) ?? id,
    [gpuLabels],
  );

  const { userPreferences, updateUserPreferences } = useAuth();
  const graphTabs = userPreferences.graphTabs;

  // Seed from persisted selection on first render so there's no flash between
  // the default and the restored selection. The dashboard click handler writes
  // the fresh click intent to graphTabs before activeGraphPanel is set, so by
  // the time we mount the persisted list already reflects the clicked metric.
  const [selectedMetrics, setSelectedMetrics] = useState<MetricType[]>(() => {
    const persisted = deserializeTabs(graphTabs?.[machineId]);
    const hasPersisted = persisted.metrics.length + persisted.nics.length + persisted.disks.length + persisted.gpus.length + persisted.diskIO.length > 0;
    return hasPersisted ? persisted.metrics : initialMetricToState(initialMetric).metrics;
  });
  const [selectedNics, setSelectedNics] = useState<string[]>(() => {
    const persisted = deserializeTabs(graphTabs?.[machineId]);
    const hasPersisted = persisted.metrics.length + persisted.nics.length + persisted.disks.length + persisted.gpus.length + persisted.diskIO.length > 0;
    return hasPersisted ? persisted.nics : initialMetricToState(initialMetric).nics;
  });
  const [selectedDisks, setSelectedDisks] = useState<string[]>(() => {
    const persisted = deserializeTabs(graphTabs?.[machineId]);
    const hasPersisted = persisted.metrics.length + persisted.nics.length + persisted.disks.length + persisted.gpus.length + persisted.diskIO.length > 0;
    return hasPersisted ? persisted.disks : initialMetricToState(initialMetric).disks;
  });
  const [selectedGpus, setSelectedGpus] = useState<string[]>(() => {
    const persisted = deserializeTabs(graphTabs?.[machineId]);
    const hasPersisted = persisted.metrics.length + persisted.nics.length + persisted.disks.length + persisted.gpus.length + persisted.diskIO.length > 0;
    return hasPersisted ? persisted.gpus : initialMetricToState(initialMetric).gpus;
  });
  const [selectedDiskIO, setSelectedDiskIO] = useState<string[]>(() => {
    const persisted = deserializeTabs(graphTabs?.[machineId]);
    const hasPersisted = persisted.metrics.length + persisted.nics.length + persisted.disks.length + persisted.gpus.length + persisted.diskIO.length > 0;
    return hasPersisted ? persisted.diskIO : initialMetricToState(initialMetric).diskIO;
  });
  const [timeRange, setTimeRangeState] = useState<TimeRange>(
    () => userPreferences.graphTimeRange || '1h',
  );

  // Keep local state in sync if another tab/device updates the preference.
  useEffect(() => {
    const next = userPreferences.graphTimeRange || '1h';
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTimeRangeState((prev) => (prev === next ? prev : next));
  }, [userPreferences.graphTimeRange]);

  const setTimeRange = useCallback((range: TimeRange) => {
    setTimeRangeState(range);
    updateUserPreferences({ graphTimeRange: range }, { silent: true })
      .catch(() => { /* fire-and-forget; matches statsExpanded pattern */ });
  }, [updateUserPreferences]);

  const { data, loading, error } = useHistoricalMetrics(siteId, machineId, timeRange);

  // Stable empty-array reference when data is null so downstream useMemo
  // dependencies don't thrash on every render while loading.
  const chartData = useMemo(() => data ?? [], [data]);

  // Extract unique device names from chart data by suffix convention
  const nicNames = useMemo(() => {
    const names = new Set<string>();
    for (const d of chartData) {
      for (const key of Object.keys(d)) {
        if (key.endsWith('_tx_util')) names.add(key.replace('_tx_util', ''));
      }
    }
    return Array.from(names);
  }, [chartData]);

  const diskNames = useMemo(() => {
    const names = new Set<string>();
    for (const d of chartData) {
      for (const key of Object.keys(d)) {
        if (key.endsWith('_pct') && !key.endsWith('_io_read_pct') && !key.endsWith('_io_write_pct')) {
          const id = key.slice(0, -4);
          if (isDriveLetter(id)) names.add(id);
        }
      }
    }
    return Array.from(names).sort();
  }, [chartData]);

  const gpuNames = useMemo(() => {
    const names = new Set<string>();
    for (const d of chartData) {
      for (const key of Object.keys(d)) {
        if (key.endsWith('_usage')) names.add(key.slice(0, -6));
      }
    }
    return Array.from(names);
  }, [chartData]);

  // Discover available volume ids from the flat `{volumeId}_io_{channel}` chart
  // keys. Any sample that carries at least one IO key contributes its volume.
  // Sorted for stable toggle-row ordering.
  const volumeIds = useMemo(() => {
    const ids = new Set<string>();
    for (const d of chartData) {
      for (const key of Object.keys(d)) {
        if (isDiskIOKey(key)) {
          const parsed = parseDiskIOKey(key);
          if (parsed) ids.add(parsed.id);
        }
      }
    }
    return Array.from(ids).sort();
  }, [chartData]);

  // Mirror persisted selection into local state. The click handler at the
  // dashboard level (see handleMetricClick) merges click intent into graphTabs
  // at click time, so the persisted list is already the source of truth.
  // Falling back to the initialMetric default only applies when graphTabs has
  // no entry for this machine yet (first-ever open).
  useEffect(() => {
    const persisted = deserializeTabs(graphTabs?.[machineId]);
    const hasPersisted = persisted.metrics.length + persisted.nics.length + persisted.disks.length + persisted.gpus.length + persisted.diskIO.length > 0;
    const next: TabSelection = hasPersisted ? persisted : initialMetricToState(initialMetric);

    // Reconciling local selection state with external (persisted) selection is
    // a legitimate sync-external-source case; the guarded setters no-op when
    // nothing changed so no cascading renders occur.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedMetrics((prev) => (sameStringArray(prev, next.metrics) ? prev : next.metrics));
    setSelectedNics((prev) => (sameStringArray(prev, next.nics) ? prev : next.nics));
    setSelectedDisks((prev) => (sameStringArray(prev, next.disks) ? prev : next.disks));
    setSelectedGpus((prev) => (sameStringArray(prev, next.gpus) ? prev : next.gpus));
    setSelectedDiskIO((prev) => (sameStringArray(prev, next.diskIO) ? prev : next.diskIO));
  }, [machineId, initialMetric, graphTabs]);

  // Generic 'disk' / 'gpu' / 'gpuTemp' are hidden from the toggle UI when
  // per-device data exists, but they may still be present in selectedMetrics
  // (from old persisted state or click intent). Filter at render time so they
  // don't draw invisible duplicate lines without affecting persisted state.
  const effectiveMetrics = useMemo(() => {
    let m = selectedMetrics;
    if (diskNames.length > 0) m = m.filter((x) => x !== 'disk');
    if (gpuNames.length > 0) m = m.filter((x) => x !== 'gpu' && x !== 'gpuTemp');
    return m;
  }, [selectedMetrics, diskNames.length, gpuNames.length]);

  // Filter out volumes no longer present in chart data — the persisted
  // selection may still reference a volume from an earlier active period.
  // Following the effectiveMetrics pattern: don't mutate persisted state,
  // just render only what the chart currently supports.
  const effectiveDiskIO = useMemo(
    () => selectedDiskIO.filter((v) => volumeIds.includes(v)),
    [selectedDiskIO, volumeIds],
  );

  // Total number of selected lines across all categories. Each disk IO
  // toggle contributes 2 lines (read + write), matching the visual count
  // in the chart.
  const totalSelected =
    effectiveMetrics.length + selectedNics.length + selectedDisks.length + selectedGpus.length + effectiveDiskIO.length * 2;

  const persistSelections = useCallback((sel: Partial<TabSelection>) => {
    const merged: TabSelection = {
      metrics: sel.metrics ?? selectedMetrics,
      nics: sel.nics ?? selectedNics,
      disks: sel.disks ?? selectedDisks,
      gpus: sel.gpus ?? selectedGpus,
      diskIO: sel.diskIO ?? selectedDiskIO,
    };
    const ids = serializeTabs(merged);
    updateUserPreferences(
      { graphTabs: { ...(graphTabs || {}), [machineId]: ids } },
      { silent: true },
    ).catch(() => { /* fire-and-forget; matches statsExpanded pattern */ });
  }, [selectedMetrics, selectedNics, selectedDisks, selectedGpus, selectedDiskIO, graphTabs, machineId, updateUserPreferences]);

  const toggleMetric = (metric: MetricType) => {
    setSelectedMetrics((prev) => {
      if (prev.includes(metric)) {
        const next = prev.filter((m) => m !== metric);
        persistSelections({ metrics: next });
        return next;
      }
      const next = [...prev, metric];
      persistSelections({ metrics: next });
      return next;
    });
  };

  const toggleNic = (nicName: string) => {
    setSelectedNics((prev) => {
      if (prev.includes(nicName)) {
        const next = prev.filter((n) => n !== nicName);
        persistSelections({ nics: next });
        return next;
      }
      const next = [...prev, nicName];
      persistSelections({ nics: next });
      return next;
    });
  };

  const toggleDisk = (diskName: string) => {
    setSelectedDisks((prev) => {
      if (prev.includes(diskName)) {
        const next = prev.filter((d) => d !== diskName);
        persistSelections({ disks: next });
        return next;
      }
      const next = [...prev, diskName];
      persistSelections({ disks: next });
      return next;
    });
  };

  const toggleGpu = (gpuName: string) => {
    setSelectedGpus((prev) => {
      if (prev.includes(gpuName)) {
        const next = prev.filter((g) => g !== gpuName);
        persistSelections({ gpus: next });
        return next;
      }
      const next = [...prev, gpuName];
      persistSelections({ gpus: next });
      return next;
    });
  };

  const toggleDiskIO = (volumeId: string) => {
    setSelectedDiskIO((prev) => {
      const next = prev.includes(volumeId)
        ? prev.filter((v) => v !== volumeId)
        : [...prev, volumeId];
      persistSelections({ diskIO: next });
      return next;
    });
  };

  // NOTE: per-device auto-select lives in the dashboard click handler now —
  // clicking a generic 'disk' / 'gpu' cell expands to all devices on that
  // machine at click time. Doing it at mount time here previously clobbered
  // user intent after an explicit clear (toggle-all-off), because the persisted
  // empty-disks state is indistinguishable from "first-ever open" at this layer.

  const hour12 = (userPreferences.timeFormat || '12h') === '12h';

  // Memoized so Recharts' XAxis/Tooltip don't re-mount on every parent render.
  const formatXAxisTick = useCallback((timestamp: number): string => {
    const date = new Date(timestamp);
    switch (timeRange) {
      case '1h':
        return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12 });
      case '1d':
        // Show date at midnight, hour otherwise
        return date.getHours() === 0
          ? date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
          : date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12 });
      case '1w':
        return `W${getISOWeek(date)} ${date.toLocaleDateString(undefined, { weekday: 'short' })}`;
      case '1m':
      case '1y':
        return date.toLocaleDateString(undefined, { month: 'short' });
      case 'all':
        return date.toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
      default:
        return date.toLocaleTimeString(undefined, { hour12 });
    }
  }, [timeRange, hour12]);

  const formatTooltipTime = useCallback((ts: number): string => {
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12 });
  }, [hour12]);

  // Latch "now" in state so the time domain is a pure function of state.
  // Refresh on every new data sample (chartData.length) AND on range change
  // so the right edge tracks wall-clock as new metrics arrive — matches the
  // behavior of the previous Date.now()-in-render implementation.
  // setState-in-effect is intentional: Date.now() is impure and can't be called
  // during render, so we have to sync the external clock here.
  const [nowTs, setNowTs] = useState<number>(() => Date.now());
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNowTs(Date.now());
  }, [timeRange, chartData.length]);

  // Recharts' ResponsiveContainer uses ResizeObserver to measure its container,
  // but ResizeObserver and rAF are throttled while the tab is hidden. When the
  // tab becomes visible again the chart sometimes holds a stale width — the
  // plot area renders offset to the right with empty space on the left. Forcing
  // a window resize event triggers all ResponsiveContainers to re-measure.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        window.dispatchEvent(new Event('resize'));
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // Calculate the time domain based on selected range
  const timeDomain = useMemo((): [number, number] => {
    const now = nowTs;
    switch (timeRange) {
      case '1h':
        return [now - 60 * 60 * 1000, now];
      case '1d':
        return [now - 24 * 60 * 60 * 1000, now];
      case '1w':
        return [now - 7 * 24 * 60 * 60 * 1000, now];
      case '1m':
        return [now - 30 * 24 * 60 * 60 * 1000, now];
      case '1y':
        return [now - 365 * 24 * 60 * 60 * 1000, now];
      case 'all':
        // For 'all', use data range or default to 1 year if no data
        if (chartData.length > 0) {
          const minTime = Math.min(...chartData.map(d => d.time));
          return [minTime, now];
        }
        return [now - 365 * 24 * 60 * 60 * 1000, now];
      default:
        return [now - 24 * 60 * 60 * 1000, now];
    }
  }, [timeRange, chartData, nowTs]);

  // Explicit ticks keep the x-axis clean: one label per natural unit
  // (date / week-day / month), no repeats, and no auto-generated gaps where
  // the data is sparse.
  const xTicks = useMemo((): number[] | undefined => {
    const [start, end] = timeDomain;
    if (timeRange === '1h') return undefined; // let recharts auto-tick
    const ticks: number[] = [];
    if (timeRange === '1d') {
      // One tick per hour. Step 2h so 24 labels don't overcrowd.
      const d = new Date(start);
      d.setMinutes(0, 0, 0);
      if (d.getTime() < start) d.setHours(d.getHours() + 1);
      // Align to even hours so midnight is always a tick when in range.
      while (d.getHours() % 2 !== 0) d.setHours(d.getHours() + 1);
      while (d.getTime() <= end) {
        ticks.push(d.getTime());
        d.setHours(d.getHours() + 2);
      }
      return ticks;
    }
    if (timeRange === '1w') {
      // One tick per midnight within the range.
      const d = new Date(start);
      d.setHours(0, 0, 0, 0);
      if (d.getTime() < start) d.setDate(d.getDate() + 1);
      while (d.getTime() <= end) {
        ticks.push(d.getTime());
        d.setDate(d.getDate() + 1);
      }
      return ticks;
    }
    // 1m / 1y / all: one tick per calendar month start.
    const d = new Date(start);
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    if (d.getTime() < start) d.setMonth(d.getMonth() + 1);
    while (d.getTime() <= end) {
      ticks.push(d.getTime());
      d.setMonth(d.getMonth() + 1);
    }
    return ticks;
  }, [timeRange, timeDomain]);

  // When per-device data exists, hide generic Disk/GPU from metric toggles
  // to avoid redundant lines (scalar primary = one of the per-device entries).
  const availableMetrics: MetricType[] = useMemo(() => {
    const base: MetricType[] = ['cpu', 'memory'];
    // Only show generic Disk if no per-device disk data
    if (diskNames.length === 0) base.push('disk');
    // Only show generic GPU/GPU° if no per-device GPU data
    if (gpuNames.length === 0) {
      if (chartData.some((d) => d.gpu != null && d.gpu > 0)) base.push('gpu');
      if (chartData.some((d) => d.gpuTemp !== undefined)) base.push('gpuTemp');
    }
    if (chartData.some((d) => d.cpuTemp !== undefined)) {
      base.push('cpuTemp');
    }
    return base;
  }, [chartData, diskNames.length, gpuNames.length]);

  const hasSelection = totalSelected > 0;

  // All-selected = every visible toggle is on.
  const allSelected =
    effectiveMetrics.length === availableMetrics.length &&
    selectedNics.length === nicNames.length &&
    selectedDisks.length === diskNames.length &&
    selectedGpus.length === gpuNames.length &&
    effectiveDiskIO.length === volumeIds.length;

  const toggleAll = () => {
    const nextMetrics = allSelected ? [initialMetric] : [...availableMetrics];
    const nextNics = allSelected ? [] : [...nicNames];
    const nextDisks = allSelected ? [] : [...diskNames];
    const nextGpus = allSelected ? [] : [...gpuNames];
    const nextDiskIO: string[] = allSelected ? [] : [...volumeIds];
    setSelectedMetrics(nextMetrics);
    setSelectedNics(nextNics);
    setSelectedDisks(nextDisks);
    setSelectedGpus(nextGpus);
    setSelectedDiskIO(nextDiskIO);
    persistSelections({ metrics: nextMetrics, nics: nextNics, disks: nextDisks, gpus: nextGpus, diskIO: nextDiskIO });
  };

  // Build the list of all active Line dataKeys and their display info.
  // `hidden: true` means the line renders with transparent stroke (tooltip-only
  // data access). `axis: 'hidden'` binds the line to the hidden Y-axis so it
  // doesn't blow out the 0-100% scale — used for visible throughput series
  // like disk IO read/write bytes/sec.
  const activeLines = useMemo(() => {
    const lines: { key: string; color: string; label: string; hidden?: boolean; axis?: 'default' | 'hidden' }[] = [];

    // Standard metrics
    for (const metric of effectiveMetrics) {
      const config = metricConfig[metric];
      if (config) {
        lines.push({ key: metric, color: config.color, label: config.label });
      }
    }

    // Per-NIC lines: TX util + RX util (visible), TX bytes + RX bytes (hidden, for tooltip)
    for (const nicName of selectedNics) {
      const nicIdx = nicNames.indexOf(nicName);
      const colors = getNicColors(nicIdx >= 0 ? nicIdx : 0);
      lines.push({ key: `${nicName}_tx_util`, color: colors.tx, label: `${nicName} TX` });
      lines.push({ key: `${nicName}_rx_util`, color: colors.rx, label: `${nicName} RX` });
      // Hidden throughput lines — included in data so tooltip can read them
      lines.push({ key: `${nicName}_tx`, color: colors.tx, label: `${nicName} TX (bps)`, hidden: true });
      lines.push({ key: `${nicName}_rx`, color: colors.rx, label: `${nicName} RX (bps)`, hidden: true });
    }

    // Per-disk lines: one usage% line per disk
    for (const diskName of selectedDisks) {
      const diskIdx = diskNames.indexOf(diskName);
      const color = getDiskColors(diskIdx >= 0 ? diskIdx : 0);
      lines.push({ key: `${diskName}_pct`, color, label: diskName });
    }

    // Per-GPU lines: usage% + temperature per GPU
    for (const gpuName of selectedGpus) {
      const gpuIdx = gpuNames.indexOf(gpuName);
      const colors = getGpuColors(gpuIdx >= 0 ? gpuIdx : 0);
      const friendly = resolveGpuLabel(gpuName);
      lines.push({ key: `${gpuName}_usage`, color: colors.usage, label: friendly });
      lines.push({ key: `${gpuName}_temp`, color: colors.temp, label: `${friendly}°` });
    }

    // Per-volume disk IO lines. Throughput (read/write) varies over orders of
    // magnitude and shares the hidden axis with NIC bytes; busy % sits on the
    // default 0-100 axis alongside CPU / memory / disk.
    // Per-volume disk IO activity: 2 lines per selected volume (read + write)
    // both as % of max bandwidth on the default 0-100 axis.
    for (const volumeId of effectiveDiskIO) {
      lines.push({
        key: `${volumeId}_io_read_pct`,
        color: DISK_IO_COLORS.read,
        label: `${volumeId} read`,
      });
      lines.push({
        key: `${volumeId}_io_write_pct`,
        color: DISK_IO_COLORS.write,
        label: `${volumeId} write`,
      });
    }

    return lines;
  }, [effectiveMetrics, selectedNics, nicNames, selectedDisks, diskNames, selectedGpus, gpuNames, effectiveDiskIO, resolveGpuLabel]);

  // Collect all selected metric/NIC/disk/GPU/disk-IO keys for stats summary.
  // `format: 'throughput'` switches the grid cell to byte-rate formatting
  // (e.g. "1.5 MB/s") instead of the default "{value}{unit}" percent display.
  const statsKeys = useMemo(() => {
    const keys: { key: string; label: string; color: string; isNetwork: boolean; unit?: string; format?: 'throughput' }[] = [];
    for (const metric of effectiveMetrics) {
      const config = metricConfig[metric];
      if (config) keys.push({ key: metric, label: config.label, color: config.color, isNetwork: false });
    }
    for (const nicName of selectedNics) {
      const nicIdx = nicNames.indexOf(nicName);
      const colors = getNicColors(nicIdx >= 0 ? nicIdx : 0);
      keys.push({ key: `${nicName}_tx_util`, label: `${nicName} TX`, color: colors.tx, isNetwork: true });
      keys.push({ key: `${nicName}_rx_util`, label: `${nicName} RX`, color: colors.rx, isNetwork: true });
    }
    for (const diskName of selectedDisks) {
      const diskIdx = diskNames.indexOf(diskName);
      const color = getDiskColors(diskIdx >= 0 ? diskIdx : 0);
      keys.push({ key: `${diskName}_pct`, label: diskName, color, isNetwork: false, unit: '%' });
    }
    for (const gpuName of selectedGpus) {
      const gpuIdx = gpuNames.indexOf(gpuName);
      const colors = getGpuColors(gpuIdx >= 0 ? gpuIdx : 0);
      const friendly = resolveGpuLabel(gpuName);
      keys.push({ key: `${gpuName}_usage`, label: friendly, color: colors.usage, isNetwork: false, unit: '%' });
      keys.push({ key: `${gpuName}_temp`, label: `${friendly}°`, color: colors.temp, isNetwork: false, unit: '°C' });
    }
    for (const volumeId of effectiveDiskIO) {
      keys.push({
        key: `${volumeId}_io_read_pct`,
        label: `${volumeId} read`,
        color: DISK_IO_COLORS.read,
        isNetwork: false,
        unit: '%',
      });
      keys.push({
        key: `${volumeId}_io_write_pct`,
        label: `${volumeId} write`,
        color: DISK_IO_COLORS.write,
        isNetwork: false,
        unit: '%',
      });
    }
    return keys;
  }, [effectiveMetrics, selectedNics, nicNames, selectedDisks, diskNames, selectedGpus, gpuNames, effectiveDiskIO, resolveGpuLabel]);

  return (
    <Card className="border-border bg-card py-0 gap-0">
      <CardContent className="p-4">
        {/* Title row */}
        <div className="flex items-center gap-3 mb-3">
          <span className="flex items-center gap-2 text-xl font-semibold text-foreground shrink-0">
            <Monitor className="h-5 w-5 text-muted-foreground" />
            {machineName || machineId}
          </span>
          <div className="flex-1" />
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="bg-card border border-border text-muted-foreground hover:text-white h-8 w-8 p-0 shrink-0"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Loading branch — historical-metrics fetch in flight. The 320px
            height matches the chart + stats area below so when the body
            commits there's no height shift. */}
        {loading ? (
          <div
            className="flex items-center justify-center h-[320px]"
            role="status"
            aria-live="polite"
            aria-busy="true"
            aria-label="loading metrics"
          >
            <div className="text-muted-foreground animate-pulse text-sm"><LoadingWord /></div>
          </div>
        ) : (
        <div className="animate-in fade-in duration-100">
        {/* Controls row */}
        <div className="flex items-center gap-3 mb-3">
          {/* Metric toggle buttons - left aligned */}
          <div className="flex flex-wrap items-center gap-1.5">
            <UITooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={toggleAll}
                  className="bg-card border border-border text-muted-foreground hover:text-white h-8 w-8 p-0 shrink-0"
                >
                  {allSelected ? (
                    <ToggleRight className="h-4 w-4" />
                  ) : (
                    <ToggleLeft className="h-4 w-4" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>{allSelected ? 'show only initial metric' : 'show all metrics'}</p>
              </TooltipContent>
            </UITooltip>
            {availableMetrics.map((metric) => {
              const config = metricConfig[metric];
              const isSelected = effectiveMetrics.includes(metric);

              return (
                <Button
                  key={metric}
                  variant={isSelected ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => toggleMetric(metric)}
                  className={cn(
                    'text-xs h-8 px-3 transition-colors',
                    isSelected
                      ? 'bg-accent text-foreground border-transparent ring-1 ring-primary/40 hover:bg-accent'
                      : 'bg-card text-muted-foreground border-border hover:bg-accent/40 hover:text-foreground'
                  )}
                >
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: config.color }}
                  />
                  <span className="ml-1.5">{config.label}</span>
                </Button>
              );
            })}

            {/* Per-disk STORAGE toggle (disk usage %) — `<HardDrive>` icon
                signals "how full" / capacity, distinct from the activity
                toggle below for the same drive. */}
            {diskNames.map((diskName, diskIdx) => {
              const isSelected = selectedDisks.includes(diskName);
              const color = getDiskColors(diskIdx);

              return (
                <Button
                  key={`disk-${diskName}`}
                  variant={isSelected ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => toggleDisk(diskName)}
                  className={cn(
                    'text-xs h-8 px-3 transition-colors',
                    isSelected
                      ? 'bg-accent text-foreground border-transparent ring-1 ring-primary/40 hover:bg-accent'
                      : 'bg-card text-muted-foreground border-border hover:bg-accent/40 hover:text-foreground'
                  )}
                  title={`${diskName} — disk usage`}
                >
                  <HardDrive className="w-3 h-3 shrink-0" style={{ color }} />
                  <span className="ml-1.5">{diskName}</span>
                </Button>
              );
            })}

            {/* Per-volume disk IO ACTIVITY toggle — one button per drive.
                When on, the chart renders 2 lines for that volume: read%
                (green) and write% (orange), both as % of the volume's
                max bandwidth (hardware-class estimate ratcheted up by
                observed peaks). The two-dot indicator mirrors the GPU
                toggle's usage+temp visual signature. */}
            {volumeIds.map((volumeId) => {
              const isSelected = selectedDiskIO.includes(volumeId);
              return (
                <Button
                  key={`diskIO-${volumeId}`}
                  variant={isSelected ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => toggleDiskIO(volumeId)}
                  className={cn(
                    'text-xs h-8 px-3 transition-colors',
                    isSelected
                      ? 'bg-accent text-foreground border-transparent ring-1 ring-primary/40 hover:bg-accent'
                      : 'bg-card text-muted-foreground border-border hover:bg-accent/40 hover:text-foreground'
                  )}
                  title={`${volumeId} — read/write activity (% of max bandwidth)`}
                >
                  <ArrowDownUp className="w-3 h-3 shrink-0" style={{ color: DISK_IO_COLORS.read }} />
                  <span className="ml-1.5">{volumeId}</span>
                </Button>
              );
            })}

            {/* Per-GPU toggle buttons */}
            {gpuNames.map((gpuName, gpuIdx) => {
              const isSelected = selectedGpus.includes(gpuName);
              const colors = getGpuColors(gpuIdx);

              return (
                <Button
                  key={`gpu-${gpuName}`}
                  variant={isSelected ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => toggleGpu(gpuName)}
                  className={cn(
                    'text-xs h-8 px-3 transition-colors',
                    isSelected
                      ? 'bg-accent text-foreground border-transparent ring-1 ring-primary/40 hover:bg-accent'
                      : 'bg-card text-muted-foreground border-border hover:bg-accent/40 hover:text-foreground'
                  )}
                >
                  <span className="flex gap-0.5 shrink-0">
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: colors.usage }} />
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: colors.temp }} />
                  </span>
                  <span className="ml-1.5">{resolveGpuLabel(gpuName)}</span>
                </Button>
              );
            })}

            {/* NIC toggle buttons */}
            {nicNames.map((nicName, nicIdx) => {
              const isSelected = selectedNics.includes(nicName);
              const colors = getNicColors(nicIdx);

              return (
                <Button
                  key={`nic-${nicName}`}
                  variant={isSelected ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => toggleNic(nicName)}
                  className={cn(
                    'text-xs h-8 px-3 transition-colors',
                    isSelected
                      ? 'bg-accent text-foreground border-transparent ring-1 ring-primary/40 hover:bg-accent'
                      : 'bg-card text-muted-foreground border-border hover:bg-accent/40 hover:text-foreground'
                  )}
                >
                  <span className="flex gap-0.5 shrink-0">
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: colors.tx }} />
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: colors.rx }} />
                  </span>
                  <span className="ml-1.5">{nicName}</span>
                </Button>
              );
            })}
          </div>

          {/* Spacer */}
          <div className="flex-1" />

          {/* Time selector */}
          <TimeRangeSelector value={timeRange} onChange={setTimeRange} />
        </div>

        {/* Chart Area */}
        <div className="h-[280px] w-full">
          {error ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-destructive">{error}</div>
            </div>
          ) : chartData.length === 0 ? (
            <div className="flex items-center justify-center h-full text-center">
              <div className="text-muted-foreground">
                no data available for this time range.
                <br />
                <span className="text-sm text-muted-foreground/70">data appears as the agent collects metrics.</span>
              </div>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 5, right: 0, bottom: 5, left: 0 }}>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="oklch(0.55 0.06 250)"
                  opacity={0.7}
                />
                <XAxis
                  dataKey="time"
                  type="number"
                  domain={timeDomain}
                  ticks={xTicks}
                  tickFormatter={formatXAxisTick}
                  stroke="oklch(0.708 0.05 250)"
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                  scale="time"
                />
                <YAxis
                  yAxisId="default"
                  width={CHART_Y_AXIS_WIDTH}
                  domain={[0, 100]}
                  stroke="oklch(0.708 0.05 250)"
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(value) => `${value}%`}
                />
                {/* Hidden Y-axis for raw throughput lines (prevents them from blowing out the % scale) */}
                <YAxis yAxisId="hidden" hide />
                <Tooltip content={<ChartTooltip formatTime={formatTooltipTime} gpuLabels={gpuLabels} />} />
                {/* Baseline reference line to show full time range */}
                <ReferenceLine y={0} stroke="oklch(0.35 0.08 250)" strokeDasharray="3 3" />
                {activeLines.map((line) => {
                  if (line.hidden) {
                    // Invisible lines for tooltip-only data (e.g. NIC raw bps)
                    // Bound to separate Y-axis so raw byte values don't blow out the 0-100% scale
                    return (
                      <Line
                        key={line.key}
                        yAxisId="hidden"
                        type="monotone"
                        dataKey={line.key}
                        stroke="transparent"
                        strokeWidth={0}
                        dot={false}
                        activeDot={false}
                        isAnimationActive={false}
                        legendType="none"
                      />
                    );
                  }
                  // Visible line — bind to explicit axis ('hidden' keeps raw
                  // throughput values off the 0-100% scale, 'default' is the
                  // standard percent axis shared by cpu/memory/disk/gpu).
                  const yAxisId = line.axis === 'hidden' ? 'hidden' : 'default';
                  return (
                    <Line
                      key={line.key}
                      yAxisId={yAxisId}
                      type="monotone"
                      dataKey={line.key}
                      name={line.label}
                      stroke={line.color}
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4, strokeWidth: 2 }}
                      isAnimationActive={false}
                    />
                  );
                })}
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Stats Summary — left padding matches the chart's YAxis width so
            cards align with the chart's plot area (the "0" on the x-axis). */}
        {chartData.length > 0 && hasSelection && (
          <div
            className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-2"
            style={{ paddingLeft: CHART_Y_AXIS_WIDTH }}
          >
            {statsKeys.map(({ key, label, color, isNetwork, unit: explicitUnit, format }) => {
              const values = chartData
                .map((d) => d[key] as number | undefined)
                .filter((v): v is number => v != null);

              if (values.length === 0) return null;

              const avg = values.reduce((a, b) => a + b, 0) / values.length;
              const max = Math.max(...values);
              const min = Math.min(...values);

              // For network stats, also compute throughput averages
              const throughputKey = isNetwork ? key.replace('_util', '') : null;
              const throughputValues = throughputKey
                ? chartData.map((d) => d[throughputKey] as number | undefined).filter((v): v is number => v != null)
                : [];
              const avgThroughput = throughputValues.length > 0
                ? throughputValues.reduce((a, b) => a + b, 0) / throughputValues.length
                : 0;

              const unit = explicitUnit ?? (isNetwork ? '%' : (metricConfig[key as MetricType]?.unit ?? '%'));

              // Byte-rate series (disk IO read/write) use formatDiskIO for all
              // three stats — the raw number has no sensible percent/°C unit.
              const isThroughput = format === 'throughput';
              const fmtAvg = isThroughput ? formatDiskIO(avg) : `${avg.toFixed(1)}${unit}`;
              const fmtMax = isThroughput ? formatDiskIO(max) : `${max.toFixed(1)}${unit}`;
              const fmtMin = isThroughput ? formatDiskIO(min) : `${min.toFixed(1)}${unit}`;

              return (
                <div
                  key={key}
                  className="p-2 rounded-lg bg-secondary border border-border"
                  style={{ borderLeftColor: color, borderLeftWidth: '3px' }}
                >
                  {/* Metric label */}
                  <div className="text-xs font-medium text-foreground mb-1.5">{label}</div>
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <div>
                      <div className="text-muted-foreground">avg</div>
                      <div className="font-semibold text-foreground">
                        {fmtAvg}
                        {isNetwork && <span className="text-muted-foreground ml-0.5 font-normal">({formatThroughput(avgThroughput)})</span>}
                      </div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">max</div>
                      <div className="font-semibold text-foreground">{fmtMax}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">min</div>
                      <div className="font-semibold text-foreground">{fmtMin}</div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        </div>
        )}
      </CardContent>
    </Card>
  );
}
