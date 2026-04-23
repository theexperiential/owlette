'use client';

/**
 * RoostTargetsList — renders per-target sync status for an expanded
 * roost row on the /roost page. Owns ONE `useTargetStates` listener
 * per expanded roost (parent RoostTargetRow is a pure render component)
 * so expanding N roosts mounts N listeners, not N×M.
 */

import React from 'react';
import { CheckCircle2, CircleDashed, Download, FileCog, Loader2, XCircle, Ban } from 'lucide-react';
import { useTargetStates, type TargetState, type TargetStatus } from '@/hooks/useTargetStates';

interface RoostTargetsListProps {
  siteId: string;
  roostId: string;
  currentManifestId: string | null;
  targets: string[];
}

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
