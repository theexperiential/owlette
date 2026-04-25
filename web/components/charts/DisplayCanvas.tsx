'use client';

/**
 * DisplayCanvas Component
 *
 * SVG-based topology visualization of a machine's monitor layout.
 *
 * Renders each monitor as a rectangle in scaled virtual-desktop coordinates,
 * with primary highlight, ghost overlays for drift visualization, and Mosaic
 * grids collapsed into a single atomic block with inner dashed dividers.
 *
 * Scaling strategy:
 *  - The container's pixel width is measured via ResizeObserver so the SVG
 *    viewBox matches rendered px (keeps text + stroke widths visually stable).
 *  - Height is driven by `className` (e.g. `h-[280px]`) or defaults to 280px.
 *  - Monitor positions / sizes are projected from virtual-desktop coords into
 *    px coords with a single uniform scale so aspect ratio is preserved.
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
  /**
   * Id of the monitor currently hovered in either the canvas or a linked
   * sibling view (e.g. DisplayMonitorTable). Drives a shared highlight so
   * hovering a row in the table lights up the matching rect here, and vice
   * versa.
   */
  hoveredMonitorId?: string;
  /** Fires on mouse enter/leave of a clickable rect — id is undefined on leave. */
  onMonitorHover?: (id: string | undefined) => void;
  ghostMonitors?: MonitorInfo[];
  /**
   * Color used for the selected-monitor stroke. Defaults to the primary CSS
   * variable. Callers can override to communicate semantic mode (e.g. live
   * vs assigned) without theming the whole canvas.
   */
  accentColor?: string;
  /**
   * Set of monitor ids that have drifted from their assigned configuration.
   * Drifted rects get a warm coral fill tint; selection still owns the
   * stroke channel so a selected drifted monitor reads as coral fill + tab
   * accent stroke simultaneously, with no channel collision.
   */
  driftedMonitorIds?: Set<string>;
  /**
   * Set of monitor `edidHash` values that exist in the rendered layout
   * (typically the assigned tab) but are NOT in the current live topology
   * — i.e., stored monitors that aren't physically connected right now.
   * These rects render with a dimmed fill + an amber "⚠ not connected"
   * badge so the operator immediately sees that part of the layout is
   * referencing absent hardware (apply will fail for those rects).
   */
  staleEdidHashes?: Set<string>;
  /**
   * Label rendering mode. `auto` (default) picks the label tier based on
   * rendered rect area: full info for big rects, abbreviated for medium,
   * just the index number for small. `indexOnly` forces every rect to show
   * just its index number — useful for compact previews where the textual
   * detail lives outside the canvas.
   */
  labelMode?: 'auto' | 'indexOnly';
  /**
   * When true, monitor rects respond to pointer drags and emit `onMonitorMove`
   * with the updated virtual-desktop position. Pure drag snaps to 1px virtual;
   * shift-drag snaps to 16px multiples. Callers wire this to a draft-state
   * setter — the canvas never mutates monitor data itself.
   */
  editable?: boolean;
  onMonitorMove?: (id: string, position: { x: number; y: number }) => void;
  /**
   * Fires when the user double-clicks a monitor rect. The panel wires this
   * to the `DisplayEditorDialog` so double-click opens the full monitor
   * editor (access to resolution, refresh, and other fields not exposed in
   * the inline table cells).
   */
  onMonitorDoubleClick?: (id: string) => void;
  /**
   * Optional callback fired while the user drags the primary monitor. The
   * primary is pinned at (0, 0) by Windows, so we can't move it directly —
   * instead we translate the drag into an inverse shift of every other
   * monitor, which visually reads as "the primary moved". Delta is
   * incremental (frame-over-frame), in virtual-desktop units. When omitted,
   * the primary stays non-draggable.
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

/**
 * Dimensions a monitor occupies on the virtual desktop, taking rotation into
 * account. Portrait orientations (90 / 270) swap the nominal width/height.
 */
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
 * Pull the dragged monitor's edges toward any other-monitor edge that sits
 * within `thresholdVirt` virtual units. Each axis is snapped independently
 * from the closest candidate across all other monitors, so the rect can
 * align its left edge with one neighbour while its top edge aligns with
 * another — the common "tile into the gap" case.
 *
 * Edges considered per axis: same-side alignment (left↔left / right↔right /
 * top↔top / bottom↔bottom) and touching alignment (left↔right / right↔left /
 * top↔bottom / bottom↔top). Together these cover every natural "click
 * together" outcome.
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
 * Locate the Mosaic member display whose virtual-desktop position is the
 * top-left corner of the composite surface. Used to anchor the outer border.
 *
 * The Mosaic payload references members by `displayId` (Windows targetId),
 * so we match against `MonitorInfo.targetId`. If no member resolves we return
 * null and the caller skips the grid entirely rather than drawing it at (0,0).
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

  // Defer the heavy monitor arrays so rapid Firestore snapshot updates (e.g.
  // arriving while the parent slide-up animation is still running) don't stall
  // the transition. React keeps the previous deferred value until the next
  // non-urgent render commits, which naturally coalesces bursts.
  const monitors = useDeferredValue(monitorsProp);
  const ghostMonitors = useDeferredValue(ghostMonitorsProp);

  // Single ResizeObserver tracks both dimensions. Equality guards prevent
  // redundant re-renders during parent animations where one axis may change
  // without the other. Rounding to whole pixels avoids sub-pixel setState
  // churn from sub-pixel fluctuations during grid-rows transitions.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const update = () => {
      const roundedW = Math.round(el.clientWidth);
      const roundedH = Math.round(el.clientHeight);
      setCanvasW((prev) => (prev === roundedW ? prev : roundedW));
      setCanvasH((prev) => (prev === roundedH ? prev : roundedH));
    };

    // Initial measurement runs synchronously before paint so the first render
    // has usable dimensions.
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
    // Centre the topology inside the padded canvas so small layouts don't
    // hug the top-left corner.
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

  // Fast id → index lookup for the small-label tier. Previously we called
  // `monitors.indexOf(monitor)` per rect per render, which is O(n²) across the
  // whole canvas. A Map makes it O(n) to build and O(1) per lookup.
  const monitorIndexById = useMemo(() => {
    const map = new Map<string, number>();
    for (let i = 0; i < monitors.length; i++) {
      map.set(monitors[i].id, i);
    }
    return map;
  }, [monitors]);

  // Stable onClick delegate so memoizing at the rect level would be meaningful
  // if we ever split rects into their own component. Also avoids allocating a
  // fresh arrow per rect per render.
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

  // Drag state lives in a ref so mid-drag pointer moves don't cascade into
  // parent renders — only the onMonitorMove / onLayoutShift callbacks (fired
  // for virtual-coord changes) trigger draft updates. `startScale` is
  // captured at pointerdown so mid-drag bbox growth (the rect expanding the
  // viewport) doesn't wobble the cursor-to-rect mapping.
  //
  // For primary drags, `lastEmittedDx/Dy` tracks the cumulative (snapped)
  // virtual delta we've already pushed to `onLayoutShift`, so each
  // pointermove can emit the *incremental* delta instead of an absolute.
  // Absolutes would compound: the secondaries have already shifted, and
  // re-applying the full cumulative against the shifted state would move
  // them twice as far as intended.
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
     * Initial positions of the non-dragged monitors, snapshotted at
     * pointerdown. Used for snap-target comparison during primary drag so
     * thresholds are measured against where the operator *sees* the
     * secondaries — not against their mid-drag shifted positions, which
     * move in lock-step with the virtual primary and would halve the
     * effective snap distance.
     */
    initialOthersForSnap: MonitorInfo[];
  } | null>(null);
  // Set on pointerup when a drag occurred; consumed+cleared by the next click
  // so drag-release doesn't also toggle selection.
  const suppressClickRef = useRef(false);

  const handleRectPointerDown = useCallback(
    (e: React.PointerEvent<SVGGElement>, monitor: MonitorInfo) => {
      if (!editable || !projection || projection.scale <= 0) return;
      // Primary uses onLayoutShift; secondaries use onMonitorMove. Bail if
      // the caller didn't wire up the matching callback for this monitor.
      if (monitor.primary ? !onLayoutShift : !onMonitorMove) return;
      if (e.button !== 0) return;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Some browsers reject capture on SVG — drag still works without it,
        // it just loses tracking when the pointer leaves the rect.
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
        // Only populated for primary drags — snap targets need initial
        // positions because secondaries shift mid-drag under our feet.
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
        // Edge-snap threshold is CSS-px-derived so it feels consistent at
        // any zoom level. 8 CSS px is wide enough for quick alignment,
        // narrow enough to avoid "sticky" feel when dragging away.
        //
        // Primary drag snaps against the *initial* positions of the other
        // monitors (snapshotted at pointerdown). Current positions shift in
        // lock-step with the virtual primary as the drag proceeds, so
        // using them would double the effective distance and make snap
        // fire at half the apparent gap. Secondary drags snap against
        // current positions, which are stable relative to the drag.
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
        // Translate the primary's virtual delta into an inverse shift of
        // every other monitor. Emit *incremental* deltas so the hook's
        // shift logic doesn't compound the cumulative movement on top of
        // already-shifted state.
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
    // Ghosts never take the selection stroke — selectedMonitorId matches by
    // monitor.id and ghosts share ids with their live counterparts, so
    // without this guard selecting a live rect would also repaint the ghost
    // in the cyan selection accent and lose the purple "assigned" signal.
    const isSelected =
      !opts.ghost && !!selectedMonitorId && selectedMonitorId === monitor.id;
    const isHovered =
      !opts.ghost && !!hoveredMonitorId && hoveredMonitorId === monitor.id;
    const isPrimary = monitor.primary;
    const clickable = !!onMonitorClick && !opts.ghost;
    const hoverable = !opts.ghost && !!onMonitorHover;

    // Color system: fill carries identity/state, stroke carries interaction.
    // Every signal owns exactly one channel so combinations stack cleanly —
    // a selected, drifted, primary rect reads as coral-warm fill + cyan
    // stroke + ★ glyph, three independent signals with no collisions.
    //
    // Fill priority: ghost > drifted > primary > default. Drift overrides
    // primary tint so operators can spot drift even on the primary monitor;
    // the ★ glyph still indicates primary independently. Drift uses coral
    // (hue ~30°) and primary uses warm amber (hue ~55°) — the same warm
    // family so they never clash, but with enough hue separation to
    // distinguish at a glance.
    //
    // Non-drifted non-ghost rects tint with the tab's accent color, so every
    // monitor on a given tab reads as "part of the same set" instead of
    // primary popping in a different hue from everyone else. Primary keeps a
    // higher saturation so it's still distinguishable at a glance without
    // hunting for the ★ star. Drift still overrides with coral (a cross-tab
    // alert signal), and ghosts still paint in --chart-4 to flag "assigned".
    const isDrifted =
      !opts.ghost && driftedMonitorIds?.has(monitor.id) === true;
    // [A4.4] Stale-edidHash check. The monitor is in the rendered layout but
    // not in the current live topology — operator stored it once, but right
    // now it's not connected. Only meaningful for non-ghost rects (ghosts
    // ARE the assigned-on-live overlay; staleness for them is conceptually
    // the same signal already encoded in their dashed style).
    const isStale =
      !opts.ghost &&
      !!monitor.edidHash &&
      staleEdidHashes?.has(monitor.edidHash) === true;
    let fill: string;
    let strokeDash: string | undefined;
    if (opts.ghost) {
      // Ghosts use --chart-4 (the assigned-tab accent) so the dashed overlay
      // reads semantically as "this is the assigned layout" — matches the
      // purple used on the assigned tab pill and apply-button drift accent.
      fill = 'color-mix(in oklab, var(--chart-4) 10%, transparent)';
      strokeDash = '5,4';
    } else if (isDrifted) {
      fill = 'color-mix(in oklab, var(--accent-coral) 40%, var(--secondary))';
    } else {
      const tintPct = isPrimary ? 32 : 22;
      fill = `color-mix(in oklab, ${accentColor} ${tintPct}%, var(--secondary))`;
    }

    // Stroke priority: selection > ghost-dashed > default. Selection owns
    // the stroke channel alone — drift is on fill (above), so selecting a
    // drifted monitor still reads the coral wash *and* the cyan outline
    // simultaneously, with no channel collision. Default stroke uses
    // `--muted-foreground` (not `--border`, which is identical to `--accent`
    // in dark mode and gives near-zero contrast against the navy fills).
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

    // Ghosts split fill vs stroke opacity: keep the fill nearly invisible so
    // live monitors read as primary, but the dashed border needs to be
    // visible enough to actually communicate the assigned layout.
    // Stale rects (assigned but not connected) drop fill opacity to ~0.5 so
    // they read as muted — the badge below is the explicit signal; the dim
    // fill reinforces "this position is reserved for hardware that's not
    // here right now".
    const fillOpacity = opts.ghost ? 0.4 : isStale ? 0.5 : 1;
    const strokeOpacity = opts.ghost ? 0.85 : 1;
    // Cross-panel hover lights up both canvas rect and table row for the same
    // monitor via a subtle brightness bump — state-driven (not :hover) so it
    // fires when the sibling sees the hover.
    // Primary is pinned at (0, 0) by Windows, so we can't emit a plain
    // position update for it — instead we rely on `onLayoutShift` to
    // translate every *other* monitor inversely, which reads to the operator
    // as "the primary moved". Falls back to non-draggable when that callback
    // isn't wired.
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

    // Text label tier driven by rendered area. Using the rect area (not just
    // width) means very tall narrow portrait monitors don't get crammed with
    // text that won't fit.
    let labelContent: React.ReactNode = null;
    if (!opts.ghost) {
      const cx = x + rectW / 2;
      const cy = y + rectH / 2;
      const rotationSuffix = monitor.rotation ? `/${monitor.rotation}°` : '';
      // Show post-rotation (effective) dimensions so the label matches what
      // Windows actually treats the panel as — and matches the rect's aspect.
      // A 4K panel rotated 270° reads as 2160×3840, not 3840×2160.
      const effRes = effectiveDimensions(monitor);
      // labelMode='indexOnly' short-circuits the area-tier logic and forces
      // every rect to render only its index number. Used by compact previews
      // (card view) where the textual detail lives outside the canvas.
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

    // Star + "primary" badge sits in the top-left corner of the primary rect.
    // Uses the warm accent so it reads as the same "identity" signal as the
    // warm fill tint underneath, and never collides with the cyan selection
    // stroke on the rect border. Matches the amber star in the names list.
    // Suppressed in indexOnly mode — when the canvas is a compact preview the
    // primary indicator lives outside the rect (e.g. amber star in the names
    // list) so the in-rect badge would be redundant noise.
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

    // [A4.4] "Not connected" badge — top-right corner so it never collides
    // with the top-left primary star. Suppressed in indexOnly mode where
    // any in-rect text would crowd the index number.
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
          // Give the rect explicit keyboard focus on click. Without this,
          // SVG `<g>` elements don't receive focus on mouse activation in
          // Chrome / Edge even with tabIndex=0, so arrow-key nudging
          // (handleKeyDown below) would silently never fire — the key
          // events would land on `document.body` and we'd miss them.
          e.currentTarget.focus();
          handleRectClick(monitor.id);
        }
      : undefined;

    // Double-click opens the full monitor editor dialog when the panel is
    // in edit mode. Only wire the handler when the caller opts in —
    // otherwise a double-click degrades to two back-to-back selection
    // clicks, which is the read-only default.
    const handleGroupDoubleClick =
      clickable && onMonitorDoubleClick
        ? () => onMonitorDoubleClick(monitor.id)
        : undefined;

    // Clickable groups get button semantics + keyboard activation so
    // screen readers announce them as selectable and keyboard-only users
    // can cycle through and select monitors with Tab + Enter/Space. In
    // edit mode arrow keys nudge the focused rect by 1 virtual px (shift
    // for 10) — essential for precision on dense topologies where the
    // virtual↔CSS scale lets 1 CSS px represent 50+ virtual px. Nudging
    // the primary rotates through `onLayoutShift` (inverse delta) so the
    // data model keeps the primary pinned at (0, 0) — same contract as
    // drag.
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
            // Primary is pinned at (0, 0); visually "moving" it means
            // shifting every secondary by the inverse delta.
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
        // Suppress the browser's default focus outline on the <g>. The
        // rect's own cyan selection stroke is our focus affordance — the
        // UA ring on top of it reads as a second, mismatched border on
        // click. `tabIndex={0}` is still needed so keyboard users can
        // Tab through monitors and so arrow-key nudging receives the
        // focused rect's keydown events.
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

    // Inner dashed dividers: one per interior row/col boundary, rendered as
    // individual <line>s so stroke-dash spacing is uniform rather than being
    // chopped by the rect outline.
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

  // Pre-built SVG children. Memoizing these collapses the per-render work to
  // a reference-equality check when nothing changed — the common case during
  // the parent's slide-up/down animation, when React re-renders ancestors but
  // the display data itself is stable. Deps intentionally include every piece
  // of state `renderMonitor` / `renderGrid` reads so the cache is correct
  // (renderMonitor reads `onMonitorClick` directly to derive clickability,
  // in addition to dispatching through `handleRectClick`). The exhaustive-deps
  // lint rule can't see through the nested closures, hence the targeted
  // suppression.
  const ghostElements = useMemo(
    () => (ghostMonitors ?? []).map((m) => renderMonitor(m, { ghost: true })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ghostMonitors, projection, selectedMonitorId, hoveredMonitorId, onMonitorClick, onMonitorHover, handleRectClick, handleRectEnter, handleRectLeave, monitorIndexById, accentColor, driftedMonitorIds, labelMode, editable, onMonitorMove, onMonitorDoubleClick, onLayoutShift, handleRectPointerDown, handleRectPointerMove, handleRectPointerUp, staleEdidHashes],
  );
  // SVG paint order is document order, not z-index — there's no z-index for
  // SVG elements. So we render non-selected monitors first, then the selected
  // one, so the selection's stroke never gets clipped by an adjacent rect
  // that happens to come later in the input array. Stable order is preserved
  // for everything else, only the selected rect is hoisted.
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
 * Memoized public export. The parent (DisplayLayoutPanel, MachineCardView)
 * re-renders on unrelated state changes; shallow-compare prop equality lets
 * us skip the entire SVG rebuild when monitor data, selection, and callbacks
 * are all stable. Callers must pass stable `onMonitorClick` (useCallback) and
 * memoize `monitors` / `ghostMonitors` / `mosaicGrids` arrays where possible.
 */
export const DisplayCanvas = memo(DisplayCanvasImpl);
