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

import React, { memo } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { MachineContextMenu } from '@/components/MachineContextMenu';
import { useDemoContext } from '@/contexts/DemoContext';
import { SparklineChart } from '@/components/charts';
import { ChevronDown, ChevronUp, Pencil, Square, Plus, Clock, Monitor, Cog, Settings2, MoreVertical } from 'lucide-react';
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
import { formatHeartbeatTime } from '@/lib/timeUtils';
import { formatThroughput, getPrimaryNic } from '@/lib/networkUtils';
import { useAllSparklineData } from '@/hooks/useSparklineData';
import type { Machine, Process, LaunchMode, ScheduleBlock } from '@/hooks/useFirestore';
import type { MetricType } from '@/components/charts';

// Memoized table header to prevent flickering on data updates
export const MemoizedTableHeader = memo(() => {
  return (
    <TableHeader className="sticky top-0 z-10 bg-background">
      <TableRow className="border-border hover:bg-transparent">
        <TableHead className="text-foreground w-8"></TableHead>
        <TableHead className="text-foreground w-[140px]">hostname</TableHead>
        <TableHead className="text-foreground w-[72px]">status</TableHead>
        <TableHead className="text-foreground w-0 overflow-hidden !px-0 sm:w-[160px] sm:overflow-visible sm:!px-2">cpu</TableHead>
        <TableHead className="text-foreground w-0 overflow-hidden !px-0 sm:w-[120px] sm:overflow-visible sm:!px-2">memory</TableHead>
        <TableHead className="text-foreground w-0 overflow-hidden !px-0 lg:w-[100px] lg:overflow-visible lg:!px-2">disk</TableHead>
        <TableHead className="text-foreground w-0 overflow-hidden !px-0 lg:w-[200px] lg:overflow-visible lg:!px-2">gpu</TableHead>
        <TableHead className="text-foreground w-0 overflow-hidden !px-0 xl:w-[130px] xl:overflow-visible xl:!px-2">network</TableHead>
        <TableHead className="text-foreground w-0 overflow-hidden !px-0 md:w-[110px] md:overflow-visible md:!px-2">last heartbeat</TableHead>
        <TableHead className="text-foreground w-10"></TableHead>
      </TableRow>
    </TableHeader>
  );
});

MemoizedTableHeader.displayName = 'MemoizedTableHeader';

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
  onScreenshot?: () => void;
  onLiveView?: () => void;
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
  onScreenshot,
  onLiveView,
}: MachineRowProps) {
  const isDemo = !!useDemoContext();
  const sparklineData = useAllSparklineData(currentSiteId, machine.machineId);

  // Format heartbeat time with timezone and time format support
  const heartbeat = formatHeartbeatTime(machine.lastHeartbeat, siteTimezone, siteTimeFormat);
  const isStale = !machine.online || !!machine.rebooting;
  const staleClass = isStale ? ' opacity-40' : '';

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
          <div className="flex items-center gap-2">
            <Monitor className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
            <span className="truncate">{machine.machineId}</span>
          </div>
        </TableCell>
        <TableCell className="w-[72px] p-2">
          <Badge className={`text-xs select-none ${
            machine.rebooting ? 'bg-amber-600' :
            machine.shuttingDown ? 'bg-amber-600' :
            machine.online ? 'bg-green-600' :
            'bg-red-600'
          }`}>
            {machine.rebooting ? 'rebooting...' :
             machine.shuttingDown ? 'shutting down...' :
             machine.online ? 'online' : 'offline'}
          </Badge>
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
            <div className={`absolute left-0 top-0 bottom-0 w-0.5 ${getUsageColorClass(machine.metrics?.cpu?.percent ?? 0)}`} />
            <div className="absolute inset-0 flex items-center p-2 pl-2.5 overflow-hidden">
              {machine.metrics?.cpu ? (
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-muted-foreground truncate" title={machine.metrics.cpu.name || 'Unknown CPU'}>
                    {machine.metrics.cpu.name || 'Unknown CPU'}
                  </div>
                  <div className="text-sm font-semibold whitespace-nowrap">
                    {machine.metrics.cpu.percent}%
                    {machine.metrics.cpu.temperature !== undefined && (
                      <span className={`ml-1 text-xs font-medium ${getTemperatureColorClass(machine.metrics.cpu.temperature)}`}>
                        {formatTemperature(machine.metrics.cpu.temperature, userPreferences.temperatureUnit)}
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
            <div className={`absolute left-0 top-0 bottom-0 w-0.5 ${getUsageColorClass(machine.metrics?.memory?.percent ?? 0)}`} />
            <div className="absolute inset-0 flex items-center p-2 pl-2.5 overflow-hidden">
              {machine.metrics?.memory ? (
                <div className="min-w-0">
                  <div className="text-sm font-semibold">{machine.metrics.memory.percent}%</div>
                  <div className="text-muted-foreground text-xs truncate">
                    {formatStorageRange(machine.metrics.memory.used_gb, machine.metrics.memory.total_gb)}
                  </div>
                </div>
              ) : '-'}
            </div>
          </div>
        </TableCell>
        {/* Disk with Sparkline */}
        <TableCell
          className="text-white p-0 w-0 lg:w-[100px] overflow-hidden"
          onClick={(e) => { e.stopPropagation(); onMetricClick?.('disk'); }}
        >
          <div className={`relative cursor-pointer hover:bg-muted/50 transition-colors overflow-hidden${staleClass}`}>
            <div className="opacity-80">
              <SparklineChart data={sparklineData.disk} color="disk" height={52} loading={sparklineData.loading} />
            </div>
            <div className={`absolute left-0 top-0 bottom-0 w-0.5 ${getUsageColorClass(machine.metrics?.disk?.percent ?? 0)}`} />
            <div className="absolute inset-0 flex items-center p-2 pl-2.5 overflow-hidden">
              {machine.metrics?.disk ? (
                <div className="min-w-0">
                  <div className="text-sm font-semibold">{machine.metrics.disk.percent}%</div>
                  <div className="text-muted-foreground text-xs truncate">
                    {formatStorageRange(machine.metrics.disk.used_gb, machine.metrics.disk.total_gb)}
                  </div>
                </div>
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
            <div className={`absolute left-0 top-0 bottom-0 w-0.5 ${getUsageColorClass(machine.metrics?.gpu?.usage_percent ?? 0)}`} />
            <div className="absolute inset-0 flex items-center p-2 pl-2.5 overflow-hidden">
              {machine.metrics?.gpu && machine.metrics.gpu.name && machine.metrics.gpu.name !== 'N/A' ? (
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-muted-foreground truncate" title={machine.metrics.gpu.name}>
                    {machine.metrics.gpu.name}
                  </div>
                  <div className="text-sm font-semibold whitespace-nowrap">
                    {machine.metrics.gpu.usage_percent}%
                    {machine.metrics.gpu.vram_used_gb !== undefined && machine.metrics.gpu.vram_total_gb && (
                      <span className="text-muted-foreground text-xs ml-1 font-normal">
                        ({formatStorageRange(machine.metrics.gpu.vram_used_gb, machine.metrics.gpu.vram_total_gb)})
                      </span>
                    )}
                    {machine.metrics.gpu.temperature !== undefined && (
                      <span className={`ml-1 text-xs font-medium ${getTemperatureColorClass(machine.metrics.gpu.temperature)}`}>
                        {formatTemperature(machine.metrics.gpu.temperature, userPreferences.temperatureUnit)}
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
            const primary = machine.metrics?.network?.interfaces
              ? getPrimaryNic(machine.metrics.network.interfaces)
              : null;
            if (primary) onMetricClick?.(`${primary.name}_tx_util` as MetricType);
          }}
        >
          {(() => {
            const interfaces = machine.metrics?.network?.interfaces;
            if (!interfaces) return <span className="text-muted-foreground text-xs p-2">-</span>;
            const primary = getPrimaryNic(interfaces);
            if (!primary) return <span className="text-muted-foreground text-xs p-2">-</span>;
            const maxUtil = Math.max(primary.data.tx_util, primary.data.rx_util);
            return (
              <div className={`relative cursor-pointer hover:bg-muted/50 transition-colors overflow-hidden${staleClass}`}>
                <div className={`absolute left-0 top-0 bottom-0 w-0.5 ${getUsageColorClass(maxUtil)}`} />
                <div className="p-2 pl-2.5">
                  <div className="text-xs text-muted-foreground truncate" title={`${primary.name} (${primary.data.link_speed} Mbps)`}>
                    {primary.name}
                  </div>
                  <div className="text-xs font-medium">
                    <span className="text-orange-400">TX {formatThroughput(primary.data.tx_bps)}</span>
                  </div>
                  <div className="text-xs font-medium">
                    <span className="text-green-400">RX {formatThroughput(primary.data.rx_bps)}</span>
                  </div>
                </div>
              </div>
            );
          })()}
        </TableCell>
        <TableCell className="w-0 md:w-[150px] overflow-hidden p-0 md:p-2">
          <span
            className={`text-xs flex items-center gap-1 cursor-default ${heartbeat.isStale ? 'text-red-400' : 'text-muted-foreground'}`}
            title={heartbeat.tooltip}
          >
            <Clock className="h-3 w-3" />
            {heartbeat.display}
          </span>
        </TableCell>
        <TableCell className="w-10 p-2" onClick={(e) => e.stopPropagation()}>
          {!isDemo && (
            <MachineContextMenu
              machineId={machine.machineId}
              machineName={machine.machineId}
              siteId={currentSiteId}
              isOnline={machine.online}
              isAdmin={isAdmin}
              onRemoveMachine={onRemoveMachine}
              onReboot={onReboot}
              onShutdown={onShutdown}
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
                            const isScheduled = currentMode === 'scheduled';
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
                                              className={`px-3 text-xs font-medium ${isActive ? 'cursor-default' : 'hover:bg-muted/50 cursor-pointer'} transition-colors`}
                                            >
                                              {labels[mode]}
                                            </button>
                                            <span className={`w-px ${isActive ? 'bg-blue-400/50' : 'bg-border'}`} />
                                            <button
                                              onClick={() => onConfigureSchedule?.(process)}
                                              className={`px-1.5 transition-colors cursor-pointer flex items-center ${isActive ? 'hover:bg-blue-500' : 'hover:bg-muted/50'}`}
                                              title="Configure schedule"
                                            >
                                              <Settings2 className="h-3.5 w-3.5" />
                                            </button>
                                          </span>
                                        );
                                      }

                                      return (
                                        <button
                                          key={mode}
                                          onClick={() => onSetLaunchMode(process.id, process.name, mode, process.exe_path)}
                                          className={`px-3 text-xs font-medium transition-all duration-500 cursor-pointer ${isActive ? activeColors[mode] : 'bg-card text-muted-foreground hover:bg-muted/50'}`}
                                        >
                                          {labels[mode]}
                                        </button>
                                      );
                                    })}
                                  </div>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => onEditProcess(process)}
                                    className="bg-card border-border text-foreground hover:bg-muted hover:border-foreground/40 cursor-pointer"
                                  >
                                    <Pencil className="h-3 w-3 mr-1" />
                                    edit
                                  </Button>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => onKillProcess(process.id, process.name)}
                                    className="bg-card border-border text-red-400 hover:bg-red-950 hover:border-red-700 hover:text-red-200 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
                                    disabled={process.status !== 'RUNNING' && process.status !== 'LAUNCHING' && process.status !== 'STALLED'}
                                  >
                                    <Square className="h-3 w-3 mr-1" />
                                    kill
                                  </Button>
                                </div>
                                {/* Compact controls (<lg) */}
                                <div className="flex lg:hidden items-center gap-2 ml-2 flex-shrink-0">
                                  <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        className="bg-card border-border text-muted-foreground hover:bg-muted hover:text-white cursor-pointer h-8 w-8 p-0"
                                      >
                                        <MoreVertical className="h-4 w-4" />
                                      </Button>
                                    </DropdownMenuTrigger>
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
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => onKillProcess(process.id, process.name)}
                                    className="bg-card border-border text-red-400 hover:bg-red-950 hover:border-red-700 hover:text-red-200 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 h-8 w-8 p-0"
                                    disabled={process.status !== 'RUNNING' && process.status !== 'LAUNCHING' && process.status !== 'STALLED'}
                                    title="kill"
                                  >
                                    <Square className="h-3 w-3" />
                                  </Button>
                                </div>
                              </>
                            );
                          })()}
                        </div>
                      </div>
                    ))}
                  </div>
                  {/* add process Button */}
                  <div className="flex justify-center pt-3 ml-4">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={onCreateProcess}
                      className="bg-card border-border text-accent-cyan hover:bg-accent-cyan/20 hover:border-accent-cyan/40 cursor-pointer"
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
                    variant="outline"
                    size="sm"
                    onClick={onCreateProcess}
                    className="bg-card border-border text-accent-cyan hover:bg-accent-cyan/20 hover:border-accent-cyan/40 cursor-pointer"
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

  return (
    <div className="rounded-lg border border-border bg-background overflow-hidden">
      <Table className="table-fixed" style={{ contain: 'layout' }}>
        <MemoizedTableHeader />
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
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
