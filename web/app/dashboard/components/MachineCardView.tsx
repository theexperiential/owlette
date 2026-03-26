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
 * - Create new process button
 * - Click sparklines to open detail panel
 *
 * Used by: Dashboard page for card view display
 */

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { MachineContextMenu } from '@/components/MachineContextMenu';
import { SparklineChart } from '@/components/charts';
import { ChevronDown, ChevronUp, Pencil, Square, Plus, Clock, AlertTriangle, X, RotateCcw, Settings2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { formatTemperature, getTemperatureColorClass } from '@/lib/temperatureUtils';
import { getUsageColorClass, getUsageRingClass } from '@/lib/usageColorUtils';
import { formatHeartbeatTime } from '@/lib/timeUtils';
import { formatThroughput, getPrimaryNic } from '@/lib/networkUtils';
import { useAllSparklineData } from '@/hooks/useSparklineData';
import type { Machine, Process, LaunchMode, ScheduleBlock } from '@/hooks/useFirestore';
import type { MetricType } from '@/components/charts';

interface MachineCardViewProps {
  machines: Machine[];
  statsExpanded: boolean;
  processesExpanded: boolean;
  onToggleStats: () => void;
  onToggleProcesses: () => void;
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
  currentSiteId: string;
  siteTimezone: string;
  siteTimeFormat: '12h' | '24h';
  userPreferences: { temperatureUnit: 'C' | 'F' };
  isAdmin: boolean;
  onToggleStats: () => void;
  onToggleProcesses: () => void;
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
}

function MachineCard({
  machine,
  statsExpanded,
  processesExpanded,
  currentSiteId,
  siteTimezone,
  siteTimeFormat,
  userPreferences,
  isAdmin,
  onToggleStats,
  onToggleProcesses,
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
}: MachineCardProps) {
  // Fetch sparkline data for this machine
  const sparklineData = useAllSparklineData(currentSiteId, machine.machineId);

  // Format heartbeat time with timezone and time format support
  const heartbeat = formatHeartbeatTime(machine.lastHeartbeat, siteTimezone, siteTimeFormat);

  return (
    <Card className="border-border bg-card py-0 gap-0">
      <CardHeader className="py-3 px-4 gap-0">
        <div className="flex items-center justify-between">
          <CardTitle className="text-xl font-semibold text-white select-text">{machine.machineId}</CardTitle>
          <div className="flex items-center gap-2">
            <Badge className={`select-none text-xs ${
              machine.rebooting ? 'bg-amber-600 hover:bg-amber-700' :
              machine.shuttingDown ? 'bg-amber-600 hover:bg-amber-700' :
              machine.online ? 'bg-green-600 hover:bg-green-700' :
              'bg-red-600 hover:bg-red-700'
            }`}>
              {machine.rebooting ? 'rebooting...' :
               machine.shuttingDown ? 'shutting down...' :
               machine.online ? 'online' : 'offline'}
            </Badge>
            {(machine.rebooting || machine.shuttingDown) && isAdmin && onCancelReboot && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs text-amber-400 hover:text-amber-300 hover:bg-amber-950/30 cursor-pointer"
                onClick={async (e) => {
                  e.stopPropagation();
                  try {
                    await onCancelReboot();
                  } catch {}
                }}
              >
                cancel
              </Button>
            )}
            <span
              className={`text-xs flex items-center gap-1 select-none cursor-default ${heartbeat.isStale ? 'text-red-400' : 'text-muted-foreground'}`}
              title={heartbeat.tooltip}
            >
              <Clock className="h-3 w-3" />
              {heartbeat.display}
            </span>
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
                    {machine.metrics.cpu && (
                      <span className="tabular-nums">cpu <span className="text-foreground font-medium">{machine.metrics.cpu.percent}%</span>
                        {machine.metrics.cpu.temperature !== undefined && (
                          <span className={`ml-1 ${getTemperatureColorClass(machine.metrics.cpu.temperature)}`}>
                            {formatTemperature(machine.metrics.cpu.temperature, userPreferences.temperatureUnit)}
                          </span>
                        )}
                      </span>
                    )}
                    <span className="text-border">|</span>
                    <span className="tabular-nums">mem <span className="text-foreground font-medium">{machine.metrics.memory?.percent}%</span></span>
                    <span className="text-border">|</span>
                    <span className="tabular-nums">disk <span className="text-foreground font-medium">{machine.metrics.disk?.percent}%</span></span>
                    {machine.metrics.gpu && (
                      <>
                        <span className="text-border">|</span>
                        <span className="tabular-nums">gpu <span className="text-foreground font-medium">{machine.metrics.gpu.usage_percent}%</span>
                          {machine.metrics.gpu.temperature !== undefined && (
                            <span className={`ml-1 ${getTemperatureColorClass(machine.metrics.gpu.temperature)}`}>
                              {formatTemperature(machine.metrics.gpu.temperature, userPreferences.temperatureUnit)}
                            </span>
                          )}
                        </span>
                      </>
                    )}
                    {machine.metrics.network?.latency_ms != null && (
                      <>
                        <span className="text-border">|</span>
                        <span className="tabular-nums">ping <span className={`font-medium ${
                          machine.metrics.network.latency_ms > 100 ? 'text-red-400' :
                          machine.metrics.network.latency_ms > 50 ? 'text-yellow-400' :
                          'text-foreground'
                        }`}>{Math.round(machine.metrics.network.latency_ms)}ms</span>
                          {(machine.metrics.network.packet_loss_pct ?? 0) > 0 && (
                            <span className="ml-1 text-red-400">{machine.metrics.network.packet_loss_pct}% loss</span>
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
          {machine.metrics.cpu && (
            <div
              className={`relative rounded-lg overflow-hidden cursor-pointer hover:ring-1 transition-all group ${getUsageRingClass(machine.metrics.cpu.percent)}`}
              onClick={onMetricClick ? () => onMetricClick('cpu') : undefined}
            >
              {/* Sparkline background */}
              <div className="absolute inset-0 opacity-80">
                <SparklineChart data={sparklineData.cpu} color="cpu" height={52} loading={sparklineData.loading} />
              </div>
              {/* Left accent bar - color based on usage */}
              <div className={`absolute left-0 top-0 bottom-0 w-1 ${getUsageColorClass(machine.metrics.cpu.percent)}`} />
              {/* Content */}
              <div className="relative z-10 flex items-center justify-between px-3 py-2.5 pl-4">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-sm font-medium text-muted-foreground">cpu</span>
                  <span className="text-xs text-muted-foreground truncate hidden sm:block" title={machine.metrics.cpu.name || 'Unknown'}>
                    {machine.metrics.cpu.name || 'Unknown'}
                  </span>
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
                  <span className="text-lg font-bold text-white tabular-nums">{machine.metrics.cpu.percent}%</span>
                  {machine.metrics.cpu.temperature !== undefined && (
                    <span className={`text-sm font-medium ${getTemperatureColorClass(machine.metrics.cpu.temperature)}`}>
                      {formatTemperature(machine.metrics.cpu.temperature, userPreferences.temperatureUnit)}
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Memory Metric */}
          <div
            className={`relative rounded-lg overflow-hidden cursor-pointer hover:ring-1 transition-all group ${getUsageRingClass(machine.metrics.memory?.percent ?? 0)}`}
            onClick={onMetricClick ? () => onMetricClick('memory') : undefined}
          >
            {/* Sparkline background */}
            <div className="absolute inset-0 opacity-80">
              <SparklineChart data={sparklineData.memory} color="memory" height={52} loading={sparklineData.loading} />
            </div>
            {/* Left accent bar - color based on usage */}
            <div className={`absolute left-0 top-0 bottom-0 w-1 ${getUsageColorClass(machine.metrics.memory?.percent ?? 0)}`} />
            {/* Content */}
            <div className="relative z-10 flex items-center justify-between px-3 py-2.5 pl-4">
              <div className="flex items-center gap-3">
                <span className="text-sm font-medium text-muted-foreground">memory</span>
                {machine.metrics.memory?.used_gb !== undefined && machine.metrics.memory?.total_gb !== undefined && (
                  <span className="text-xs text-muted-foreground hidden sm:block">
                    {machine.metrics.memory.used_gb.toFixed(1)} / {machine.metrics.memory.total_gb.toFixed(1)} GB
                  </span>
                )}
              </div>
              <span className="text-lg font-bold text-white tabular-nums">{machine.metrics.memory?.percent}%</span>
            </div>
          </div>

          {/* Disk Metric */}
          <div
            className={`relative rounded-lg overflow-hidden cursor-pointer hover:ring-1 transition-all group ${getUsageRingClass(machine.metrics.disk?.percent ?? 0)}`}
            onClick={onMetricClick ? () => onMetricClick('disk') : undefined}
          >
            {/* Sparkline background */}
            <div className="absolute inset-0 opacity-80">
              <SparklineChart data={sparklineData.disk} color="disk" height={52} loading={sparklineData.loading} />
            </div>
            {/* Left accent bar - color based on usage */}
            <div className={`absolute left-0 top-0 bottom-0 w-1 ${getUsageColorClass(machine.metrics.disk?.percent ?? 0)}`} />
            {/* Content */}
            <div className="relative z-10 flex items-center justify-between px-3 py-2.5 pl-4">
              <div className="flex items-center gap-3">
                <span className="text-sm font-medium text-muted-foreground">disk</span>
                {machine.metrics.disk?.used_gb !== undefined && machine.metrics.disk?.total_gb !== undefined && (
                  <span className="text-xs text-muted-foreground hidden sm:block">
                    {machine.metrics.disk.used_gb.toFixed(1)} / {machine.metrics.disk.total_gb.toFixed(1)} GB
                  </span>
                )}
              </div>
              <span className="text-lg font-bold text-white tabular-nums">{machine.metrics.disk?.percent}%</span>
            </div>
          </div>

          {/* GPU Metric */}
          {machine.metrics.gpu && (
            <div
              className={`relative rounded-lg overflow-hidden cursor-pointer hover:ring-1 transition-all group ${getUsageRingClass(machine.metrics.gpu.usage_percent ?? 0)}`}
              onClick={onMetricClick ? () => onMetricClick('gpu') : undefined}
            >
              {/* Sparkline background */}
              {sparklineData.gpu.length > 0 && (
                <div className="absolute inset-0 opacity-80">
                  <SparklineChart data={sparklineData.gpu} color="gpu" height={52} loading={sparklineData.loading} />
                </div>
              )}
              {/* Left accent bar - color based on usage */}
              <div className={`absolute left-0 top-0 bottom-0 w-1 ${getUsageColorClass(machine.metrics.gpu.usage_percent ?? 0)}`} />
              {/* Content */}
              <div className="relative z-10 flex items-center justify-between px-3 py-2.5 pl-4">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-sm font-medium text-muted-foreground">gpu</span>
                  <span className="text-xs text-muted-foreground truncate hidden sm:block" title={machine.metrics.gpu.name}>
                    {machine.metrics.gpu.name}
                  </span>
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
                  <span className="text-lg font-bold text-white tabular-nums">{machine.metrics.gpu.usage_percent}%</span>
                  {machine.metrics.gpu.vram_used_gb !== undefined && machine.metrics.gpu.vram_total_gb && (
                    <span className="text-xs text-muted-foreground hidden md:block">
                      {machine.metrics.gpu.vram_used_gb.toFixed(1)}/{machine.metrics.gpu.vram_total_gb.toFixed(1)}GB
                    </span>
                  )}
                  {machine.metrics.gpu.temperature !== undefined && (
                    <span className={`text-sm font-medium ${getTemperatureColorClass(machine.metrics.gpu.temperature)}`}>
                      {formatTemperature(machine.metrics.gpu.temperature, userPreferences.temperatureUnit)}
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Network Metric */}
          {(() => {
            const interfaces = machine.metrics?.network?.interfaces;
            if (!interfaces) return null;
            const primary = getPrimaryNic(interfaces);
            if (!primary) return null;
            const maxUtil = Math.max(primary.data.tx_util, primary.data.rx_util);
            return (
              <div
                className={`relative rounded-lg overflow-hidden cursor-pointer hover:ring-1 transition-all group ${getUsageRingClass(maxUtil)}`}
                onClick={onMetricClick ? () => onMetricClick(`${primary.name}_tx_util` as MetricType) : undefined}
              >
                <div className={`absolute left-0 top-0 bottom-0 w-1 ${getUsageColorClass(maxUtil)}`} />
                <div className="relative z-10 flex items-center justify-between px-3 py-2.5 pl-4">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="text-sm font-medium text-muted-foreground">network</span>
                    <span className="text-xs text-muted-foreground truncate hidden sm:block" title={`${primary.name} (${primary.data.link_speed} Mbps)`}>
                      {primary.name}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <span className="text-xs font-medium text-orange-400">TX {formatThroughput(primary.data.tx_bps)}</span>
                    <span className="text-xs font-medium text-green-400">RX {formatThroughput(primary.data.rx_bps)}</span>
                  </div>
                </div>
              </div>
            );
          })()}
        </CardContent>
          </CollapsibleContent>
        </Collapsible>
      )}

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
                          <Badge className={`text-xs flex-shrink-0 select-none ${!machine.online ? 'bg-muted hover:bg-muted' : process.status === 'RUNNING' ? 'bg-green-600 hover:bg-green-700' : process.status === 'INACTIVE' ? 'bg-slate-600 hover:bg-slate-600 text-slate-200' : process.status === 'LAUNCH_FAILED' || process.status === 'STOPPED' || process.status === 'KILLED' ? 'bg-red-600 hover:bg-red-700' : 'bg-yellow-600 hover:bg-yellow-700'}`}>
                            {(!machine.online ? 'unknown' : process.status === 'LAUNCH_FAILED' ? 'failed' : process.status).toLowerCase()}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-2 md:gap-3 ml-2 md:ml-4 flex-shrink-0">
                          {(() => {
                            const currentMode = (process._optimisticLaunchMode ?? process.launch_mode ?? (process.autolaunch ? 'always' : 'off')) as LaunchMode;
                            const isScheduled = currentMode === 'scheduled';
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

                                  if (mode === 'scheduled' && isScheduled) {
                                    return (
                                      <span key={mode} className="flex items-stretch bg-blue-600 text-white">
                                        <button
                                          onClick={() => {}}
                                          className="px-3 text-xs font-medium cursor-default"
                                        >
                                          {labels[mode]}
                                        </button>
                                        <span className="w-px bg-blue-400/50" />
                                        <button
                                          onClick={() => onConfigureSchedule?.(process)}
                                          className="px-1.5 hover:bg-blue-500 transition-colors cursor-pointer flex items-center"
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
                            );
                          })()}
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => onEditProcess(process)}
                            className="bg-card border-border text-foreground hover:bg-muted hover:border-border hover:text-white cursor-pointer p-2"
                            title="edit"
                          >
                            <Pencil className="h-3 w-3" />
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => onKillProcess(process.id, process.name)}
                            className="bg-card border-border text-red-400 hover:bg-red-900 hover:border-red-800 hover:text-red-200 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 p-2"
                            disabled={process.status !== 'RUNNING'}
                            title="kill"
                          >
                            <Square className="h-3 w-3" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                {/* new process Button */}
                <div className="flex justify-center pt-3 ml-3">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={onCreateProcess}
                    className="bg-card border-border text-accent-cyan hover:bg-accent-cyan/15 hover:border-accent-cyan/20 hover:text-accent-cyan cursor-pointer"
                  >
                    <Plus className="h-3 w-3 mr-1" />
                    new process
                  </Button>
                </div>
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* new process button for machines with no processes */}
      {(!machine.processes || machine.processes.length === 0) && (
        <div className="border-t border-border p-4">
          <Button
            variant="outline"
            size="sm"
            onClick={onCreateProcess}
            className="w-full bg-card border-border text-accent-cyan hover:bg-accent-cyan/15 hover:border-accent-cyan/20 hover:text-accent-cyan cursor-pointer"
          >
            <Plus className="h-3 w-3 mr-1" />
            new process
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
  onToggleStats,
  onToggleProcesses,
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

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {machines.map((machine) => (
        <MachineCard
          key={machine.machineId}
          machine={machine}
          statsExpanded={statsExpanded}
          processesExpanded={processesExpanded}
          currentSiteId={currentSiteId}
          siteTimezone={siteTimezone}
          siteTimeFormat={siteTimeFormat}
          userPreferences={userPreferences}
          isAdmin={isAdmin}
          onToggleStats={onToggleStats}
          onToggleProcesses={onToggleProcesses}
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
        />
      ))}
    </div>
  );
}
