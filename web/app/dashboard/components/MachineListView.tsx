/**
 * MachineListView Component
 *
 * Table display of machines with expandable process rows.
 * Hidden on mobile, toggleable with card view on desktop.
 *
 * Features:
 * - Tabular layout with sortable columns
 * - Expandable rows for process details
 * - Process controls (autolaunch, edit, kill)
 * - Create add process button
 * - Memoized table header for performance
 * - Sparkline charts behind metric cells
 *
 * Used by: Dashboard page for list view display
 */

'use client';

import React, { memo, useMemo } from 'react';
import { useMinuteTick } from '@/hooks/useMinuteTick';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { MachineContextMenu } from '@/components/MachineContextMenu';
import { MachineStatusPill } from '@/components/MachineStatusPill';
import { useDemoContext } from '@/contexts/DemoContext';
import { SparklineChart } from '@/components/charts';
import { ChevronDown, ChevronUp, Pencil, Square, Plus, Clock, Monitor, Cog, Settings2, MoreVertical, BellOff } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuLabel,
} from '@/components/ui/dropdown-menu';
import { useAuth } from '@/contexts/AuthContext';
import { formatScheduleSummary } from '@/components/ScheduleEditor';
import { BLOCK_COLORS } from '@/lib/scheduleDefaults';
import { formatTemperature, getTemperatureColorClass } from '@/lib/temperatureUtils';
import { formatStorageRange } from '@/lib/storageUtils';
import { getUsageColorClass } from '@/lib/usageColorUtils';
import { formatHeartbeatTime, formatMachineLocalClock, formatTimezoneShortName, getDisplayTimezone } from '@/lib/timeUtils';
import { formatThroughput } from '@/lib/networkUtils';
import { DISK_IO_COLORS, formatDiskIO } from '@/lib/diskIOUtils';
import { resolveDevice, unionIds } from '@/lib/deviceResolvers';
import { useDevicePrefs, type DeviceKind, type DeviceSelection } from '@/hooks/useDevicePrefs';
import { useAllSparklineData } from '@/hooks/useSparklineData';
import type { Machine, Process, LaunchMode, ScheduleBlock } from '@/hooks/useFirestore';
import type { MetricType } from '@/components/charts';

/**
 * Per-kind device id union across all visible machines. Used to populate
 * the shared column-header dropdowns in the list view.
 */
export interface DeviceUnion {
  cpus: string[];
  disks: string[];
  gpus: string[];
  nics: string[];
}

/** Which column headers should render a device dropdown (vs. plain label). */
export interface ShowDropdownFlags {
  cpu: boolean;
  disk: boolean;
  gpu: boolean;
  nic: boolean;
}

interface DeviceColumnHeaderProps {
  label: string;
  kind: DeviceKind;
  showDropdown: boolean;
  ids: string[];
  selectedId: string | undefined;
  onSelect: (kind: DeviceKind, id: string | null) => void;
}

function DeviceColumnHeader({
  label,
  kind,
  showDropdown,
  ids,
  selectedId,
  onSelect,
}: DeviceColumnHeaderProps) {
  if (!showDropdown) {
    return <>{label}</>;
  }
  const displayLabel = selectedId ? `${label}: ${selectedId}` : label;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 text-foreground hover:text-white cursor-pointer"
        >
          <span>{displayLabel}</span>
          <ChevronDown className="h-3 w-3 opacity-70" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="border-border bg-secondary">
        <DropdownMenuRadioGroup
          value={selectedId ?? ''}
          onValueChange={(value) => onSelect(kind, value === '' ? null : value)}
        >
          <DropdownMenuRadioItem value="" className="cursor-pointer">
            auto (most active)
          </DropdownMenuRadioItem>
          {ids.map((id) => (
            <DropdownMenuRadioItem key={id} value={id} className="cursor-pointer">
              {id}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Legacy no-dropdown header, kept for callers (demo page, dashboard page)
 * that render the list-view table directly and don't need column-header
 * device selectors. Renders plain column labels identical to the pre-v2
 * layout so existing pages keep working without wiring deviceUnion through.
 */
export const MemoizedTableHeader = memo(function MemoizedTableHeader() {
  return (
    <TableHeader className="sticky top-0 z-10 bg-background">
      <TableRow className="border-border hover:bg-transparent">
        <TableHead className="text-foreground w-8"></TableHead>
        <TableHead className="text-foreground w-[140px]">hostname</TableHead>
        <TableHead className="text-foreground w-[72px]">status</TableHead>
        <TableHead className="text-foreground w-0 overflow-hidden !px-0 sm:w-[160px] sm:overflow-visible sm:!px-2">cpu</TableHead>
        <TableHead className="text-foreground w-0 overflow-hidden !px-0 sm:w-[120px] sm:overflow-visible sm:!px-2">memory</TableHead>
        <TableHead className="text-foreground w-0 overflow-hidden !px-0 lg:w-[160px] lg:overflow-visible lg:!px-2">disk</TableHead>
        <TableHead className="text-foreground w-0 overflow-hidden !px-0 lg:w-[200px] lg:overflow-visible lg:!px-2">gpu</TableHead>
        <TableHead className="text-foreground w-0 overflow-hidden !px-0 xl:w-[130px] xl:overflow-visible xl:!px-2">network</TableHead>
        <TableHead className="text-foreground w-0 overflow-hidden !px-0 md:w-[110px] md:overflow-visible md:!px-2">last heartbeat</TableHead>
        <TableHead className="text-foreground w-10"></TableHead>
      </TableRow>
    </TableHeader>
  );
});

interface MachineTableHeaderProps {
  deviceUnion: DeviceUnion;
  showDropdown: ShowDropdownFlags;
  listPref: DeviceSelection;
  setListPref: (kind: DeviceKind, id: string | null) => void;
}

// Memoized table header to prevent flickering on data updates. Memo compares
// the prop bag by reference; callers pass stable refs for listPref/setListPref
// and a memoized deviceUnion/showDropdown so the header only re-renders when
// the device set or user selection actually changes — not on every metrics tick.
export const MachineTableHeader = memo(function MachineTableHeader({
  deviceUnion,
  showDropdown,
  listPref,
  setListPref,
}: MachineTableHeaderProps) {
  return (
    <TableHeader className="sticky top-0 z-10 bg-background">
      <TableRow className="border-border hover:bg-transparent">
        <TableHead className="text-foreground w-8"></TableHead>
        <TableHead className="text-foreground w-[140px]">hostname</TableHead>
        <TableHead className="text-foreground w-[72px]">status</TableHead>
        <TableHead className="text-foreground w-0 overflow-hidden !px-0 sm:w-[160px] sm:overflow-visible sm:!px-2">
          <DeviceColumnHeader
            label="cpu"
            kind="cpu"
            showDropdown={showDropdown.cpu}
            ids={deviceUnion.cpus}
            selectedId={listPref.cpu}
            onSelect={setListPref}
          />
        </TableHead>
        <TableHead className="text-foreground w-0 overflow-hidden !px-0 sm:w-[120px] sm:overflow-visible sm:!px-2">memory</TableHead>
        <TableHead className="text-foreground w-0 overflow-hidden !px-0 lg:w-[160px] lg:overflow-visible lg:!px-2">
          <DeviceColumnHeader
            label="disk"
            kind="disk"
            showDropdown={showDropdown.disk}
            ids={deviceUnion.disks}
            selectedId={listPref.disk}
            onSelect={setListPref}
          />
        </TableHead>
        <TableHead className="text-foreground w-0 overflow-hidden !px-0 lg:w-[200px] lg:overflow-visible lg:!px-2">
          <DeviceColumnHeader
            label="gpu"
            kind="gpu"
            showDropdown={showDropdown.gpu}
            ids={deviceUnion.gpus}
            selectedId={listPref.gpu}
            onSelect={setListPref}
          />
        </TableHead>
        <TableHead className="text-foreground w-0 overflow-hidden !px-0 xl:w-[130px] xl:overflow-visible xl:!px-2">
          <DeviceColumnHeader
            label="network"
            kind="nic"
            showDropdown={showDropdown.nic}
            ids={deviceUnion.nics}
            selectedId={listPref.nic}
            onSelect={setListPref}
          />
        </TableHead>
        <TableHead className="text-foreground w-0 overflow-hidden !px-0 md:w-[110px] md:overflow-visible md:!px-2">last heartbeat</TableHead>
        <TableHead className="text-foreground w-10"></TableHead>
      </TableRow>
    </TableHeader>
  );
});

interface MachineListViewProps {
  machines: Machine[];
  processesExpanded: boolean;
  currentSiteId: string;
  siteTimezone?: string;
  siteTimeFormat?: '12h' | '24h';
  onToggleProcesses: () => void;
  onEditProcess: (machineId: string, process: Process) => void;
  onCreateProcess: (machineId: string) => void;
  onKillProcess: (machineId: string, processId: string, processName: string) => void;
  onSetLaunchMode: (machineId: string, processId: string, processName: string, mode: LaunchMode, exePath: string, schedules?: ScheduleBlock[] | null) => void;
  onConfigureSchedule?: (machineId: string, process: Process) => void;
  onRemoveMachine: (machineId: string, machineName: string, isOnline: boolean) => void;
  onMetricClick?: (machineId: string, metricType: MetricType) => void;
}

/**
 * Individual machine row component with sparkline support
 */
interface MachineRowProps {
  machine: Machine;
  isExpanded: boolean;
  currentSiteId: string;
  siteTimezone: string;
  siteTimeFormat: '12h' | '24h';
  userPreferences: { temperatureUnit: 'C' | 'F' };
  isAdmin?: boolean;
  onToggleExpanded: () => void;
  onEditProcess: (process: Process) => void;
  onCreateProcess: () => void;
  onKillProcess: (processId: string, processName: string) => void;
  onSetLaunchMode: (processId: string, processName: string, mode: LaunchMode, exePath: string, schedules?: ScheduleBlock[] | null) => void;
  onConfigureSchedule?: (process: Process) => void;
  onRemoveMachine: () => void;
  onMetricClick?: (metricType: MetricType) => void;
  onReboot?: () => Promise<void>;
  onShutdown?: () => Promise<void>;
  onCancelReboot?: () => Promise<void>;
  onScreenshot?: () => void;
  onLiveView?: () => void;
  showLocalClock?: boolean;
  /**
   * User's column-dropdown selection for this view (cpu/disk/gpu/nic). When
   * omitted (legacy callers) or a kind is unset, the row falls back to the
   * machine's reported primary device — which also matches "auto (most
   * active)" in the column-header selector.
   */
  listPref?: DeviceSelection;
}

export function MachineRow({
  machine,
  isExpanded,
  currentSiteId,
  siteTimezone,
  siteTimeFormat,
  userPreferences,
  isAdmin,
  onToggleExpanded,
  onEditProcess,
  onCreateProcess,
  onKillProcess,
  onSetLaunchMode,
  onConfigureSchedule,
  onRemoveMachine,
  onMetricClick,
  onReboot,
  onShutdown,
  onCancelReboot,
  onScreenshot,
  onLiveView,
  showLocalClock,
  listPref,
}: MachineRowProps) {
  const pref = listPref ?? {};
  const primary = machine.metrics?.primary;
  const cpuDevice = resolveDevice(machine.devices?.cpus, pref.cpu, primary?.cpu);
  const diskDevice = resolveDevice(machine.devices?.disks, pref.disk, primary?.disk);
  const gpuDevice = resolveDevice(machine.devices?.gpus, pref.gpu, primary?.gpu);
  const nicDevice = resolveDevice(machine.devices?.nics, pref.nic, primary?.nic);

  // Memory has no per-device fan-out; `totalGb` isn't reported on the v2
  // MemoryMetric, so derive it from (usedGb / percent) when both are present.
  // When percent is 0/missing, we can't derive total reliably — fall back to
  // showing the used value alone.
  const memoryPercent = machine.metrics?.memory?.percent ?? 0;
  const memoryUsedGb = machine.metrics?.memory?.usedGb;
  const memoryTotalGb =
    memoryUsedGb !== undefined && memoryPercent > 0
      ? Math.round((memoryUsedGb / memoryPercent) * 100 * 10) / 10
      : null;
  const isDemo = !!useDemoContext();
  const { userPreferences: fullPrefs } = useAuth();
  const isMuted = fullPrefs.mutedMachines.includes(machine.machineId);
  const sparklineData = useAllSparklineData(currentSiteId, machine.machineId);

  // Format heartbeat time. The display tz is resolved per-machine according
  // to the user's chosen `timeDisplayMode` (preferences) — see getDisplayTimezone.
  const displayTz = getDisplayTimezone(
    fullPrefs.timeDisplayMode || 'machine',
    fullPrefs.timezone,
    machine.machineTimezone,
    siteTimezone
  );
  const heartbeat = formatHeartbeatTime(machine.lastHeartbeat, displayTz, siteTimeFormat);
  const isStale = !machine.online || !!machine.rebooting;
  const staleClass = isStale ? ' opacity-40' : '';

  // Live-updating local clock for this machine's own timezone (under hostname).
  // Subscribing to the shared wall-clock minute tick re-renders this row
  // once per minute (in lockstep with every other machine row) so the
  // formatted clock string below stays current. One interval, app-wide.
  useMinuteTick();
  const localClock = formatMachineLocalClock(machine.machineTimezone, siteTimeFormat);
  const localTzShort = formatTimezoneShortName(machine.machineTimezone);

  const handleRowClick = () => {
    const selection = window.getSelection();
    if (selection && selection.toString().length > 0) return;
    onToggleExpanded();
  };

  return (
    <>
      <TableRow
        className="border-border hover:bg-secondary/30 cursor-pointer"
        onClick={handleRowClick}
      >
        <TableCell className="w-8 p-2">
          <div className="flex items-center justify-center">
            {isExpanded ? (
              <ChevronUp className="h-4 w-4 text-foreground/70" />
            ) : (
              <ChevronDown className="h-4 w-4 text-foreground/70" />
            )}
          </div>
        </TableCell>
        <TableCell className="w-[100px] font-medium text-white select-text overflow-hidden">
          <div className="flex flex-col gap-0.5 min-w-0">
            <div className="flex items-center gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      onMetricClick?.('display');
                    }}
                    className="bg-card border border-border text-muted-foreground hover:text-white h-8 w-8 p-0"
                    aria-label="view displays"
                  >
                    <Monitor className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>view displays</p>
                </TooltipContent>
              </Tooltip>
              <span className="truncate">{machine.machineId}</span>
              {isMuted && <span title="alerts muted"><BellOff className="h-3 w-3 text-muted-foreground flex-shrink-0" /></span>}
            </div>
            {showLocalClock && machine.machineTimezone && localClock && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="text-[10px] text-muted-foreground/80 select-none cursor-help truncate ml-5">
                    {localTzShort}, {localClock}
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  <p className="max-w-xs">this machine&apos;s local time ({machine.machineTimezone}). schedule entries are interpreted in this timezone.</p>
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        </TableCell>
        <TableCell className="w-[72px] p-2">
          <MachineStatusPill
            online={machine.online}
            rebooting={machine.rebooting}
            shuttingDown={machine.shuttingDown}
            rebootScheduledAt={machine.rebootScheduledAt}
            shutdownScheduledAt={machine.shutdownScheduledAt}
            isAdmin={isAdmin}
            onCancel={onCancelReboot}
          />
        </TableCell>
        {/* CPU with Sparkline */}
        <TableCell
          className="text-white p-0 w-0 sm:w-[160px] overflow-hidden"
          onClick={(e) => { e.stopPropagation(); onMetricClick?.('cpu'); }}
        >
          <div className={`relative cursor-pointer hover:bg-muted/50 transition-colors overflow-hidden${staleClass}`}>
            <div className="opacity-80">
              <SparklineChart data={sparklineData.cpu} color="cpu" height={52} loading={sparklineData.loading} />
            </div>
            <div className={`absolute left-0 top-0 bottom-0 w-0.5 ${getUsageColorClass(cpuDevice?.percent ?? 0)}`} />
            <div className="absolute inset-0 flex items-center p-2 pl-2.5 overflow-hidden">
              {cpuDevice && typeof cpuDevice.percent === 'number' ? (
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-muted-foreground truncate" title={cpuDevice.model || 'Unknown CPU'}>
                    {cpuDevice.model || 'Unknown CPU'}
                  </div>
                  <div className="text-sm font-semibold whitespace-nowrap">
                    {cpuDevice.percent}%
                    {typeof cpuDevice.temperature === 'number' && (
                      <span className={`ml-1 text-xs font-medium ${getTemperatureColorClass(cpuDevice.temperature)}`}>
                        {formatTemperature(cpuDevice.temperature, userPreferences.temperatureUnit)}
                      </span>
                    )}
                  </div>
                </div>
              ) : '-'}
            </div>
          </div>
        </TableCell>
        {/* Memory with Sparkline */}
        <TableCell
          className="text-white p-0 w-0 sm:w-[120px] overflow-hidden"
          onClick={(e) => { e.stopPropagation(); onMetricClick?.('memory'); }}
        >
          <div className={`relative cursor-pointer hover:bg-muted/50 transition-colors overflow-hidden${staleClass}`}>
            <div className="opacity-80">
              <SparklineChart data={sparklineData.memory} color="memory" height={52} loading={sparklineData.loading} />
            </div>
            <div className={`absolute left-0 top-0 bottom-0 w-0.5 ${getUsageColorClass(memoryPercent)}`} />
            <div className="absolute inset-0 flex items-center p-2 pl-2.5 overflow-hidden">
              {machine.metrics?.memory && memoryUsedGb !== undefined ? (
                <div className="min-w-0">
                  <div className="text-sm font-semibold">{memoryPercent}%</div>
                  <div className="text-muted-foreground text-xs truncate">
                    {memoryTotalGb !== null
                      ? formatStorageRange(memoryUsedGb, memoryTotalGb)
                      : `${memoryUsedGb.toFixed(1)} GB`}
                  </div>
                </div>
              ) : '-'}
            </div>
          </div>
        </TableCell>
        {/* Disk with Sparkline */}
        <TableCell
          className="text-white p-0 w-0 lg:w-[160px] overflow-hidden"
          onClick={(e) => { e.stopPropagation(); onMetricClick?.('disk'); }}
        >
          <div className={`relative cursor-pointer hover:bg-muted/50 transition-colors overflow-hidden${staleClass}`}>
            <div className="opacity-80">
              <SparklineChart data={sparklineData.disk} color="disk" height={52} loading={sparklineData.loading} />
            </div>
            <div className={`absolute left-0 top-0 bottom-0 w-0.5 ${getUsageColorClass(diskDevice?.percent ?? 0)}`} />
            <div className="absolute inset-0 flex items-end gap-3 p-2 pl-2.5 overflow-hidden">
              {diskDevice && typeof diskDevice.percent === 'number' && typeof diskDevice.usedGb === 'number' ? (
                <>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold">{diskDevice.percent}%</div>
                    <div className="text-muted-foreground text-xs truncate" title={diskDevice.id}>
                      {typeof diskDevice.totalGb === 'number'
                        ? formatStorageRange(diskDevice.usedGb, diskDevice.totalGb)
                        : `${diskDevice.usedGb.toFixed(1)} GB`}
                    </div>
                  </div>
                  {(() => {
                    const io = machine.metrics?.diskio?.[diskDevice.id];
                    if (!io || (io.readBps === 0 && io.writeBps === 0)) return null;
                    return (
                      <div className="flex-shrink-0 flex gap-1 text-xs font-medium">
                        <div className="flex flex-col text-right">
                          <span style={{ color: DISK_IO_COLORS.read }}>r</span>
                          <span style={{ color: DISK_IO_COLORS.write }}>w</span>
                        </div>
                        <div className="flex flex-col text-left tabular-nums">
                          <span style={{ color: DISK_IO_COLORS.read }}>{formatDiskIO(io.readBps)}</span>
                          <span style={{ color: DISK_IO_COLORS.write }}>{formatDiskIO(io.writeBps)}</span>
                        </div>
                      </div>
                    );
                  })()}
                </>
              ) : '-'}
            </div>
          </div>
        </TableCell>
        {/* GPU with Sparkline */}
        <TableCell
          className="text-white p-0 w-0 lg:w-[200px] overflow-hidden"
          onClick={(e) => { e.stopPropagation(); onMetricClick?.('gpu'); }}
        >
          <div className={`relative cursor-pointer hover:bg-muted/50 transition-colors overflow-hidden${staleClass}`}>
            <div className="opacity-80">
              <SparklineChart data={sparklineData.gpu.length > 0 ? sparklineData.gpu : []} color="gpu" height={52} loading={sparklineData.loading} />
            </div>
            <div className={`absolute left-0 top-0 bottom-0 w-0.5 ${getUsageColorClass(gpuDevice?.usagePercent ?? 0)}`} />
            <div className="absolute inset-0 flex items-center p-2 pl-2.5 overflow-hidden">
              {gpuDevice && gpuDevice.name && gpuDevice.name !== 'N/A' && typeof gpuDevice.usagePercent === 'number' ? (
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-muted-foreground truncate" title={gpuDevice.name}>
                    {gpuDevice.name}
                  </div>
                  <div className="text-sm font-semibold whitespace-nowrap">
                    {gpuDevice.usagePercent}%
                    {typeof gpuDevice.vramUsedGb === 'number' && typeof gpuDevice.vramTotalGb === 'number' && (
                      <span className="text-muted-foreground text-xs ml-1 font-normal">
                        ({formatStorageRange(gpuDevice.vramUsedGb, gpuDevice.vramTotalGb)})
                      </span>
                    )}
                    {typeof gpuDevice.temperature === 'number' && (
                      <span className={`ml-1 text-xs font-medium ${getTemperatureColorClass(gpuDevice.temperature)}`}>
                        {formatTemperature(gpuDevice.temperature, userPreferences.temperatureUnit)}
                      </span>
                    )}
                  </div>
                </div>
              ) : (
                <span className="text-muted-foreground">N/A</span>
              )}
            </div>
          </div>
        </TableCell>
        {/* Network */}
        <TableCell
          className="text-white p-0 w-0 xl:w-[130px] overflow-hidden"
          onClick={(e) => {
            e.stopPropagation();
            if (nicDevice) onMetricClick?.(`${nicDevice.id}_tx_util` as MetricType);
          }}
        >
          {(() => {
            if (
              !nicDevice ||
              typeof nicDevice.txBps !== 'number' ||
              typeof nicDevice.rxBps !== 'number'
            ) {
              return <span className="text-muted-foreground text-xs p-2">-</span>;
            }
            const txUtil = nicDevice.txUtil ?? 0;
            const rxUtil = nicDevice.rxUtil ?? 0;
            const maxUtil = Math.max(txUtil, rxUtil);
            const linkSpeed = nicDevice.linkSpeedMbps;
            const titleText = typeof linkSpeed === 'number'
              ? `${nicDevice.id} (${linkSpeed} Mbps)`
              : nicDevice.id;
            return (
              <div className={`relative cursor-pointer hover:bg-muted/50 transition-colors overflow-hidden${staleClass}`}>
                <div className={`absolute left-0 top-0 bottom-0 w-0.5 ${getUsageColorClass(maxUtil)}`} />
                <div className="p-2 pl-2.5">
                  <div className="text-xs text-muted-foreground truncate" title={titleText}>
                    {nicDevice.id}
                  </div>
                  <div className="text-xs font-medium">
                    <span className="text-orange-400">{'\u2191 '}{formatThroughput(nicDevice.txBps)}</span>
                  </div>
                  <div className="text-xs font-medium">
                    <span className="text-green-400">{'\u2193 '}{formatThroughput(nicDevice.rxBps)}</span>
                  </div>
                </div>
              </div>
            );
          })()}
        </TableCell>
        <TableCell className="w-0 md:w-[150px] overflow-hidden p-0 md:p-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className={`text-xs flex items-center gap-1 cursor-help ${heartbeat.isStale ? 'text-red-400' : 'text-muted-foreground'}`}
              >
                <Clock className="h-3 w-3" />
                {heartbeat.display}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              <p>{heartbeat.tooltip}</p>
            </TooltipContent>
          </Tooltip>
        </TableCell>
        <TableCell className="w-10 p-2" onClick={(e) => e.stopPropagation()}>
          {!isDemo && (
            <MachineContextMenu
              machineId={machine.machineId}
              machineName={machine.machineId}
              machineTimezone={machine.machineTimezone}
              siteId={currentSiteId}
              isOnline={machine.online}
              isAdmin={isAdmin}
              rebooting={machine.rebooting}
              shuttingDown={machine.shuttingDown}
              onRemoveMachine={onRemoveMachine}
              onReboot={onReboot}
              onShutdown={onShutdown}
              onCancelReboot={onCancelReboot}
              onScreenshot={onScreenshot}
              onLiveView={onLiveView}
              rebootSchedule={machine.rebootSchedule}
            />
          )}
        </TableCell>
      </TableRow>

      {/* Expanded Process Details Row */}
      {isExpanded && (
        <TableRow key={`${machine.machineId}-processes`} className="border-border">
          <TableCell colSpan={10} className="p-0 overflow-hidden">
            <div className="pr-4 relative" style={{ paddingLeft: '12px', paddingTop: '8px', paddingBottom: '8px' }}>
              {machine.processes && machine.processes.length > 0 ? (
                <>
                  <div className="space-y-2">
                    {machine.processes.map((process, index) => (
                      <div key={process.id} className="relative flex items-stretch">
                        {/* Vertical line: from container top for first row, from row top for others */}
                        <div
                          className="absolute w-px bg-border/50"
                          style={{
                            left: '4px',
                            top: index === 0 ? '-8px' : 0,
                            height: index === 0 ? 'calc(50% + 8px)' : '50%'
                          }}
                        />
                        {/* Extension for non-last rows bridging the gap */}
                        {index < machine.processes!.length - 1 && (
                          <div className="absolute w-px bg-border/50" style={{ left: '4px', top: '50%', bottom: '-8px' }} />
                        )}
                        {/* Horizontal branch */}
                        <div className="relative w-5 flex-shrink-0">
                          <div className="absolute h-px bg-border/50" style={{ left: '4px', top: '50%', width: '12px' }} />
                          </div>
                          {/* Process card */}
                          <div className="flex-1 min-w-0 flex items-center justify-between p-3 rounded border border-border/50">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <Cog className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                              <span className="text-white font-medium truncate select-text">{process.name}</span>
                              <Badge className={`text-xs flex-shrink-0 select-none ${!machine.online ? 'bg-muted' : process.status === 'RUNNING' ? 'bg-green-600' : process.status === 'INACTIVE' ? 'bg-slate-600 text-slate-200' : process.status === 'LAUNCH_FAILED' || process.status === 'STOPPED' || process.status === 'KILLED' ? 'bg-red-600' : 'bg-yellow-600'}`}>
                                {(!machine.online ? 'unknown' : process.status === 'LAUNCH_FAILED' ? 'failed' : process.status).toLowerCase()}
                              </Badge>
                              {process.pid && <span className="text-xs text-muted-foreground flex-shrink-0 select-text">PID: {process.pid}</span>}
                            </div>
                            <div className="flex items-center gap-1.5 text-xs text-muted-foreground select-text min-w-0">
                              <span className="truncate" title={process.exe_path}>{process.exe_path}</span>
                              {process.file_path && (
                                <>
                                  <span className="flex-shrink-0 text-muted-foreground/70">›</span>
                                  <span className="truncate" title={process.file_path}>{process.file_path}</span>
                                </>
                              )}
                            </div>
                            {((process._optimisticLaunchMode ?? process.launch_mode) === 'scheduled') && (process._optimisticSchedules ?? process.schedules) && (process._optimisticSchedules ?? process.schedules)!.length > 0 && (
                              <div className="flex items-center gap-1.5 text-[11px] mt-0.5">
                                <Clock className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
                                <span className="truncate">
                                  {(process._optimisticSchedules ?? process.schedules)!.map((block, i) => {
                                    const colorIdx = block.colorIndex ?? i;
                                    const color = BLOCK_COLORS[colorIdx % BLOCK_COLORS.length];
                                    const summary = block.name || formatScheduleSummary([block], siteTimeFormat);
                                    return (
                                      <span key={i}>
                                        {i > 0 && <span className="text-muted-foreground"> · </span>}
                                        <span className={color.label}>{summary}</span>
                                      </span>
                                    );
                                  })}
                                </span>
                              </div>
                            )}
                          </div>
                          {(() => {
                            const currentMode = (process._optimisticLaunchMode ?? process.launch_mode ?? (process.autolaunch ? 'always' : 'off')) as LaunchMode;
                            return (
                              <>
                                {/* Desktop controls (lg+) */}
                                <div className="hidden lg:flex items-center gap-3 ml-4 flex-shrink-0">
                                  <div className="flex items-stretch rounded-md overflow-hidden border border-border h-8">
                                    {(['off', 'always', 'scheduled'] as const).map((mode) => {
                                      const isActive = currentMode === mode;
                                      const labels = { off: 'Off', always: 'Always On', scheduled: 'Scheduled' };
                                      const activeColors = {
                                        off: 'bg-muted text-foreground',
                                        always: 'bg-emerald-600 text-white',
                                        scheduled: 'bg-blue-600 text-white',
                                      };

                                      if (mode === 'scheduled') {
                                        return (
                                          <span key={mode} className={`flex items-stretch ${isActive ? 'bg-blue-600 text-white' : 'bg-card text-muted-foreground'}`}>
                                            <button
                                              onClick={() => !isActive && onSetLaunchMode(process.id, process.name, mode, process.exe_path)}
                                              className={`px-3 text-sm font-medium ${isActive ? 'cursor-default' : 'hover:bg-accent/50 cursor-pointer'} transition-colors`}
                                            >
                                              {labels[mode]}
                                            </button>
                                            <span className={`w-px ${isActive ? 'bg-blue-400/50' : 'bg-border'}`} />
                                            <Tooltip>
                                              <TooltipTrigger asChild>
                                                <button
                                                  onClick={() => onConfigureSchedule?.(process)}
                                                  className={`px-1.5 transition-colors cursor-pointer flex items-center ${isActive ? 'hover:bg-blue-500' : 'hover:bg-accent/50'}`}
                                                >
                                                  <Settings2 className="h-3.5 w-3.5" />
                                                </button>
                                              </TooltipTrigger>
                                              <TooltipContent>
                                                <p>configure schedule</p>
                                              </TooltipContent>
                                            </Tooltip>
                                          </span>
                                        );
                                      }

                                      return (
                                        <button
                                          key={mode}
                                          onClick={() => onSetLaunchMode(process.id, process.name, mode, process.exe_path)}
                                          className={`px-3 text-sm font-medium transition-all duration-500 cursor-pointer ${isActive ? activeColors[mode] : 'bg-card text-muted-foreground hover:bg-accent/50'}`}
                                        >
                                          {labels[mode]}
                                        </button>
                                      );
                                    })}
                                  </div>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => onEditProcess(process)}
                                    className="bg-card border border-border text-foreground"
                                  >
                                    <Pencil className="h-3 w-3 mr-1" />
                                    edit
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => onKillProcess(process.id, process.name)}
                                    className="bg-card border border-border text-red-400 hover:bg-red-950/50 hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-50"
                                    disabled={process.status !== 'RUNNING' && process.status !== 'LAUNCHING' && process.status !== 'STALLED'}
                                  >
                                    <Square className="h-3 w-3 mr-1" />
                                    kill
                                  </Button>
                                </div>
                                {/* Compact controls (<lg) */}
                                <div className="flex lg:hidden items-center gap-2 ml-2 flex-shrink-0">
                                  <DropdownMenu>
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <DropdownMenuTrigger asChild>
                                          <Button
                                            variant="ghost"
                                            size="sm"
                                            className="bg-card border border-border text-muted-foreground hover:text-white h-8 w-8 p-0"
                                          >
                                            <MoreVertical className="h-4 w-4" />
                                          </Button>
                                        </DropdownMenuTrigger>
                                      </TooltipTrigger>
                                      <TooltipContent>
                                        <p>more options</p>
                                      </TooltipContent>
                                    </Tooltip>
                                    <DropdownMenuContent align="end" className="border-border bg-secondary w-52">
                                      <DropdownMenuLabel className="text-muted-foreground text-xs">
                                        launch mode
                                      </DropdownMenuLabel>
                                      <DropdownMenuRadioGroup
                                        value={currentMode}
                                        onValueChange={(value) => {
                                          if (value !== currentMode) {
                                            onSetLaunchMode(process.id, process.name, value as LaunchMode, process.exe_path);
                                          }
                                        }}
                                      >
                                        <DropdownMenuRadioItem value="off" className="cursor-pointer">
                                          Off
                                        </DropdownMenuRadioItem>
                                        <DropdownMenuRadioItem value="always" className="text-emerald-400 cursor-pointer">
                                          Always On
                                        </DropdownMenuRadioItem>
                                        <DropdownMenuRadioItem value="scheduled" className="text-blue-400 cursor-pointer">
                                          Scheduled
                                        </DropdownMenuRadioItem>
                                      </DropdownMenuRadioGroup>
                                      <DropdownMenuItem
                                        onClick={() => onConfigureSchedule?.(process)}
                                        className="text-blue-400 focus:bg-blue-950/30 focus:text-blue-300 cursor-pointer pl-8"
                                      >
                                        <Settings2 className="mr-2 h-3.5 w-3.5" />
                                        configure schedule
                                      </DropdownMenuItem>
                                      <DropdownMenuSeparator className="bg-accent" />
                                      <DropdownMenuItem
                                        onClick={() => onEditProcess(process)}
                                        className="cursor-pointer"
                                      >
                                        <Pencil className="mr-2 h-3.5 w-3.5" />
                                        edit process
                                      </DropdownMenuItem>
                                    </DropdownMenuContent>
                                  </DropdownMenu>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => onKillProcess(process.id, process.name)}
                                        className="bg-card border border-border text-red-400 hover:bg-red-950/50 hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-50 h-8 w-8 p-0"
                                        disabled={process.status !== 'RUNNING' && process.status !== 'LAUNCHING' && process.status !== 'STALLED'}
                                      >
                                        <Square className="h-3 w-3" />
                                      </Button>
                                    </TooltipTrigger>
                                    <TooltipContent>
                                      <p>kill process</p>
                                    </TooltipContent>
                                  </Tooltip>
                                </div>
                              </>
                            );
                          })()}
                        </div>
                      </div>
                    ))}
                  </div>
                  {/* add process Button */}
                  <div className="flex justify-center pt-3">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={onCreateProcess}
                      className="bg-card border border-border text-accent-cyan hover:bg-accent-cyan/15 hover:text-accent-cyan"
                    >
                      <Plus className="h-3 w-3 mr-1" />
                      add process
                    </Button>
                  </div>
                </>
              ) : (
                <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
                  <p className="mb-4 text-sm">No processes configured for this machine</p>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={onCreateProcess}
                    className="bg-card border border-border text-accent-cyan hover:bg-accent-cyan/15 hover:text-accent-cyan"
                  >
                    <Plus className="h-3 w-3 mr-1" />
                    add process
                  </Button>
                </div>
              )}
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

export function MachineListView({
  machines,
  processesExpanded,
  currentSiteId,
  siteTimezone = 'UTC',
  siteTimeFormat = '12h',
  onToggleProcesses,
  onEditProcess,
  onCreateProcess,
  onKillProcess,
  onSetLaunchMode,
  onConfigureSchedule,
  onRemoveMachine,
  onMetricClick,
}: MachineListViewProps) {
  const { userPreferences } = useAuth();
  const { prefs, setListPref } = useDevicePrefs();
  const listPref = prefs.listView;
  const uniqueTimezones = new Set(machines.map(m => m.machineTimezone).filter(Boolean));
  const showLocalClock = uniqueTimezones.size > 1;

  // Union of device ids across visible machines — drives the column-header
  // dropdown menus. Memoized so the memoized table header doesn't re-render
  // on every metrics tick (only when the device set actually changes).
  const deviceUnion = useMemo<DeviceUnion>(() => ({
    cpus:  unionIds(machines.map(m => m.devices?.cpus?.map(c => c.id) ?? [])),
    disks: unionIds(machines.map(m => m.devices?.disks?.map(d => d.id) ?? [])),
    gpus:  unionIds(machines.map(m => m.devices?.gpus?.map(g => g.id) ?? [])),
    nics:  unionIds(machines.map(m => m.devices?.nics?.map(n => n.id) ?? [])),
  }), [machines]);

  // A dropdown is worth showing only when at least one visible machine has
  // more than one device of that kind — otherwise the selector would offer
  // nothing meaningful beyond "auto".
  const showDropdown = useMemo<ShowDropdownFlags>(() => ({
    cpu:  machines.some(m => (m.devices?.cpus?.length  ?? 0) > 1),
    disk: machines.some(m => (m.devices?.disks?.length ?? 0) > 1),
    gpu:  machines.some(m => (m.devices?.gpus?.length  ?? 0) > 1),
    nic:  machines.some(m => (m.devices?.nics?.length  ?? 0) > 1),
  }), [machines]);


  return (
    <div className="rounded-lg border border-border bg-background overflow-hidden">
      <Table className="table-fixed" style={{ contain: 'layout' }}>
        <MachineTableHeader
          deviceUnion={deviceUnion}
          showDropdown={showDropdown}
          listPref={listPref}
          setListPref={setListPref}
        />
        <TableBody>
          {machines.map((machine) => (
            <MachineRow
              key={machine.machineId}
              machine={machine}
              isExpanded={processesExpanded}
              currentSiteId={currentSiteId}
              siteTimezone={siteTimezone}
              siteTimeFormat={siteTimeFormat}
              userPreferences={userPreferences}
              onToggleExpanded={onToggleProcesses}
              onEditProcess={(process) => onEditProcess(machine.machineId, process)}
              onCreateProcess={() => onCreateProcess(machine.machineId)}
              onKillProcess={(processId, processName) => onKillProcess(machine.machineId, processId, processName)}
              onSetLaunchMode={(processId, processName, mode, exePath, schedules) =>
                onSetLaunchMode(machine.machineId, processId, processName, mode, exePath, schedules)
              }
              onConfigureSchedule={onConfigureSchedule ? (process) => onConfigureSchedule(machine.machineId, process) : undefined}
              onRemoveMachine={() => onRemoveMachine(machine.machineId, machine.machineId, machine.online)}
              onMetricClick={onMetricClick ? (metricType) => onMetricClick(machine.machineId, metricType) : undefined}
              showLocalClock={showLocalClock}
              listPref={listPref}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
