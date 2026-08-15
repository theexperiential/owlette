'use client';

/**
 * One talon in the `/talons` list — a single dense row in an aligned-column
 * list: a chevron that expands recent history, the talon's name, what fires
 * it, what it does, where it runs, when it last ran, and per-action icon
 * buttons that each spin on their own.
 *
 * The columns are a CSS grid rather than a `<table>` for two reasons: the run
 * history expands as a natural full-width block *beneath* a row, and the
 * repo's fixed-table-layout rules (dashboard lists — content cannot grow a
 * declared column) would apply. Grid gets the same guarantee more cheaply, as
 * long as every text cell carries `min-w-0` + `truncate` and hands the full
 * value to a `title`.
 *
 * Mutations go through the api (`PATCH` / `DELETE` / `POST .../test`); the
 * list itself is a live `useTalons` subscription, so nothing here has to ask
 * the page to refetch — the write lands and the snapshot follows.
 *
 * talons wave 4.2.
 */

import { useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Eye,
  Loader2,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  Trash2,
} from 'lucide-react';

import ConfirmDialog from '@/components/ConfirmDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useAuth } from '@/contexts/AuthContext';
import type { Machine } from '@/hooks/useFirestore';
import { useTalonRuns } from '@/hooks/useTalonRuns';
import { toast } from '@/lib/toast';
import type {
  TalonCondition,
  TalonMetric,
  TalonOutput,
  TalonScheduleEntry,
  TalonScope,
  TalonTimestamp,
  TalonTrigger,
} from '@/lib/talons/types';

import { formatRelative, talonStatusIcon, TalonRunRow } from './TalonRunRow';

/** How many runs the expanded history shows. */
const RUN_HISTORY_LIMIT = 20;

/**
 * The one column definition the list header and every talon row share. Each
 * row is its own grid element, so the tracks only line up if they resolve
 * identically everywhere — which means **no `auto` tracks**: a header cell and
 * a four-button action cluster would size the same `auto` track differently
 * and skew every `fr` column after it. Every non-`fr` track here is a fixed
 * length for exactly that reason — the trailing `9.5rem` is sized off the four
 * `h-8 w-8` action buttons plus their gaps, with slack.
 *
 * Cells are placed by document order, so hiding one at a breakpoint shifts the
 * rest up a track. The three tiers below are therefore prefix-compatible:
 *
 *   `xl` (7): state · name · trigger · outputs · scope · last run · actions
 *   `lg` (6): scope drops out — it rides along as a suffix on `trigger`
 *   `md` (5): outputs drops out too — its chips move under the name
 *
 * Below `md` the grid never engages and rows fall back to the stacked layout.
 */
export const TALON_ROW_GRID =
  'md:grid md:items-center md:gap-x-3 ' +
  'md:grid-cols-[2.25rem_minmax(0,1fr)_minmax(0,1.5fr)_9.5rem_9.5rem] ' +
  'lg:grid-cols-[2.25rem_minmax(0,1fr)_minmax(0,1.35fr)_minmax(0,0.9fr)_9.5rem_9.5rem] ' +
  'xl:grid-cols-[2.25rem_minmax(0,1fr)_minmax(0,1.25fr)_minmax(0,0.9fr)_8rem_9.5rem_9.5rem]';

/**
 * A talon as the client sees it. Deliberately permissive past `id`, `name`,
 * and `enabled`: the documents arrive straight off a Firestore listener, so a
 * talon written by an older build has to render rather than throw.
 */
export interface TalonListItem {
  id: string;
  name: string;
  enabled: boolean;
  description?: string | null;
  trigger?: TalonTrigger | null;
  condition?: TalonCondition | null;
  outputs?: TalonOutput[] | null;
  scope?: TalonScope | null;
  cooldownMinutes?: number | null;
  lastRunAt?: TalonTimestamp | null;
  lastRunStatus?: string | null;
  consecutiveFailures?: number | null;
}

interface TalonCardProps {
  talon: TalonListItem;
  siteId: string;
  /** The site's machines — used to size the scope summary. */
  machines: Machine[];
  onEdit: () => void;
}

/* -------------------------------------------------------------------------- */
/*  summaries                                                                 */
/* -------------------------------------------------------------------------- */

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];
const WEEKENDS = ['sat', 'sun'];

const METRIC_LABELS: Record<TalonMetric, { label: string; unit: string }> = {
  cpu_percent: { label: 'cpu', unit: '%' },
  memory_percent: { label: 'memory', unit: '%' },
  disk_percent: { label: 'disk', unit: '%' },
  gpu_percent: { label: 'gpu', unit: '%' },
  cpu_temp: { label: 'cpu temp', unit: '°' },
  gpu_temp: { label: 'gpu temp', unit: '°' },
  network_latency: { label: 'latency', unit: 'ms' },
  network_packet_loss: { label: 'packet loss', unit: '%' },
};

/** `hoot` is the user-facing name for the assistant; `cortex` is the wire type. */
const OUTPUT_LABELS: Record<string, string> = {
  email: 'email',
  webhook: 'webhook',
  cortex: 'hoot',
  command: 'command',
};

function formatClock(time: string, use24h: boolean): string {
  const [rawHours, rawMinutes] = time.split(':').map(Number);
  if (!Number.isFinite(rawHours) || !Number.isFinite(rawMinutes)) return time;
  if (use24h) {
    return `${rawHours.toString().padStart(2, '0')}:${rawMinutes.toString().padStart(2, '0')}`;
  }
  const suffix = rawHours >= 12 ? 'pm' : 'am';
  const hours12 = rawHours % 12 || 12;
  return rawMinutes === 0
    ? `${hours12} ${suffix}`
    : `${hours12}:${rawMinutes.toString().padStart(2, '0')} ${suffix}`;
}

/**
 * Day grouping matching `formatScheduleSummary`'s vocabulary (daily /
 * weekdays / weekends / an explicit list). That helper itself takes
 * start–stop *ranges*; a talon schedule entry is a single instant, so it
 * would render `9 am–9 am`. Same words, right shape.
 */
function formatDays(days: string[]): string {
  if (days.length === 0 || days.length === 7) return 'daily';
  const sorted = [...days].sort();
  if (JSON.stringify(sorted) === JSON.stringify([...WEEKDAYS].sort())) return 'weekdays';
  if (JSON.stringify(sorted) === JSON.stringify([...WEEKENDS].sort())) return 'weekends';
  return days.join(', ');
}

function formatEntries(entries: TalonScheduleEntry[], use24h: boolean): string {
  if (entries.length === 0) return 'no schedule configured';
  return entries
    .map((entry) => `${formatDays(entry.days)} at ${formatClock(entry.time, use24h)}`)
    .join(' · ');
}

/** The one-line "what fires this" summary under the talon name. */
function formatTrigger(trigger: TalonTrigger | null | undefined, use24h: boolean): string {
  if (!trigger) return 'no trigger configured';
  switch (trigger.type) {
    case 'schedule':
      return typeof trigger.intervalMinutes === 'number'
        ? `every ${trigger.intervalMinutes} minutes`
        : formatEntries(trigger.entries ?? [], use24h);
    case 'threshold': {
      const metric = METRIC_LABELS[trigger.metric];
      return metric
        ? `${metric.label} ${trigger.operator} ${trigger.value}${metric.unit}`
        : `${trigger.metric} ${trigger.operator} ${trigger.value}`;
    }
    case 'event':
      return `on ${trigger.eventTypes.join(', ')}`;
    default:
      return 'no trigger configured';
  }
}

function formatOutput(output: TalonOutput): string {
  if (output.type === 'command') {
    return output.commandType.replace(/_/g, ' ');
  }
  return OUTPUT_LABELS[output.type] ?? output.type;
}

function formatScope(scope: TalonScope | null | undefined, machineCount: number): string {
  const ids = scope?.machineIds;
  if (!ids) return 'all machines';
  if (ids.length === 0) return 'no machines';
  return machineCount > 0
    ? `${ids.length} of ${machineCount} machines`
    : `${ids.length} machine${ids.length === 1 ? '' : 's'}`;
}

/** A run-status counter, e.g. `1 succeeded · 1 skipped`, for the re-run toast. */
function summarizeRuns(runs: Array<{ status?: string | null }>): string {
  const counts = new Map<string, number>();
  for (const run of runs) {
    const status = run.status ?? 'running';
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return [...counts.entries()].map(([status, count]) => `${count} ${status}`).join(' · ');
}

/* -------------------------------------------------------------------------- */
/*  cells                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The output type chips. Rendered in two places by design — as the `outputs`
 * column at `lg`+, and as a second line under the name below `lg`, where that
 * column has been dropped for width. Only one of the two is ever visible.
 */
function OutputChips({ outputs }: { outputs: TalonOutput[] }) {
  return (
    <>
      {outputs.map((output, index) => (
        <Badge
          key={`${output.type}-${index}`}
          variant="secondary"
          className="max-w-full px-1.5 text-[10px]"
        >
          <span className="min-w-0 truncate">{formatOutput(output)}</span>
        </Badge>
      ))}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  run history                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The expanded history. Split out so the subscription only exists while the
 * card is open, and so the card's refresh button can tear it down and
 * re-establish it by remounting on a changed `key`.
 */
function TalonRunList({ siteId, talonId }: { siteId: string; talonId: string }) {
  const { runs, loading, error } = useTalonRuns(siteId, talonId, RUN_HISTORY_LIMIT);

  if (loading && runs.length === 0) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return <p className="py-6 text-center text-xs text-red-400">{error}</p>;
  }

  if (runs.length === 0) {
    return (
      <p className="py-6 text-center text-xs text-muted-foreground">
        no runs yet. this talon has not fired since it was created.
      </p>
    );
  }

  return (
    <div className="space-y-1">
      {runs.map((run) => (
        <TalonRunRow key={run.id} run={run} />
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  card                                                                      */
/* -------------------------------------------------------------------------- */

export function TalonCard({ talon, siteId, machines, onEdit }: TalonCardProps) {
  const { userPreferences } = useAuth();
  const use24h = (userPreferences.timeFormat || '12h') === '24h';
  const [expanded, setExpanded] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  // Bumped by the refresh button — remounting the list drops and re-opens its
  // subscription, which is what "refresh" means for live data.
  const [runsKey, setRunsKey] = useState(0);

  const talonUrl = `/api/sites/${encodeURIComponent(siteId)}/talons/${encodeURIComponent(talon.id)}`;
  const outputs = talon.outputs ?? [];
  const failures = talon.consecutiveFailures ?? 0;
  const isVisualCheck = talon.condition?.type === 'visual_check';

  // Every column truncates, so each one also carries the full value as a
  // `title` — the list stays dense without hiding anything from the operator.
  const triggerSummary = formatTrigger(talon.trigger, use24h);
  const scopeSummary = formatScope(talon.scope, machines.length);
  const lastRunStatus = talon.lastRunStatus ?? null;
  const nameTitle = talon.description ? `${talon.name} — ${talon.description}` : talon.name;
  const lastRunTitle = `last run ${formatRelative(talon.lastRunAt)}${
    lastRunStatus ? ` · ${lastRunStatus}` : ''
  }`;

  async function handleToggleEnabled() {
    setBusyAction('enabled');
    try {
      const res = await fetch(talonUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !talon.enabled }),
      });
      if (res.ok) {
        toast.success(talon.enabled ? 'talon disabled' : 'talon enabled');
      } else {
        const data = (await res.json().catch(() => ({}))) as { detail?: string };
        toast.error(data.detail ?? 'failed to update talon');
      }
    } catch {
      toast.error('failed to update talon');
    }
    setBusyAction(null);
  }

  async function handleRerun() {
    setBusyAction('rerun');
    try {
      const res = await fetch(`${talonUrl}/test`, { method: 'POST' });
      const data = (await res.json().catch(() => ({}))) as {
        runs?: Array<{ status?: string | null }>;
        detail?: string;
      };
      if (res.ok) {
        const runs = data.runs ?? [];
        toast.success(`ran ${talon.name}`, {
          description: runs.length === 0 ? 'no machines in scope' : summarizeRuns(runs),
        });
        // Re-open the history so the fresh run is what the operator sees.
        setExpanded(true);
        setRunsKey((key) => key + 1);
      } else {
        toast.error(data.detail ?? 'failed to run talon');
      }
    } catch {
      toast.error('failed to run talon');
    }
    setBusyAction(null);
  }

  async function handleDelete() {
    setBusyAction('delete');
    try {
      const res = await fetch(talonUrl, { method: 'DELETE' });
      if (res.ok) {
        toast.success('talon deleted');
      } else {
        const data = (await res.json().catch(() => ({}))) as { detail?: string };
        toast.error(data.detail ?? 'failed to delete talon');
      }
    } catch {
      toast.error('failed to delete talon');
    }
    setBusyAction(null);
  }

  return (
    <div data-testid="talon-row">
      <div
        className={`flex items-start gap-3 px-3 py-2.5 transition-colors hover:bg-muted/50 dark:hover:bg-muted/30 ${TALON_ROW_GRID}`}
      >
        {/* (a) expand chevron + enabled state */}
        <div className="flex flex-shrink-0 items-center gap-1.5 pt-0.5 md:pt-0">
          <button
            type="button"
            onClick={() => setExpanded((open) => !open)}
            className="cursor-pointer text-muted-foreground hover:text-foreground"
            aria-label={expanded ? 'collapse run history' : 'expand run history'}
            aria-expanded={expanded}
          >
            {expanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </button>
          {/* Filled vs hollow, not just green vs grey — the state has to read
              without relying on colour alone. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                role="img"
                aria-label={talon.enabled ? 'enabled' : 'disabled'}
                className={`h-2 w-2 flex-shrink-0 rounded-full border ${
                  talon.enabled
                    ? 'border-green-500 bg-green-500'
                    : 'border-muted-foreground bg-transparent'
                }`}
              />
            </TooltipTrigger>
            <TooltipContent>{talon.enabled ? 'enabled' : 'disabled'}</TooltipContent>
          </Tooltip>
        </div>

        {/* Below `md` this is the stacked card's content column; at `md`+ it
            dissolves so cells (b)–(f) become grid items of the row itself. */}
        <div className="min-w-0 flex-1 md:contents">
          {/* (b) name */}
          <div className="flex min-w-0 flex-col">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-medium text-foreground" title={nameTitle}>
                {talon.name}
              </span>
              {failures > 0 && (
                <Badge
                  variant="outline"
                  className="flex-shrink-0 border-red-800 px-1.5 text-[10px] text-red-400"
                  title={`${failures} consecutive failure${failures === 1 ? '' : 's'}`}
                >
                  <AlertTriangle className="h-3 w-3" />
                  {failures}
                </Badge>
              )}
            </div>
            {talon.description && (
              <p className="mt-1 truncate text-xs text-muted-foreground md:hidden">
                {talon.description}
              </p>
            )}
            {/* The outputs column does not exist below `lg`; its chips live
                here instead so nothing is lost at those widths. */}
            {outputs.length > 0 && (
              <div className="mt-1.5 flex min-w-0 flex-wrap gap-1 lg:hidden">
                <OutputChips outputs={outputs} />
              </div>
            )}
          </div>

          {/* (c) trigger */}
          <div className="mt-1 flex min-w-0 items-center gap-1.5 md:mt-0">
            <span
              className="truncate text-xs text-muted-foreground"
              title={`${triggerSummary} · ${scopeSummary}`}
            >
              {triggerSummary}
              {/* Scope has no column of its own between `md` and `lg`. */}
              <span className="hidden md:inline xl:hidden"> · {scopeSummary}</span>
            </span>
            {isVisualCheck && (
              <Badge variant="secondary" className="flex-shrink-0 px-1.5 text-[10px]">
                <Eye className="h-3 w-3" />
                visual check
              </Badge>
            )}
          </div>

          {/* (d) outputs */}
          <div className="hidden min-w-0 flex-wrap items-center gap-1 lg:flex">
            {outputs.length > 0 ? (
              <OutputChips outputs={outputs} />
            ) : (
              <span className="truncate text-xs text-muted-foreground">no outputs</span>
            )}
          </div>

          {/* Below `md` scope and last run share one meta line, as they do
              today; at `md`+ this wrapper dissolves into columns (e) and (f). */}
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 md:contents">
            {/* (e) scope */}
            <span
              className="block min-w-0 truncate text-xs text-muted-foreground md:hidden xl:block"
              title={scopeSummary}
            >
              {scopeSummary}
            </span>

            {/* (f) last run */}
            <span
              className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
              title={lastRunTitle}
            >
              <span
                role="img"
                className="flex-shrink-0"
                aria-label={lastRunStatus ?? 'never run'}
              >
                {talonStatusIcon(lastRunStatus)}
              </span>
              <span className="truncate">
                <span className="md:hidden">last run </span>
                {formatRelative(talon.lastRunAt)}
              </span>
            </span>
          </div>
        </div>

        {/* (g) actions */}
        <div className="flex flex-shrink-0 items-center gap-1 md:justify-self-end">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="sm"
                variant="outline"
                data-testid="talon-rerun"
                onClick={handleRerun}
                disabled={busyAction !== null}
                aria-label={`run ${talon.name} now`}
                className="h-8 w-8 cursor-pointer border-border p-0"
              >
                {busyAction === 'rerun' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RotateCcw className="h-3.5 w-3.5" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>run now</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="sm"
                variant="outline"
                data-testid="talon-toggle"
                onClick={handleToggleEnabled}
                disabled={busyAction !== null}
                aria-label={talon.enabled ? `disable ${talon.name}` : `enable ${talon.name}`}
                className="h-8 w-8 cursor-pointer border-border p-0"
              >
                {busyAction === 'enabled' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : talon.enabled ? (
                  <Pause className="h-3.5 w-3.5" />
                ) : (
                  <Play className="h-3.5 w-3.5" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{talon.enabled ? 'disable' : 'enable'}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={onEdit}
                disabled={busyAction !== null}
                aria-label={`edit ${talon.name}`}
                className="h-8 w-8 cursor-pointer border-border p-0"
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>edit</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="sm"
                variant="outline"
                data-testid="talon-delete"
                onClick={() => setConfirmDeleteOpen(true)}
                disabled={busyAction !== null}
                aria-label={`delete ${talon.name}`}
                className="h-8 w-8 cursor-pointer border-border p-0 text-red-400 hover:bg-red-950 hover:text-red-300"
              >
                {busyAction === 'delete' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>delete</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* A sibling of the grid row rather than a cell in it: the history is a
          full-width block under the row, and keeping the grid single-row is
          what guarantees the columns resolve identically on every row. */}
      {expanded && (
        <div className="border-t border-border bg-muted/20 px-3 py-3 dark:bg-muted/10">
          <div className="mb-2 flex items-center justify-between">
            <h4 className="text-xs font-semibold tracking-wide text-foreground">recent runs</h4>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setRunsKey((key) => key + 1)}
              className="h-7 cursor-pointer border-border text-xs"
            >
              refresh
            </Button>
          </div>
          <TalonRunList key={runsKey} siteId={siteId} talonId={talon.id} />
        </div>
      )}

      <ConfirmDialog
        open={confirmDeleteOpen}
        onOpenChange={setConfirmDeleteOpen}
        title="delete talon?"
        description={`"${talon.name}" will stop running. its run history is kept for audit.`}
        confirmText="delete"
        cancelText="cancel"
        variant="destructive"
        onConfirm={handleDelete}
      />
    </div>
  );
}
