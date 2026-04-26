'use client';

/**
 * DisplayMonitorCard
 *
 * Per-monitor info card used by the display state view. Mirrors the stat-card
 * styling from MetricsDetailPanel (p-2 rounded-lg bg-secondary border with a
 * 3px colored left border). Parent is responsible for grid layout — this is a
 * single cell.
 */

import { memo } from 'react';
import { Star } from 'lucide-react';
import { MonitorInfo } from '@/hooks/useDisplayState';
import { cn } from '@/lib/utils';

interface DisplayMonitorCardProps {
  monitor: MonitorInfo;
  index: number;
  selected?: boolean;
  /**
   * Invoked with the monitor's id on click. Taking the id here (rather than a
   * zero-arg closure the parent has to rebuild per row) lets the parent pass a
   * single stable useCallback reference, which in turn makes React.memo on
   * this card actually skip re-renders for siblings that haven't changed.
   */
  onClick?: (id: string) => void;
  driftFields?: string[];
  /**
   * Color used for the 3px left border. Lets the parent push the active tab's
   * semantic color (live vs assigned) so the card row reads as a coherent
   * group instead of a rainbow of unrelated indices.
   */
  accentColor?: string;
  className?: string;
}

function DisplayMonitorCardImpl({
  monitor,
  index,
  selected = false,
  onClick,
  driftFields,
  accentColor = 'var(--primary)',
  className,
}: DisplayMonitorCardProps) {
  const isDrifted = (field: string) => driftFields?.includes(field) ?? false;

  const friendlyName = monitor.friendlyName ?? '';
  const manufacturerId = monitor.manufacturerId ?? '';
  const productCode = monitor.productCode ?? '';
  const hasMakeModel = manufacturerId.length > 0 || productCode.length > 0;
  const connectionType = monitor.connectionType ?? '';

  const resolutionDrifted =
    isDrifted('resolution.width') || isDrifted('resolution.height') || isDrifted('refreshHz');
  const scaleDrifted = isDrifted('scalePct') || isDrifted('rotation');
  const xDrifted = isDrifted('position.x');
  const yDrifted = isDrifted('position.y');
  const primaryDrifted = isDrifted('primary');

  return (
    <div
      className={cn(
        'p-2 rounded-lg bg-secondary border border-border',
        selected && 'bg-accent/20',
        onClick && 'cursor-pointer',
        className,
      )}
      style={{
        borderLeft: `3px solid ${accentColor}`,
        boxShadow: selected ? `0 0 0 1px ${accentColor}66` : undefined,
      }}
      onClick={onClick ? () => onClick(monitor.id) : undefined}
    >
      <div className="flex items-center gap-1.5 mb-0.5">
        <span className="text-xs font-mono bg-muted px-1 rounded">{index + 1}</span>
        {monitor.primary && (
          <Star
            className="h-3 w-3 text-accent-warm fill-accent-warm"
            aria-label="primary"
          />
        )}
        <span className="text-sm font-semibold text-foreground truncate">
          {friendlyName || 'unknown display'}
        </span>
        {connectionType && (
          <span className="text-[10px] bg-muted px-1 rounded ml-auto">
            {connectionType}
          </span>
        )}
      </div>

      {hasMakeModel && (
        <div className="text-xs text-muted-foreground">
          {[manufacturerId, productCode].filter(Boolean).join(' ')}
        </div>
      )}

      <div className={cn('text-xs', resolutionDrifted && 'text-amber-400')}>
        {monitor.resolution.width}x{monitor.resolution.height} @{monitor.refreshHz}hz
      </div>

      <div className={cn('text-xs', scaleDrifted && 'text-amber-400')}>
        scale {monitor.scalePct}%
        {monitor.rotation !== 0 && ` /${monitor.rotation}`}
      </div>

      <div className="text-xs text-muted-foreground">
        pos{' '}
        <span className={xDrifted ? 'text-amber-400' : undefined}>
          {monitor.position.x}
        </span>
        ,{' '}
        <span className={yDrifted ? 'text-amber-400' : undefined}>
          {monitor.position.y}
        </span>
        {monitor.primary && (
          <>
            {' \u00b7 '}
            <span className={primaryDrifted ? 'text-amber-400' : undefined}>
              primary
            </span>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Memoized export. Cards render inside a grid that rebuilds on unrelated
 * DisplayLayoutPanel state changes (tab switch, selection, write-action
 * spinners). Shallow prop equality lets us skip the full re-render when the
 * per-card data is stable. Callers must pass a stable `onClick` — see the
 * `handleMonitorClick` useCallback in DisplayLayoutPanel.
 */
export const DisplayMonitorCard = memo(DisplayMonitorCardImpl);
