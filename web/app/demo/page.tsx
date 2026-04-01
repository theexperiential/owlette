'use client';

import { useState, useCallback, useMemo } from 'react';
import { LayoutGrid, List, Monitor, Cog, ChevronsUpDown, ChevronsDownUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Table, TableBody } from '@/components/ui/table';
import { PageHeader } from '@/components/PageHeader';
import { MetricsDetailPanel, type MetricType } from '@/components/charts';
import { MachineCardView } from '@/app/dashboard/components/MachineCardView';
import { MachineRow, MemoizedTableHeader as ListViewTableHeader } from '@/app/dashboard/components/MachineListView';
import { AddMachineButton } from '@/app/dashboard/components/AddMachineButton';
import { DemoContext } from '@/contexts/DemoContext';
import {
  DEMO_SITE_ID,
  DEMO_SITE,
  getDemoMachines,
  getDemoSparklineData,
  getDemoHistoricalData,
} from '@/lib/demo-data';

type ViewType = 'card' | 'list';

interface DetailPanelState {
  machineId: string;
  machineName: string;
  metric: MetricType;
}

// No-op async handler for required Promise-returning props
const noopAsync = async () => {};
// No-op sync handler
const noop = () => {};

export default function DemoPage() {
  const machines = useMemo(() => getDemoMachines(), []);
  const [viewType, setViewType] = useState<ViewType>('list');
  const [statsExpanded, setStatsExpanded] = useState(false);
  const [detailPanel, setDetailPanel] = useState<DetailPanelState | null>(null);

  // Per-row expand state — initialize all as collapsed
  const [expandedMachineIds, setExpandedMachineIds] = useState<Set<string>>(
    () => new Set()
  );

  const allExpanded = expandedMachineIds.size === machines.length;

  const toggleAllProcesses = useCallback(() => {
    setExpandedMachineIds(prev => {
      if (prev.size === machines.length) {
        setStatsExpanded(false);
        return new Set();
      }
      setStatsExpanded(true);
      return new Set(machines.map(m => m.machineId));
    });
  }, []);

  const toggleMachineExpanded = useCallback((machineId: string) => {
    setExpandedMachineIds(prev => {
      const next = new Set(prev);
      if (next.has(machineId)) next.delete(machineId);
      else next.add(machineId);
      return next;
    });
  }, []);

  const toggleStats = useCallback(() => setStatsExpanded(v => !v), []);

  const handleMetricClick = useCallback((machineId: string, metric: MetricType) => {
    const machine = machines.find(m => m.machineId === machineId);
    setDetailPanel({
      machineId,
      machineName: machine?.machineId || machineId,
      metric,
    });
  }, []);

  const sites = useMemo(() => [DEMO_SITE], []);
  const onlineMachines = machines.filter(m => m.online).length;
  const totalProcesses = machines.reduce((acc, m) => {
    return acc + (m.metrics?.processes ? Object.keys(m.metrics.processes).length : 0);
  }, 0);

  const demoContextValue = useMemo(() => ({
    isDemo: true as const,
    getSparklineData: getDemoSparklineData,
    getHistoricalData: getDemoHistoricalData,
  }), []);

  return (
    <DemoContext.Provider value={demoContextValue}>
      <div className="relative min-h-screen pb-24">
        {/* Header */}
        <PageHeader
          currentPage="dashboard"
          sites={sites}
          currentSiteId={DEMO_SITE_ID}
          onSiteChange={noop}
          onManageSites={noop}
          disableNav
        />

        {/* Demo banner */}
        <div className="bg-accent-cyan/10 border-b border-accent-cyan/20">
          <div className="mx-auto max-w-screen-2xl px-3 md:px-4 py-2">
            <p className="text-sm text-muted-foreground">
              you&apos;re viewing a demo with sample data
            </p>
          </div>
        </div>

        {/* Main content */}
        <main className="relative z-10 mx-auto max-w-screen-2xl p-3 md:p-4">
          {/* Welcome + stats */}
          <div className="mt-3 md:mt-2 mb-6 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div className="flex-1">
              <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground mb-1">
                welcome to owlette!
              </h2>
              <p className="text-sm md:text-base text-muted-foreground">
                keeping your pixels in good hands
              </p>
            </div>

            {/* Quick stats */}
            <div className="flex items-center gap-6 md:gap-8">
              <div className="flex items-center gap-2.5">
                <div className={`rounded-md p-1.5 ${onlineMachines > 0 ? 'bg-emerald-500/10 text-emerald-400' : 'bg-muted text-muted-foreground'}`}>
                  <Monitor className="h-4 w-4" />
                </div>
                <div>
                  <div className="flex items-baseline gap-0.5">
                    <span className={`text-xl font-bold ${onlineMachines > 0 ? 'text-emerald-400' : 'text-foreground'}`}>{onlineMachines}</span>
                    <span className="text-xs text-muted-foreground">/ {machines.length}</span>
                  </div>
                  <p className="text-[11px] text-muted-foreground leading-tight">online</p>
                </div>
              </div>

              <div className="h-8 w-px bg-border" />

              <div className="flex items-center gap-2.5">
                <div className="rounded-md p-1.5 bg-muted text-muted-foreground">
                  <Cog className="h-4 w-4" />
                </div>
                <div>
                  <div className="flex items-baseline gap-0.5">
                    <span className="text-xl font-bold text-foreground">{totalProcesses}</span>
                    <span className="text-xs text-muted-foreground">managed</span>
                  </div>
                  <p className="text-[11px] text-muted-foreground leading-tight">processes</p>
                </div>
              </div>
            </div>
          </div>

          {/* Metrics Detail Panel */}
          {detailPanel && (
            <div className="mb-6">
              <MetricsDetailPanel
                machineId={detailPanel.machineId}
                machineName={detailPanel.machineName}
                siteId={DEMO_SITE_ID}
                initialMetric={detailPanel.metric}
                onClose={() => setDetailPanel(null)}
              />
            </div>
          )}

          {/* Machines */}
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <h3 className="text-lg md:text-xl font-bold text-foreground">machines</h3>

              <div className="flex items-center gap-2">
                {/* Add Machine Button */}
                <AddMachineButton
                  currentSiteId={DEMO_SITE_ID}
                  currentSiteName={DEMO_SITE.name}
                />

                {/* Expand/Collapse All + View Toggle */}
                <div className="flex items-center gap-1 rounded-lg border border-border bg-muted p-1 select-none">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={toggleAllProcesses}
                    className="cursor-pointer text-muted-foreground hover:bg-secondary hover:text-foreground"
                    title={allExpanded ? 'collapse all' : 'expand all'}
                  >
                    {allExpanded ? <ChevronsDownUp className="h-4 w-4" /> : <ChevronsUpDown className="h-4 w-4" />}
                  </Button>
                  <div className="h-4 w-px bg-border" />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setViewType('card')}
                    className={`cursor-pointer ${viewType === 'card' ? 'bg-secondary text-accent-cyan' : 'text-muted-foreground hover:bg-secondary hover:text-foreground'}`}
                  >
                    <LayoutGrid className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setViewType('list')}
                    className={`cursor-pointer ${viewType === 'list' ? 'bg-secondary text-accent-cyan' : 'text-muted-foreground hover:bg-secondary hover:text-foreground'}`}
                  >
                    <List className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>

            {/* Card View */}
            {viewType === 'card' && (
              <div className="animate-in fade-in duration-300">
                <MachineCardView
                  machines={machines}
                  statsExpanded={statsExpanded}
                  processesExpanded={allExpanded}
                  onToggleStats={toggleStats}
                  onToggleProcesses={toggleAllProcesses}
                  currentSiteId={DEMO_SITE_ID}
                  siteTimezone={DEMO_SITE.timezone}
                  siteTimeFormat={DEMO_SITE.timeFormat}
                  onEditProcess={noop}
                  onCreateProcess={noop}
                  onKillProcess={noop}
                  onSetLaunchMode={noop}
                  onRemoveMachine={noop}
                  onMetricClick={handleMetricClick}
                  onReboot={noopAsync}
                  onShutdown={noopAsync}
                  onCancelReboot={noopAsync}
                  onDismissRebootPending={noopAsync}
                />
              </div>
            )}

            {/* List View */}
            {viewType === 'list' && (
              <div className="rounded-lg border border-border bg-card overflow-hidden animate-in fade-in duration-300">
                <Table style={{ contain: 'layout', tableLayout: 'fixed' }}>
                  <ListViewTableHeader />
                  <TableBody>
                    {machines.map((machine) => (
                      <MachineRow
                        key={machine.machineId}
                        machine={machine}
                        isExpanded={expandedMachineIds.has(machine.machineId)}
                        currentSiteId={DEMO_SITE_ID}
                        siteTimezone={DEMO_SITE.timezone}
                        siteTimeFormat={DEMO_SITE.timeFormat}
                        userPreferences={{ temperatureUnit: 'C' }}
                        isAdmin={false}
                        onToggleExpanded={() => toggleMachineExpanded(machine.machineId)}
                        onEditProcess={noop}
                        onCreateProcess={noop}
                        onKillProcess={noop}
                        onSetLaunchMode={noop}
                        onRemoveMachine={noop}
                        onMetricClick={(metricType) => handleMetricClick(machine.machineId, metricType)}
                      />
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        </main>
      </div>
    </DemoContext.Provider>
  );
}
