'use client';

/**
 * Presentational wiring between the three pipeline cards — trigger → condition
 * → outputs. No drag, no zoom, no persisted positions: it draws the graph and
 * gets out of the way.
 *
 * The shape is 1 → 1 → N. Trigger to condition is a single arrow; condition to
 * outputs is a FAN, one elbow arrow per output row, so a talon with three
 * outputs reads as three outputs at a glance rather than as one arrow pointing
 * at a stack.
 *
 * Geometry is MEASURED, not derived from the grid's box model: every card and
 * every output row carries a `data-talon-node` attribute, and the overlay walks
 * them with `getBoundingClientRect`. The overlay is `absolute inset-0` inside
 * the grid's `relative` wrapper, so its own rect is the coordinate origin —
 * subtracting it turns viewport coords into container coords with no ref
 * threading. `computeConnectorPaths` is exported and unit-tested on its own,
 * because in jsdom every rect is zero and a rendered assertion would prove
 * nothing.
 *
 * Sizing follows `DisplayCanvas` (charts/DisplayCanvas.tsx:12-17): the viewBox
 * is set to the rendered pixel box, so stroke widths stay visually constant
 * instead of scaling with the dialog.
 *
 * Below `md` the grid collapses to one column and this overlay is display:none
 * (every rect reports 0 and nothing is drawn). The stacked layout gets
 * `PipelineStackConnector` instead — a short vertical rule rendered as a grid
 * item between the cards, since an absolute overlay cannot know where the card
 * boundaries fall once they are stacked.
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
   * The outputs card's own box. Fan arms terminate HERE — at the card's outer
   * edge, at each row's height — not at the rows' left edges inside the card.
   * Ending inside the card dragged every wire across the card border and put
   * the elbow spine right on top of it; ending at the card edge keeps the
   * whole fan in the gutter between sections, where it reads as wiring.
   */
  outputsCard: ConnectorRect | null;
  outputRows: ConnectorRect[];
}

/** One decimal is plenty at a 1.5px stroke, and keeps the `d` strings stable. */
function px(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Right-pointing chevron at a terminus, stroked as two lines off a single
 * moveto. Deliberately not an SVG marker: markers inherit `fill`, not
 * `stroke`, so a `stroke-border` arrowhead would need a second colour token
 * kept in sync by hand.
 */
function chevron(x: number, y: number): string {
  return `M ${px(x - ARROW)} ${px(y - ARROW)} L ${px(x)} ${px(y)} L ${px(x - ARROW)} ${px(y + ARROW)}`;
}

/**
 * Elbow from a source to a target: out horizontally to the midpoint of the
 * gap, across to the target's row, then in to its left edge. Collapses to a
 * straight run when the two ends already share a row.
 */
function elbow(sx: number, sy: number, ex: number, ey: number): string {
  if (Math.abs(sy - ey) < SAME_ROW_EPSILON) return `M ${px(sx)} ${px(sy)} H ${px(ex)}`;
  const midX = (sx + ex) / 2;
  return `M ${px(sx)} ${px(sy)} H ${px(midX)} V ${px(ey)} H ${px(ex)}`;
}

/**
 * The connector paths for one measurement, as SVG `d` strings in draw order:
 * trigger → condition first, then one fan arm per output row.
 *
 * All rects are viewport rects; `container` is the origin. Degenerate input —
 * a zero-size container (jsdom, or the stacked layout where the overlay is
 * display:none), a missing card, or a target that does not sit to the right of
 * its source — yields no path rather than a garbage one.
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
    // Terminate at the card edge (gutter-only wiring); fall back to the row's
    // own edge only when the card was not found.
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
  /**
   * How many output rows are rendered. Adding or removing a row moves every
   * terminus below it, and a ResizeObserver alone would miss the new row —
   * this re-runs the measurement and re-attaches the observer.
   */
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

    /*
     * Queried per measurement, never captured once.
     *
     * A node set captured on mount goes stale the moment React replaces an
     * element, and a DETACHED node still answers getBoundingClientRect() — with
     * all zeros. That read like "this row has no size", so the arm to it was
     * skipped and the fan silently lost a wire. Applying a template did exactly
     * this: it swaps an output's TYPE without changing the output COUNT, so the
     * effect below never re-ran, and the row element it was holding had already
     * been thrown away.
     */
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

    // Measured before paint so the first frame already has the connectors.
    measure();

    /*
     * ...and then again until the box stops moving.
     *
     * The dialog animates OPEN with a transform (Radix's `zoom-in-95`). A
     * transform changes what `getBoundingClientRect()` reports but NOT the
     * element's border-box size, so a ResizeObserver never fires for it — the
     * measurement above is taken mid-animation, at 95%, and stays that way for
     * the life of the dialog. Every arm then lands about a gutter short of the
     * card it points at.
     *
     * The tell was that it looked correct with two or more outputs: changing
     * `outputCount` re-runs this effect, which re-measures after the animation
     * has finished. One output meant one measurement, taken at the wrong moment.
     *
     * So: re-measure per frame until the container's rect repeats, then stop.
     * Bounded because a never-settling box (a looping animation) must not pin a
     * rAF loop for the life of the dialog.
     */
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

    // Every node, not just the overlay: a row that grows (email → hoot swaps a
    // hint line for a textarea) shifts the rows below it without changing the
    // overlay's own box, since the grid row is sized by the tallest card.
    const observer = new ResizeObserver(measure);
    const observeAll = () => {
      observer.disconnect();
      observer.observe(el);
      for (const node of findNodes()) observer.observe(node);
      measure();
    };
    observeAll();

    // Re-point the observer whenever the card subtree is rebuilt — a swapped
    // output row is a NEW element, and an observer still watching the old one
    // reports on a node nobody can see.
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

/**
 * Stacked-layout connector. Rendered as a grid item between two cards and
 * hidden at `md` and up, where `PipelineConnectors` takes over.
 */
export function PipelineStackConnector() {
  return (
    <div aria-hidden="true" className="flex justify-center md:hidden">
      <span className="h-4 w-px bg-border" />
    </div>
  );
}
