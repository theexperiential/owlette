'use client';

/**
 * SparklineChart Component
 *
 * A compact, inline area chart for displaying metric trends.
 * Used in machine cards and table rows to show CPU, Memory, Disk, GPU history.
 *
 * Features:
 * - Default 32px height for visibility
 * - Gradient fill for better visual impact
 * - Color-coded by metric type
 * - Click handler for expanding to detail view
 * - Loading state with skeleton
 */

import { AreaChart, Area, ResponsiveContainer, YAxis } from 'recharts';
import { cn } from '@/lib/utils';

export interface SparklineDataPoint {
  t: number;  // timestamp
  v: number;  // value (0-100 for percentages)
}

export type MetricColor = 'cpu' | 'memory' | 'disk' | 'gpu' | 'temp';

interface SparklineChartProps {
  data: SparklineDataPoint[];
  color?: MetricColor;
  height?: number;
  className?: string;
  onClick?: () => void;
  loading?: boolean;
}

// Map metric types to explicit colors (CSS variables don't work in SVG stroke)
const colorMap: Record<MetricColor, string> = {
  cpu: 'oklch(0.75 0.18 195)',    // cyan accent (matches --accent-cyan)
  memory: 'oklch(0.65 0.25 250)', // blue (matches sidebar-primary)
  disk: 'rgb(34, 197, 94)',       // green-500
  gpu: 'rgb(249, 115, 22)',       // orange-500
  temp: 'rgb(239, 68, 68)',       // red-500
};

// Unique gradient IDs per color to avoid conflicts
const gradientIds: Record<MetricColor, string> = {
  cpu: 'sparkline-gradient-cpu',
  memory: 'sparkline-gradient-memory',
  disk: 'sparkline-gradient-disk',
  gpu: 'sparkline-gradient-gpu',
  temp: 'sparkline-gradient-temp',
};

export function SparklineChart({
  data,
  color = 'cpu',
  height = 48,  // Taller default for better visibility
  className,
  onClick,
  loading = false,
}: SparklineChartProps) {
  // Loading state
  if (loading) {
    return (
      <div
        className={cn(
          'bg-muted/30 rounded animate-pulse',
          className
        )}
        style={{ height }}
      />
    );
  }

  // No data state - render empty placeholder (no text, no background)
  if (!data || data.length === 0) {
    return (
      <div
        className={cn('rounded', className)}
        style={{ height }}
      />
    );
  }

  const strokeColor = colorMap[color];
  const gradientId = gradientIds[color];

  return (
    <div
      className={cn(
        'cursor-pointer hover:opacity-90 transition-opacity rounded',
        onClick && 'hover:bg-muted/30',
        className
      )}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => e.key === 'Enter' && onClick() : undefined}
    >
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 2, left: 0 }}>
          <defs>
            {/* Vertical gradient: neutral grey, fades to transparent at bottom */}
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgb(148, 163, 184)" stopOpacity={0.4} />
              <stop offset="100%" stopColor="rgb(71, 85, 105)" stopOpacity={0.05} />
            </linearGradient>
          </defs>
          <YAxis domain={[0, 100]} hide />
          <Area
            type="monotone"
            dataKey="v"
            stroke="transparent"
            strokeWidth={0}
            fill={`url(#${gradientId})`}
            dot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
