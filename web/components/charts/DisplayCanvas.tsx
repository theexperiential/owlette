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
   * Label rendering mode. `auto` (default) picks the label tier based on
   * rendered rect area: full info for big rects, abbreviated for medium,
   * just the index number for small. `indexOnly` forces every rect to show
   * just its index number — useful for compact previews where the textual
   * detail lives outside the canvas.
   */
  labelMode?: 'auto' | 'indexOnly';
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
  labelMode = 'auto',
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
    const fillOpacity = opts.ghost ? 0.4 : 1;
    const strokeOpacity = opts.ghost ? 0.85 : 1;
    // Cross-panel hover lights up both canvas rect and table row for the same
    // monitor via a subtle brightness bump — state-driven (not :hover) so it
    // fires when the sibling sees the hover.
    const rectStyle: React.CSSProperties = {
      cursor: clickable ? 'pointer' : 'default',
      filter: isHovered ? 'brightness(1.15)' : undefined,
      transition: 'filter 120ms ease',
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

    return (
      <g
        key={`${opts.ghost ? 'ghost-' : ''}${monitor.id}`}
        onClick={clickable ? () => handleRectClick(monitor.id) : undefined}
        onMouseEnter={hoverable ? () => handleRectEnter(monitor.id) : undefined}
        onMouseLeave={hoverable ? handleRectLeave : undefined}
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
    [ghostMonitors, projection, selectedMonitorId, hoveredMonitorId, onMonitorClick, onMonitorHover, handleRectClick, handleRectEnter, handleRectLeave, monitorIndexById, accentColor, driftedMonitorIds, labelMode],
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
  }, [monitors, projection, selectedMonitorId, hoveredMonitorId, onMonitorClick, onMonitorHover, handleRectClick, handleRectEnter, handleRectLeave, monitorIndexById, accentColor, driftedMonitorIds, labelMode]);
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
