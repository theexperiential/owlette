import { describe, expect, it } from 'vitest'
import {
  clampSidebarWidth,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_KEY_STEP,
  SIDEBAR_KEY_STEP_COARSE,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  widthForDrag,
  widthForKey,
} from './sidebarWidth'
// The host clamps again on the way to disk; these two sets of bounds have to be
// the same numbers or the divider would offer a width that is silently rewritten
// on the next launch.
import windowStateRs from '../../src-tauri/src/window_state.rs?raw'

/** Read a `pub const NAME: f64 = 123.0;` out of the rust module. */
function rustConst(name: string): number {
  const match = new RegExp(`pub const ${name}: f64 = ([0-9_.]+);`).exec(windowStateRs)
  if (!match) throw new Error(`${name} is no longer declared in window_state.rs`)
  return Number(match[1].replace(/_/g, ''))
}

describe('bounds', () => {
  it('matches the clamp the host applies', () => {
    expect(SIDEBAR_MIN_WIDTH).toBe(rustConst('MIN_SIDEBAR_WIDTH'))
    expect(SIDEBAR_MAX_WIDTH).toBe(rustConst('MAX_SIDEBAR_WIDTH'))
    expect(SIDEBAR_DEFAULT_WIDTH).toBe(rustConst('DEFAULT_SIDEBAR_WIDTH'))
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

describe('widthForDrag', () => {
  it('measures from where the gesture started', () => {
    expect(widthForDrag(288, 40)).toBe(328)
    expect(widthForDrag(288, -40)).toBe(248)
    expect(widthForDrag(288, 0)).toBe(288)
  })

  it('parks at the minimum instead of collapsing, however far the pointer runs', () => {
    expect(widthForDrag(288, -1000)).toBe(SIDEBAR_MIN_WIDTH)
    expect(widthForDrag(288, 1000)).toBe(SIDEBAR_MAX_WIDTH)
  })

  it('follows the pointer back after an overshoot', () => {
    // The width is derived from the start, not accumulated, so a pointer that
    // ran 1000 px past the end and came back to +20 lands on +20.
    expect(widthForDrag(288, 20)).toBe(308)
  })
})

describe('widthForKey', () => {
  it('nudges by a step, or a coarse step with shift', () => {
    expect(widthForKey(288, 'ArrowRight')).toBe(288 + SIDEBAR_KEY_STEP)
    expect(widthForKey(288, 'ArrowLeft')).toBe(288 - SIDEBAR_KEY_STEP)
    expect(widthForKey(288, 'ArrowRight', true)).toBe(288 + SIDEBAR_KEY_STEP_COARSE)
  })

  it('jumps to either end', () => {
    expect(widthForKey(288, 'Home')).toBe(SIDEBAR_MIN_WIDTH)
    expect(widthForKey(288, 'End')).toBe(SIDEBAR_MAX_WIDTH)
  })

  it('clamps like a drag does', () => {
    expect(widthForKey(SIDEBAR_MIN_WIDTH, 'ArrowLeft')).toBe(SIDEBAR_MIN_WIDTH)
    expect(widthForKey(SIDEBAR_MAX_WIDTH, 'ArrowRight')).toBe(SIDEBAR_MAX_WIDTH)
  })

  it('leaves keys it does not handle to whoever else wants them', () => {
    expect(widthForKey(288, 'Tab')).toBeNull()
    expect(widthForKey(288, 'ArrowUp')).toBeNull()
    expect(widthForKey(288, 'Enter')).toBeNull()
  })
})
