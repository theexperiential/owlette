/**
 * Geometry of the resizable process-list sidebar, including the icon rail it
 * collapses to.
 *
 * The numbers here are mirrored in `src-tauri/src/window_state.rs`, which is the
 * authority — it clamps again on the way to disk, so a bug on this side can make
 * the drag feel wrong but can never persist a width the divider cannot produce.
 *
 * The list has two shapes, not one range: an expanded column between the bounds
 * below, and a fixed-width rail of icons. Dragging the divider left past
 * {@link SIDEBAR_COLLAPSE_AT} snaps to the rail — the same gesture VS Code's
 * sidebar uses — and dragging back out restores the width the operator had
 * before, which is why {@link SidebarLayout} keeps that width while collapsed
 * rather than overwriting it with the rail's.
 */

export const SIDEBAR_MIN_WIDTH = 200
export const SIDEBAR_MAX_WIDTH = 400
/** `w-72` — what the sidebar measured before it became resizable. */
export const SIDEBAR_DEFAULT_WIDTH = 288

/**
 * The collapsed rail: one column of 32 px icon targets with 8 px either side.
 * Wide enough for a comfortable click, narrow enough that the detail pane gets
 * effectively the whole window.
 */
export const SIDEBAR_RAIL_WIDTH = 48

/**
 * Drag the divider below this and the list collapses.
 *
 * Deliberately well above the rail's own width: the snap has to happen while
 * the pointer is still travelling, so it reads as the list *choosing* to
 * collapse rather than as a column that got squashed. Below the minimum width,
 * so no ordinary resize ever crosses it by accident.
 */
export const SIDEBAR_COLLAPSE_AT = 120

/** Keyboard nudge, and the coarse step when shift is held. */
export const SIDEBAR_KEY_STEP = 8
export const SIDEBAR_KEY_STEP_COARSE = 32

/**
 * What the sidebar looks like: collapsed or not, and how wide it is when it is
 * not. `width` is meaningful in both states — while collapsed it is what the
 * list will expand back to.
 */
export interface SidebarLayout {
  collapsed: boolean
  width: number
}

/**
 * Round and clamp a width into the range the expanded column offers.
 *
 * Whole pixels only: the width lands in an inline style and in a JSON file, and
 * a fractional column edge blurs the 1 px divider line on a fractional-scale
 * display.
 */
export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)))
}

/** How many pixels the column actually occupies in either state. */
export function sidebarColumnWidth(layout: SidebarLayout): number {
  return layout.collapsed ? SIDEBAR_RAIL_WIDTH : layout.width
}

/**
 * The layout for a drag that began at `start` and has travelled `deltaX`.
 *
 * Measured from where the gesture started rather than accumulated per move, so
 * a pointer that runs past either end and comes back lands exactly where it
 * points instead of trailing by however far it overshot. That also makes the
 * collapse reversible inside one gesture: dragging back out past the threshold
 * expands again without letting go.
 */
export function layoutForDrag(start: SidebarLayout, deltaX: number): SidebarLayout {
  const pointed = sidebarColumnWidth(start) + deltaX
  if (pointed < SIDEBAR_COLLAPSE_AT) {
    // The expanded width is left as it was: it is what "expand" restores.
    return { collapsed: true, width: start.width }
  }
  return { collapsed: false, width: clampSidebarWidth(pointed) }
}

/**
 * The layout after a keyboard nudge on the divider, or null for a key we do not
 * handle — the caller uses that to decide whether to swallow the event.
 *
 * The rail is the far left of the range, so `Home` collapses and a left arrow
 * from the minimum width does too; a right arrow out of the rail restores the
 * remembered width rather than the minimum.
 */
export function layoutForKey(
  layout: SidebarLayout,
  key: string,
  coarse = false,
): SidebarLayout | null {
  const step = coarse ? SIDEBAR_KEY_STEP_COARSE : SIDEBAR_KEY_STEP
  switch (key) {
    case 'ArrowLeft':
      if (layout.collapsed) return null
      return layout.width <= SIDEBAR_MIN_WIDTH
        ? { collapsed: true, width: layout.width }
        : { collapsed: false, width: clampSidebarWidth(layout.width - step) }
    case 'ArrowRight':
      return layout.collapsed
        ? { collapsed: false, width: clampSidebarWidth(layout.width) }
        : { collapsed: false, width: clampSidebarWidth(layout.width + step) }
    case 'Home':
      return { collapsed: true, width: layout.width }
    case 'End':
      return { collapsed: false, width: SIDEBAR_MAX_WIDTH }
    default:
      return null
  }
}
