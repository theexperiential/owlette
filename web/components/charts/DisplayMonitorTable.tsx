'use client';

/**
 * DisplayMonitorTable
 *
 * Compact table view of a machine's monitors. Replaces the per-monitor card
 * stack — denser, easier to scan when comparing values across monitors,
 * better fit for the canvas-on-left / data-on-right 50/50 layout.
 *
 * Columns: # | name | resolution @ refresh | scale (+ rotation) | position | port
 * Selection: row highlight in the active tab's accent color.
 * Drift: amber cell tinting per-field (resolution / scale / position).
 */

import { memo } from 'react';
import { Star } from 'lucide-react';
import { MonitorInfo } from '@/hooks/useDisplayState';
import { cn } from '@/lib/utils';

interface DisplayMonitorTableProps {
  monitors: MonitorInfo[];
  selectedMonitorId?: string;
  onSelect?: (id: string) => void;
  /**
   * Id of the monitor currently hovered in either this table or a linked
   * sibling view (e.g. DisplayCanvas). Drives a shared row highlight so
   * hovering a rect on the canvas lights up the matching row here.
   */
  hoveredMonitorId?: string;
  /** Fires on mouse enter/leave of a row — id is undefined on leave. */
  onHover?: (id: string | undefined) => void;
  accentColor: string;
  driftMap?: Map<string, string[]>;
}

/**
 * Map a rotation in degrees to Windows-style display orientation labels.
 * Matches the verbiage in Windows Settings → Display → Display orientation,
 * lowercased per the project copy convention.
 */
function orientationLabel(rotation: number): string {
  switch (rotation % 360) {
    case 90:
      return 'portrait';
    case 180:
      return 'landscape (flipped)';
    case 270:
      return 'portrait (flipped)';
    default:
      return 'landscape';
  }
}

/**
 * Effective panel dimensions on the virtual desktop, accounting for rotation.
 * Portrait orientations (90 / 270) swap the nominal width/height so the
 * displayed resolution matches what Windows treats the panel as.
 */
function effectiveResolution(monitor: MonitorInfo): { w: number; h: number } {
  const rot = monitor.rotation % 360;
  if (rot === 90 || rot === 270) {
    return { w: monitor.resolution.height, h: monitor.resolution.width };
  }
  return { w: monitor.resolution.width, h: monitor.resolution.height };
}

function DisplayMonitorTableImpl({
  monitors,
  selectedMonitorId,
  onSelect,
  hoveredMonitorId,
  onHover,
  accentColor,
  driftMap,
}: DisplayMonitorTableProps) {
  return (
    <div className="rounded-r-lg border border-border bg-secondary overflow-hidden h-[280px] overflow-y-auto">
      <table className="w-full text-xs">
        <thead className="text-[10px] text-muted-foreground bg-card sticky top-0 z-10">
          <tr className="border-b border-border">
            <th className="text-left font-medium py-1.5 pl-2 pr-1 w-6">#</th>
            <th className="text-left font-medium py-1.5 px-1">name</th>
            <th className="text-left font-medium py-1.5 px-1">resolution</th>
            <th className="text-left font-medium py-1.5 px-1">scale</th>
            <th className="text-left font-medium py-1.5 px-1">orientation</th>
            <th className="text-left font-medium py-1.5 px-1">position</th>
            <th className="text-left font-medium py-1.5 px-1 pr-2 w-10">port</th>
          </tr>
        </thead>
        <tbody>
          {monitors.map((monitor, idx) => {
            const drift = driftMap?.get(monitor.id) ?? [];
            const resolutionDrifted =
              drift.includes('resolution.width') ||
              drift.includes('resolution.height') ||
              drift.includes('refreshHz');
            const scaleDrifted = drift.includes('scalePct');
            const orientationDrifted = drift.includes('rotation');
            const xDrifted = drift.includes('position.x');
            const yDrifted = drift.includes('position.y');

            const isSelected = selectedMonitorId === monitor.id;
            const isHovered = hoveredMonitorId === monitor.id;
            const friendlyName = monitor.friendlyName || monitor.id;
            const effRes = effectiveResolution(monitor);

            return (
              <tr
                key={monitor.id}
                onClick={onSelect ? () => onSelect(monitor.id) : undefined}
                onMouseEnter={onHover ? () => onHover(monitor.id) : undefined}
                onMouseLeave={onHover ? () => onHover(undefined) : undefined}
                className={cn(
                  'border-b border-border last:border-b-0 transition-colors',
                  onSelect && 'cursor-pointer',
                  isSelected
                    ? 'bg-accent/30'
                    : isHovered && 'bg-accent/20',
                )}
                style={
                  isSelected
                    ? { boxShadow: `inset 3px 0 0 0 ${accentColor}` }
                    : undefined
                }
              >
                <td className="py-1.5 pl-2 pr-1 font-mono text-muted-foreground tabular-nums">
                  {idx + 1}
                </td>
                <td className="py-1.5 px-1">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span
                      className="font-medium text-foreground truncate"
                      title={friendlyName}
                    >
                      {friendlyName}
                    </span>
                    {monitor.primary && (
                      <Star
                        className="h-2.5 w-2.5 text-accent-warm fill-accent-warm shrink-0"
                        aria-label="primary"
                      />
                    )}
                  </div>
                </td>
                <td
                  className={cn(
                    'py-1.5 px-1 tabular-nums',
                    resolutionDrifted ? 'text-accent-coral' : 'text-foreground',
                  )}
                >
                  {effRes.w}×{effRes.h}
                  <span className="text-muted-foreground"> @{monitor.refreshHz}</span>
                </td>
                <td
                  className={cn(
                    'py-1.5 px-1 tabular-nums',
                    scaleDrifted ? 'text-accent-coral' : 'text-foreground',
                  )}
                >
                  {monitor.scalePct}%
                </td>
                <td
                  className={cn(
                    'py-1.5 px-1',
                    orientationDrifted ? 'text-accent-coral' : 'text-muted-foreground',
                  )}
                >
                  {orientationLabel(monitor.rotation)}
                </td>
                <td className="py-1.5 px-1 tabular-nums text-muted-foreground">
                  <span className={xDrifted ? 'text-accent-coral' : undefined}>
                    {monitor.position.x}
                  </span>
                  ,{' '}
                  <span className={yDrifted ? 'text-accent-coral' : undefined}>
                    {monitor.position.y}
                  </span>
                </td>
                <td className="py-1.5 px-1 pr-2 text-muted-foreground">
                  {monitor.connectionType}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export const DisplayMonitorTable = memo(DisplayMonitorTableImpl);
