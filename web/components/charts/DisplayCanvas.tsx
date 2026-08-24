'use client';

/**
 * SVG topology of a machine's monitor layout: rects in scaled virtual-desktop
 * coords, primary highlight, drift ghosts, and Mosaic grids collapsed into one
 * block with dashed inner dividers.
 *
 * Container px width is measured via ResizeObserver so the viewBox matches
 * rendered px (keeps text + stroke widths stable); height comes from
 * `className` or DEFAULT_HEIGHT. Positions project through a single uniform
 * scale so aspect ratio is preserved.
 */

import {
  memo,
  useCallback,
  useDeferredValue,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { cn } from '@/lib/utils';
import type { MonitorInfo, MosaicGrid } from '@/hooks/useDisplayState';

interface DisplayCanvasProps {
  monitors: MonitorInfo[];
  mosaicGrids?: MosaicGrid[];
  selectedMonitorId?: string;
  onMonitorClick?: (id: string) => void;
  /** Monitor hovered here or in a linked sibling (DisplayMonitorTable) — shared highlight. */
  hoveredMonitorId?: string;
  /** Fires on mouse enter/leave of a clickable rect — id is undefined on leave. */
  onMonitorHover?: (id: string | undefined) => void;
  ghostMonitors?: MonitorInfo[];
  /** Selected-monitor stroke color. Override to signal mode (live vs assigned). */
  accentColor?: string;
  /** Drifted monitors take a coral fill; selection still owns the stroke channel. */
  driftedMonitorIds?: Set<string>;
  /**
   * `edidHash`es present in the rendered layout but absent from live topology —
   * dimmed fill + "not connected" badge; apply will fail for those rects.
   */
  staleEdidHashes?: Set<string>;
  /** `auto` picks label detail by rect area; `indexOnly` shows only the index. */
  labelMode?: 'auto' | 'indexOnly';
  /**
   * Enables drag, emitting `onMonitorMove` in virtual-desktop coords (1px snap,
   * 16px on shift-drag). The canvas never mutates monitor data itself.
   */
  editable?: boolean;
  onMonitorMove?: (id: string, position: { x: number; y: number }) => void;
  /** Double-click a rect — the panel wires this to DisplayEditorDialog. */
  onMonitorDoubleClick?: (id: string) => void;
  /**
   * Windows pins the primary at (0,0), so "moving" it means shifting every other
   * monitor by the inverse. Delta is incremental (frame-over-frame), in
   * virtual-desktop units. Omit to make the primary non-draggable.
   */
  onLayoutShift?: (dx: number, dy: number) => void;
  className?: string;
}

/** Default rendered canvas height in CSS px when caller doesn't override via className. */
const DEFAULT_HEIGHT = 280;
/** Minimum inner padding around the topology, in CSS px. */
const MIN_PADDING = 24;
/** Fraction of the smaller axis used as padding (before clamping to MIN_PADDING). */
const PADDING_RATIO = 0.1;

/** Area thresholds (in px²) that switch between the three label detail tiers. */
const LABEL_AREA_FULL = 12000;
const LABEL_AREA_ABBREV = 4000;

/** Virtual-desktop footprint, accounting for rotation (90/270 swap w/h). */
function effectiveDimensions(monitor: MonitorInfo): { w: number; h: number } {
  const { width, height } = monitor.resolution;
  const rot = monitor.rotation % 360;
  if (rot === 90 || rot === 270) {
    return { w: height, h: width };
  }
  return { w: width, h: height };
}

interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function computeBBox(all: MonitorInfo[]): BBox | null {
  if (all.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const m of all) {
    const { w, h } = effectiveDimensions(m);
    const x = m.position.x;
    const y = m.position.y;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x + w > maxX) maxX = x + w;
    if (y + h > maxY) maxY = y + h;
  }
  // Always include the virtual origin so the (0,0) marker never falls outside.
  if (0 < minX) minX = 0;
  if (0 < minY) minY = 0;
  if (0 > maxX) maxX = 0;
  if (0 > maxY) maxY = 0;
  return { minX, minY, maxX, maxY };
}

/**
 * Snap each axis independently to the nearest other-monitor edge within
 * `thresholdVirt`, so the rect can align left with one neighbour and top with
 * another. Covers same-side (left↔left) and touching (left↔right) pairs.
 */
function computeSnappedPosition(
  dragged: { id: string; width: number; height: number },
  candidate: { x: number; y: number },
  others: MonitorInfo[],
  thresholdVirt: number,
): { x: number; y: number } {
  let snappedX = candidate.x;
  let snappedY = candidate.y;
  let bestDx = thresholdVirt;
  let bestDy = thresholdVirt;
  const draggedLeft = candidate.x;
  const draggedRight = candidate.x + dragged.width;
  const draggedTop = candidate.y;
  const draggedBottom = candidate.y + dragged.height;
  for (const other of others) {
    if (other.id === dragged.id) continue;
    const { w: ow, h: oh } = effectiveDimensions(other);
    const oLeft = other.position.x;
    const oRight = other.position.x + ow;
    const oTop = other.position.y;
    const oBottom = other.position.y + oh;
    const xPairs: [number, number][] = [
      [draggedLeft, oLeft],
      [draggedLeft, oRight],
      [draggedRight, oLeft],
      [draggedRight, oRight],
    ];
    for (const [dEdge, oEdge] of xPairs) {
      const dist = Math.abs(dEdge - oEdge);
      if (dist < bestDx) {
        bestDx = dist;
        snappedX = candidate.x + (oEdge - dEdge);
      }
    }
    const yPairs: [number, number][] = [
      [draggedTop, oTop],
      [draggedTop, oBottom],
      [draggedBottom, oTop],
      [draggedBottom, oBottom],
    ];
    for (const [dEdge, oEdge] of yPairs) {
      const dist = Math.abs(dEdge - oEdge);
      if (dist < bestDy) {
        bestDy = dist;
        snappedY = candidate.y + (oEdge - dEdge);
      }
    }
  }
  return { x: snappedX, y: snappedY };
}

/**
 * Mosaic member at the composite's top-left, used to anchor the outer border.
 * Members reference `displayId` (Windows targetId). Returns null when no member
 * resolves so the caller skips the grid instead of drawing it at (0,0).
 */
function findGridAnchor(
  grid: MosaicGrid,
  monitorsByTargetId: Map<number, MonitorInfo>
): MonitorInfo | null {
  let anchor: MonitorInfo | null = null;
  for (const member of grid.members) {
    const m = monitorsByTargetId.get(member.displayId);
    if (!m) continue;
    if (
      !anchor ||
      m.position.y < anchor.position.y ||
      (m.position.y === anchor.position.y && m.position.x < anchor.position.x)
    ) {
      anchor = m;
    }
  }
  return anchor;
}

function DisplayCanvasImpl({
  monitors: monitorsProp,
  mosaicGrids,
  selectedMonitorId,
  onMonitorClick,
  hoveredMonitorId,
  onMonitorHover,
  ghostMonitors: ghostMonitorsProp,
  accentColor = 'var(--primary)',
  driftedMonitorIds,
  staleEdidHashes,
  labelMode = 'auto',
  editable = false,
  onMonitorMove,
  onMonitorDoubleClick,
  onLayoutShift,
  className,
}: DisplayCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [canvasW, setCanvasW] = useState<number>(0);
  const [canvasH, setCanvasH] = useState<number>(DEFAULT_HEIGHT);

  // Deferred so bursts of Firestore snapshots don't stall the parent's slide-up.
  const monitors = useDeferredValue(monitorsProp);
  const ghostMonitors = useDeferredValue(ghostMonitorsProp);

  // One ResizeObserver for both axes. Equality guards + px rounding avoid setState
  // churn from sub-pixel wobble during grid-rows transitions.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const update = () => {
      const roundedW = Math.round(el.clientWidth);
      const roundedH = Math.round(el.clientHeight);
      setCanvasW((prev) => (prev === roundedW ? prev : roundedW));
      setCanvasH((prev) => (prev === roundedH ? prev : roundedH));
    };

    // Measure synchronously so the first render already has dimensions.
    update();

    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const projection = useMemo(() => {
    const allForBBox: MonitorInfo[] = [
      ...monitors,
      ...(ghostMonitors ?? []),
    ];
    const bbox = computeBBox(allForBBox);
    if (!bbox || canvasW <= 0 || canvasH <= 0) {
      return null;
    }
    const bboxW = bbox.maxX - bbox.minX || 1;
    const bboxH = bbox.maxY - bbox.minY || 1;
    const padding = Math.max(
      MIN_PADDING,
      Math.min(canvasW, canvasH) * PADDING_RATIO
    );
    const scaleX = (canvasW - 2 * padding) / bboxW;
    const scaleY = (canvasH - 2 * padding) / bboxH;
    const scale = Math.max(0, Math.min(scaleX, scaleY));
    // Centre the topology so small layouts don't hug the top-left corner.
    const contentW = bboxW * scale;
    const contentH = bboxH * scale;
    const offsetX = (canvasW - contentW) / 2 - bbox.minX * scale;
    const offsetY = (canvasH - contentH) / 2 - bbox.minY * scale;
    return { bbox, scale, offsetX, offsetY, padding };
  }, [monitors, ghostMonitors, canvasW, canvasH]);

  const monitorsByTargetId = useMemo(() => {
    const map = new Map<number, MonitorInfo>();
    for (const m of monitors) map.set(m.targetId, m);
    return map;
  }, [monitors]);

  // O(1) index lookup; `monitors.indexOf` per rect per render was O(n²).
  const monitorIndexById = useMemo(() => {
    const map = new Map<string, number>();
    for (let i = 0; i < monitors.length; i++) {
      map.set(monitors[i].id, i);
    }
    return map;
  }, [monitors]);

  // Stable delegates — no fresh arrow allocated per rect per render.
  const handleRectClick = useCallback(
    (id: string) => {
      onMonitorClick?.(id);
    },
    [onMonitorClick],
  );
  const handleRectEnter = useCallback(
    (id: string) => {
      onMonitorHover?.(id);
    },
    [onMonitorHover],
  );
  const handleRectLeave = useCallback(() => {
    onMonitorHover?.(undefined);
  }, [onMonitorHover]);

  // Drag state in a ref so pointermove doesn't re-render; only onMonitorMove /
  // onLayoutShift push draft updates. `startScale` is captured at pointerdown so
  // mid-drag bbox growth doesn't wobble the cursor-to-rect mapping.
  // `lastEmittedDx/Dy` lets primary drags emit *incremental* deltas — absolutes
  // would compound against already-shifted secondaries and move them twice as far.
  const dragStateRef = useRef<{
    monitorId: string;
    isPrimary: boolean;
    startClientX: number;
    startClientY: number;
    startPosX: number;
    startPosY: number;
    startScale: number;
    draggedW: number;
    draggedH: number;
    pointerId: number;
    moved: boolean;
    lastEmittedDx: number;
    lastEmittedDy: number;
    /**
     * Non-dragged monitors as of pointerdown. Primary-drag snap must measure
     * against where the operator sees them — current positions shift in lock-step
     * with the virtual primary and would halve the effective snap distance.
     */
    initialOthersForSnap: MonitorInfo[];
  } | null>(null);
  // Set on pointerup after a drag; consumed by the next click so release doesn't
  // also toggle selection.
  const suppressClickRef = useRef(false);

  const handleRectPointerDown = useCallback(
    (e: React.PointerEvent<SVGGElement>, monitor: MonitorInfo) => {
      if (!editable || !projection || projection.scale <= 0) return;
      // Primary routes through onLayoutShift, secondaries through onMonitorMove.
      if (monitor.primary ? !onLayoutShift : !onMonitorMove) return;
      if (e.button !== 0) return;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Some browsers reject capture on SVG — drag still works, it just loses
        // tracking once the pointer leaves the rect.
      }
      const { w, h } = effectiveDimensions(monitor);
      dragStateRef.current = {
        monitorId: monitor.id,
        isPrimary: monitor.primary,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startPosX: monitor.position.x,
        startPosY: monitor.position.y,
        startScale: projection.scale,
        draggedW: w,
        draggedH: h,
        pointerId: e.pointerId,
        moved: false,
        lastEmittedDx: 0,
        lastEmittedDy: 0,
        // Primary drags only — snap needs pre-drag positions (secondaries shift).
        initialOthersForSnap: monitor.primary
          ? monitors.filter((m) => m.id !== monitor.id)
          : [],
      };
    },
    [editable, onMonitorMove, onLayoutShift, projection, monitors],
  );

  const handleRectPointerMove = useCallback(
    (e: React.PointerEvent<SVGGElement>) => {
      const state = dragStateRef.current;
      if (!state || e.pointerId !== state.pointerId) return;
      const dxCss = e.clientX - state.startClientX;
      const dyCss = e.clientY - state.startClientY;
      // 3px dead-zone separates a click-with-microshake from an intent to drag.
      if (!state.moved && Math.hypot(dxCss, dyCss) < 3) return;
      state.moved = true;
      const dxVirt = dxCss / state.startScale;
      const dyVirt = dyCss / state.startScale;
      let newX = state.startPosX + dxVirt;
      let newY = state.startPosY + dyVirt;
      if (e.shiftKey) {
        // Shift-drag opts out of edge-snap in favor of an explicit 16px grid.
        newX = Math.round(newX / 16) * 16;
        newY = Math.round(newY / 16) * 16;
      } else {
        // Snap threshold is CSS-px-derived so it feels the same at any zoom.
        // Primary snaps against pointerdown-time positions (secondaries shift in
        // lock-step and would halve the effective distance); secondaries snap
        // against current positions.
        const snapTargets = state.isPrimary ? state.initialOthersForSnap : monitors;
        const snapThresholdVirt = 8 / state.startScale;
        const snapped = computeSnappedPosition(
          { id: state.monitorId, width: state.draggedW, height: state.draggedH },
          { x: newX, y: newY },
          snapTargets,
          snapThresholdVirt,
        );
        newX = Math.round(snapped.x);
        newY = Math.round(snapped.y);
      }
      if (state.isPrimary) {
        // Inverse-shift every other monitor; incremental so the hook's shift
        // logic doesn't compound on already-shifted state.
        const incDx = newX - state.lastEmittedDx;
        const incDy = newY - state.lastEmittedDy;
        if (incDx !== 0 || incDy !== 0) {
          onLayoutShift?.(-incDx, -incDy);
          state.lastEmittedDx = newX;
          state.lastEmittedDy = newY;
        }
      } else {
        onMonitorMove?.(state.monitorId, { x: newX, y: newY });
      }
    },
    [onMonitorMove, onLayoutShift, monitors],
  );

  const handleRectPointerUp = useCallback(
    (e: React.PointerEvent<SVGGElement>) => {
      const state = dragStateRef.current;
      if (!state || e.pointerId !== state.pointerId) return;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // ignore — capture may have already been lost
      }
      if (state.moved) {
        suppressClickRef.current = true;
      }
      dragStateRef.current = null;
    },
    [],
  );

  const renderMonitor = (
    monitor: MonitorInfo,
    opts: { ghost: boolean }
  ) => {
    if (!projection) return null;
    const { scale, offsetX, offsetY } = projection;
    const { w, h } = effectiveDimensions(monitor);
    const x = monitor.position.x * scale + offsetX;
    const y = monitor.position.y * scale + offsetY;
    const rectW = w * scale;
    const rectH = h * scale;
    if (rectW <= 0 || rectH <= 0) return null;

    const area = rectW * rectH;
    // Ghosts share ids with their live counterparts — without this guard,
    // selecting a live rect would repaint the ghost too and lose the "assigned" hue.
    const isSelected =
      !opts.ghost && !!selectedMonitorId && selectedMonitorId === monitor.id;
    const isHovered =
      !opts.ghost && !!hoveredMonitorId && hoveredMonitorId === monitor.id;
    const isPrimary = monitor.primary;
    const clickable = !!onMonitorClick && !opts.ghost;
    const hoverable = !opts.ghost && !!onMonitorHover;

    // One signal per channel: fill = identity/state, stroke = interaction, so they
    // stack (selected + drifted + primary = coral fill + accent stroke + ★).
    // Fill priority: ghost > drifted > primary > default — drift (coral) overrides
    // primary (warm amber) so drift shows even on the primary. Non-drifted rects
    // tint with the tab accent so a tab's monitors read as one set.
    const isDrifted =
      !opts.ghost && driftedMonitorIds?.has(monitor.id) === true;
    // [A4.4] In the rendered layout but not in live topology — stored once, not
    // connected now. Ghosts already encode this via their dashed style.
    const isStale =
      !opts.ghost &&
      !!monitor.edidHash &&
      staleEdidHashes?.has(monitor.edidHash) === true;
    let fill: string;
    let strokeDash: string | undefined;
    if (opts.ghost) {
      // --chart-4 is the assigned-tab accent, matching the pill and drift accent.
      fill = 'color-mix(in oklab, var(--chart-4) 10%, transparent)';
      strokeDash = '5,4';
    } else if (isDrifted) {
      fill = 'color-mix(in oklab, var(--accent-warm) 40%, var(--secondary))';
    } else {
      const tintPct = isPrimary ? 32 : 22;
      fill = `color-mix(in oklab, ${accentColor} ${tintPct}%, var(--secondary))`;
    }

    // Selection owns the stroke channel alone. Default is --muted-foreground, not
    // --border, which equals --accent in dark mode (no contrast on navy fills).
    let stroke: string;
    let strokeWidth: number;
    if (isSelected) {
      stroke = accentColor;
      strokeWidth = 2;
    } else if (opts.ghost) {
      stroke = 'var(--chart-4)';
      strokeWidth = 1.5;
    } else {
      stroke = 'var(--muted-foreground)';
      strokeWidth = 1;
    }

    // Ghost fill stays faint but its dashed border must remain readable. Stale
    // rects dim to 0.5 to reinforce the "not connected" badge.
    const fillOpacity = opts.ghost ? 0.4 : isStale ? 0.5 : 1;
    const strokeOpacity = opts.ghost ? 0.85 : 1;
    // Hover brightness is state-driven (not :hover) so the sibling table row can
    // light this rect up too.
    // Primary is pinned at (0,0) by Windows — only onLayoutShift can "move" it.
    const draggable =
      editable &&
      !opts.ghost &&
      (monitor.primary ? !!onLayoutShift : !!onMonitorMove);
    const rectStyle: React.CSSProperties = {
      cursor: draggable ? 'move' : clickable ? 'pointer' : 'default',
      filter: isHovered ? 'brightness(1.15)' : undefined,
      transition: 'filter 120ms ease',
      touchAction: draggable ? 'none' : undefined,
    };

    // Label tier from rendered area (not width) so tall portrait rects don't
    // get crammed with text that won't fit.
    let labelContent: React.ReactNode = null;
    if (!opts.ghost) {
      const cx = x + rectW / 2;
      const cy = y + rectH / 2;
      const rotationSuffix = monitor.rotation ? `/${monitor.rotation}°` : '';
      // Effective (post-rotation) dims — a 4K panel at 270° reads 2160×3840.
      const effRes = effectiveDimensions(monitor);
      // indexOnly: compact previews keep the textual detail outside the canvas.
      if (labelMode === 'indexOnly') {
        const idx = monitorIndexById.get(monitor.id) ?? -1;
        labelContent = (
          <text
            x={cx}
            y={cy + 5}
            textAnchor="middle"
            fontSize={14}
            fontWeight={600}
            fill="var(--foreground)"
            style={{ fontFamily: 'inherit' }}
            pointerEvents="none"
          >
            {idx >= 0 ? idx + 1 : ''}
          </text>
        );
      } else if (area > LABEL_AREA_FULL) {
        labelContent = (
          <g pointerEvents="none">
            <text
              x={cx}
              y={cy - 16}
              textAnchor="middle"
              fontSize={12}
              fontWeight={600}
              fill="var(--foreground)"
              style={{ fontFamily: 'inherit' }}
            >
              {monitor.friendlyName ?? monitor.id}
            </text>
            <text
              x={cx}
              y={cy}
              textAnchor="middle"
              fontSize={11}
              fill="var(--muted-foreground)"
              style={{ fontFamily: 'inherit' }}
            >
              {effRes.w}x{effRes.h} @{monitor.refreshHz}hz
            </text>
            <text
              x={cx}
              y={cy + 14}
              textAnchor="middle"
              fontSize={11}
              fill="var(--muted-foreground)"
              style={{ fontFamily: 'inherit' }}
            >
              {monitor.scalePct}%{rotationSuffix}
            </text>
          </g>
        );
      } else if (area > LABEL_AREA_ABBREV) {
        labelContent = (
          <g pointerEvents="none">
            <text
              x={cx}
              y={cy - 6}
              textAnchor="middle"
              fontSize={11}
              fontWeight={600}
              fill="var(--foreground)"
              style={{ fontFamily: 'inherit' }}
            >
              {monitor.friendlyName ?? monitor.id}
            </text>
            <text
              x={cx}
              y={cy + 9}
              textAnchor="middle"
              fontSize={10}
              fill="var(--muted-foreground)"
              style={{ fontFamily: 'inherit' }}
            >
              {effRes.w}x{effRes.h}
            </text>
          </g>
        );
      } else {
        const idx = monitorIndexById.get(monitor.id) ?? -1;
        labelContent = (
          <text
            x={cx}
            y={cy}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={12}
            fontWeight={600}
            fill="var(--foreground)"
            style={{ fontFamily: 'inherit' }}
            pointerEvents="none"
          >
            {idx >= 0 ? idx + 1 : ''}
          </text>
        );
      }
    }

    // Primary star, top-left. Warm accent matches the fill tint and never collides
    // with the selection stroke. Redundant in indexOnly mode.
    const primaryBadge =
      isPrimary && !opts.ghost && labelMode !== 'indexOnly' ? (
        <text
          x={x + 6}
          y={y + 12}
          fontSize={9}
          fontWeight={600}
          fill="var(--accent-warm)"
          style={{ fontFamily: 'inherit', textTransform: 'lowercase' }}
          pointerEvents="none"
        >
          ★ primary
        </text>
      ) : null;

    // [A4.4] Top-right so it never collides with the primary star; hidden in
    // indexOnly, where it would crowd the index number.
    const staleBadge =
      isStale && labelMode !== 'indexOnly' ? (
        <text
          x={x + rectW - 6}
          y={y + 12}
          textAnchor="end"
          fontSize={9}
          fontWeight={600}
          fill="var(--accent-warm)"
          style={{ fontFamily: 'inherit', textTransform: 'lowercase' }}
          pointerEvents="none"
        >
          ⚠ not connected
        </text>
      ) : null;

    const handleGroupClick = clickable
      ? (e: React.MouseEvent<SVGGElement>) => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
          }
          // Chrome/Edge don't focus an SVG <g> on mouse activation even with
          // tabIndex=0, so arrow-key nudging would silently never fire.
          e.currentTarget.focus();
          handleRectClick(monitor.id);
        }
      : undefined;

    // Only wired when the caller opts in; otherwise double-click degrades to two
    // back-to-back selection clicks (the read-only default).
    const handleGroupDoubleClick =
      clickable && onMonitorDoubleClick
        ? () => onMonitorDoubleClick(monitor.id)
        : undefined;

    // Button semantics + keyboard activation. In edit mode arrows nudge 1 virtual
    // px (shift: 10) — needed where 1 CSS px can span 50+ virtual px. Primary
    // nudges route through onLayoutShift, same contract as drag.
    const handleKeyDown = clickable
      ? (e: React.KeyboardEvent<SVGGElement>) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleRectClick(monitor.id);
            return;
          }
          if (!draggable) return;
          if (
            e.key !== 'ArrowLeft' &&
            e.key !== 'ArrowRight' &&
            e.key !== 'ArrowUp' &&
            e.key !== 'ArrowDown'
          ) {
            return;
          }
          const step = e.shiftKey ? 10 : 1;
          let dx = 0;
          let dy = 0;
          if (e.key === 'ArrowLeft') dx = -step;
          else if (e.key === 'ArrowRight') dx = step;
          else if (e.key === 'ArrowUp') dy = -step;
          else dy = step;
          e.preventDefault();
          if (isPrimary) {
            // Primary is pinned at (0,0); shift every secondary by the inverse.
            onLayoutShift?.(-dx, -dy);
          } else {
            onMonitorMove?.(monitor.id, {
              x: monitor.position.x + dx,
              y: monitor.position.y + dy,
            });
          }
        }
      : undefined;

    return (
      <g
        key={`${opts.ghost ? 'ghost-' : ''}${monitor.id}`}
        role={clickable ? 'button' : undefined}
        tabIndex={clickable ? 0 : undefined}
        // The UA focus ring would double up with the selection stroke. tabIndex=0
        // stays for Tab order and arrow-key nudging.
        style={clickable ? { outline: 'none' } : undefined}
        aria-label={
          clickable ? (monitor.friendlyName || monitor.id) : undefined
        }
        aria-pressed={clickable ? isSelected : undefined}
        onClick={handleGroupClick}
        onDoubleClick={handleGroupDoubleClick}
        onKeyDown={handleKeyDown}
        onMouseEnter={hoverable ? () => handleRectEnter(monitor.id) : undefined}
        onMouseLeave={hoverable ? handleRectLeave : undefined}
        onPointerDown={
          draggable ? (e) => handleRectPointerDown(e, monitor) : undefined
        }
        onPointerMove={draggable ? handleRectPointerMove : undefined}
        onPointerUp={draggable ? handleRectPointerUp : undefined}
        onPointerCancel={draggable ? handleRectPointerUp : undefined}
      >
        <rect
          x={x}
          y={y}
          width={rectW}
          height={rectH}
          rx={4}
          ry={4}
          fill={fill}
          fillOpacity={fillOpacity}
          stroke={stroke}
          strokeWidth={strokeWidth}
          strokeDasharray={strokeDash}
          strokeOpacity={strokeOpacity}
          style={rectStyle}
        />
        {primaryBadge}
        {staleBadge}
        {labelContent}
      </g>
    );
  };

  const renderGrid = (grid: MosaicGrid, gridIdx: number) => {
    if (!projection) return null;
    const anchor = findGridAnchor(grid, monitorsByTargetId);
    if (!anchor) return null;
    const { scale, offsetX, offsetY } = projection;
    const x = anchor.position.x * scale + offsetX;
    const y = anchor.position.y * scale + offsetY;
    const w = grid.compositeWidth * scale;
    const h = grid.compositeHeight * scale;
    if (w <= 0 || h <= 0) return null;

    // Interior dividers as individual <line>s so dash spacing stays uniform
    // instead of being chopped by the rect outline.
    const dividers: React.ReactNode[] = [];
    const cellW = w / grid.cols;
    const cellH = h / grid.rows;
    for (let c = 1; c < grid.cols; c++) {
      const lx = x + c * cellW;
      dividers.push(
        <line
          key={`v-${gridIdx}-${c}`}
          x1={lx}
          y1={y}
          x2={lx}
          y2={y + h}
          stroke="var(--primary)"
          strokeWidth={1}
          strokeDasharray="4,4"
          opacity={0.6}
        />
      );
    }
    for (let r = 1; r < grid.rows; r++) {
      const ly = y + r * cellH;
      dividers.push(
        <line
          key={`h-${gridIdx}-${r}`}
          x1={x}
          y1={ly}
          x2={x + w}
          y2={ly}
          stroke="var(--primary)"
          strokeWidth={1}
          strokeDasharray="4,4"
          opacity={0.6}
        />
      );
    }

    return (
      <g key={`mosaic-${gridIdx}`} pointerEvents="none">
        <rect
          x={x}
          y={y}
          width={w}
          height={h}
          rx={4}
          ry={4}
          fill="none"
          stroke="var(--primary)"
          strokeWidth={2}
        />
        {dividers}
      </g>
    );
  };

  // Memoized so unrelated parent re-renders (e.g. the slide-up animation) skip the
  // SVG rebuild. Deps list every value renderMonitor/renderGrid reads;
  // exhaustive-deps can't see through the nested closures, hence the suppression.
  const ghostElements = useMemo(
    () => (ghostMonitors ?? []).map((m) => renderMonitor(m, { ghost: true })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ghostMonitors, projection, selectedMonitorId, hoveredMonitorId, onMonitorClick, onMonitorHover, handleRectClick, handleRectEnter, handleRectLeave, monitorIndexById, accentColor, driftedMonitorIds, labelMode, editable, onMonitorMove, onMonitorDoubleClick, onLayoutShift, handleRectPointerDown, handleRectPointerMove, handleRectPointerUp, staleEdidHashes],
  );
  // SVG has no z-index — paint order is document order. Render the selected rect
  // last so its stroke isn't clipped by an adjacent later sibling.
  const monitorElements = useMemo(() => {
    const selected: MonitorInfo[] = [];
    const rest: MonitorInfo[] = [];
    for (const m of monitors) {
      if (m.id === selectedMonitorId) selected.push(m);
      else rest.push(m);
    }
    return [
      ...rest.map((m) => renderMonitor(m, { ghost: false })),
      ...selected.map((m) => renderMonitor(m, { ghost: false })),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monitors, projection, selectedMonitorId, hoveredMonitorId, onMonitorClick, onMonitorHover, handleRectClick, handleRectEnter, handleRectLeave, monitorIndexById, accentColor, driftedMonitorIds, labelMode, editable, onMonitorMove, onMonitorDoubleClick, onLayoutShift, handleRectPointerDown, handleRectPointerMove, handleRectPointerUp, staleEdidHashes]);
  const gridElements = useMemo(
    () => (mosaicGrids ?? []).map((g, i) => renderGrid(g, i)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mosaicGrids, projection, monitorsByTargetId],
  );

  const originMarker = useMemo(() => {
    if (!projection) return null;
    const { scale, offsetX, offsetY } = projection;
    const ox = 0 * scale + offsetX;
    const oy = 0 * scale + offsetY;
    const size = 5;
    return (
      <g opacity={0.3} pointerEvents="none">
        <line
          x1={ox - size}
          y1={oy}
          x2={ox + size}
          y2={oy}
          stroke="var(--muted-foreground)"
          strokeWidth={1}
        />
        <line
          x1={ox}
          y1={oy - size}
          x2={ox}
          y2={oy + size}
          stroke="var(--muted-foreground)"
          strokeWidth={1}
        />
      </g>
    );
  }, [projection]);

  const hasHeightClass = !!className && /\bh-\[|\bh-\d/.test(className);

  return (
    <div
      ref={containerRef}
      className={cn('w-full relative', !hasHeightClass && 'h-[280px]', className)}
    >
      {canvasW > 0 && canvasH > 0 && (
        <svg
          width={canvasW}
          height={canvasH}
          viewBox={`0 0 ${canvasW} ${canvasH}`}
          preserveAspectRatio="xMidYMid meet"
          style={{ display: 'block' }}
        >
          {originMarker}
          {ghostElements}
          {monitorElements}
          {gridElements}
        </svg>
      )}
    </div>
  );
}

/**
 * Memoized. Callers must pass a stable `onMonitorClick` and memoized
 * `monitors` / `ghostMonitors` / `mosaicGrids` for this to help.
 */
export const DisplayCanvas = memo(DisplayCanvasImpl);
