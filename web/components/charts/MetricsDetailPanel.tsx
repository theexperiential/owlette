'use client';

/**
 * MetricsDetailPanel Component
 *
 * Expanded chart view for detailed metric analysis.
 * Replaces the top stats cards when a sparkline is clicked.
 * Supports per-NIC network metrics with TX/RX utilization lines.
 */

import { useState, useMemo, useEffect } from 'react';
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
import { X, ToggleLeft, ToggleRight } from 'lucide-react';
import { TimeRangeSelector, type TimeRange } from './TimeRangeSelector';
import { ChartTooltip, metricConfig, isNetworkMetricKey, type MetricType } from './ChartTooltip';
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

export function MetricsDetailPanel({
  machineId,
  machineName,
  siteId,
  initialMetric = 'cpu',
  onClose,
}: MetricsDetailPanelProps) {
  const { userPreferences } = useAuth();
  const [selectedMetrics, setSelectedMetrics] = useState<MetricType[]>([initialMetric]);
  const [selectedNics, setSelectedNics] = useState<string[]>([]);
  const [timeRange, setTimeRange] = useState<TimeRange>('1h');

  const { data, loading, error } = useHistoricalMetrics(siteId, machineId, timeRange);

  const chartData = useMemo(() => {
    if (!data) return [];
    return data;
  }, [data]);

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

  // Sync selectedMetrics when initialMetric changes (user clicked different cell)
  // For CPU/GPU, also select the corresponding temperature metric
  // For network metrics, select the NIC
  useEffect(() => {
    const initStr = initialMetric as string;
    if (initStr.endsWith('_tx_util') || initStr.endsWith('_rx_util')) {
      // Network metric — extract NIC name and select it
      const nicName = initStr.replace(/_[tr]x_util$/, '');
      setSelectedMetrics([]);
      setSelectedNics([nicName]);
    } else if (initialMetric === 'cpu') {
      setSelectedMetrics(['cpu', 'cpuTemp']);
      setSelectedNics([]);
    } else if (initialMetric === 'gpu') {
      setSelectedMetrics(['gpu', 'gpuTemp']);
      setSelectedNics([]);
    } else {
      setSelectedMetrics([initialMetric]);
      setSelectedNics([]);
    }
  }, [initialMetric]);

  const toggleMetric = (metric: MetricType) => {
    setSelectedMetrics((prev) => {
      if (prev.includes(metric)) {
        // Don't allow deselecting if it's the only thing selected (and no NICs)
        if (prev.length === 1 && selectedNics.length === 0) return prev;
        return prev.filter((m) => m !== metric);
      }
      return [...prev, metric];
    });
  };

  const toggleNic = (nicName: string) => {
    setSelectedNics((prev) => {
      if (prev.includes(nicName)) {
        // Don't allow deselecting if it's the only thing selected (and no metrics)
        if (prev.length === 1 && selectedMetrics.length === 0) return prev;
        return prev.filter((n) => n !== nicName);
      }
      return [...prev, nicName];
    });
  };

  const hour12 = (userPreferences.timeFormat || '12h') === '12h';
  const formatXAxisTick = (timestamp: number): string => {
    const date = new Date(timestamp);
    switch (timeRange) {
      case '1h':
      case '1d':
        return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12 });
      case '1w':
        return date.toLocaleDateString(undefined, { weekday: 'short', hour: '2-digit', hour12 });
      case '1m':
        return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      case '1y':
      case 'all':
        return date.toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
      default:
        return date.toLocaleTimeString(undefined, { hour12 });
    }
  };

  // Calculate the time domain based on selected range
  const timeDomain = useMemo((): [number, number] => {
    const now = Date.now();
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
  }, [timeRange, chartData]);

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
    if (allSelected) {
      setSelectedMetrics([initialMetric]);
      setSelectedNics([]);
    } else {
      setSelectedMetrics([...availableMetrics]);
      setSelectedNics([...nicNames]);
    }
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
    <Card className="border-border bg-card">
      <CardContent className="p-3 pt-2">
        {/* Header row */}
        <div className="flex items-center gap-3 mb-3">
          {/* Machine name */}
          <span className="text-base font-semibold text-foreground shrink-0">
            {machineName || machineId}
          </span>

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
                    'text-xs h-7 px-2',
                    isSelected
                      ? 'bg-secondary text-foreground border-border'
                      : 'bg-transparent text-muted-foreground border-border hover:bg-secondary hover:text-foreground'
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
                    'text-xs h-7 px-2',
                    isSelected
                      ? 'bg-secondary text-foreground border-border'
                      : 'bg-transparent text-muted-foreground border-border hover:bg-secondary hover:text-foreground'
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

          {/* Time selector + close button */}
          <TimeRangeSelector value={timeRange} onChange={setTimeRange} />
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground hover:bg-secondary shrink-0"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Chart Area */}
        <div className="h-[280px] w-full">
          {loading ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-muted-foreground animate-pulse">Loading...</div>
            </div>
          ) : error ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-destructive">{error}</div>
            </div>
          ) : chartData.length === 0 ? (
            <div className="flex items-center justify-center h-full text-center">
              <div className="text-muted-foreground">
                No data available for this time range.
                <br />
                <span className="text-sm text-muted-foreground/70">Data appears as the agent collects metrics.</span>
              </div>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData}>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="oklch(0.35 0.08 250)"
                  opacity={0.5}
                />
                <XAxis
                  dataKey="time"
                  type="number"
                  domain={timeDomain}
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
                <Tooltip content={<ChartTooltip formatTime={(ts) => {
                  const d = new Date(ts);
                  const isToday = d.toDateString() === new Date().toDateString();
                  if (isToday) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12 });
                  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12 });
                }} />} />
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
      </CardContent>
    </Card>
  );
}
