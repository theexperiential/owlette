'use client';

/**
 * RoostTargetsList — renders per-target sync status for an expanded
 * roost row on the /roosts page. Owns ONE `useTargetStates` listener
 * per expanded roost (parent RoostTargetRow is a pure render component)
 * so expanding N roosts mounts N listeners, not N×M.
 */

import React from 'react';
import { CheckCircle2, CircleDashed, Download, FileCog, Loader2, XCircle, Ban, AlertTriangle } from 'lucide-react';
import { useTargetStates, type TargetState, type TargetStatus } from '@/hooks/useTargetStates';

interface RoostTargetsListProps {
  siteId: string;
  roostId: string;
  currentManifestId: string | null;
  targets: string[];
}

interface RoostStatusPillProps {
  siteId: string;
  roostId: string;
  currentManifestId: string | null;
  targets: string[];
}

type RollupStatus =
  | 'synced'      // all targets committed for the current manifest
  | 'syncing'     // at least one target in-flight, none failed
  | 'partial'     // some targets synced, some still pending / in-flight
  | 'pending'     // no target has started yet
  | 'failed'      // at least one target reported failed
  | 'unreported'; // zero targets, or nothing reported + can't tell

interface StatusPresentation {
  label: string;
  className: string;
  icon: React.ComponentType<{ className?: string }>;
  spin?: boolean;
}

/**
 * When the agent's last report is for an OLD manifest, the machine is
 * really "pending" on the current rollout — surfacing a stale
 * `committed` for the prior manifest would mislead the operator into
 * thinking this deploy has landed.
 */
function effectiveStatus(
  state: TargetState | undefined,
  currentManifestId: string | null,
): TargetStatus | 'stale' | 'unreported' {
  if (!state || !state.status) return 'unreported';
  const isForCurrent =
    !!currentManifestId && state.reportedManifestId === currentManifestId;
  if (!isForCurrent) return 'stale';
  return state.status;
}

function presentation(status: TargetStatus | 'stale' | 'unreported'): StatusPresentation {
  switch (status) {
    case 'committed':
      return {
        label: 'synced',
        className: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
        icon: CheckCircle2,
      };
    case 'downloading':
      return {
        label: 'downloading',
        className: 'bg-accent-cyan/10 text-accent-cyan border-accent-cyan/30',
        icon: Download,
      };
    case 'assembling':
      return {
        label: 'assembling',
        className: 'bg-accent-cyan/10 text-accent-cyan border-accent-cyan/30',
        icon: FileCog,
      };
    case 'pending':
      return {
        label: 'queued',
        className: 'bg-muted text-muted-foreground border-border',
        icon: Loader2,
        spin: true,
      };
    case 'failed':
      return {
        label: 'failed',
        className: 'bg-red-500/10 text-red-400 border-red-500/30',
        icon: XCircle,
      };
    case 'cancelled':
      return {
        label: 'cancelled',
        className: 'bg-muted text-muted-foreground border-border',
        icon: Ban,
      };
    case 'stale':
      return {
        label: 'awaiting agent',
        className: 'bg-muted text-muted-foreground border-border',
        icon: CircleDashed,
      };
    case 'unreported':
    default:
      return {
        label: 'no report yet',
        className: 'bg-muted text-muted-foreground border-border',
        icon: CircleDashed,
      };
  }
}

function metricLine(
  state: TargetState | undefined,
  status: TargetStatus | 'stale' | 'unreported',
): string | null {
  if (!state) return null;
  if (status === 'downloading') {
    const total = state.chunksTotal ?? 0;
    const done = state.chunksFetched ?? 0;
    if (total > 0) return `${done}/${total} chunks`;
    return null;
  }
  if (status === 'assembling') {
    const total = state.filesTotal ?? 0;
    if (total > 0) return `${total} files`;
    return null;
  }
  if (status === 'committed') {
    const files = state.filesAssembled ?? 0;
    const dedup = state.chunksDedup ?? 0;
    const parts: string[] = [];
    if (files > 0) parts.push(`${files} file${files === 1 ? '' : 's'}`);
    if (dedup > 0) parts.push(`${dedup} dedup`);
    return parts.length ? parts.join(' · ') : null;
  }
  return null;
}

function TargetRow({
  machineId,
  currentManifestId,
  state,
}: {
  machineId: string;
  currentManifestId: string | null;
  state: TargetState | undefined;
}) {
  const status = effectiveStatus(state, currentManifestId);
  const pres = presentation(status);
  const metrics = metricLine(state, status);
  const Icon = pres.icon;

  return (
    <div className="flex items-center justify-between gap-3 py-1.5 px-3 rounded border border-border/40 bg-background/50">
      <span className="text-foreground text-sm select-text truncate min-w-0">{machineId}</span>
      <div className="flex items-center gap-2 flex-shrink-0">
        {metrics && (
          <span className="text-[11px] text-muted-foreground tabular-nums select-none">
            {metrics}
          </span>
        )}
        <span
          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${pres.className}`}
          title={state?.error ?? undefined}
        >
          <Icon className={`h-3 w-3 ${pres.spin ? 'animate-spin' : ''}`} />
          {pres.label}
        </span>
      </div>
    </div>
  );
}

/**
 * Aggregate per-machine states into a single rollup for the collapsed row.
 *
 * A report only counts for the current manifest — a prior `committed` for
 * an older manifest shouldn't make the new rollout look done.
 */
function rollup(
  targets: string[],
  currentManifestId: string | null,
  byMachine: Map<string, TargetState>,
): { status: RollupStatus; synced: number; total: number; failed: number; inFlight: number } {
  const total = targets.length;
  if (total === 0) {
    return { status: 'unreported', synced: 0, total: 0, failed: 0, inFlight: 0 };
  }
  let synced = 0;
  let failed = 0;
  let inFlight = 0; // downloading | assembling | pending
  let reported = 0;
  for (const mid of targets) {
    const s = byMachine.get(mid);
    if (!s || !s.status) continue;
    if (currentManifestId && s.reportedManifestId !== currentManifestId) continue;
    reported++;
    switch (s.status) {
      case 'committed':
        synced++;
        break;
      case 'failed':
        failed++;
        break;
      case 'downloading':
      case 'assembling':
      case 'pending':
        inFlight++;
        break;
    }
  }
  let status: RollupStatus;
  if (failed > 0) status = 'failed';
  else if (synced === total) status = 'synced';
  else if (inFlight > 0 && synced === 0) status = 'syncing';
  else if (inFlight > 0) status = 'partial';
  else if (reported === 0) status = 'pending';
  else status = 'partial';
  return { status, synced, total, failed, inFlight };
}

function rollupPresentation(status: RollupStatus): StatusPresentation {
  switch (status) {
    case 'synced':
      return {
        label: 'synced',
        className: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
        icon: CheckCircle2,
      };
    case 'syncing':
      return {
        label: 'syncing',
        className: 'bg-accent-cyan/10 text-accent-cyan border-accent-cyan/30',
        icon: Download,
      };
    case 'partial':
      return {
        label: 'partial',
        className: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
        icon: AlertTriangle,
      };
    case 'pending':
      return {
        label: 'queued',
        className: 'bg-muted text-muted-foreground border-border',
        icon: Loader2,
        spin: true,
      };
    case 'failed':
      return {
        label: 'failed',
        className: 'bg-red-500/10 text-red-400 border-red-500/30',
        icon: XCircle,
      };
    case 'unreported':
    default:
      return {
        label: 'no targets',
        className: 'bg-muted text-muted-foreground border-border',
        icon: CircleDashed,
      };
  }
}

/**
 * Compact status pill for the collapsed roost row. Mounts ONE listener
 * per roost (cheap — the target_state subcollection is small). Expanded
 * rows have their own `RoostTargetsList`; React keeps both hooks alive
 * when expanded so the snapshot is shared via Firestore's listener cache.
 */
export function RoostStatusPill({
  siteId,
  roostId,
  currentManifestId,
  targets,
}: RoostStatusPillProps) {
  const { states, loading } = useTargetStates(siteId, roostId);
  const byMachine = React.useMemo(() => {
    const m = new Map<string, TargetState>();
    for (const s of states) m.set(s.machineId, s);
    return m;
  }, [states]);
  const r = React.useMemo(
    () => rollup(targets, currentManifestId, byMachine),
    [targets, currentManifestId, byMachine],
  );

  // While the first snapshot is still in flight, render a neutral
  // placeholder rather than flashing "queued" → something-else.
  if (loading && targets.length > 0) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] bg-muted text-muted-foreground border-border">
        <Loader2 className="h-3 w-3 animate-spin" />
        checking
      </span>
    );
  }

  const pres = rollupPresentation(r.status);
  const Icon = pres.icon;
  // Show counts when partial / syncing / failed — they're informative.
  // For a clean "synced (3/3)" we also show on fully-synced so the
  // operator can confirm total targets at a glance.
  const showCount =
    r.total > 0 && (r.status === 'synced' || r.status === 'partial' || r.status === 'syncing' || r.status === 'failed');
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${pres.className}`}
    >
      <Icon className={`h-3 w-3 ${pres.spin ? 'animate-spin' : ''}`} />
      {pres.label}
      {showCount && (
        <span className="tabular-nums opacity-80">
          {r.synced}/{r.total}
        </span>
      )}
    </span>
  );
}

export function RoostTargetsList({
  siteId,
  roostId,
  currentManifestId,
  targets,
}: RoostTargetsListProps) {
  const { states } = useTargetStates(siteId, roostId);
  // Index by machineId so each row lookup is O(1). Rebuild only when
  // the snapshot changes — not on every parent render.
  const byMachine = React.useMemo(() => {
    const m = new Map<string, TargetState>();
    for (const s of states) m.set(s.machineId, s);
    return m;
  }, [states]);

  if (targets.length === 0) {
    return <p className="text-xs text-muted-foreground italic">no targets assigned</p>;
  }

  return (
    <div className="space-y-1.5">
      {targets.map((machineId) => (
        <TargetRow
          key={machineId}
          machineId={machineId}
          currentManifestId={currentManifestId}
          state={byMachine.get(machineId)}
        />
      ))}
    </div>
  );
}
