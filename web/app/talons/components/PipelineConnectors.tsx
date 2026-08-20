'use client';

/**
 * Wiring between the three pipeline cards: trigger → condition → outputs (1 → 1 → N).
 * Condition→outputs is a fan — one elbow arm per output row — so N outputs read as N.
 *
 * Geometry is MEASURED, not derived from the box model: nodes carry `data-talon-node`
 * and the overlay walks them with getBoundingClientRect. The overlay is `absolute inset-0`
 * in the grid's relative wrapper, so its own rect is the coordinate origin. jsdom reports
 * every rect as zero, which is why `computeConnectorPaths` is exported and unit-tested
 * directly instead of asserting on a render.
 *
 * viewBox is the rendered pixel box (as in charts/DisplayCanvas.tsx) so stroke widths
 * don't scale with the dialog.
 *
 * Below `md` the grid is one column and this overlay is display:none; the stacked layout
 * uses `PipelineStackConnector`, since an absolute overlay can't know where the stacked
 * card boundaries fall.
 */

import { useLayoutEffect, useRef, useState } from 'react';

/** Arrowhead half-height / length, in px. */
const ARROW = 4;
/** Below this, two ends count as sharing a row and the elbow collapses. */
const SAME_ROW_EPSILON = 0.5;
/** Identical rects in a row before the open animation counts as finished. */
const SETTLE_STABLE_FRAMES = 2;
/** ~0.5s at 60fps. A box still moving after this is animating on a loop. */
const SETTLE_MAX_FRAMES = 30;

/** The subset of `DOMRect` the geometry reads. */
export interface ConnectorRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Measured nodes. Null means the element was not found in the DOM. */
export interface ConnectorNodes {
  trigger: ConnectorRect | null;
  condition: ConnectorRect | null;
  /**
   * Outputs card box. Fan arms terminate at this outer edge (at each row's height), not
   * at the rows' left edges — ending inside dragged every wire across the card border and
   * laid the elbow spine on top of it.
   */
  outputsCard: ConnectorRect | null;
  outputRows: ConnectorRect[];
}

/** One decimal is plenty at a 1.5px stroke, and keeps the `d` strings stable. */
function px(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Right-pointing chevron, two stroked lines off one moveto. Not an SVG marker: markers
 * inherit `fill`, not `stroke`, so it would need a second colour token kept in sync.
 */
function chevron(x: number, y: number): string {
  return `M ${px(x - ARROW)} ${px(y - ARROW)} L ${px(x)} ${px(y)} L ${px(x - ARROW)} ${px(y + ARROW)}`;
}

/** Elbow: out to the gap midpoint, across to the target row, in to its left edge.
 * Collapses to a straight run when both ends already share a row. */
function elbow(sx: number, sy: number, ex: number, ey: number): string {
  if (Math.abs(sy - ey) < SAME_ROW_EPSILON) return `M ${px(sx)} ${px(sy)} H ${px(ex)}`;
  const midX = (sx + ex) / 2;
  return `M ${px(sx)} ${px(sy)} H ${px(midX)} V ${px(ey)} H ${px(ex)}`;
}

/**
 * SVG `d` strings in draw order: trigger→condition, then one fan arm per output row.
 * All rects are viewport rects with `container` as the origin. Degenerate input — zero-size
 * container (jsdom / stacked layout), missing card, target not to the right of its source —
 * yields no path rather than a garbage one.
 */
export function computeConnectorPaths(
  container: ConnectorRect,
  nodes: ConnectorNodes,
): string[] {
  if (container.width <= 0 || container.height <= 0) return [];

  const { trigger, condition } = nodes;
  if (!trigger || !condition || trigger.width <= 0 || condition.width <= 0) return [];

  const toX = (value: number) => value - container.left;
  const toY = (value: number) => value - container.top;

  const paths: string[] = [];

  const triggerRight = toX(trigger.left + trigger.width);
  const conditionLeft = toX(condition.left);
  const conditionMidY = toY(condition.top + condition.height / 2);

  if (conditionLeft > triggerRight) {
    const triggerMidY = toY(trigger.top + trigger.height / 2);
    paths.push(
      `${elbow(triggerRight, triggerMidY, conditionLeft, conditionMidY)} ${chevron(conditionLeft, conditionMidY)}`,
    );
  }

  const conditionRight = toX(condition.left + condition.width);
  const card = nodes.outputsCard;
  const cardLeft = card && card.width > 0 && card.height > 0 ? toX(card.left) : null;
  for (const row of nodes.outputRows) {
    if (row.width <= 0 || row.height <= 0) continue;
    // Card edge keeps wiring in the gutter; row edge only when the card is missing.
    const endX = cardLeft ?? toX(row.left);
    if (endX <= conditionRight) continue;
    const rowMidY = toY(row.top + row.height / 2);
    paths.push(
      `${elbow(conditionRight, conditionMidY, endX, rowMidY)} ${chevron(endX, rowMidY)}`,
    );
  }

  return paths;
}

interface PipelineConnectorsProps {
  /** Row count: a ResizeObserver alone misses an added/removed row, so this re-runs the
   * measurement and re-attaches the observer. */
  outputCount: number;
}

export function PipelineConnectors({ outputCount }: PipelineConnectorsProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [paths, setPaths] = useState<string[]>([]);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const wrapper = el.parentElement;
    if (!wrapper) return;

    // Queried per measurement, never captured: a detached node still answers
    // getBoundingClientRect() with all zeros, which read as "row has no size" and silently
    // dropped its arm. Applying a template hit this — it swaps an output's type without
    // changing the count, so the effect below never re-ran.
    const findNodes = () => Array.from(wrapper.querySelectorAll('[data-talon-node]'));

    const measure = () => {
      const nodeEls = findNodes();
      const container = el.getBoundingClientRect();

      let trigger: ConnectorRect | null = null;
      let condition: ConnectorRect | null = null;
      let outputsCard: ConnectorRect | null = null;
      const outputRows: ConnectorRect[] = [];
      for (const node of nodeEls) {
        const rect = node.getBoundingClientRect();
        switch (node.getAttribute('data-talon-node')) {
          case 'trigger-card':
            trigger = rect;
            break;
          case 'condition-card':
            condition = rect;
            break;
          case 'outputs-card':
            outputsCard = rect;
            break;
          case 'output-row':
            outputRows.push(rect);
            break;
        }
      }

      const width = Math.round(container.width);
      const height = Math.round(container.height);
      setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));

      const next = computeConnectorPaths(container, { trigger, condition, outputsCard, outputRows });
      setPaths((prev) =>
        prev.length === next.length && prev.every((d, i) => d === next[i]) ? prev : next,
      );
    };

    // Measured before paint so the first frame already has connectors.
    measure();

    // ...then per frame until the rect repeats. The dialog opens with a transform
    // (Radix `zoom-in-95`), which changes getBoundingClientRect() but not the border-box,
    // so no ResizeObserver fires and the measurement above sticks at 95% — every arm lands
    // a gutter short. Bounded so a looping animation can't pin the rAF loop.
    let frame = 0;
    let elapsed = 0;
    let previous = '';
    let repeats = 0;
    const settle = () => {
      const { left, top, width, height } = el.getBoundingClientRect();
      const key = `${left}|${top}|${width}|${height}`;
      if (key === previous) {
        repeats += 1;
      } else {
        previous = key;
        repeats = 0;
        measure();
      }
      if (repeats >= SETTLE_STABLE_FRAMES || (elapsed += 1) > SETTLE_MAX_FRAMES) return;
      frame = requestAnimationFrame(settle);
    };
    frame = requestAnimationFrame(settle);

    // Every node, not just the overlay: a row that grows (email → hoot swaps a hint for a
    // textarea) shifts rows below it without changing the overlay's own box.
    const observer = new ResizeObserver(measure);
    const observeAll = () => {
      observer.disconnect();
      observer.observe(el);
      for (const node of findNodes()) observer.observe(node);
      measure();
    };
    observeAll();

    // Re-point on subtree rebuild: a swapped output row is a new element, and the old
    // observer would keep reporting on a detached node.
    const mutations = new MutationObserver(observeAll);
    mutations.observe(wrapper, { childList: true, subtree: true });

    return () => {
      cancelAnimationFrame(frame);
      mutations.disconnect();
      observer.disconnect();
    };
  }, [outputCount]);

  const drawable = size.width > 0 && size.height > 0 && paths.length > 0;

  return (
    <div ref={containerRef} className="pointer-events-none absolute inset-0 hidden md:block">
      {drawable && (
        <svg
          width={size.width}
          height={size.height}
          viewBox={`0 0 ${size.width} ${size.height}`}
          aria-hidden="true"
          className="stroke-border"
        >
          <g fill="none" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
            {paths.map((d) => (
              <path key={d} d={d} />
            ))}
          </g>
        </svg>
      )}
    </div>
  );
}

/** Stacked-layout connector: a grid item between two cards, hidden at `md` and up. */
export function PipelineStackConnector() {
  return (
    <div aria-hidden="true" className="flex justify-center md:hidden">
      <span className="h-4 w-px bg-border" />
    </div>
  );
}
