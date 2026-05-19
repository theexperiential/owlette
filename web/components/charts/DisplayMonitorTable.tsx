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
 * Edit mode: when an operator opens the editor on the assigned tab, position /
 * orientation / scale / primary become editable as native widgets. Resolution
 * + refresh dropdowns are bound to the per-monitor supported lists from
 * `useDisplayModes` (wave A3.4) and only render when the catalogue has arrived.
 */

import { memo, useState } from 'react';
import { Star, TriangleAlert } from 'lucide-react';
import { MonitorInfo } from '@/hooks/useDisplayState';
import type { DisplayModeEntry } from '@/hooks/useDisplayModes';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

type MonitorUpdate = Partial<MonitorInfo>;

/**
 * Unique `(w, h)` pairs across the monitor's supported modes, in descending
 * order. The catalogue arrives already sorted (descending w, then h, then hz)
 * so the first time each `(w, h)` is seen is the order we want to emit.
 *
 * The monitor's current `{width, height}` is always appended if not already
 * present so an off-catalogue value (custom overclock, legacy config) stays
 * selectable — without this the Select would show no selection on entry and
 * look broken. A warning affordance for off-list picks ships in A3.5.
 */
function uniqueResolutionsForMonitor(
  modes: readonly DisplayModeEntry[],
  currentW: number,
  currentH: number,
): Array<{ w: number; h: number }> {
  const seen = new Set<string>();
  const out: Array<{ w: number; h: number }> = [];
  const add = (w: number, h: number) => {
    const key = `${w}x${h}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ w, h });
  };
  for (const m of modes) add(m.w, m.h);
  add(currentW, currentH);
  // Re-sort in case the current (w, h) was appended out of order.
  out.sort((a, b) => b.w - a.w || b.h - a.h);
  return out;
}

/**
 * Refresh rates valid for a specific `(w, h)` — descending. Mirrors the
 * resolution helper: always include the monitor's current `refreshHz` even
 * if the catalogue doesn't list it, so the Select never shows blank.
 */
function refreshesForResolution(
  modes: readonly DisplayModeEntry[],
  w: number,
  h: number,
  currentHz: number,
): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const m of modes) {
    if (m.w !== w || m.h !== h) continue;
    if (seen.has(m.hz)) continue;
    seen.add(m.hz);
    out.push(m.hz);
  }
  if (!seen.has(currentHz)) {
    out.push(currentHz);
    out.sort((a, b) => b - a);
  }
  return out;
}

interface DisplayMonitorTableProps {
  monitors: MonitorInfo[];
  selectedMonitorId?: string;
  onSelect?: (id: string) => void;
  /**
   * Fires when the user double-clicks a row. The panel wires this to the
   * `DisplayEditorDialog` so double-click opens the full monitor editor.
   * Only attached to non-editable cells so double-clicks inside editable
   * Selects (rotation / scale) are absorbed by the widget.
   */
  onRowDoubleClick?: (id: string) => void;
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
  /** When true, renders editable cells and fires onUpdateMonitor on changes. */
  editable?: boolean;
  onUpdateMonitor?: (id: string, partial: MonitorUpdate) => void;
  /**
   * Per-monitor catalogue of supported display modes, keyed by edidHash —
   * feed from `useDisplayModes(...).catalogue?.byEdidHash`. When present in
   * edit mode, the resolution + refresh cells become bound Selects. When
   * absent (catalogue still loading, or monitor not in the catalogue), the
   * cell falls back to the read-only "WxH @Hz" text.
   */
  modesByEdidHash?: Record<string, { modes: DisplayModeEntry[]; dpiScales: number[] }>;
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

const ROTATION_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 0, label: 'landscape' },
  { value: 90, label: 'portrait' },
  { value: 180, label: 'landscape (flipped)' },
  { value: 270, label: 'portrait (flipped)' },
];

// Common Windows DPI scales. Not every monitor supports every value, but
// Windows is forgiving — applying an unsupported scale clamps to the nearest
// supported. Full per-monitor filtering is A3.4 (mode catalogue).
const SCALE_OPTIONS = [100, 125, 150, 175, 200];

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

// Shared styles for in-table native inputs. Matches the dark theme and keeps
// the row compact; native controls get a lot for free (keyboard, a11y) at the
// cost of some styling ceiling — acceptable for an editor of this density.
const EDITABLE_CELL_BASE =
  'bg-card border border-border rounded px-1.5 py-0.5 text-xs text-foreground ' +
  'hover:border-accent focus:outline-none focus:ring-1 focus:ring-accent';

/**
 * Controlled numeric input that survives the two classic controlled-number
 * traps: typing a bare "-" to start a negative (Number("-") is NaN) and
 * clearing the field to retype (Number("") is 0 — which gets pushed back
 * as a 0 the user can't backspace over, producing "09" / "080" etc.).
 *
 * We keep the raw text in local state and only push to the parent when it
 * parses to a finite number. Empty string and a lone "-" are held locally
 * as in-flight edits, so the caret sees what the user typed instead of
 * React overwriting it. External prop changes (e.g. primary-drag shifting
 * this secondary under the operator) flow into `local` only when the input
 * isn't focused — so typing is never clobbered mid-edit. On blur, an
 * unparseable value reverts to the last committed number.
 */
interface NumericPositionInputProps {
  value: number;
  onCommit: (next: number) => void;
  ariaLabel: string;
  className: string;
}

function NumericPositionInput({
  value,
  onCommit,
  ariaLabel,
  className,
}: NumericPositionInputProps) {
  const [local, setLocal] = useState<string>(() => String(value));
  const [focused, setFocused] = useState(false);
  // Mirror of the last `value` prop we hydrated `local` from. When the prop
  // changes from outside (primary-drag shifts this secondary, reset-to-
  // assigned, etc.) we resync during render — skipped while focused so the
  // operator's in-flight typing survives. "setState during render" is the
  // canonical React pattern for this kind of prop-driven sync and avoids
  // the repo's `react-hooks/set-state-in-effect` rule.
  const [lastSyncedValue, setLastSyncedValue] = useState<number>(value);
  if (value !== lastSyncedValue) {
    setLastSyncedValue(value);
    if (!focused) setLocal(String(value));
  }

  return (
    <input
      type="number"
      inputMode="numeric"
      step={1}
      value={local}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        setFocused(false);
        const parsed = Number(e.target.value);
        if (e.target.value.trim() === '' || !Number.isFinite(parsed)) {
          setLocal(String(value));
          return;
        }
        // Windows virtual-desktop coordinates are integer pixels. Round on
        // blur so a user who typed `1.5` or `1e2` lands on a value the
        // agent can actually apply without producing phantom drift.
        const rounded = Math.round(parsed);
        if (rounded !== value) onCommit(rounded);
        setLocal(String(rounded));
      }}
      onChange={(e) => {
        const raw = e.target.value;
        setLocal(raw);
        // Hold transient states ("", "-") and *any* non-integer mid-typing
        // string locally without pushing a bogus number upstream. Commit
        // only fires when the buffer parses cleanly to an integer — so
        // `1.5` and `1e2` are held in the input, not committed, until the
        // onBlur path rounds them.
        if (raw === '' || raw === '-') return;
        const parsed = Number(raw);
        if (
          Number.isFinite(parsed) &&
          Number.isInteger(parsed) &&
          parsed !== value
        ) {
          onCommit(parsed);
        }
      }}
      onClick={(e) => e.stopPropagation()}
      className={className}
      aria-label={ariaLabel}
    />
  );
}

function DisplayMonitorTableImpl({
  monitors,
  selectedMonitorId,
  onSelect,
  onRowDoubleClick,
  hoveredMonitorId,
  onHover,
  accentColor,
  driftMap,
  editable = false,
  onUpdateMonitor,
  modesByEdidHash,
}: DisplayMonitorTableProps) {
  const canEdit = editable && !!onUpdateMonitor;

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

            const rowClick = onSelect ? () => onSelect(monitor.id) : undefined;
            const rowDblClick = onRowDoubleClick
              ? () => onRowDoubleClick(monitor.id)
              : undefined;
            // Keyboard activation for row selection. Guarded by
            // `e.target === e.currentTarget` so pressing Enter inside a
            // child input (orientation/scale/position) doesn't re-fire
            // selection on the row — only keypresses landing on the row
            // itself activate. Space also activates to match button-row
            // convention.
            const rowKeyDown = onSelect
              ? (e: React.KeyboardEvent<HTMLTableRowElement>) => {
                  if (e.target !== e.currentTarget) return;
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect(monitor.id);
                  }
                }
              : undefined;

            return (
              <tr
                key={monitor.id}
                tabIndex={onSelect ? 0 : undefined}
                aria-selected={onSelect ? isSelected : undefined}
                aria-label={onSelect ? friendlyName : undefined}
                onKeyDown={rowKeyDown}
                onMouseEnter={onHover ? () => onHover(monitor.id) : undefined}
                onMouseLeave={onHover ? () => onHover(undefined) : undefined}
                className={cn(
                  'border-b border-border last:border-b-0 transition-colors',
                  onSelect && !canEdit && 'cursor-pointer',
                  onSelect && 'focus:outline-none focus-visible:ring-1 focus-visible:ring-accent',
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
                <td
                  className="py-1.5 pl-2 pr-1 font-mono text-muted-foreground tabular-nums"
                  onClick={rowClick}
                  onDoubleClick={rowDblClick}
                >
                  {idx + 1}
                </td>
                <td
                  className="py-1.5 px-1"
                  onClick={rowClick}
                  onDoubleClick={rowDblClick}
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span
                      className="font-medium text-foreground truncate"
                      title={friendlyName}
                    >
                      {friendlyName}
                    </span>
                    {canEdit ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (!monitor.primary) {
                            onUpdateMonitor?.(monitor.id, { primary: true });
                          }
                        }}
                        disabled={monitor.primary}
                        title={
                          monitor.primary
                            ? 'primary monitor'
                            : 'mark as primary'
                        }
                        className={cn(
                          'shrink-0 transition-colors',
                          monitor.primary
                            ? 'text-accent-warm cursor-default'
                            : 'text-muted-foreground/50 hover:text-accent-warm',
                        )}
                      >
                        <Star
                          className={cn(
                            'h-3 w-3',
                            monitor.primary && 'fill-accent-warm',
                          )}
                          aria-label={monitor.primary ? 'primary' : 'set primary'}
                        />
                      </button>
                    ) : (
                      monitor.primary && (
                        <Star
                          className="h-2.5 w-2.5 text-accent-warm fill-accent-warm shrink-0"
                          aria-label="primary"
                        />
                      )
                    )}
                  </div>
                </td>
                <td
                  className={cn(
                    'py-1.5 px-1 tabular-nums',
                    resolutionDrifted ? 'text-amber-400' : 'text-foreground',
                  )}
                  onClick={canEdit ? undefined : rowClick}
                  onDoubleClick={canEdit ? undefined : rowDblClick}
                >
                  {(() => {
                    // Per-monitor modes from the catalogue. May be missing when
                    // the subscription hasn't landed yet, when the catalogue
                    // hasn't been built for this machine, or when this monitor
                    // is a mirror target that got deduped out of `byEdidHash`.
                    const monitorModes = modesByEdidHash?.[monitor.edidHash]?.modes;
                    const haveModes = !!monitorModes && monitorModes.length > 0;
                    if (!canEdit || !haveModes) {
                      // Read-only fallback — view mode OR modes catalogue not
                      // available yet. `effRes` shows the rotated dimensions
                      // (what the desktop sees); the underlying stored
                      // resolution is always the native panel orientation.
                      return (
                        <>
                          {effRes.w}×{effRes.h}
                          <span className="text-muted-foreground"> @{monitor.refreshHz}</span>
                        </>
                      );
                    }
                    const currentW = monitor.resolution.width;
                    const currentH = monitor.resolution.height;
                    const resolutions = uniqueResolutionsForMonitor(
                      monitorModes,
                      currentW,
                      currentH,
                    );
                    const refreshes = refreshesForResolution(
                      monitorModes,
                      currentW,
                      currentH,
                      monitor.refreshHz,
                    );
                    // [A3.5] Off-catalogue detection — signal to the operator
                    // when the current pick isn't something the driver
                    // advertises so the apply-at-your-own-risk implication is
                    // surfaced before they hit restore. Two independent flags
                    // so a matching resolution + non-matching refresh (valid
                    // at a different rate) shows only on the refresh widget.
                    const resolutionOffList = !monitorModes.some(
                      (m) => m.w === currentW && m.h === currentH,
                    );
                    const refreshOffList = !monitorModes.some(
                      (m) =>
                        m.w === currentW &&
                        m.h === currentH &&
                        m.hz === monitor.refreshHz,
                    );
                    return (
                      <div className="flex items-center gap-1">
                        <select
                          value={`${currentW}x${currentH}`}
                          onChange={(e) => {
                            const [wRaw, hRaw] = e.target.value.split('x');
                            const w = Number(wRaw);
                            const h = Number(hRaw);
                            // Snap the refresh rate to the highest that the
                            // newly-selected resolution supports — dropping
                            // to 60Hz on a res switch feels worse than
                            // preserving the operator's intent where valid.
                            const candidateRefreshes = refreshesForResolution(
                              monitorModes,
                              w,
                              h,
                              monitor.refreshHz,
                            );
                            const keepHz =
                              candidateRefreshes.includes(monitor.refreshHz)
                                ? monitor.refreshHz
                                : candidateRefreshes[0] ?? monitor.refreshHz;
                            onUpdateMonitor?.(monitor.id, {
                              resolution: { width: w, height: h },
                              refreshHz: keepHz,
                            });
                          }}
                          onClick={(e) => e.stopPropagation()}
                          className={cn(EDITABLE_CELL_BASE, 'tabular-nums')}
                          aria-label="resolution"
                        >
                          {resolutions.map(({ w, h }) => (
                            <option key={`${w}x${h}`} value={`${w}x${h}`}>
                              {w}×{h}
                            </option>
                          ))}
                        </select>
                        {resolutionOffList && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <TriangleAlert
                                className="h-3 w-3 text-accent-warm shrink-0 cursor-help"
                                aria-label="resolution not in the supported list"
                              />
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>
                                {currentW}×{currentH} isn&apos;t in this monitor&apos;s supported list — apply at your own risk
                              </p>
                            </TooltipContent>
                          </Tooltip>
                        )}
                        <span className="text-muted-foreground text-[10px] select-none">@</span>
                        <select
                          value={monitor.refreshHz}
                          onChange={(e) =>
                            onUpdateMonitor?.(monitor.id, {
                              refreshHz: Number(e.target.value),
                            })
                          }
                          onClick={(e) => e.stopPropagation()}
                          className={cn(EDITABLE_CELL_BASE, 'tabular-nums')}
                          aria-label="refresh rate"
                        >
                          {refreshes.map((hz) => (
                            <option key={hz} value={hz}>
                              {hz}
                            </option>
                          ))}
                        </select>
                        {refreshOffList && !resolutionOffList && (
                          // Suppressed when the resolution itself is off-list —
                          // a single warning at the resolution already
                          // implicates everything downstream, showing two is
                          // redundant noise.
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <TriangleAlert
                                className="h-3 w-3 text-accent-warm shrink-0 cursor-help"
                                aria-label="refresh rate not in the supported list"
                              />
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>
                                {monitor.refreshHz}Hz isn&apos;t supported at {currentW}×{currentH} — apply at your own risk
                              </p>
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </div>
                    );
                  })()}
                </td>
                <td
                  className={cn(
                    'py-1.5 px-1 tabular-nums',
                    scaleDrifted ? 'text-amber-400' : 'text-foreground',
                  )}
                >
                  {canEdit ? (
                    <select
                      value={monitor.scalePct}
                      onChange={(e) =>
                        onUpdateMonitor?.(monitor.id, {
                          scalePct: Number(e.target.value),
                        })
                      }
                      onClick={(e) => e.stopPropagation()}
                      className={cn(EDITABLE_CELL_BASE, 'tabular-nums')}
                    >
                      {SCALE_OPTIONS.map((s) => (
                        <option key={s} value={s}>
                          {s}%
                        </option>
                      ))}
                    </select>
                  ) : (
                    `${monitor.scalePct}%`
                  )}
                </td>
                <td
                  className={cn(
                    'py-1.5 px-1',
                    orientationDrifted ? 'text-amber-400' : 'text-muted-foreground',
                  )}
                >
                  {canEdit ? (
                    <select
                      value={monitor.rotation % 360}
                      onChange={(e) =>
                        onUpdateMonitor?.(monitor.id, {
                          rotation: Number(e.target.value),
                        })
                      }
                      onClick={(e) => e.stopPropagation()}
                      className={EDITABLE_CELL_BASE}
                    >
                      {ROTATION_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    orientationLabel(monitor.rotation)
                  )}
                </td>
                <td className="py-1.5 px-1 tabular-nums text-muted-foreground">
                  {canEdit && !monitor.primary ? (
                    <div className="flex items-center gap-1">
                      <NumericPositionInput
                        value={monitor.position.x}
                        onCommit={(x) =>
                          onUpdateMonitor?.(monitor.id, {
                            position: { x, y: monitor.position.y },
                          })
                        }
                        ariaLabel="x position"
                        className={cn(EDITABLE_CELL_BASE, 'w-20 tabular-nums')}
                      />
                      <NumericPositionInput
                        value={monitor.position.y}
                        onCommit={(y) =>
                          onUpdateMonitor?.(monitor.id, {
                            position: { x: monitor.position.x, y },
                          })
                        }
                        ariaLabel="y position"
                        className={cn(EDITABLE_CELL_BASE, 'w-20 tabular-nums')}
                      />
                    </div>
                  ) : (
                    <span
                      title={
                        canEdit && monitor.primary
                          ? 'primary defines the coordinate origin — drag it on the layout to reposition relative to the others'
                          : undefined
                      }
                    >
                      <span className={xDrifted ? 'text-amber-400' : undefined}>
                        {monitor.position.x}
                      </span>
                      ,{' '}
                      <span className={yDrifted ? 'text-amber-400' : undefined}>
                        {monitor.position.y}
                      </span>
                    </span>
                  )}
                </td>
                <td
                  className="py-1.5 px-1 pr-2 text-muted-foreground"
                  onClick={rowClick}
                  onDoubleClick={rowDblClick}
                >
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
