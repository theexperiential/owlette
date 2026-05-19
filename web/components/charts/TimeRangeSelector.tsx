'use client';

/**
 * TimeRangeSelector Component
 *
 * A button group for selecting time ranges for metric charts.
 * Options: Day, Week, Month, Year, All
 *
 * Used by MetricsDetailPanel to control the chart's time window.
 */

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type TimeRange = '1h' | '1d' | '1w' | '1m' | '1y' | 'all';

interface TimeRangeSelectorProps {
  value: TimeRange;
  onChange: (range: TimeRange) => void;
  className?: string;
}

const ranges: { value: TimeRange; label: string }[] = [
  { value: '1h', label: 'hour' },
  { value: '1d', label: 'day' },
  { value: '1w', label: 'week' },
  { value: '1m', label: 'month' },
  { value: '1y', label: 'year' },
  { value: 'all', label: 'all' },
];

export function TimeRangeSelector({ value, onChange, className }: TimeRangeSelectorProps) {
  return (
    <div className={cn('flex gap-1.5', className)}>
      {ranges.map((range) => {
        const isSelected = value === range.value;
        return (
          <Button
            key={range.value}
            variant="ghost"
            size="sm"
            className={cn(
              'h-8 px-3 text-xs transition-colors',
              isSelected
                ? 'bg-accent text-foreground border-transparent ring-1 ring-primary/40 hover:bg-accent'
                : 'bg-card text-muted-foreground border border-border hover:bg-accent/40 hover:text-foreground'
            )}
            onClick={() => onChange(range.value)}
          >
            {range.label}
          </Button>
        );
      })}
    </div>
  );
}

/**
 * Get the start timestamp for a given time range
 * @param range - The time range to calculate
 * @returns Start timestamp in seconds (Unix time)
 */
export function getTimeRangeStart(range: TimeRange): number {
  const now = Date.now();
  const MS_PER_HOUR = 60 * 60 * 1000;
  const MS_PER_DAY = 24 * MS_PER_HOUR;

  switch (range) {
    case '1h':
      return Math.floor((now - MS_PER_HOUR) / 1000);
    case '1d':
      return Math.floor((now - MS_PER_DAY) / 1000);
    case '1w':
      return Math.floor((now - 7 * MS_PER_DAY) / 1000);
    case '1m':
      return Math.floor((now - 30 * MS_PER_DAY) / 1000);
    case '1y':
      return Math.floor((now - 365 * MS_PER_DAY) / 1000);
    case 'all':
      return 0; // Beginning of time
    default:
      return Math.floor((now - MS_PER_DAY) / 1000);
  }
}

/**
 * Get human-readable label for a time range
 */
export function getTimeRangeLabel(range: TimeRange): string {
  return ranges.find(r => r.value === range)?.label ?? 'day';
}
