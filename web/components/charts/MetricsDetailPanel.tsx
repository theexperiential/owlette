'use client';

/**
 * MetricsDetailPanel Component
 *
 * Expanded chart view for detailed metric analysis.
 * Replaces the top stats cards when a sparkline is clicked.
 * Supports per-NIC network metrics with TX/RX utilization lines.
 */

import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
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
import { X, ToggleLeft, ToggleRight, Monitor } from 'lucide-react';
import { TimeRangeSelector, type TimeRange } from './TimeRangeSelector';
import { ChartTooltip, metricConfig, type MetricType } from './ChartTooltip';
import { useHistoricalMetrics } from '@/hooks/useHistoricalMetrics';
import { getNicColors, formatThroughput } from '@/lib/networkUtils';
import { useAuth } from '@/contexts/AuthContext';
import { cn } from '@/lib/utils';

interface MetricsDetailPanelProps {
  machineId: string;
  machineName?: string;
  siteId: string;
  initialMetric?: MetricType;
  onClose: () => void;
}

// Namespaced tab-id storage format. New entity types (per-GPU, per-disk, etc.)
// slot in with a new prefix without any schema change; unknown prefixes are
// silently ignored on read so older clients don't crash.
const METRIC_PREFIX = 'metric:';
const NIC_PREFIX = 'nic:';
// Exhaustive map keyed by MetricType — TypeScript errors here if MetricType
// gains a new member, forcing us to decide whether it should be persistable.
const KNOWN_METRIC_MAP: Record<MetricType, true> = {
  cpu: true, memory: true, disk: true, gpu: true, cpuTemp: true, gpuTemp: true,
};
const KNOWN_METRICS: ReadonlySet<MetricType> = new Set(
  Object.keys(KNOWN_METRIC_MAP) as MetricType[],
);

function serializeTabs(metrics: MetricType[], nics: string[]): string[] {
  return [
    ...metrics.map((m) => `${METRIC_PREFIX}${m}`),
    ...nics.map((n) => `${NIC_PREFIX}${n}`),
  ];
}

function deserializeTabs(ids: string[] | undefined): { metrics: MetricType[]; nics: string[] } {
  const metrics: MetricType[] = [];
  const nics: string[] = [];
  if (!ids) return { metrics, nics };
  for (const id of ids) {
    if (id.startsWith(METRIC_PREFIX)) {
      const m = id.slice(METRIC_PREFIX.length) as MetricType;
      if (KNOWN_METRICS.has(m)) metrics.push(m);
    } else if (id.startsWith(NIC_PREFIX)) {
      nics.push(id.slice(NIC_PREFIX.length));
    }
  }
  return { metrics, nics };
}

function initialMetricToState(initialMetric: MetricType): { metrics: MetricType[]; nics: string[] } {
  const initStr = initialMetric as string;
  if (initStr.endsWith('_tx_util') || initStr.endsWith('_rx_util')) {
    return { metrics: [], nics: [initStr.replace(/_[tr]x_util$/, '')] };
  }
  if (initialMetric === 'cpu') return { metrics: ['cpu', 'cpuTemp'], nics: [] };
  if (initialMetric === 'gpu') return { metrics: ['gpu', 'gpuTemp'], nics: [] };
  return { metrics: [initialMetric], nics: [] };
}

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

export function MetricsDetailPanel({
  machineId,
  machineName,
  siteId,
  initialMetric = 'cpu',
  onClose,
}: MetricsDetailPanelProps) {
  const { userPreferences, updateUserPreferences } = useAuth();
  const graphTabs = userPreferences.graphTabs;

  // Seed from persisted selection on first render so there's no flash between
  // the default and the restored selection. The post-mount effect below handles
  // all subsequent syncs (machine changes, cross-tab updates, click intent).
  const [selectedMetrics, setSelectedMetrics] = useState<MetricType[]>(() => {
    const persisted = deserializeTabs(graphTabs?.[machineId]);
    const click = initialMetricToState(initialMetric);
    if (persisted.metrics.length > 0 || persisted.nics.length > 0) {
      return Array.from(new Set([...persisted.metrics, ...click.metrics]));
    }
    return click.metrics;
  });
  const [selectedNics, setSelectedNics] = useState<string[]>(() => {
    const persisted = deserializeTabs(graphTabs?.[machineId]);
    const click = initialMetricToState(initialMetric);
    if (persisted.metrics.length > 0 || persisted.nics.length > 0) {
      return Array.from(new Set([...persisted.nics, ...click.nics]));
    }
    return click.nics;
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

  // Extract unique NIC names from chart data
  const nicNames = useMemo(() => {
    const names = new Set<string>();
    for (const d of chartData) {
      for (const key of Object.keys(d)) {
        if (key.endsWith('_tx_util')) names.add(key.replace('_tx_util', ''));
      }
    }
    return Array.from(names);
  }, [chartData]);

  // Reconcile local state with (machine, initialMetric, persisted) on every
  // change. Click intent (a new machineId/initialMetric) is merged with the
  // persisted selection so the clicked cell is visible without erasing the
  // user's other sticky tabs. When only the persisted map changes (our own
  // write echoing back, or a cross-tab update), click intent is NOT re-merged
  // — otherwise toggling off e.g. cpuTemp would immediately re-add it.
  const prevIntentRef = useRef<string | null>(null);
  const intentKey = `${machineId}|${initialMetric}`;
  useEffect(() => {
    const persisted = deserializeTabs(graphTabs?.[machineId]);
    const intentChanged = prevIntentRef.current !== intentKey;
    prevIntentRef.current = intentKey;

    let nextMetrics: MetricType[];
    let nextNics: string[];
    if (intentChanged) {
      const click = initialMetricToState(initialMetric);
      const hasPersisted = persisted.metrics.length > 0 || persisted.nics.length > 0;
      nextMetrics = hasPersisted
        ? Array.from(new Set([...persisted.metrics, ...click.metrics]))
        : click.metrics;
      nextNics = hasPersisted
        ? Array.from(new Set([...persisted.nics, ...click.nics]))
        : click.nics;
    } else {
      nextMetrics = persisted.metrics;
      nextNics = persisted.nics;
    }
    // Reconciling local selection state with external (persisted) selection is
    // a legitimate sync-external-source case; the guarded setters no-op when
    // nothing changed so no cascading renders occur.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedMetrics((prev) => (sameStringArray(prev, nextMetrics) ? prev : nextMetrics));
    setSelectedNics((prev) => (sameStringArray(prev, nextNics) ? prev : nextNics));
  }, [machineId, initialMetric, graphTabs, intentKey]);

  const persistSelections = (metrics: MetricType[], nics: string[]) => {
    const ids = serializeTabs(metrics, nics);
    updateUserPreferences(
      { graphTabs: { ...(graphTabs || {}), [machineId]: ids } },
      { silent: true },
    ).catch(() => { /* fire-and-forget; matches statsExpanded pattern */ });
  };

  const toggleMetric = (metric: MetricType) => {
    setSelectedMetrics((prev) => {
      let next: MetricType[];
      if (prev.includes(metric)) {
        // Don't allow deselecting if it's the only thing selected (and no NICs)
        if (prev.length === 1 && selectedNics.length === 0) return prev;
        next = prev.filter((m) => m !== metric);
      } else {
        next = [...prev, metric];
      }
      persistSelections(next, selectedNics);
      return next;
    });
  };

  const toggleNic = (nicName: string) => {
    setSelectedNics((prev) => {
      let next: string[];
      if (prev.includes(nicName)) {
        // Don't allow deselecting if it's the only thing selected (and no metrics)
        if (prev.length === 1 && selectedMetrics.length === 0) return prev;
        next = prev.filter((n) => n !== nicName);
      } else {
        next = [...prev, nicName];
      }
      persistSelections(selectedMetrics, next);
      return next;
    });
  };

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

  const availableMetrics: MetricType[] = useMemo(() => {
    const base: MetricType[] = ['cpu', 'memory', 'disk'];
    if (chartData.some((d) => d.gpu != null && d.gpu > 0)) {
      base.push('gpu');
    }
    if (chartData.some((d) => d.cpuTemp !== undefined)) {
      base.push('cpuTemp');
    }
    if (chartData.some((d) => d.gpuTemp !== undefined)) {
      base.push('gpuTemp');
    }
    return base;
  }, [chartData]);

  // Check if anything is selected at all (metrics or NICs)
  const hasSelection = selectedMetrics.length > 0 || selectedNics.length > 0;

  const allSelected =
    selectedMetrics.length === availableMetrics.length &&
    selectedNics.length === nicNames.length;

  const toggleAll = () => {
    const nextMetrics = allSelected ? [initialMetric] : [...availableMetrics];
    const nextNics = allSelected ? [] : [...nicNames];
    setSelectedMetrics(nextMetrics);
    setSelectedNics(nextNics);
    persistSelections(nextMetrics, nextNics);
  };

  // Build the list of all active Line dataKeys and their display info
  const activeLines = useMemo(() => {
    const lines: { key: string; color: string; label: string; hidden?: boolean }[] = [];

    // Standard metrics
    for (const metric of selectedMetrics) {
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

    return lines;
  }, [selectedMetrics, selectedNics, nicNames]);

  // Collect all selected metric/NIC keys for stats summary
  const statsKeys = useMemo(() => {
    const keys: { key: string; label: string; color: string; isNetwork: boolean }[] = [];
    for (const metric of selectedMetrics) {
      const config = metricConfig[metric];
      if (config) keys.push({ key: metric, label: config.label, color: config.color, isNetwork: false });
    }
    for (const nicName of selectedNics) {
      const nicIdx = nicNames.indexOf(nicName);
      const colors = getNicColors(nicIdx >= 0 ? nicIdx : 0);
      keys.push({ key: `${nicName}_tx_util`, label: `${nicName} TX`, color: colors.tx, isNetwork: true });
      keys.push({ key: `${nicName}_rx_util`, label: `${nicName} RX`, color: colors.rx, isNetwork: true });
    }
    return keys;
  }, [selectedMetrics, selectedNics, nicNames]);

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
            className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground hover:bg-secondary shrink-0"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Controls + chart render together once data is ready so the panel
            doesn't show an empty shell while the fetch is in flight. */}
        {loading ? (
          <div
            className="flex items-center justify-center h-[320px]"
            role="status"
            aria-live="polite"
            aria-busy="true"
            aria-label="loading metrics"
          >
            <div className="text-muted-foreground animate-pulse text-sm">loading...</div>
          </div>
        ) : (
        <div className="animate-in fade-in duration-200">
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
                  className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground hover:bg-secondary shrink-0"
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
              const isSelected = selectedMetrics.includes(metric);

              return (
                <Button
                  key={metric}
                  variant={isSelected ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => toggleMetric(metric)}
                  className={cn(
                    'text-xs h-7 px-2 transition-colors',
                    isSelected
                      ? 'bg-accent text-foreground border-transparent ring-1 ring-primary/40 hover:bg-accent'
                      : 'bg-transparent text-muted-foreground/70 border-border/40 hover:bg-accent/40 hover:text-foreground hover:border-border'
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
                    'text-xs h-7 px-2 transition-colors',
                    isSelected
                      ? 'bg-accent text-foreground border-transparent ring-1 ring-primary/40 hover:bg-accent'
                      : 'bg-transparent text-muted-foreground/70 border-border/40 hover:bg-accent/40 hover:text-foreground hover:border-border'
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
              <LineChart data={chartData}>
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
                  domain={[0, 100]}
                  stroke="oklch(0.708 0.05 250)"
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(value) => `${value}%`}
                />
                {/* Hidden Y-axis for raw throughput lines (prevents them from blowing out the % scale) */}
                <YAxis yAxisId="hidden" hide />
                <Tooltip content={<ChartTooltip formatTime={formatTooltipTime} />} />
                {/* Baseline reference line to show full time range */}
                <ReferenceLine y={0} stroke="oklch(0.35 0.08 250)" strokeDasharray="3 3" />
                {activeLines.map((line) =>
                  line.hidden ? (
                    // Hidden lines for throughput data (tooltip reads these)
                    // Bound to separate Y-axis so raw byte values don't blow out the 0-100% scale
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
                  ) : (
                    <Line
                      key={line.key}
                      yAxisId="default"
                      type="monotone"
                      dataKey={line.key}
                      name={line.label}
                      stroke={line.color}
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4, strokeWidth: 2 }}
                      isAnimationActive={false}
                    />
                  )
                )}
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Stats Summary */}
        {chartData.length > 0 && hasSelection && (
          <div className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-2">
            {statsKeys.map(({ key, label, color, isNetwork }) => {
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

              const unit = isNetwork ? '%' : (metricConfig[key as MetricType]?.unit ?? '%');

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
                      <div className="text-muted-foreground">Avg</div>
                      <div className="font-semibold text-foreground">
                        {avg.toFixed(1)}{unit}
                        {isNetwork && <span className="text-muted-foreground ml-0.5 font-normal">({formatThroughput(avgThroughput)})</span>}
                      </div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Max</div>
                      <div className="font-semibold text-foreground">{max.toFixed(1)}{unit}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Min</div>
                      <div className="font-semibold text-foreground">{min.toFixed(1)}{unit}</div>
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
