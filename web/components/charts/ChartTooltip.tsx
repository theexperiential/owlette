'use client';

/**
 * ChartTooltip Component
 *
 * Custom tooltip for Recharts that displays metric values on hover.
 * Styled to match Owlette's dark theme.
 */

export type MetricType = 'cpu' | 'memory' | 'disk' | 'gpu' | 'cpuTemp' | 'gpuTemp';

// Configuration for each metric type
// Using explicit RGB colors because CSS variables don't work in SVG stroke attributes
export const metricConfig: Record<MetricType, { label: string; color: string; unit: string }> = {
  cpu: { label: 'CPU', color: 'oklch(0.75 0.18 195)', unit: '%' },       // cyan accent (matches --accent-cyan)
  memory: { label: 'Memory', color: 'oklch(0.65 0.25 250)', unit: '%' }, // blue (matches sidebar-primary)
  disk: { label: 'Disk', color: 'rgb(34, 197, 94)', unit: '%' },         // green-500
  gpu: { label: 'GPU', color: 'rgb(249, 115, 22)', unit: '%' },          // orange-500
  cpuTemp: { label: 'CPU°', color: 'rgb(239, 68, 68)', unit: '°C' },     // red-500
  gpuTemp: { label: 'GPU°', color: 'rgb(236, 72, 153)', unit: '°C' },    // pink-500
};

interface TooltipPayloadEntry {
  dataKey?: string | number;
  value?: number | string;
  name?: string;
  color?: string;
}

interface ChartTooltipProps {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
  label?: string | number;
  /** Optional: Override the default time formatter */
  formatTime?: (timestamp: number) => string;
}

/**
 * Format a timestamp for display in the tooltip
 */
function defaultFormatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();

  if (isToday) {
    return date.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function ChartTooltip({ active, payload, label, formatTime = defaultFormatTime }: ChartTooltipProps) {
  if (!active || !payload || payload.length === 0) {
    return null;
  }

  // The label is the timestamp in milliseconds
  const timestamp = typeof label === 'number' ? label : parseInt(label as string, 10);

  return (
    <div className="bg-popover border border-border rounded-lg shadow-lg p-3 min-w-[140px]">
      {/* Timestamp */}
      <p className="text-xs text-muted-foreground mb-2">
        {formatTime(timestamp)}
      </p>

      {/* Metric values */}
      <div className="space-y-1">
        {payload.map((entry, index) => {
          const metricKey = entry.dataKey as MetricType;
          const config = metricConfig[metricKey];

          if (!config || entry.value === undefined || entry.value === null) {
            return null;
          }

          return (
            <div key={entry.dataKey ?? index} className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <div
                  className="w-2 h-2 rounded-full"
                  style={{ backgroundColor: config.color }}
                />
                <span className="text-sm text-foreground">{config.label}</span>
              </div>
              <span className="text-sm font-medium text-foreground">
                {typeof entry.value === 'number' ? entry.value.toFixed(1) : entry.value}
                {config.unit}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
