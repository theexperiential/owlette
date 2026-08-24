/** @jest-environment node */

/**
 * Geometry for the talon pipeline's connector overlay.
 *
 * The component is untestable in jsdom — every `getBoundingClientRect` returns zeros, so
 * a rendered assertion would only prove nothing is drawn. `computeConnectorPaths` is
 * exported to pin the MATH: one arrow trigger → condition, one elbow per output row.
 */
import { computeConnectorPaths, type ConnectorRect } from '@/app/talons/components/PipelineConnectors';

/** The overlay box: 900 × 300 at viewport (100, 50). */
const CONTAINER: ConnectorRect = { left: 100, top: 50, width: 900, height: 300 };

/** Three equal-height columns with a 20px gap, matching the md grid. */
const TRIGGER: ConnectorRect = { left: 100, top: 50, width: 286, height: 300 };
const CONDITION: ConnectorRect = { left: 406, top: 50, width: 286, height: 300 };
const OUTPUTS_LEFT = 712;
const OUTPUTS_CARD: ConnectorRect = { left: OUTPUTS_LEFT, top: 50, width: 286, height: 300 };

/**
 * `count` output rows stacked down the outputs column, 40px tall, 8px apart —
 * INSET 20px from the card edge, like the card's real padding. Arms must stop
 * at the card edge (x 612 in container coords), never travel to the rows.
 */
function outputRows(count: number): ConnectorRect[] {
  return Array.from({ length: count }, (_, i) => ({
    left: OUTPUTS_LEFT + 20,
    top: 90 + i * 48,
    width: 254,
    height: 40,
  }));
}

/** Terminal point of a path — the chevron's tip, which is its last `L`. */
function terminus(d: string): { x: number; y: number } {
  const points = [...d.matchAll(/L (-?[\d.]+) (-?[\d.]+)/g)];
  const tip = points[points.length - 2];
  return { x: Number(tip[1]), y: Number(tip[2]) };
}

describe('computeConnectorPaths', () => {
  it('draws only the trigger → condition arrow when there are no output rows', () => {
    const paths = computeConnectorPaths(CONTAINER, {
      trigger: TRIGGER,
      condition: CONDITION,
      outputsCard: OUTPUTS_CARD,
      outputRows: [],
    });

    expect(paths).toHaveLength(1);
    // Both cards share a vertical centre, so the elbow collapses to a run.
    expect(paths[0]).toContain('M 286 150 H 306');
    expect(terminus(paths[0])).toEqual({ x: 306, y: 150 });
  });

  it('lands the single-output arm on that row centre, not the card centre', () => {
    const [, fan] = computeConnectorPaths(CONTAINER, {
      trigger: TRIGGER,
      condition: CONDITION,
      outputsCard: OUTPUTS_CARD,
      outputRows: outputRows(1),
    });

    // Row spans 90..130 in viewport coords → centre 110 → container y 60.
    expect(terminus(fan)).toEqual({ x: 612, y: 60 });
    // It leaves the condition card at that card's centre and elbows across.
    expect(fan.startsWith('M 592 150 H 602 V 60 H 612')).toBe(true);
  });

  it('fans one arm per output row, each terminating at a distinct height', () => {
    const paths = computeConnectorPaths(CONTAINER, {
      trigger: TRIGGER,
      condition: CONDITION,
      outputsCard: OUTPUTS_CARD,
      outputRows: outputRows(3),
    });

    expect(paths).toHaveLength(4);
    const fanEnds = paths.slice(1).map(terminus);
    expect(fanEnds.map((point) => point.y)).toEqual([60, 108, 156]);
    // Every arm ends on the same left edge — only the height varies.
    expect(new Set(fanEnds.map((point) => point.x))).toEqual(new Set([612]));
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('shares one source point across the fan, so the arms read as a branch', () => {
    const paths = computeConnectorPaths(CONTAINER, {
      trigger: TRIGGER,
      condition: CONDITION,
      outputsCard: OUTPUTS_CARD,
      outputRows: outputRows(3),
    });

    for (const path of paths.slice(1)) {
      expect(path.startsWith('M 592 150 ')).toBe(true);
    }
  });

  it.each<{ label: string; container: ConnectorRect; trigger: ConnectorRect }>([
    {
      // What jsdom reports, and what the stacked layout's display:none overlay
      // reports in a real browser.
      label: 'a zero-size container',
      container: { left: 0, top: 0, width: 0, height: 0 },
      trigger: TRIGGER,
    },
    { label: 'a card that has not been laid out', container: CONTAINER, trigger: { ...TRIGGER, width: 0 } },
  ])('draws nothing for $label', ({ container, trigger }) => {
    expect(
      computeConnectorPaths(container, {
        trigger,
        condition: CONDITION,
        outputsCard: OUTPUTS_CARD,
        outputRows: outputRows(2),
      }),
    ).toEqual([]);
  });

  it('draws nothing when a card is missing from the dom', () => {
    expect(
      computeConnectorPaths(CONTAINER, {
        trigger: null,
        condition: CONDITION,
        outputsCard: OUTPUTS_CARD,
        outputRows: outputRows(2),
      }),
    ).toEqual([]);
  });

  it('skips a target that does not sit to the right of its source', () => {
    // The stacked (<md) layout, where every column shares a left edge.
    const stacked = { ...CONDITION, left: TRIGGER.left };
    const paths = computeConnectorPaths(CONTAINER, {
      trigger: TRIGGER,
      condition: stacked,
      outputsCard: { ...OUTPUTS_CARD, left: TRIGGER.left },
      outputRows: [{ left: TRIGGER.left, top: 90, width: 274, height: 40 }],
    });

    expect(paths).toEqual([]);
  });

  it('falls back to the row edge only when the outputs card is missing', () => {
    const [, fan] = computeConnectorPaths(CONTAINER, {
      trigger: TRIGGER,
      condition: CONDITION,
      outputsCard: null,
      outputRows: outputRows(1),
    });

    // Rows are inset 20px past the card edge — 612 with the card, 632 without.
    expect(terminus(fan).x).toBe(632);
  });

  it('ignores a row that has not been laid out yet', () => {
    const paths = computeConnectorPaths(CONTAINER, {
      trigger: TRIGGER,
      condition: CONDITION,
      outputsCard: OUTPUTS_CARD,
      outputRows: [...outputRows(1), { left: OUTPUTS_LEFT, top: 90, width: 274, height: 0 }],
    });

    expect(paths).toHaveLength(2);
  });
});
