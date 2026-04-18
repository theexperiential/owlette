'use client';

/**
 * ChartTooltip Component
 *
 * Custom tooltip for Recharts that displays metric values on hover.
 * Styled to match Owlette's dark theme.
 */

import { formatThroughput } from '@/lib/networkUtils';
import { DISK_IO_COLORS, formatDiskIO, isDiskIOKey, parseDiskIOKey } from '@/lib/diskIOUtils';

export type MetricType = 'cpu' | 'memory' | 'disk' | 'gpu' | 'cpuTemp' | 'gpuTemp' | 'display';

// Configuration for each metric type
// Using explicit RGB colors because CSS variables don't work in SVG stroke attributes
export const metricConfig: Record<MetricType, { label: string; color: string; unit: string }> = {
  cpu: { label: 'CPU', color: 'oklch(0.75 0.18 195)', unit: '%' },       // cyan accent (matches --accent-cyan)
  memory: { label: 'Memory', color: 'oklch(0.65 0.25 250)', unit: '%' }, // blue (matches sidebar-primary)
  disk: { label: 'Disk', color: 'rgb(34, 197, 94)', unit: '%' },         // green-500
  gpu: { label: 'GPU', color: 'rgb(249, 115, 22)', unit: '%' },          // orange-500
  cpuTemp: { label: 'CPU°', color: 'rgb(239, 68, 68)', unit: '°C' },     // red-500
  gpuTemp: { label: 'GPU°', color: 'rgb(236, 72, 153)', unit: '°C' },    // pink-500
  display: { label: 'Displays', color: 'oklch(0.70 0.15 280)', unit: '' }, // purple — display topology (not a time-series metric)
};

/**
 * Check if a dataKey is a network metric (e.g., "Ethernet_tx_util", "Wi-Fi_rx_util")
 */
export function isNetworkMetricKey(key: string): boolean {
  return key.endsWith('_tx_util') || key.endsWith('_rx_util');
}

/**
 * Get the NIC name and direction from a network metric key
 */
function parseNetworkKey(key: string): { nic: string; direction: 'TX' | 'RX' } | null {
  if (key.endsWith('_tx_util')) return { nic: key.replace('_tx_util', ''), direction: 'TX' };
  if (key.endsWith('_rx_util')) return { nic: key.replace('_rx_util', ''), direction: 'RX' };
  return null;
}

/**
 * Check if a dataKey is a per-device disk metric (e.g., "C:_pct", "L:_pct")
 */
function parseDiskKey(key: string): { diskName: string } | null {
  if (!key.endsWith('_pct')) return null;
  return { diskName: key.slice(0, -4) };
}

/**
 * Check if a dataKey is a per-device GPU metric (e.g., "GPU 0_usage", "GPU 0_temp")
 */
function parseGpuDeviceKey(key: string): { gpuName: string; field: 'usage' | 'temp' } | null {
  if (key.endsWith('_usage')) return { gpuName: key.slice(0, -6), field: 'usage' };
  if (key.endsWith('_temp')) return { gpuName: key.slice(0, -5), field: 'temp' };
  return null;
}

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
  /** Optional: UUID → friendly-name map for GPU entries. Chart keys stay
   *  UUID-based; this map only swaps what the tooltip label displays. */
  gpuLabels?: ReadonlyMap<string, string>;
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

export function ChartTooltip({ active, payload, label, formatTime = defaultFormatTime, gpuLabels }: ChartTooltipProps) {
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
        {payload.map((entry, _index) => {
          const key = String(entry.dataKey ?? '');
          const config = metricConfig[key as MetricType];
          const netInfo = !config ? parseNetworkKey(key) : null;
          const diskInfo = !config && !netInfo ? parseDiskKey(key) : null;
          const gpuInfo = !config && !netInfo && !diskInfo ? parseGpuDeviceKey(key) : null;
          const diskIOChannel = !config && !netInfo && !diskInfo && !gpuInfo && isDiskIOKey(key) ? parseDiskIOKey(key) : null;

          if (!config && !netInfo && !diskInfo && !gpuInfo && !diskIOChannel) return null;
          if (entry.value === undefined || entry.value === null) return null;

          // For network metrics, find the corresponding throughput value
          if (netInfo) {
            const throughputKey = key.replace('_util', '');  // e.g., "Ethernet_tx"
            const throughputEntry = payload.find(e => String(e.dataKey) === throughputKey);
            const throughput = typeof throughputEntry?.value === 'number' ? throughputEntry.value : 0;

            return (
              <div key={key} className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-2">
                  <div
                    className="w-2 h-2 rounded-full"
                    style={{ backgroundColor: entry.color }}
                  />
                  <span className="text-sm text-foreground">{netInfo.nic} {netInfo.direction}</span>
                </div>
                <span className="text-sm font-medium text-foreground">
                  {typeof entry.value === 'number' ? entry.value.toFixed(1) : entry.value}%
                  <span className="text-muted-foreground ml-1">({formatThroughput(throughput)})</span>
                </span>
              </div>
            );
          }

          // Per-device disk metrics (e.g., "C:_pct", "L:_pct")
          if (diskInfo) {
            return (
              <div key={key} className="flex items-center justify-between gap-6">
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: entry.color }} />
                  <span className="text-foreground font-medium">{diskInfo.diskName}</span>
                </div>
                <span className="text-foreground font-semibold tabular-nums">{Number(entry.value).toFixed(1)}%</span>
              </div>
            );
          }

          // Per-device GPU metrics (e.g., "GPU 0_usage", "GPU 0_temp")
          if (gpuInfo) {
            const unit = gpuInfo.field === 'temp' ? '°C' : '%';
            const friendly = gpuLabels?.get(gpuInfo.gpuName) ?? gpuInfo.gpuName;
            const label = gpuInfo.field === 'temp' ? `${friendly}°` : friendly;
            return (
              <div key={key} className="flex items-center justify-between gap-6">
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: entry.color }} />
                  <span className="text-foreground font-medium">{label}</span>
                </div>
                <span className="text-foreground font-semibold tabular-nums">{Number(entry.value).toFixed(1)}{unit}</span>
              </div>
            );
          }

          // Per-volume disk IO metrics (e.g. "C:_io_read"). Label is
          // volume-qualified ("C: read" / "L: busy") and throughput values
          // render via formatDiskIO; busy is a plain percent.
          if (diskIOChannel) {
            const label = `${diskIOChannel.id} ${diskIOChannel.channel}`;
            const dotColor = DISK_IO_COLORS[diskIOChannel.channel];
            const numericValue = typeof entry.value === 'number' ? entry.value : Number(entry.value);
            const formatted = diskIOChannel.channel === 'busy'
              ? `${numericValue.toFixed(1)}%`
              : formatDiskIO(numericValue);
            return (
              <div key={key} className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full" style={{ backgroundColor: dotColor }} />
                  <span className="text-sm text-foreground">{label}</span>
                </div>
                <span className="text-sm font-medium text-foreground">{formatted}</span>
              </div>
            );
          }

          return (
            <div key={key} className="flex items-center justify-between gap-4">
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
