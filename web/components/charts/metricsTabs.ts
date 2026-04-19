/**
 * metricsTabs — pure serialization helpers for MetricsDetailPanel's tab state.
 *
 * Lives in its own file (no React / Recharts imports) so the dashboard can
 * import `serializeTabs` / `initialMetricToState` synchronously without pulling
 * the entire chart panel (and Recharts) into the main bundle. The heavy
 * `MetricsDetailPanel` component is code-split via `next/dynamic`; these
 * helpers stay eager because they run at click-time to compute the persisted
 * tab list before the panel even mounts.
 */

import type { MetricType } from './ChartTooltip';

// Namespaced tab-id storage format. New entity types (per-GPU, per-disk, etc.)
// slot in with a new prefix without any schema change; unknown prefixes are
// silently ignored on read so older clients don't crash.
export const METRIC_PREFIX = 'metric:';
export const NIC_PREFIX = 'nic:';
export const DISK_PREFIX = 'disk:';
export const GPU_PREFIX = 'gpu:';
// Per-volume disk IO activity uses a `diskIO:{volumeId}` id format — one entry
// per volume. When a volume is selected, the chart renders both read% and write%
// lines; users don't toggle them independently. Simpler than the previous
// per-channel sub-toggle scheme that produced UI-overload toggle lists.
export const DISK_IO_PREFIX = 'diskIO:';

// Exhaustive map keyed by MetricType — TypeScript errors here if MetricType
// gains a new member, forcing us to decide whether it should be persistable
// as a graph tab. `false` entries are routed to their own panel (e.g. the
// display topology panel) and never stored in `graphTabs`.
const KNOWN_METRIC_MAP: Record<MetricType, boolean> = {
  cpu: true, memory: true, disk: true, gpu: true, cpuTemp: true, gpuTemp: true,
  display: false,
};
const KNOWN_METRICS: ReadonlySet<MetricType> = new Set(
  (Object.keys(KNOWN_METRIC_MAP) as MetricType[]).filter((m) => KNOWN_METRIC_MAP[m]),
);

export interface TabSelection {
  metrics: MetricType[];
  nics: string[];
  disks: string[];
  gpus: string[];
  /** Per-volume disk IO activity selections — list of volume ids whose
   *  read+write lines are currently selected. */
  diskIO: string[];
}

export function serializeTabs(sel: TabSelection): string[] {
  return [
    ...sel.metrics.map((m) => `${METRIC_PREFIX}${m}`),
    ...sel.nics.map((n) => `${NIC_PREFIX}${n}`),
    ...sel.disks.map((d) => `${DISK_PREFIX}${d}`),
    ...sel.gpus.map((g) => `${GPU_PREFIX}${g}`),
    ...sel.diskIO.map((v) => `${DISK_IO_PREFIX}${v}`),
  ];
}

export function deserializeTabs(ids: string[] | undefined): TabSelection {
  const metrics: MetricType[] = [];
  const nics: string[] = [];
  const disks: string[] = [];
  const gpus: string[] = [];
  const diskIO: string[] = [];
  if (!ids) return { metrics, nics, disks, gpus, diskIO };
  for (const id of ids) {
    if (id.startsWith(METRIC_PREFIX)) {
      const m = id.slice(METRIC_PREFIX.length) as MetricType;
      if (KNOWN_METRICS.has(m)) metrics.push(m);
    } else if (id.startsWith(NIC_PREFIX)) {
      nics.push(id.slice(NIC_PREFIX.length));
    } else if (id.startsWith(DISK_PREFIX)) {
      disks.push(id.slice(DISK_PREFIX.length));
    } else if (id.startsWith(GPU_PREFIX)) {
      gpus.push(id.slice(GPU_PREFIX.length));
    } else if (id.startsWith(DISK_IO_PREFIX)) {
      const rest = id.slice(DISK_IO_PREFIX.length);
      // Strip any legacy `:channel` suffix from the v1 per-channel format —
      // older persisted preferences had `diskIO:C::read`, etc. Now we just
      // store volume ids; collapse duplicates from the legacy format.
      const colonIdx = rest.lastIndexOf(':');
      const volumeId = colonIdx > 0 && colonIdx > rest.indexOf(':') ? rest.slice(0, colonIdx) : rest;
      if (volumeId && !diskIO.includes(volumeId)) diskIO.push(volumeId);
    }
  }
  return { metrics, nics, disks, gpus, diskIO };
}

export function initialMetricToState(initialMetric: MetricType): TabSelection {
  const empty: TabSelection = { metrics: [], nics: [], disks: [], gpus: [], diskIO: [] };
  const initStr = initialMetric as string;
  if (initStr.endsWith('_tx_util') || initStr.endsWith('_rx_util')) {
    return { ...empty, nics: [initStr.replace(/_[tr]x_util$/, '')] };
  }
  if (initialMetric === 'cpu') return { ...empty, metrics: ['cpu', 'cpuTemp'] };
  if (initialMetric === 'gpu') return { ...empty, metrics: ['gpu', 'gpuTemp'] };
  return { ...empty, metrics: [initialMetric] };
}
