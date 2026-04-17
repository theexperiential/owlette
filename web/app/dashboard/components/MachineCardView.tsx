/**
 * MachineCardView Component
 *
 * Grid display of machines as cards showing metrics and processes.
 * Always shown on mobile, toggleable with list view on desktop.
 *
 * Features:
 * - Machine status (online/offline)
 * - System metrics (CPU, Memory, Disk, GPU) with sparkline charts
 * - Expandable process list
 * - Process controls (autolaunch, edit, kill)
 * - Create add process button
 * - Click sparklines to open detail panel
 *
 * Used by: Dashboard page for card view display
 */

import { useMinuteTick } from '@/hooks/useMinuteTick';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { MachineContextMenu } from '@/components/MachineContextMenu';
import { MachineStatusPill } from '@/components/MachineStatusPill';
import { useDemoContext } from '@/contexts/DemoContext';
import { SparklineChart } from '@/components/charts';
import { ChevronDown, ChevronUp, Pencil, Square, Plus, Clock, AlertTriangle, X, RotateCcw, Settings2, BellOff } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { formatTemperature, getTemperatureColorClass } from '@/lib/temperatureUtils';
import { getUsageColorClass, getUsageRingClass } from '@/lib/usageColorUtils';
import { formatHeartbeatTime, formatMachineLocalClock, formatTimezoneShortName, getDisplayTimezone } from '@/lib/timeUtils';
import { formatThroughput } from '@/lib/networkUtils';
import { DISK_IO_COLORS, formatDiskIO } from '@/lib/diskIOUtils';
import { useAllSparklineData } from '@/hooks/useSparklineData';
import { useDevicePrefs, type DeviceKind } from '@/hooks/useDevicePrefs';
import { useDisplayState } from '@/hooks/useDisplayState';
import { DisplayCanvas } from '@/components/charts/DisplayCanvas';
import { resolveDevice, shouldShowDeviceDropdown } from '@/lib/deviceResolvers';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { Machine, Process, LaunchMode, ScheduleBlock } from '@/hooks/useFirestore';
import type { MetricType } from '@/components/charts';

interface MachineCardViewProps {
  machines: Machine[];
  statsExpanded: boolean;
  processesExpanded: boolean;
  displaysExpanded?: boolean;
  onToggleStats: () => void;
  onToggleProcesses: () => void;
  onToggleDisplays?: () => void;
  currentSiteId: string;
  siteTimezone?: string;
  siteTimeFormat?: '12h' | '24h';
  onEditProcess: (machineId: string, process: Process) => void;
  onCreateProcess: (machineId: string) => void;
  onKillProcess: (machineId: string, processId: string, processName: string) => void;
  onSetLaunchMode: (machineId: string, processId: string, processName: string, mode: LaunchMode, exePath: string, schedules?: ScheduleBlock[] | null) => void;
  onConfigureSchedule?: (machineId: string, process: Process) => void;
  onRemoveMachine: (machineId: string, machineName: string, isOnline: boolean) => void;
  onMetricClick?: (machineId: string, metricType: MetricType) => void;
  onReboot?: (machineId: string) => Promise<void>;
  onShutdown?: (machineId: string) => Promise<void>;
  onCancelReboot?: (machineId: string) => Promise<void>;
  onDismissRebootPending?: (machineId: string, processName: string) => Promise<void>;
  onScreenshot?: (machineId: string) => void;
  onLiveView?: (machineId: string) => void;
}

/**
 * Individual machine card with sparkline support
 * Separated to allow hooks inside the map
 */
interface MachineCardProps {
  machine: Machine;
  statsExpanded: boolean;
  processesExpanded: boolean;
  displaysExpanded?: boolean;
  currentSiteId: string;
  siteTimezone: string;
  siteTimeFormat: '12h' | '24h';
  userPreferences: { temperatureUnit: 'C' | 'F' };
  isAdmin: boolean;
  cardPref: { cpu?: string; disk?: string; gpu?: string; nic?: string };
  onSetCardPref: (kind: DeviceKind, id: string | null) => void;
  onToggleStats: () => void;
  onToggleProcesses: () => void;
  onToggleDisplays?: () => void;
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
  onDismissRebootPending?: (processName: string) => Promise<void>;
  onScreenshot?: () => void;
  onLiveView?: () => void;
  showLocalClock?: boolean;
}

function MachineCard({
  machine,
  statsExpanded,
  processesExpanded,
  displaysExpanded,
  currentSiteId,
  siteTimezone,
  siteTimeFormat,
  userPreferences,
  isAdmin,
  cardPref,
  onSetCardPref,
  onToggleStats,
  onToggleProcesses,
  onToggleDisplays,
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
  onDismissRebootPending,
  onScreenshot,
  onLiveView,
  showLocalClock,
}: MachineCardProps) {
  const isDemo = !!useDemoContext();
  const { userPreferences: fullPrefs } = useAuth();
  const isMuted = fullPrefs.mutedMachines.includes(machine.machineId);

  // Fetch sparkline data for this machine
  const sparklineData = useAllSparklineData(currentSiteId, machine.machineId);

  // Live display topology (monitors + mosaic) for the displays collapsible.
  // Only subscribe when the displays section is explicitly expanded — a
  // 50-machine dashboard would otherwise open 100 Firestore listeners on
  // mount.
  const { profile: displayProfile } = useDisplayState(
    currentSiteId,
    machine.machineId,
    { enabled: displaysExpanded === true }
  );
  const displayMonitors = displayProfile?.monitors ?? [];
  const primaryMonitor =
    displayMonitors.find((m) => m.primary) ?? displayMonitors[0] ?? null;
  // Parent preference is the source of truth; default collapsed on first render.
  const effectiveDisplaysExpanded = displaysExpanded ?? false;

  // Format heartbeat time. The display tz is resolved per-machine according
  // to the user's chosen `timeDisplayMode` (preferences) — see getDisplayTimezone.
  const displayTz = getDisplayTimezone(
    fullPrefs.timeDisplayMode || 'machine',
    fullPrefs.timezone,
    machine.machineTimezone,
    siteTimezone
  );
  const heartbeat = formatHeartbeatTime(machine.lastHeartbeat, displayTz, siteTimeFormat);

  // Live-updating local clock for this machine's own timezone (under hostname).
  // Subscribing to the shared wall-clock minute tick re-renders this card
  // once per minute (in lockstep with every other machine card) so the
  // formatted clock string below stays current. One interval, app-wide.
  useMinuteTick();
  const localClock = formatMachineLocalClock(machine.machineTimezone, siteTimeFormat);
  const localTzShort = formatTimezoneShortName(machine.machineTimezone);

  // Resolve per-card device selection (user pref → primary → first).
  const primary = machine.metrics?.primary;
  const cpuDevice = resolveDevice(machine.devices?.cpus, cardPref.cpu, primary?.cpu);
  const diskDevice = resolveDevice(machine.devices?.disks, cardPref.disk, primary?.disk);
  const gpuDevice = resolveDevice(machine.devices?.gpus, cardPref.gpu, primary?.gpu);
  const nicDevice = resolveDevice(machine.devices?.nics, cardPref.nic, primary?.nic);

  const showCpuDropdown = shouldShowDeviceDropdown(machine.devices?.cpus);
  const showDiskDropdown = shouldShowDeviceDropdown(machine.devices?.disks);
  const showGpuDropdown = shouldShowDeviceDropdown(machine.devices?.gpus);
  const showNicDropdown = shouldShowDeviceDropdown(machine.devices?.nics);

  // Derive memory total from usedGb / (percent/100) when percent > 0. v2 agents
  // no longer send total_gb — the ratio is recoverable from the two fields we do
  // have. Guard against divide-by-zero / missing fields.
  const memory = machine.metrics?.memory;
  const memoryTotalGb =
    memory && memory.usedGb != null && memory.percent != null && memory.percent > 0
      ? memory.usedGb / (memory.percent / 100)
      : null;

  // Tiny shadcn Select helpers for the per-card device selectors.
  // Kept inline so they can close over machine + resolved device state.
  const renderDeviceSelect = (
    kind: DeviceKind,
    devices: { id: string }[],
    currentId: string | undefined,
    labelFor: (id: string) => string
  ) => (
    <Select
      value={currentId ?? 'auto'}
      onValueChange={(v) => onSetCardPref(kind, v === 'auto' ? null : v)}
    >
      <SelectTrigger
        size="sm"
        className="h-5 px-1.5 py-0 text-xs border-0 bg-transparent shadow-none gap-1 text-muted-foreground hover:text-foreground focus-visible:ring-0"
        onClick={(e) => e.stopPropagation()}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent onClick={(e) => e.stopPropagation()}>
        <SelectItem value="auto">auto (most active)</SelectItem>
        {devices.map((d) => (
          <SelectItem key={d.id} value={d.id}>{labelFor(d.id)}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  return (
    <Card className="border-border bg-card py-0 gap-0">
      <CardHeader className="py-3 px-4 gap-0">
        <div className="flex items-center justify-between">
          <div className="flex flex-col min-w-0">
            <CardTitle className="text-xl font-semibold text-white select-text flex items-center gap-1.5">
              {machine.machineId}
              {isMuted && <span title="alerts muted"><BellOff className="h-3.5 w-3.5 text-muted-foreground" /></span>}
            </CardTitle>
            {showLocalClock && machine.machineTimezone && localClock && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="text-xs text-muted-foreground mt-0.5 cursor-help select-none">
                    {localTzShort}, {localClock} local
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  <p className="max-w-xs">this machine&apos;s local time ({machine.machineTimezone}). schedule entries are interpreted in this timezone.</p>
                </TooltipContent>
              </Tooltip>
            )}
          </div>
          <div className="flex items-center gap-2">
            <MachineStatusPill
              online={machine.online}
              rebooting={machine.rebooting}
              shuttingDown={machine.shuttingDown}
              rebootScheduledAt={machine.rebootScheduledAt}
              shutdownScheduledAt={machine.shutdownScheduledAt}
              isAdmin={isAdmin}
              onCancel={onCancelReboot}
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className={`text-xs flex items-center gap-1 select-none cursor-help ${heartbeat.isStale ? 'text-red-400' : 'text-muted-foreground'}`}
                >
                  <Clock className="h-3 w-3" />
                  {heartbeat.display}
                </span>
              </TooltipTrigger>
              <TooltipContent>
                <p>{heartbeat.tooltip}</p>
              </TooltipContent>
            </Tooltip>
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
          </div>
        </div>
      </CardHeader>
      {/* Reboot Pending Banner */}
      {machine.rebootPending?.active && (
        <div className="mx-4 mb-2 p-3 rounded-lg border border-amber-600/30 bg-amber-950/20">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <AlertTriangle className="h-4 w-4 text-amber-400 flex-shrink-0" />
              <span className="text-sm text-amber-300 truncate">
                reboot pending: {machine.rebootPending.reason || 'process crashed'}
              </span>
            </div>
            {isAdmin && (
              <div className="flex items-center gap-1.5 flex-shrink-0">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2.5 text-xs bg-amber-600 hover:bg-amber-700 text-white cursor-pointer"
                  onClick={async (e) => {
                    e.stopPropagation();
                    if (onReboot) {
                      try { await onReboot(); } catch {}
                    }
                  }}
                >
                  <RotateCcw className="h-3 w-3 mr-1" />
                  approve
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2.5 text-xs text-muted-foreground hover:text-white hover:bg-accent cursor-pointer"
                  onClick={async (e) => {
                    e.stopPropagation();
                    if (onDismissRebootPending && machine.rebootPending?.processName) {
                      try { await onDismissRebootPending(machine.rebootPending.processName); } catch {}
                    }
                  }}
                >
                  <X className="h-3 w-3 mr-1" />
                  dismiss
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      {machine.metrics && (
        <Collapsible open={statsExpanded} onOpenChange={onToggleStats}>
          {!statsExpanded && (
            <CollapsibleTrigger asChild>
              <Button variant="ghost" className="w-full border-t border-border rounded-none hover:bg-secondary/30 cursor-pointer px-4 py-2.5 h-auto">
                <div className="flex items-center gap-2 w-full select-none">
                  <ChevronDown className="h-4 w-4 text-foreground/70 flex-shrink-0" />
                  <div className="flex items-center gap-2.5 text-sm text-muted-foreground overflow-hidden">
                    {cpuDevice && cpuDevice.percent != null && (
                      <span className="tabular-nums">cpu <span className="text-foreground font-medium">{cpuDevice.percent}%</span>
                        {cpuDevice.temperature != null && (
                          <span className={`ml-1 ${getTemperatureColorClass(cpuDevice.temperature)}`}>
                            {formatTemperature(cpuDevice.temperature, userPreferences.temperatureUnit)}
                          </span>
                        )}
                      </span>
                    )}
                    {memory?.percent != null && (
                      <>
                        <span className="text-border">|</span>
                        <span className="tabular-nums">mem <span className="text-foreground font-medium">{memory.percent}%</span></span>
                      </>
                    )}
                    {diskDevice && diskDevice.percent != null && (() => {
                      const io = machine.metrics?.diskio?.[diskDevice.id];
                      return (
                        <>
                          <span className="text-border">|</span>
                          <span className="tabular-nums">disk <span className="text-foreground font-medium">{diskDevice.percent}%</span>
                            {io && io.writeBps > 0 && (
                              <span className="ml-1 font-medium" style={{ color: DISK_IO_COLORS.write }}>
                                w {formatDiskIO(io.writeBps)}
                              </span>
                            )}
                          </span>
                        </>
                      );
                    })()}
                    {gpuDevice && gpuDevice.usagePercent != null && (
                      <>
                        <span className="text-border">|</span>
                        <span className="tabular-nums">gpu <span className="text-foreground font-medium">{gpuDevice.usagePercent}%</span>
                          {gpuDevice.temperature != null && (
                            <span className={`ml-1 ${getTemperatureColorClass(gpuDevice.temperature)}`}>
                              {formatTemperature(gpuDevice.temperature, userPreferences.temperatureUnit)}
                            </span>
                          )}
                        </span>
                      </>
                    )}
                    {machine.metrics.network?.latencyMs != null && (
                      <>
                        <span className="text-border">|</span>
                        <span className="tabular-nums">ping <span className={`font-medium ${
                          machine.metrics.network.latencyMs > 100 ? 'text-red-400' :
                          machine.metrics.network.latencyMs > 50 ? 'text-yellow-400' :
                          'text-foreground'
                        }`}>{Math.round(machine.metrics.network.latencyMs)}ms</span>
                          {(machine.metrics.network.packetLossPct ?? 0) > 0 && (
                            <span className="ml-1 text-red-400">{machine.metrics.network.packetLossPct}% loss</span>
                          )}
                        </span>
                      </>
                    )}
                  </div>
                </div>
              </Button>
            </CollapsibleTrigger>
          )}
          <CollapsibleContent>
        <CollapsibleTrigger asChild>
          <div className="border-t border-border relative cursor-pointer group">
            <div className="absolute inset-0 bg-gradient-to-b from-secondary to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
            <div className="relative flex items-center px-4 py-1.5 select-none">
              <ChevronUp className="h-4 w-4 text-foreground/50 group-hover:text-foreground/70 transition-colors flex-shrink-0" />
            </div>
          </div>
        </CollapsibleTrigger>
        <CardContent className="space-y-1.5 select-none pt-0 pb-4">
          {/* CPU Metric */}
          {cpuDevice && cpuDevice.percent != null && (
            <div
              className={`relative rounded-lg overflow-hidden cursor-pointer hover:ring-1 transition-all group ${getUsageRingClass(cpuDevice.percent)}`}
              onClick={onMetricClick ? () => onMetricClick('cpu') : undefined}
            >
              {/* Sparkline background */}
              <div className="absolute inset-0 opacity-80">
                <SparklineChart data={sparklineData.cpu} color="cpu" height={52} loading={sparklineData.loading} />
              </div>
              {/* Left accent bar - color based on usage */}
              <div className={`absolute left-0 top-0 bottom-0 w-1 ${getUsageColorClass(cpuDevice.percent)}`} />
              {/* Content */}
              <div className="relative z-10 flex items-center justify-between px-3 py-2.5 pl-4">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-sm font-medium text-muted-foreground">cpu</span>
                  <span className="text-xs text-muted-foreground truncate hidden sm:block" title={cpuDevice.model || cpuDevice.id}>
                    {cpuDevice.model || cpuDevice.id}
                  </span>
                  {showCpuDropdown && machine.devices?.cpus && (
                    renderDeviceSelect('cpu', machine.devices.cpus, cardPref.cpu, (id) => {
                      const d = machine.devices?.cpus.find(x => x.id === id);
                      return d?.model || id;
                    })
                  )}
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
                  <span className="text-lg font-bold text-white tabular-nums">{cpuDevice.percent}%</span>
                  {cpuDevice.temperature != null && (
                    <span className={`text-sm font-medium ${getTemperatureColorClass(cpuDevice.temperature)}`}>
                      {formatTemperature(cpuDevice.temperature, userPreferences.temperatureUnit)}
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Memory Metric */}
          {memory?.percent != null && (
            <div
              className={`relative rounded-lg overflow-hidden cursor-pointer hover:ring-1 transition-all group ${getUsageRingClass(memory.percent)}`}
              onClick={onMetricClick ? () => onMetricClick('memory') : undefined}
            >
              {/* Sparkline background */}
              <div className="absolute inset-0 opacity-80">
                <SparklineChart data={sparklineData.memory} color="memory" height={52} loading={sparklineData.loading} />
              </div>
              {/* Left accent bar - color based on usage */}
              <div className={`absolute left-0 top-0 bottom-0 w-1 ${getUsageColorClass(memory.percent)}`} />
              {/* Content */}
              <div className="relative z-10 flex items-center justify-between px-3 py-2.5 pl-4">
                <div className="flex items-center gap-3">
                  <span className="text-sm font-medium text-muted-foreground">memory</span>
                  {memory.usedGb != null && memoryTotalGb != null && (
                    <span className="text-xs text-muted-foreground hidden sm:block">
                      {memory.usedGb.toFixed(1)} / {memoryTotalGb.toFixed(1)} GB
                    </span>
                  )}
                </div>
                <span className="text-lg font-bold text-white tabular-nums">{memory.percent}%</span>
              </div>
            </div>
          )}

          {/* Disk Metric */}
          {diskDevice && diskDevice.percent != null && (
            <div
              className={`relative rounded-lg overflow-hidden cursor-pointer hover:ring-1 transition-all group ${getUsageRingClass(diskDevice.percent)}`}
              onClick={onMetricClick ? () => onMetricClick('disk') : undefined}
            >
              {/* Sparkline background */}
              <div className="absolute inset-0 opacity-80">
                <SparklineChart data={sparklineData.disk} color="disk" height={52} loading={sparklineData.loading} />
              </div>
              {/* Left accent bar - color based on usage */}
              <div className={`absolute left-0 top-0 bottom-0 w-1 ${getUsageColorClass(diskDevice.percent)}`} />
              {/* Content */}
              <div className="relative z-10 flex items-center justify-between px-3 py-2.5 pl-4">
                <div className="flex items-center gap-3">
                  <span className="text-sm font-medium text-muted-foreground">disk</span>
                  <span className="text-xs text-muted-foreground hidden sm:block">
                    {diskDevice.id}
                    {diskDevice.usedGb != null && diskDevice.totalGb != null && (
                      <> &nbsp;{diskDevice.usedGb.toFixed(1)} / {diskDevice.totalGb.toFixed(1)} GB</>
                    )}
                  </span>
                  {showDiskDropdown && machine.devices?.disks && (
                    renderDeviceSelect('disk', machine.devices.disks, cardPref.disk, (id) => id)
                  )}
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
                  {(() => {
                    const io = machine.metrics?.diskio?.[diskDevice.id];
                    if (!io || (io.readBps === 0 && io.writeBps === 0)) return null;
                    return (
                      <div className="flex flex-col items-end leading-tight">
                        <span className="text-xs font-medium tabular-nums" style={{ color: DISK_IO_COLORS.read }}>
                          r {formatDiskIO(io.readBps)}
                        </span>
                        <span className="text-xs font-medium tabular-nums" style={{ color: DISK_IO_COLORS.write }}>
                          w {formatDiskIO(io.writeBps)}
                        </span>
                      </div>
                    );
                  })()}
                  <span className="text-lg font-bold text-white tabular-nums">{diskDevice.percent}%</span>
                </div>
              </div>
            </div>
          )}

          {/* GPU Metric */}
          {gpuDevice && gpuDevice.usagePercent != null && (
            <div
              className={`relative rounded-lg overflow-hidden cursor-pointer hover:ring-1 transition-all group ${getUsageRingClass(gpuDevice.usagePercent)}`}
              onClick={onMetricClick ? () => onMetricClick('gpu') : undefined}
            >
              {/* Sparkline background */}
              {sparklineData.gpu.length > 0 && (
                <div className="absolute inset-0 opacity-80">
                  <SparklineChart data={sparklineData.gpu} color="gpu" height={52} loading={sparklineData.loading} />
                </div>
              )}
              {/* Left accent bar - color based on usage */}
              <div className={`absolute left-0 top-0 bottom-0 w-1 ${getUsageColorClass(gpuDevice.usagePercent)}`} />
              {/* Content */}
              <div className="relative z-10 flex items-center justify-between px-3 py-2.5 pl-4">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-sm font-medium text-muted-foreground">gpu</span>
                  <span className="text-xs text-muted-foreground truncate hidden sm:block" title={gpuDevice.name || gpuDevice.id}>
                    {gpuDevice.name || gpuDevice.id}
                  </span>
                  {showGpuDropdown && machine.devices?.gpus && (
                    renderDeviceSelect('gpu', machine.devices.gpus, cardPref.gpu, (id) => {
                      const d = machine.devices?.gpus.find(x => x.id === id);
                      return d?.name || id;
                    })
                  )}
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
                  <span className="text-lg font-bold text-white tabular-nums">{gpuDevice.usagePercent}%</span>
                  {gpuDevice.vramUsedGb != null && gpuDevice.vramTotalGb != null && gpuDevice.vramTotalGb > 0 && (
                    <span className="text-xs text-muted-foreground hidden md:block">
                      {gpuDevice.vramUsedGb.toFixed(1)}/{gpuDevice.vramTotalGb.toFixed(1)}GB
                    </span>
                  )}
                  {gpuDevice.temperature != null && (
                    <span className={`text-sm font-medium ${getTemperatureColorClass(gpuDevice.temperature)}`}>
                      {formatTemperature(gpuDevice.temperature, userPreferences.temperatureUnit)}
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Network Metric */}
          {nicDevice && nicDevice.txBps != null && nicDevice.rxBps != null && (() => {
            const maxUtil = Math.max(nicDevice.txUtil ?? 0, nicDevice.rxUtil ?? 0);
            return (
              <div
                className={`relative rounded-lg overflow-hidden cursor-pointer hover:ring-1 transition-all group ${getUsageRingClass(maxUtil)}`}
                onClick={onMetricClick ? () => onMetricClick(`${nicDevice.id}_tx_util` as MetricType) : undefined}
              >
                <div className={`absolute left-0 top-0 bottom-0 w-1 ${getUsageColorClass(maxUtil)}`} />
                <div className="relative z-10 flex items-center justify-between px-3 py-2.5 pl-4">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="text-sm font-medium text-muted-foreground">network</span>
                    <span className="text-xs text-muted-foreground truncate hidden sm:block" title={nicDevice.linkSpeedMbps ? `${nicDevice.id} (${nicDevice.linkSpeedMbps} Mbps)` : nicDevice.id}>
                      {nicDevice.id}
                    </span>
                    {showNicDropdown && machine.devices?.nics && (
                      renderDeviceSelect('nic', machine.devices.nics, cardPref.nic, (id) => id)
                    )}
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <span className="text-xs font-medium text-orange-400">{'\u2191 '}{formatThroughput(nicDevice.txBps)}</span>
                    <span className="text-xs font-medium text-green-400">{'\u2193 '}{formatThroughput(nicDevice.rxBps)}</span>
                  </div>
                </div>
              </div>
            );
          })()}
        </CardContent>
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* Displays Collapsible */}
      <Collapsible open={effectiveDisplaysExpanded} onOpenChange={onToggleDisplays}>
        {!effectiveDisplaysExpanded && (
          <CollapsibleTrigger asChild>
            <Button variant="ghost" className="w-full border-t border-border rounded-none hover:bg-secondary/30 cursor-pointer px-4 py-2.5 h-auto">
              <div className="flex items-center gap-2 w-full select-none">
                <ChevronDown className="h-4 w-4 text-foreground/70 flex-shrink-0" />
                {displayMonitors.length > 0 && primaryMonitor ? (
                  <div className="flex items-center gap-2.5 text-sm text-muted-foreground overflow-hidden">
                    <span className="tabular-nums">
                      <span className="text-foreground font-medium">{displayMonitors.length}</span> display{displayMonitors.length === 1 ? '' : 's'}
                    </span>
                    <span className="text-border">|</span>
                    <span className="truncate">
                      primary: <span className="text-foreground font-medium">{primaryMonitor.friendlyName || primaryMonitor.id}</span>
                      <span className="ml-1 tabular-nums">@ {primaryMonitor.resolution.width}x{primaryMonitor.resolution.height}</span>
                    </span>
                  </div>
                ) : (
                  <span className="text-muted-foreground text-sm">displays: no data</span>
                )}
              </div>
            </Button>
          </CollapsibleTrigger>
        )}
        <CollapsibleContent>
          <CollapsibleTrigger asChild>
            <div className="border-t border-border relative cursor-pointer group">
              <div className="absolute inset-0 bg-gradient-to-b from-secondary to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
              <div className="relative flex items-center px-4 py-1.5 select-none">
                <ChevronUp className="h-4 w-4 text-foreground/50 group-hover:text-foreground/70 transition-colors flex-shrink-0" />
              </div>
            </div>
          </CollapsibleTrigger>
          <div
            className={`px-4 pb-4 pt-2 ${onMetricClick ? 'cursor-pointer hover:bg-secondary/20 transition-colors' : ''}`}
            onClick={onMetricClick ? (e) => { e.stopPropagation(); onMetricClick('display'); } : undefined}
          >
            {displayMonitors.length > 0 ? (
              <>
                <DisplayCanvas
                  monitors={displayMonitors}
                  mosaicGrids={displayProfile?.mosaicGrids}
                  className="h-[120px]"
                />
                <div className="mt-2 space-y-0.5 text-xs text-muted-foreground">
                  {displayMonitors.map((m) => (
                    <div key={m.id} className="truncate">
                      {m.friendlyName || m.id} &middot; {m.resolution.width}x{m.resolution.height} @{m.refreshHz}hz{m.primary ? ' \u00b7 primary' : ''}
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="text-xs text-muted-foreground py-4 text-center">no display data reported</div>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* Expandable Process List */}
      {machine.processes && machine.processes.length > 0 && (
        <Collapsible open={processesExpanded} onOpenChange={onToggleProcesses}>
          {!processesExpanded && (
            <CollapsibleTrigger asChild>
              <Button variant="ghost" className="w-full border-t border-border rounded-none hover:bg-secondary/30 cursor-pointer px-4 py-2.5 h-auto">
                <div className="flex items-center gap-2 w-full select-none">
                  <ChevronDown className="h-4 w-4 text-foreground/70 flex-shrink-0" />
                  <span className="text-muted-foreground text-sm flex-shrink-0">
                    {machine.processes.length} process{machine.processes.length > 1 ? 'es' : ''}
                  </span>
                  <div className="flex items-center gap-3 overflow-hidden">
                    {machine.processes.map((proc) => (
                      <span key={proc.id} className="flex items-center gap-1 flex-shrink-0">
                        <span className="text-sm text-muted-foreground truncate max-w-[100px]">{proc.name}</span>
                        <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${
                          !machine.online ? 'bg-muted-foreground/40' :
                          proc.status === 'RUNNING' ? 'bg-green-500' :
                          proc.status === 'INACTIVE' ? 'bg-slate-500' :
                          proc.status === 'LAUNCH_FAILED' || proc.status === 'STOPPED' || proc.status === 'KILLED' ? 'bg-red-500' :
                          'bg-yellow-500'
                        }`} />
                      </span>
                    ))}
                  </div>
                </div>
              </Button>
            </CollapsibleTrigger>
          )}
          <CollapsibleContent>
            <CollapsibleTrigger asChild>
              <div className="border-t border-border relative cursor-pointer group">
                <div className="absolute inset-0 bg-gradient-to-b from-secondary to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                <div className="relative flex items-center px-4 py-2 select-none">
                  <ChevronUp className="h-4 w-4 text-foreground/50 group-hover:text-foreground/70 transition-colors flex-shrink-0" />
                </div>
              </div>
            </CollapsibleTrigger>
            <div className="relative px-2 pb-2 pt-0 md:px-4 md:pb-4 md:pt-0">
              <div className="space-y-2">
                {machine.processes.map((process, index) => (
                  <div key={process.id} className="relative flex items-stretch">
                    {/* Vertical line: from container top for first row, from row top for others */}
                    <div
                      className="absolute w-px bg-border/50"
                      style={{
                        left: '2px',
                        top: index === 0 ? '-8px' : 0,
                        height: index === 0 ? 'calc(50% + 8px)' : '50%'
                      }}
                    />
                    {/* Extension for non-last rows bridging the gap */}
                    {index < machine.processes!.length - 1 && (
                      <div className="absolute w-px bg-border/50" style={{ left: '2px', top: '50%', bottom: '-8px' }} />
                    )}
                    {/* Horizontal branch */}
                    <div className="relative w-4 flex-shrink-0">
                      <div className="absolute h-px bg-border/50" style={{ left: '2px', top: '50%', width: '10px' }} />
                    </div>
                    {/* Process card */}
                    <div className="flex-1 flex items-center justify-between p-2 md:p-3 rounded border border-border/50">
                        <div className="flex-1 min-w-0 flex items-center gap-2">
                          <span className="text-sm md:text-base text-white font-medium truncate select-text">{process.name}</span>
                          <Badge className={`text-xs flex-shrink-0 select-none ${!machine.online ? 'bg-muted' : process.status === 'RUNNING' ? 'bg-green-600' : process.status === 'INACTIVE' ? 'bg-slate-600 text-slate-200' : process.status === 'LAUNCH_FAILED' || process.status === 'STOPPED' || process.status === 'KILLED' ? 'bg-red-600' : 'bg-yellow-600'}`}>
                            {(!machine.online ? 'unknown' : process.status === 'LAUNCH_FAILED' ? 'failed' : process.status).toLowerCase()}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-2 md:gap-3 ml-2 md:ml-4 flex-shrink-0">
                          {(() => {
                            const currentMode = (process._optimisticLaunchMode ?? process.launch_mode ?? (process.autolaunch ? 'always' : 'off')) as LaunchMode;
                            return (
                              <div className="hidden md:flex items-stretch rounded-md overflow-hidden border border-border h-8">
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
                            );
                          })()}
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => onEditProcess(process)}
                            className="bg-card border border-border text-foreground p-2"
                          >
                            <Pencil className="h-3 w-3" />
                          </Button>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => onKillProcess(process.id, process.name)}
                                className="bg-card border border-border text-red-400 hover:bg-red-950/50 hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-50 p-2"
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
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* add process button for machines with no processes */}
      {(!machine.processes || machine.processes.length === 0) && (
        <div className="border-t border-border p-4">
          <Button
            variant="outline"
            size="sm"
            onClick={onCreateProcess}
            className="w-full bg-card border-border text-accent-cyan hover:bg-accent-cyan/20 hover:border-accent-cyan/40 cursor-pointer"
          >
            <Plus className="h-3 w-3 mr-1" />
            add process
          </Button>
        </div>
      )}
    </Card>
  );
}

export function MachineCardView({
  machines,
  statsExpanded,
  processesExpanded,
  displaysExpanded,
  onToggleStats,
  onToggleProcesses,
  onToggleDisplays,
  currentSiteId,
  siteTimezone = 'UTC',
  siteTimeFormat = '12h',
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
  onDismissRebootPending,
  onScreenshot,
  onLiveView,
}: MachineCardViewProps) {
  const { userPreferences, isAdmin } = useAuth();
  const { prefs, setCardPref } = useDevicePrefs();
  const uniqueTimezones = new Set(machines.map(m => m.machineTimezone).filter(Boolean));
  const showLocalClock = uniqueTimezones.size > 1;

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {machines.map((machine) => (
        <MachineCard
          key={machine.machineId}
          machine={machine}
          statsExpanded={statsExpanded}
          processesExpanded={processesExpanded}
          displaysExpanded={displaysExpanded}
          currentSiteId={currentSiteId}
          siteTimezone={siteTimezone}
          siteTimeFormat={siteTimeFormat}
          userPreferences={userPreferences}
          isAdmin={isAdmin}
          cardPref={prefs.cardView[machine.machineId] ?? {}}
          onSetCardPref={(kind, id) => setCardPref(machine.machineId, kind, id)}
          onToggleStats={onToggleStats}
          onToggleProcesses={onToggleProcesses}
          onToggleDisplays={onToggleDisplays}
          onEditProcess={(process) => onEditProcess(machine.machineId, process)}
          onCreateProcess={() => onCreateProcess(machine.machineId)}
          onKillProcess={(processId, processName) => onKillProcess(machine.machineId, processId, processName)}
          onSetLaunchMode={(processId, processName, mode, exePath, schedules) =>
            onSetLaunchMode(machine.machineId, processId, processName, mode, exePath, schedules)
          }
          onConfigureSchedule={onConfigureSchedule ? (process) => onConfigureSchedule(machine.machineId, process) : undefined}
          onRemoveMachine={() => onRemoveMachine(machine.machineId, machine.machineId, machine.online)}
          onMetricClick={onMetricClick ? (metricType) => onMetricClick(machine.machineId, metricType) : undefined}
          onReboot={onReboot ? () => onReboot(machine.machineId) : undefined}
          onShutdown={onShutdown ? () => onShutdown(machine.machineId) : undefined}
          onCancelReboot={onCancelReboot ? () => onCancelReboot(machine.machineId) : undefined}
          onDismissRebootPending={onDismissRebootPending ? (processName) => onDismissRebootPending(machine.machineId, processName) : undefined}
          onScreenshot={onScreenshot ? () => onScreenshot(machine.machineId) : undefined}
          onLiveView={onLiveView ? () => onLiveView(machine.machineId) : undefined}
          showLocalClock={showLocalClock}
        />
      ))}
    </div>
  );
}
