import { describe, expect, it } from 'vitest'
import {
  clampSidebarWidth,
  layoutForDrag,
  layoutForKey,
  sidebarColumnWidth,
  SIDEBAR_COLLAPSE_AT,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_KEY_STEP,
  SIDEBAR_KEY_STEP_COARSE,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_RAIL_WIDTH,
} from './sidebarWidth'
// The host re-clamps on the way to disk, so these bounds must match its numbers
// or the divider offers a width that is silently rewritten next launch.
import windowStateRs from '../../src-tauri/src/window_state.rs?raw'

/** Read a `pub const NAME: f64 = 123.0;` out of the rust module. */
function rustConst(name: string): number {
  const match = new RegExp(`pub const ${name}: f64 = ([0-9_.]+);`).exec(windowStateRs)
  if (!match) throw new Error(`${name} is no longer declared in window_state.rs`)
  return Number(match[1].replace(/_/g, ''))
}

const expanded = (width: number) => ({ collapsed: false, width })
const collapsed = (width: number) => ({ collapsed: true, width })

describe('bounds', () => {
  it('matches the clamp the host applies', () => {
    expect(SIDEBAR_MIN_WIDTH).toBe(rustConst('MIN_SIDEBAR_WIDTH'))
    expect(SIDEBAR_MAX_WIDTH).toBe(rustConst('MAX_SIDEBAR_WIDTH'))
    expect(SIDEBAR_DEFAULT_WIDTH).toBe(rustConst('DEFAULT_SIDEBAR_WIDTH'))
  })

  it('collapses well before the rail is reached', () => {
    // The snap must fire while the pointer is still moving: a threshold at or
    // below the rail width means dragging into an already-rail-narrow column.
    expect(SIDEBAR_COLLAPSE_AT).toBeGreaterThan(SIDEBAR_RAIL_WIDTH)
    expect(SIDEBAR_COLLAPSE_AT).toBeLessThan(SIDEBAR_MIN_WIDTH)
  })
})

describe('clampSidebarWidth', () => {
  it('keeps a width inside the range', () => {
    expect(clampSidebarWidth(300)).toBe(300)
    expect(clampSidebarWidth(SIDEBAR_MIN_WIDTH)).toBe(SIDEBAR_MIN_WIDTH)
    expect(clampSidebarWidth(SIDEBAR_MAX_WIDTH)).toBe(SIDEBAR_MAX_WIDTH)
  })

  it('clamps either end', () => {
    expect(clampSidebarWidth(0)).toBe(SIDEBAR_MIN_WIDTH)
    expect(clampSidebarWidth(-4000)).toBe(SIDEBAR_MIN_WIDTH)
    expect(clampSidebarWidth(4000)).toBe(SIDEBAR_MAX_WIDTH)
  })

  it('rounds to whole pixels and refuses nonsense', () => {
    expect(clampSidebarWidth(301.4)).toBe(301)
    expect(clampSidebarWidth(301.6)).toBe(302)
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT_WIDTH)
    expect(clampSidebarWidth(Number.POSITIVE_INFINITY)).toBe(SIDEBAR_DEFAULT_WIDTH)
  })
})

describe('sidebarColumnWidth', () => {
  it('is the rail while collapsed and the width otherwise', () => {
    expect(sidebarColumnWidth(expanded(288))).toBe(288)
    expect(sidebarColumnWidth(collapsed(288))).toBe(SIDEBAR_RAIL_WIDTH)
  })
})

describe('layoutForDrag', () => {
  it('measures from where the gesture started', () => {
    expect(layoutForDrag(expanded(288), 40)).toEqual(expanded(328))
    expect(layoutForDrag(expanded(288), -40)).toEqual(expanded(248))
    expect(layoutForDrag(expanded(288), 0)).toEqual(expanded(288))
  })

  it('holds at either end of the expanded range', () => {
    expect(layoutForDrag(expanded(288), -100)).toEqual(expanded(SIDEBAR_MIN_WIDTH))
    expect(layoutForDrag(expanded(288), 1000)).toEqual(expanded(SIDEBAR_MAX_WIDTH))
  })

  it('collapses once the pointer crosses the threshold', () => {
    expect(layoutForDrag(expanded(288), -(288 - SIDEBAR_COLLAPSE_AT))).toEqual(
      expanded(SIDEBAR_MIN_WIDTH),
    )
    expect(layoutForDrag(expanded(288), -1000)).toEqual(collapsed(288))
  })

  it('keeps the expanded width to come back to', () => {
    // Collapsing is not a resize — expanding restores the dragged-to width, now or
    // three launches later.
    const gesture = layoutForDrag(expanded(352), -1000)
    expect(gesture).toEqual(collapsed(352))
    expect(layoutForDrag(gesture, 1000)).toEqual(expanded(SIDEBAR_MAX_WIDTH))
  })

  it('expands again inside the same gesture', () => {
    // Out of the rail: measured from the rail's own width, so crossing the
    // threshold lands at the minimum and grows from there.
    expect(layoutForDrag(collapsed(288), SIDEBAR_COLLAPSE_AT - SIDEBAR_RAIL_WIDTH)).toEqual(
      expanded(SIDEBAR_MIN_WIDTH),
    )
    expect(layoutForDrag(collapsed(288), 300 - SIDEBAR_RAIL_WIDTH)).toEqual(expanded(300))
    expect(layoutForDrag(collapsed(288), 4)).toEqual(collapsed(288))
  })
})

describe('layoutForKey', () => {
  it('nudges by a step, or a coarse step with shift', () => {
    expect(layoutForKey(expanded(288), 'ArrowRight')).toEqual(expanded(288 + SIDEBAR_KEY_STEP))
    expect(layoutForKey(expanded(288), 'ArrowLeft')).toEqual(expanded(288 - SIDEBAR_KEY_STEP))
    expect(layoutForKey(expanded(288), 'ArrowRight', true)).toEqual(
      expanded(288 + SIDEBAR_KEY_STEP_COARSE),
    )
  })

  it('jumps to either end, and the far left is the rail', () => {
    expect(layoutForKey(expanded(288), 'Home')).toEqual(collapsed(288))
    expect(layoutForKey(expanded(288), 'End')).toEqual(expanded(SIDEBAR_MAX_WIDTH))
  })

  it('collapses off the left edge and expands back to the remembered width', () => {
    expect(layoutForKey(expanded(SIDEBAR_MIN_WIDTH), 'ArrowLeft')).toEqual(
      collapsed(SIDEBAR_MIN_WIDTH),
    )
    expect(layoutForKey(collapsed(352), 'ArrowRight')).toEqual(expanded(352))
  })

  it('leaves keys it does not handle to whoever else wants them', () => {
    expect(layoutForKey(expanded(288), 'Tab')).toBeNull()
    expect(layoutForKey(expanded(288), 'ArrowUp')).toBeNull()
    expect(layoutForKey(expanded(288), 'Enter')).toBeNull()
    // There is nothing to the left of the rail.
    expect(layoutForKey(collapsed(288), 'ArrowLeft')).toBeNull()
  })
})
