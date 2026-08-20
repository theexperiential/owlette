'use client';

/** Expanded chart view that replaces the top stats cards when a sparkline is clicked. */

import { Fragment, useState, useMemo, useEffect, useCallback, useRef } from 'react';
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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Input } from '@/components/ui/input';
import { X, ToggleLeft, ToggleRight, Monitor, HardDrive, ArrowDownUp, ArrowUp, ArrowDown, Thermometer, ChevronDown, Check } from 'lucide-react';
import { TimeRangeSelector, type TimeRange } from './TimeRangeSelector';
import { ChartTooltip, metricConfig, type MetricType } from './ChartTooltip';
import {
  serializeTabs,
  deserializeTabs,
  initialMetricToState,
  type TabSelection,
} from './metricsTabs';
import { useHistoricalMetrics } from '@/hooks/useHistoricalMetrics';
import { useDemoContext } from '@/contexts/DemoContext';
import { getNicColors, getDiskColors, getGpuColors, formatThroughput } from '@/lib/networkUtils';
import { DISK_IO_COLORS, formatDiskIO, isDiskIOKey, parseDiskIOKey, computeNiceByteTicks } from '@/lib/diskIOUtils';
import { useAuth } from '@/contexts/AuthContext';
import { cn } from '@/lib/utils';
import { ChartLoadingIndicator } from './ChartLoadingIndicator';

interface MetricsDetailPanelProps {
  machineId: string;
  machineName?: string;
  siteId: string;
  initialMetric?: MetricType;
  onClose: () => void;
  /** GPU profile keyed by UUID — supplies friendly labels; UUID stays the chart-data key. */
  gpus?: ReadonlyArray<{ id: string; name?: string }>;
  /** Site machines; past MACHINE_SWITCHER_MIN the title becomes a switcher dropdown. */
  machines?: ReadonlyArray<{ machineId: string; online: boolean }>;
  /** Invoked when a different machine is picked from the title dropdown. */
  onSwitchMachine?: (machineId: string) => void;
}

// Below this machine count the plain-text title stays — scrolling the list is cheap.
const MACHINE_SWITCHER_MIN = 5;
// Past this count the switcher grows a filter input.
const MACHINE_SWITCHER_FILTER_MIN = 8;

/** Title-bar dropdown for switching machines without leaving the panel. */
function MachineSwitcher({
  currentId,
  label,
  machines,
  onSelect,
}: {
  currentId: string;
  label: string;
  machines: ReadonlyArray<{ machineId: string; online: boolean }>;
  onSelect: (machineId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const showFilter = machines.length > MACHINE_SWITCHER_FILTER_MIN;

  const sorted = useMemo(
    () => [...machines].sort((a, b) =>
      a.machineId.localeCompare(b.machineId, undefined, { sensitivity: 'base' }),
    ),
    [machines],
  );
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? sorted.filter((m) => m.machineId.toLowerCase().includes(q)) : sorted;
  }, [sorted, filter]);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Clear stale filter text on close so the dropdown reopens fresh.
        if (!next) setFilter('');
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="switch machine"
          className="flex items-center gap-2 text-xl font-semibold text-foreground shrink-0 -ml-1.5 px-1.5 py-0.5 rounded-md cursor-pointer hover:bg-accent/40 transition-colors outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          <Monitor className="h-5 w-5 text-muted-foreground" />
          {label}
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="p-0 w-64">
        {showFilter && (
          <div className="border-b border-border p-2">
            <Input
              autoFocus
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="filter machines…"
              className="h-8 text-sm"
            />
          </div>
        )}
        <div className="max-h-72 overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-sm text-muted-foreground">no machines match</div>
          ) : (
            filtered.map((m) => {
              const isCurrent = m.machineId === currentId;
              return (
                <button
                  key={m.machineId}
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    if (!isCurrent) onSelect(m.machineId);
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-1.5 text-sm text-left cursor-pointer transition-colors',
                    isCurrent
                      ? 'bg-accent text-foreground'
                      : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      'h-1.5 w-1.5 rounded-full shrink-0',
                      m.online ? 'bg-green-500' : 'bg-muted-foreground/40',
                    )}
                  />
                  <span className="truncate">{m.machineId}</span>
                  {isCurrent && <Check className="ml-auto h-3.5 w-3.5 shrink-0 text-primary" />}
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// Tab-state helpers + types live in ./metricsTabs so the dashboard can import them
// without pulling Recharts into the main bundle.

// Recharts YAxis width; also the stats-grid left padding so cards align with the plot area.
const CHART_Y_AXIS_WIDTH = 40;

// Right-side bytes axis width — wider than the left to fit "1.2 MB/s" ticks.
const CHART_BYTES_AXIS_WIDTH = 56;

// Once a visible peak hits this % of max rate (disk bandwidth / NIC link speed) the
// series flip from the auto-scaled bytes axis to the 0-100% axis so saturation is
// legible; below it, bytes mode keeps low-activity lines off the floor. Disk IO and
// NIC apply it independently.
const BYTES_MODE_PCT_THRESHOLD = 70;

// Shared toggle-button className. Call sites use variant="ghost" plus the explicit
// border here: the outline variant's `dark:border-input` outranks `border-border` in
// dark mode and renders invisible borders.
function toggleButtonClass(isSelected: boolean): string {
  return cn(
    'text-xs h-8 px-3 transition-colors',
    isSelected
      ? 'bg-accent text-foreground border-transparent ring-1 ring-primary/40 hover:bg-accent'
      : 'bg-card text-muted-foreground border border-border hover:bg-accent/40 hover:text-foreground',
  );
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

/** Drive-letter shape (`C:`); filters out unmapped `HarddiskVolumeN` partitions. */
function isDriveLetter(id: string): boolean {
  return /^[A-Z]:$/.test(id);
}

/** Temperature sibling for a base metric; toggles flip both in lock-step. */
function tempSiblingOf(metric: MetricType): MetricType | null {
  if (metric === 'cpu') return 'cpuTemp';
  if (metric === 'gpu') return 'gpuTemp';
  return null;
}

/** Starting TabSelection. An explicit graphTabs entry — even an empty one — wins, so a
 *  deliberate deselect-all survives remounts; only an absent entry falls back. */
function resolveSelection(
  persistedIds: string[] | undefined,
  initialMetric: MetricType,
): TabSelection {
  if (persistedIds !== undefined) return deserializeTabs(persistedIds);
  return initialMetricToState(initialMetric);
}

export function MetricsDetailPanel({
  machineId,
  machineName,
  siteId,
  initialMetric = 'cpu',
  onClose,
  gpus,
  machines,
  onSwitchMachine,
}: MetricsDetailPanelProps) {

  const { userPreferences, updateUserPreferences } = useAuth();

  // Demo mode keeps selection + range local: reading real graphTabs would seed an
  // empty selection from foreign machine ids, and writing back would pollute real
  // preferences (or toast "must be signed in"). No-op outside demo (`demo` is null).
  const demo = useDemoContext();
  const isDemo = demo != null;
  const graphTabs = isDemo ? undefined : userPreferences.graphTabs;

  // Seed from persisted selection on first render — no default-then-restored flash.
  // The dashboard writes click intent to graphTabs before this panel mounts.
  const [selectedMetrics, setSelectedMetrics] = useState<MetricType[]>(
    () => resolveSelection(graphTabs?.[machineId], initialMetric).metrics,
  );
  const [selectedNics, setSelectedNics] = useState<string[]>(
    () => resolveSelection(graphTabs?.[machineId], initialMetric).nics,
  );
  const [selectedDisks, setSelectedDisks] = useState<string[]>(
    () => resolveSelection(graphTabs?.[machineId], initialMetric).disks,
  );
  const [selectedGpus, setSelectedGpus] = useState<string[]>(
    () => resolveSelection(graphTabs?.[machineId], initialMetric).gpus,
  );
  const [selectedDiskIO, setSelectedDiskIO] = useState<string[]>(
    () => resolveSelection(graphTabs?.[machineId], initialMetric).diskIO,
  );
  const [timeRange, setTimeRangeState] = useState<TimeRange>(
    () => (isDemo ? undefined : userPreferences.graphTimeRange) || '1h',
  );

  // Hovered stat card highlights its line and dims the rest. Card `key` === Line `dataKey`.
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);

  // Sync when another tab/device changes the preference; skipped in demo (range is local).
  useEffect(() => {
    if (isDemo) return;
    const next = userPreferences.graphTimeRange || '1h';
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTimeRangeState((prev) => (prev === next ? prev : next));
  }, [userPreferences.graphTimeRange, isDemo]);

  const setTimeRange = useCallback((range: TimeRange) => {
    setTimeRangeState(range);
    if (isDemo) return;
    updateUserPreferences({ graphTimeRange: range }, { silent: true })
      .catch(() => { /* fire-and-forget; matches statsExpanded pattern */ });
  }, [updateUserPreferences, isDemo]);

  const { data, loading, error } = useHistoricalMetrics(siteId, machineId, timeRange);

  // Stable empty-array ref so downstream useMemo deps don't thrash while loading.
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
    const arr = Array.from(names);
    // Profile order (PCI bus) first, then alphabetical for unknown ids. "GPU 1/2"
    // numbering depends on this order staying stable.
    if (gpus && gpus.length > 0) {
      const orderIndex = new Map(gpus.map((g, i) => [g.id, i]));
      arr.sort((a, b) => {
        const ai = orderIndex.get(a) ?? Number.MAX_SAFE_INTEGER;
        const bi = orderIndex.get(b) ?? Number.MAX_SAFE_INTEGER;
        if (ai !== bi) return ai - bi;
        return a.localeCompare(b);
      });
    } else {
      arr.sort();
    }
    return arr;
  }, [chartData, gpus]);

  // "GPU" when single, "GPU N" when multiple; index follows sorted gpuNames.
  // Toggles, legend, stats cards, and ChartTooltip all use this label.
  const gpuDisplayLabel = useCallback(
    (id: string): string => {
      if (gpuNames.length <= 1) return 'GPU';
      const idx = gpuNames.indexOf(id);
      return idx >= 0 ? `GPU ${idx + 1}` : 'GPU';
    },
    [gpuNames],
  );

  // chart-key → display label for ChartTooltip; the raw key is the cloud function's gpu.name.
  const gpuLabels = useMemo(() => {
    const m = new Map<string, string>();
    for (const id of gpuNames) m.set(id, gpuDisplayLabel(id));
    return m;
  }, [gpuNames, gpuDisplayLabel]);

  // Volume ids from the flat `{volumeId}_io_{channel}` keys; sorted for stable toggle order.
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

  // Union of storage + activity drive ids, sorted, so each drive's two toggles sit adjacent.
  const driveOrder = useMemo(() => {
    const all = new Set<string>();
    for (const d of diskNames) all.add(d);
    for (const v of volumeIds) all.add(v);
    return Array.from(all).sort();
  }, [diskNames, volumeIds]);

  // Mirror persisted selection; graphTabs is the source of truth (the dashboard merges
  // click intent at click time). An empty array is an explicit deselect-all, not "unset".
  useEffect(() => {
    const next = resolveSelection(graphTabs?.[machineId], initialMetric);

    // Sync from external persisted state; guarded setters no-op when nothing changed.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedMetrics((prev) => (sameStringArray(prev, next.metrics) ? prev : next.metrics));
    setSelectedNics((prev) => (sameStringArray(prev, next.nics) ? prev : next.nics));
    setSelectedDisks((prev) => (sameStringArray(prev, next.disks) ? prev : next.disks));
    setSelectedGpus((prev) => (sameStringArray(prev, next.gpus) ? prev : next.gpus));
    setSelectedDiskIO((prev) => (sameStringArray(prev, next.diskIO) ? prev : next.diskIO));
  }, [machineId, initialMetric, graphTabs]);

  // Opening on a generic 'disk'/'gpu' for a machine with per-device history: expand to
  // every per-device line once data lands, or the chart is blank (generics are filtered
  // out of the toggle row when per-device data exists). One-shot per (machine, metric),
  // never overriding a persisted selection or a later toggle; covers callers like /demo
  // that pass `initialMetric` without writing graphTabs.
  const didExpandInitialDevice = useRef(false);
  // Re-arm on machine/metric change only — re-arming on graphTabs would let a re-expand
  // clobber a deliberate deselect. Declared before the expand effect so the reset lands first.
  useEffect(() => {
    didExpandInitialDevice.current = false;
  }, [machineId, initialMetric]);
  useEffect(() => {
    if (didExpandInitialDevice.current) return;
    if (graphTabs?.[machineId] !== undefined) return; // persisted selection is authoritative
    if (chartData.length === 0) return;               // wait for data to derive device ids
    if (initialMetric === 'disk' && diskNames.length > 0) {
      didExpandInitialDevice.current = true;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelectedDisks((prev) => (prev.length > 0 ? prev : diskNames));
    } else if (initialMetric === 'gpu' && gpuNames.length > 0) {
      didExpandInitialDevice.current = true;
      setSelectedGpus((prev) => (prev.length > 0 ? prev : gpuNames));
    }
  }, [chartData, graphTabs, machineId, initialMetric, diskNames, gpuNames]);

  // Stale generics can linger in selectedMetrics; filter at render time (not in persisted
  // state) so they don't draw invisible duplicate lines.
  const effectiveMetrics = useMemo(() => {
    let m = selectedMetrics;
    if (diskNames.length > 0) m = m.filter((x) => x !== 'disk');
    if (gpuNames.length > 0) m = m.filter((x) => x !== 'gpu' && x !== 'gpuTemp');
    return m;
  }, [selectedMetrics, diskNames.length, gpuNames.length]);

  // Drop volumes absent from current chart data; render-time only, persisted state untouched.
  const effectiveDiskIO = useMemo(
    () => selectedDiskIO.filter((v) => volumeIds.includes(v)),
    [selectedDiskIO, volumeIds],
  );

  // "percent" (shared 0-100 axis, saturation obvious) once a visible peak hits the
  // threshold, else "bytes" (auto-scaled right axis, sub-%-of-max still legible).
  const diskIOMode: 'percent' | 'bytes' = useMemo(() => {
    if (effectiveDiskIO.length === 0) return 'bytes';
    let peakPct = 0;
    for (const volumeId of effectiveDiskIO) {
      const readKey = `${volumeId}_io_read_pct`;
      const writeKey = `${volumeId}_io_write_pct`;
      for (const d of chartData) {
        const r = d[readKey];
        const w = d[writeKey];
        if (typeof r === 'number' && r > peakPct) peakPct = r;
        if (typeof w === 'number' && w > peakPct) peakPct = w;
      }
    }
    return peakPct >= BYTES_MODE_PCT_THRESHOLD ? 'percent' : 'bytes';
  }, [effectiveDiskIO, chartData]);

  // Per-NIC analogue of diskIOMode against link speed: bytes mode keeps 1 MB/s on a
  // 1 Gbps link readable instead of flatlining at 0.9%.
  const networkMode: 'percent' | 'bytes' = useMemo(() => {
    if (selectedNics.length === 0) return 'bytes';
    let peakPct = 0;
    for (const nicName of selectedNics) {
      const txKey = `${nicName}_tx_util`;
      const rxKey = `${nicName}_rx_util`;
      for (const d of chartData) {
        const tx = d[txKey];
        const rx = d[rxKey];
        if (typeof tx === 'number' && tx > peakPct) peakPct = tx;
        if (typeof rx === 'number' && rx > peakPct) peakPct = rx;
      }
    }
    return peakPct >= BYTES_MODE_PCT_THRESHOLD ? 'percent' : 'bytes';
  }, [selectedNics, chartData]);

  // Selected line count; each disk-IO toggle counts 2 (read + write).
  const totalSelected =
    effectiveMetrics.length + selectedNics.length + selectedDisks.length + selectedGpus.length + effectiveDiskIO.length * 2;

  const persistSelections = useCallback((sel: Partial<TabSelection>) => {
    if (isDemo) return; // demo selections are local-only — never touch real prefs
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
  }, [isDemo, selectedMetrics, selectedNics, selectedDisks, selectedGpus, selectedDiskIO, graphTabs, machineId, updateUserPreferences]);

  // Flip a base metric and its temperature sibling in lock-step.
  const togglePairedMetric = (base: MetricType, temp: MetricType | null) => {
    setSelectedMetrics((prev) => {
      const isOn = prev.includes(base);
      const stripped = prev.filter((m) => m !== base && m !== temp);
      const next = isOn ? stripped : [...stripped, base, ...(temp ? [temp] : [])];
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

  // Per-device auto-select lives in the dashboard click handler: doing it at mount
  // clobbered an explicit toggle-all-off, indistinguishable from first-ever open here.

  const hour12 = (userPreferences.timeFormat || '12h') === '12h';

  // Memoized so Recharts' XAxis/Tooltip don't remount each parent render. Returning ''
  // keeps the gridline (CartesianGrid draws one per tick) but drops the crowded label.
  const formatXAxisTick = useCallback((timestamp: number): string => {
    const date = new Date(timestamp);
    switch (timeRange) {
      case '1h':
        return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12 });
      case '1d':
        // Gridline every hour; label only even hours (date at midnight).
        if (date.getHours() % 2 !== 0) return '';
        return date.getHours() === 0
          ? date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
          : date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12 });
      case '1w':
        return `W${getISOWeek(date)} ${date.toLocaleDateString(undefined, { weekday: 'short' })}`;
      case '1m':
        // Gridline every midnight; label only at month starts.
        return date.getDate() === 1
          ? date.toLocaleDateString(undefined, { month: 'short' })
          : '';
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

  // Latch "now" so the time domain is a pure function of state. Keyed on the chartData
  // array identity, not its length — a refetch capped at MAX_POINTS returns the same
  // count but must still advance the right edge. setState-in-effect is deliberate:
  // Date.now() is impure and can't run during render.
  const [nowTs, setNowTs] = useState<number>(() => Date.now());
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNowTs(Date.now());
  }, [timeRange, chartData]);

  // ResizeObserver/rAF are throttled while the tab is hidden, so ResponsiveContainer can
  // hold a stale width on refocus (plot offset right); a synthetic resize forces
  // re-measure. Snapping nowTs keeps the axis right edge from staying frozen at the
  // mount-time "now" until the refetch lands, which would render new samples off-window.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        setNowTs(Date.now());
        window.dispatchEvent(new Event('resize'));
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

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

  // Render the right bytes axis only when some bytes-mode series is selected.
  const bytesAxisActive =
    (diskIOMode === 'bytes' && effectiveDiskIO.length > 0) ||
    (networkMode === 'bytes' && selectedNics.length > 0);

  // Explicit round ticks (250 KB/s, 1 MB/s, …): Recharts' default divides the data max
  // by 4 and lands on values like "585.9 KB/s". Scans the visible domain across every
  // bytes-axis series so disk IO and NIC share one scale. Null when no data is in range,
  // which falls back to recharts' auto scale.
  const bytesAxis = useMemo(() => {
    if (!bytesAxisActive) return null;
    const [start, end] = timeDomain;
    let max = 0;
    for (const d of chartData) {
      if (d.time < start || d.time > end) continue;
      if (diskIOMode === 'bytes') {
        for (const volumeId of effectiveDiskIO) {
          const r = d[`${volumeId}_io_read`];
          const w = d[`${volumeId}_io_write`];
          if (typeof r === 'number' && r > max) max = r;
          if (typeof w === 'number' && w > max) max = w;
        }
      }
      if (networkMode === 'bytes') {
        for (const nicName of selectedNics) {
          const tx = d[`${nicName}_tx`];
          const rx = d[`${nicName}_rx`];
          if (typeof tx === 'number' && tx > max) max = tx;
          if (typeof rx === 'number' && rx > max) max = rx;
        }
      }
    }
    return computeNiceByteTicks(max);
  }, [bytesAxisActive, diskIOMode, effectiveDiskIO, networkMode, selectedNics, chartData, timeDomain]);

  // One tick per natural unit (hour/date/month) — no repeats, no gaps on sparse data.
  // formatXAxisTick blanks the labels in between.
  const xTicks = useMemo((): number[] | undefined => {
    const [start, end] = timeDomain;
    if (timeRange === '1h') return undefined; // let recharts auto-tick
    const ticks: number[] = [];
    if (timeRange === '1d') {
      // One tick (gridline) per hour on the hour.
      const d = new Date(start);
      d.setMinutes(0, 0, 0);
      if (d.getTime() < start) d.setHours(d.getHours() + 1);
      while (d.getTime() <= end) {
        ticks.push(d.getTime());
        d.setHours(d.getHours() + 1);
      }
      return ticks;
    }
    if (timeRange === '1w' || timeRange === '1m') {
      // One tick (gridline) per midnight within the range.
      const d = new Date(start);
      d.setHours(0, 0, 0, 0);
      if (d.getTime() < start) d.setDate(d.getDate() + 1);
      while (d.getTime() <= end) {
        ticks.push(d.getTime());
        d.setDate(d.getDate() + 1);
      }
      return ticks;
    }
    // 1y / all: one tick per calendar month start.
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

  // Hide generic Disk/GPU when per-device data exists — the scalar is one of those devices.
  const availableMetrics: MetricType[] = useMemo(() => {
    const base: MetricType[] = ['cpu', 'memory'];
    if (diskNames.length === 0) base.push('disk');
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
    // True on/off: all-selected clears every toggle, otherwise select all.
    const nextMetrics: MetricType[] = allSelected ? [] : [...availableMetrics];
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

  // Active Line dataKeys. `hidden` renders a transparent stroke (tooltip-only data);
  // `axis: 'bytes'` binds to the right auto-scaled axis so byte/sec doesn't blow out
  // the shared 0-100% scale.
  const activeLines = useMemo(() => {
    const lines: { key: string; color: string; label: string; hidden?: boolean; axis?: 'default' | 'hidden' | 'bytes' }[] = [];

    // Standard metrics
    for (const metric of effectiveMetrics) {
      const config = metricConfig[metric];
      if (config) {
        lines.push({ key: metric, color: config.color, label: config.label });
      }
    }

    // Per-NIC lines, same dual-family routing as disk IO: percent mode draws
    // `_tx_util`/`_rx_util` with hidden `_tx`/`_rx` bytes siblings for the tooltip;
    // bytes mode draws `_tx`/`_rx` on the right axis and needs no siblings.
    for (const nicName of selectedNics) {
      const nicIdx = nicNames.indexOf(nicName);
      const colors = getNicColors(nicIdx >= 0 ? nicIdx : 0);
      if (networkMode === 'percent') {
        lines.push({ key: `${nicName}_tx_util`, color: colors.tx, label: `${nicName} TX` });
        lines.push({ key: `${nicName}_rx_util`, color: colors.rx, label: `${nicName} RX` });
        lines.push({ key: `${nicName}_tx`, color: colors.tx, label: `${nicName} TX (bps)`, hidden: true });
        lines.push({ key: `${nicName}_rx`, color: colors.rx, label: `${nicName} RX (bps)`, hidden: true });
      } else {
        lines.push({ key: `${nicName}_tx`, color: colors.tx, label: `${nicName} TX`, axis: 'bytes' });
        lines.push({ key: `${nicName}_rx`, color: colors.rx, label: `${nicName} RX`, axis: 'bytes' });
      }
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
      const label = gpuDisplayLabel(gpuName);
      lines.push({ key: `${gpuName}_usage`, color: colors.usage, label });
      lines.push({ key: `${gpuName}_temp`, color: colors.temp, label });
    }

    // Per-volume disk IO: 2 visible lines (read + write) per volume. percent mode draws
    // `_pct` with hidden bytes siblings for the tooltip; bytes mode draws the bytes keys.
    for (const volumeId of effectiveDiskIO) {
      if (diskIOMode === 'percent') {
        lines.push({ key: `${volumeId}_io_read_pct`, color: DISK_IO_COLORS.read, label: `${volumeId} read` });
        lines.push({ key: `${volumeId}_io_write_pct`, color: DISK_IO_COLORS.write, label: `${volumeId} write` });
        lines.push({ key: `${volumeId}_io_read`, color: DISK_IO_COLORS.read, label: `${volumeId} read (bps)`, hidden: true });
        lines.push({ key: `${volumeId}_io_write`, color: DISK_IO_COLORS.write, label: `${volumeId} write (bps)`, hidden: true });
      } else {
        lines.push({ key: `${volumeId}_io_read`, color: DISK_IO_COLORS.read, label: `${volumeId} read`, axis: 'bytes' });
        lines.push({ key: `${volumeId}_io_write`, color: DISK_IO_COLORS.write, label: `${volumeId} write`, axis: 'bytes' });
      }
    }

    return lines;
  }, [effectiveMetrics, selectedNics, nicNames, networkMode, selectedDisks, diskNames, selectedGpus, gpuNames, effectiveDiskIO, diskIOMode, gpuDisplayLabel]);

  // Stats-grid cards. `format: 'throughput'` renders byte rates; `valueKey` overrides the
  // avg/max/min source, so disk-IO cards hover the visible `_pct` line but report bytes.
  const statsKeys = useMemo(() => {
    const keys: { key: string; label: string; color: string; isNetwork: boolean; unit?: string; format?: 'throughput'; valueKey?: string; showThermometer?: boolean; direction?: 'tx' | 'rx' }[] = [];

    // Order mirrors the toggle-button row: metrics → drives → GPUs → NICs.

    // Iterate availableMetrics for deterministic order; inject each temp sibling after its base.
    const seenMetrics = new Set<MetricType>();
    const pushMetricCard = (metric: MetricType) => {
      if (seenMetrics.has(metric)) return;
      seenMetrics.add(metric);
      const config = metricConfig[metric];
      if (!config) return;
      keys.push({
        key: metric,
        label: config.label,
        color: config.color,
        isNetwork: false,
        // cpuTemp/gpuTemp share the base label; the thermometer icon distinguishes them.
        showThermometer: metric === 'cpuTemp' || metric === 'gpuTemp',
      });
    };
    for (const metric of availableMetrics) {
      if (metric === 'cpuTemp' || metric === 'gpuTemp') continue; // inserted after base
      if (effectiveMetrics.includes(metric)) pushMetricCard(metric);
      const temp = tempSiblingOf(metric);
      if (temp && effectiveMetrics.includes(temp)) pushMetricCard(temp);
    }
    // Safety net: a standalone temp whose base isn't in availableMetrics.
    for (const metric of effectiveMetrics) pushMetricCard(metric);

    // Drive cards mirror the toggle row: storage card, then read/write IO.
    for (const drive of driveOrder) {
      if (selectedDisks.includes(drive)) {
        const diskIdx = diskNames.indexOf(drive);
        const color = getDiskColors(diskIdx >= 0 ? diskIdx : 0);
        keys.push({ key: `${drive}_pct`, label: drive, color, isNetwork: false, unit: '%' });
      }
      if (effectiveDiskIO.includes(drive)) {
        // `key` matches the mode-dependent visible line so hover dimming hits it;
        // `valueKey` is always bytes so avg/max/min stay in KB/MB/GB.
        const readKey = diskIOMode === 'percent' ? `${drive}_io_read_pct` : `${drive}_io_read`;
        const writeKey = diskIOMode === 'percent' ? `${drive}_io_write_pct` : `${drive}_io_write`;
        keys.push({
          key: readKey,
          valueKey: `${drive}_io_read`,
          label: `${drive} read`,
          color: DISK_IO_COLORS.read,
          isNetwork: false,
          format: 'throughput',
        });
        keys.push({
          key: writeKey,
          valueKey: `${drive}_io_write`,
          label: `${drive} write`,
          color: DISK_IO_COLORS.write,
          isNetwork: false,
          format: 'throughput',
        });
      }
    }

    // GPU cards — usage + temp per GPU, in the same order as the GPU toggles.
    for (const gpuName of selectedGpus) {
      const gpuIdx = gpuNames.indexOf(gpuName);
      const colors = getGpuColors(gpuIdx >= 0 ? gpuIdx : 0);
      const label = gpuDisplayLabel(gpuName);
      keys.push({ key: `${gpuName}_usage`, label, color: colors.usage, isNetwork: false, unit: '%' });
      keys.push({ key: `${gpuName}_temp`, label, color: colors.temp, isNetwork: false, unit: '°C', showThermometer: true });
    }

    // NIC cards: TX + RX per NIC, direction shown as an arrow icon rather than a
    // " TX"/" RX" suffix. `key` matches the mode-dependent visible line so hover hits it;
    // bytes mode swaps the percent-with-throughput format for throughput-only.
    for (const nicName of selectedNics) {
      const nicIdx = nicNames.indexOf(nicName);
      const colors = getNicColors(nicIdx >= 0 ? nicIdx : 0);
      if (networkMode === 'percent') {
        keys.push({ key: `${nicName}_tx_util`, label: nicName, color: colors.tx, isNetwork: true, direction: 'tx' });
        keys.push({ key: `${nicName}_rx_util`, label: nicName, color: colors.rx, isNetwork: true, direction: 'rx' });
      } else {
        keys.push({
          key: `${nicName}_tx`,
          label: nicName,
          color: colors.tx,
          isNetwork: false,
          format: 'throughput',
          direction: 'tx',
        });
        keys.push({
          key: `${nicName}_rx`,
          label: nicName,
          color: colors.rx,
          isNetwork: false,
          format: 'throughput',
          direction: 'rx',
        });
      }
    }

    return keys;
  }, [availableMetrics, effectiveMetrics, selectedNics, nicNames, networkMode, selectedDisks, diskNames, driveOrder, selectedGpus, gpuNames, effectiveDiskIO, diskIOMode, gpuDisplayLabel]);

  return (
    <Card className="border-border bg-card-sunken py-0 gap-0">
      <CardContent className="p-4">
        {/* Title row */}
        <div className="flex items-center gap-3 mb-3">
          {onSwitchMachine && machines && machines.length > MACHINE_SWITCHER_MIN ? (
            <MachineSwitcher
              currentId={machineId}
              label={machineName || machineId}
              machines={machines}
              onSelect={onSwitchMachine}
            />
          ) : (
            <span className="flex items-center gap-2 text-xl font-semibold text-foreground shrink-0">
              <Monitor className="h-5 w-5 text-muted-foreground" />
              {machineName || machineId}
            </span>
          )}
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
            <ChartLoadingIndicator />
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
                <p>{allSelected ? 'clear all' : 'show all metrics'}</p>
              </TooltipContent>
            </UITooltip>
            {availableMetrics
              .filter((m) => m !== 'cpuTemp' && m !== 'gpuTemp')
              .map((metric) => {
                const config = metricConfig[metric];
                const temp = tempSiblingOf(metric);
                const hasTemp = temp !== null && availableMetrics.includes(temp);
                const tempConfig = hasTemp && temp ? metricConfig[temp] : null;
                const isSelected = effectiveMetrics.includes(metric);

                return (
                  <Button
                    key={metric}
                    variant="ghost"
                    size="sm"
                    onClick={() => togglePairedMetric(metric, hasTemp ? temp : null)}
                    className={toggleButtonClass(isSelected)}
                    title={hasTemp ? `${config.label} — usage & temperature` : undefined}
                  >
                    <span className="inline-flex items-center gap-0.5 shrink-0">
                      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: config.color }} />
                      {tempConfig && (
                        <Thermometer className="w-3 h-3" style={{ color: tempConfig.color }} />
                      )}
                    </span>
                    <span className="ml-1.5">{config.label}</span>
                  </Button>
                );
              })}

            {/* Per-drive toggle pair: STORAGE (`<HardDrive>` = capacity %) then
                ACTIVITY (`<ArrowDownUp>` = read+write % of max bandwidth). Grouped
                by drive so each letter's two buttons sit next to each other
                (C storage → C activity → L storage → L activity) rather than
                separated by type. A drive missing one axis (e.g. no IO data)
                simply renders whichever button it has. */}
            {driveOrder.map((drive) => {
              const diskIdx = diskNames.indexOf(drive);
              const hasStorage = diskIdx >= 0;
              const hasActivity = volumeIds.includes(drive);
              const storageSelected = selectedDisks.includes(drive);
              const activitySelected = selectedDiskIO.includes(drive);
              const storageColor = hasStorage ? getDiskColors(diskIdx) : undefined;
              return (
                <Fragment key={drive}>
                  {hasStorage && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => toggleDisk(drive)}
                      className={toggleButtonClass(storageSelected)}
                      title={`${drive} — disk usage`}
                    >
                      <HardDrive className="w-3 h-3 shrink-0" style={{ color: storageColor }} />
                      <span className="ml-1.5">{drive}</span>
                    </Button>
                  )}
                  {hasActivity && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => toggleDiskIO(drive)}
                      className={toggleButtonClass(activitySelected)}
                      title={`${drive} — read/write activity (% of max bandwidth)`}
                    >
                      <ArrowDownUp className="w-3 h-3 shrink-0" style={{ color: DISK_IO_COLORS.read }} />
                      <span className="ml-1.5">{drive}</span>
                    </Button>
                  )}
                </Fragment>
              );
            })}

            {/* Per-GPU toggle buttons */}
            {gpuNames.map((gpuName, gpuIdx) => {
              const isSelected = selectedGpus.includes(gpuName);
              const colors = getGpuColors(gpuIdx);

              return (
                <Button
                  key={`gpu-${gpuName}`}
                  variant="ghost"
                  size="sm"
                  onClick={() => toggleGpu(gpuName)}
                  className={toggleButtonClass(isSelected)}
                >
                  <span className="inline-flex items-center gap-0.5 shrink-0">
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: colors.usage }} />
                    <Thermometer className="w-3 h-3" style={{ color: colors.temp }} />
                  </span>
                  <span className="ml-1.5">{gpuDisplayLabel(gpuName)}</span>
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
                  variant="ghost"
                  size="sm"
                  onClick={() => toggleNic(nicName)}
                  className={toggleButtonClass(isSelected)}
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
        <div className="h-[280px] w-full rounded-lg border border-border/40 bg-card p-2">
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
          ) : !activeLines.some((line) => !line.hidden) ? (
            <div className="flex items-center justify-center h-full text-center">
              <div className="text-muted-foreground">
                no metrics selected.
                <br />
                <span className="text-sm text-muted-foreground/70">toggle a metric above to view its chart.</span>
              </div>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 12, right: 0, bottom: 5, left: 0 }}>
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
                {/* Right-side bytes axis — visible whenever any byte-rate
                    category (disk IO, NIC) is rendering in bytes mode. Ticks
                    format via formatDiskIO so each level picks its own unit
                    (KB/MB/GB), and the domain is the union across all
                    bytes-axis-bound series (see `bytesAxis`). */}
                {bytesAxisActive && (
                  <YAxis
                    yAxisId="bytes"
                    orientation="right"
                    width={CHART_BYTES_AXIS_WIDTH}
                    stroke="oklch(0.708 0.05 250)"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v: number) => formatDiskIO(v)}
                    {...(bytesAxis
                      ? { domain: [0, bytesAxis.domainMax], ticks: bytesAxis.ticks }
                      : {})}
                  />
                )}
                <Tooltip content={<ChartTooltip formatTime={formatTooltipTime} gpuLabels={gpuLabels} />} />
                {/* Baseline reference line to show full time range */}
                <ReferenceLine y={0} stroke="oklch(0.35 0.08 250)" strokeDasharray="3 3" />
                {activeLines.map((line) => {
                  if (line.hidden) {
                    // Tooltip-only lines on their own axis so raw bytes don't blow out the 0-100% scale.
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
                  // axis: 'bytes' → right auto-scaled, 'hidden' → off-scale, default → shared percent.
                  const yAxisId = line.axis === 'bytes' ? 'bytes' : line.axis === 'hidden' ? 'hidden' : 'default';
                  const isHovered = hoveredKey === line.key;
                  const isDimmed = hoveredKey !== null && !isHovered;
                  return (
                    <Line
                      key={line.key}
                      yAxisId={yAxisId}
                      type="monotone"
                      dataKey={line.key}
                      name={line.label}
                      stroke={line.color}
                      strokeWidth={isHovered ? 3 : 2}
                      strokeOpacity={isDimmed ? 0.15 : 1}
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
            className="mt-2 flex flex-wrap gap-2"
            style={{ paddingLeft: CHART_Y_AXIS_WIDTH }}
            onMouseLeave={() => setHoveredKey(null)}
          >
            {statsKeys.map(({ key, valueKey, label, color, isNetwork, unit: explicitUnit, format, showThermometer, direction }) => {
              const sourceKey = valueKey ?? key;
              const values = chartData
                .map((d) => d[sourceKey] as number | undefined)
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

              // Byte-rate series have no percent/°C unit — formatDiskIO for all three stats.
              const isThroughput = format === 'throughput';
              const fmtAvg = isThroughput ? formatDiskIO(avg) : `${avg.toFixed(1)}${unit}`;
              const fmtMax = isThroughput ? formatDiskIO(max) : `${max.toFixed(1)}${unit}`;
              const fmtMin = isThroughput ? formatDiskIO(min) : `${min.toFixed(1)}${unit}`;

              return (
                <div
                  key={key}
                  className="flex items-center gap-4 px-3 py-2 rounded-lg bg-secondary border border-border/60 transition-colors hover:bg-accent/40 cursor-default"
                  style={{ borderLeftColor: color, borderLeftWidth: '3px' }}
                  onMouseEnter={() => setHoveredKey(key)}
                >
                  {/* Metric label — left. Thermometer icon for temp entries
                      (cpuTemp/gpuTemp and per-GPU _temp), ArrowUp/ArrowDown
                      for NIC TX/RX. Both disambiguate siblings that share the
                      same base label (CPU usage vs CPU temp, Ethernet TX vs
                      Ethernet RX). */}
                  <div className="inline-flex items-center gap-1 text-xs font-medium text-foreground">
                    {label}
                    {showThermometer && <Thermometer className="h-3 w-3 shrink-0" />}
                    {direction === 'tx' && <ArrowUp className="h-3 w-3 shrink-0" />}
                    {direction === 'rx' && <ArrowDown className="h-3 w-3 shrink-0" />}
                  </div>
                  {/* Stats — enclosed section floated right, ordered min / avg / max. */}
                  <div className="flex shrink-0 items-center gap-3 rounded-md border border-border/50 bg-background/40 px-2.5 py-1 text-xs">
                    <div className="text-center leading-tight">
                      <div className="text-[10px] text-muted-foreground">min</div>
                      <div className="font-semibold text-foreground whitespace-nowrap">{fmtMin}</div>
                    </div>
                    <div className="text-center leading-tight">
                      <div className="text-[10px] text-muted-foreground">avg</div>
                      <div className="font-semibold text-foreground whitespace-nowrap">
                        {fmtAvg}
                        {isNetwork && <span className="text-muted-foreground ml-0.5 font-normal">({formatThroughput(avgThroughput)})</span>}
                      </div>
                    </div>
                    <div className="text-center leading-tight">
                      <div className="text-[10px] text-muted-foreground">max</div>
                      <div className="font-semibold text-foreground whitespace-nowrap">{fmtMax}</div>
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
