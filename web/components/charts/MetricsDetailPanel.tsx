'use client';

/**
 * MetricsDetailPanel Component
 *
 * Expanded chart view for detailed metric analysis.
 * Replaces the top stats cards when a sparkline is clicked.
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
import { X } from 'lucide-react';
import { TimeRangeSelector, type TimeRange } from './TimeRangeSelector';
import { ChartTooltip, metricConfig, type MetricType } from './ChartTooltip';
import { useHistoricalMetrics } from '@/hooks/useHistoricalMetrics';
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
  const [selectedMetrics, setSelectedMetrics] = useState<MetricType[]>([initialMetric]);
  const [timeRange, setTimeRange] = useState<TimeRange>('1h');

  // Sync selectedMetrics when initialMetric changes (user clicked different cell)
  // For CPU/GPU, also select the corresponding temperature metric
  useEffect(() => {
    if (initialMetric === 'cpu') {
      setSelectedMetrics(['cpu', 'cpuTemp']);
    } else if (initialMetric === 'gpu') {
      setSelectedMetrics(['gpu', 'gpuTemp']);
    } else {
      setSelectedMetrics([initialMetric]);
    }
  }, [initialMetric]);

  const { data, loading, error } = useHistoricalMetrics(siteId, machineId, timeRange);

  const toggleMetric = (metric: MetricType) => {
    setSelectedMetrics((prev) => {
      if (prev.includes(metric)) {
        if (prev.length === 1) return prev;
        return prev.filter((m) => m !== metric);
      }
      return [...prev, metric];
    });
  };

  const chartData = useMemo(() => {
    if (!data) return [];
    return data;
  }, [data]);

  const formatXAxisTick = (timestamp: number): string => {
    const date = new Date(timestamp);
    switch (timeRange) {
      case '1h':
      case '1d':
        return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      case '1w':
        return date.toLocaleDateString(undefined, { weekday: 'short', hour: '2-digit' });
      case '1m':
        return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      case '1y':
      case 'all':
        return date.toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
      default:
        return date.toLocaleTimeString();
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
          <div className="flex flex-wrap gap-1.5">
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
                  domain={[0, 100]}
                  stroke="oklch(0.708 0.05 250)"
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(value) => `${value}%`}
                />
                <Tooltip content={<ChartTooltip />} />
                {/* Baseline reference line to show full time range */}
                <ReferenceLine y={0} stroke="oklch(0.35 0.08 250)" strokeDasharray="3 3" />
                {selectedMetrics.map((metric) => (
                  <Line
                    key={metric}
                    type="monotone"
                    dataKey={metric}
                    name={metricConfig[metric].label}
                    stroke={metricConfig[metric].color}
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4, strokeWidth: 2 }}
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Stats Summary */}
        {chartData.length > 0 && (
          <div className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-2">
            {selectedMetrics.map((metric) => {
              const config = metricConfig[metric];
              const values = chartData
                .map((d) => d[metric as keyof typeof d] as number | undefined)
                .filter((v): v is number => v != null);

              if (values.length === 0) return null;

              const avg = values.reduce((a, b) => a + b, 0) / values.length;
              const max = Math.max(...values);
              const min = Math.min(...values);

              return (
                <div
                  key={metric}
                  className="p-2 rounded-lg bg-secondary border border-border"
                  style={{ borderLeftColor: config.color, borderLeftWidth: '3px' }}
                >
                  {/* Metric label */}
                  <div className="text-xs font-medium text-foreground mb-1.5">{config.label}</div>
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <div>
                      <div className="text-muted-foreground">Avg</div>
                      <div className="font-semibold text-foreground">{avg.toFixed(1)}{config.unit}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Max</div>
                      <div className="font-semibold text-foreground">{max.toFixed(1)}{config.unit}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Min</div>
                      <div className="font-semibold text-foreground">{min.toFixed(1)}{config.unit}</div>
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
