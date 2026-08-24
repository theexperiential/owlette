/**
 * Geometry of the resizable process-list sidebar and the icon rail it collapses
 * to. These numbers are mirrored in `src-tauri/src/window_state.rs`, which is the
 * AUTHORITY — it clamps again before writing to disk.
 *
 * Two shapes, not one range: an expanded column between the bounds below, and a
 * fixed rail. Dragging past {@link SIDEBAR_COLLAPSE_AT} snaps to the rail;
 * dragging back out restores the previous width, which is why
 * {@link SidebarLayout} keeps `width` while collapsed.
 */

export const SIDEBAR_MIN_WIDTH = 200
export const SIDEBAR_MAX_WIDTH = 400
/** `w-72` — what the sidebar measured before it became resizable. */
export const SIDEBAR_DEFAULT_WIDTH = 288

/** Collapsed rail: 32px icon targets with 8px either side. */
export const SIDEBAR_RAIL_WIDTH = 48

/**
 * Collapse threshold. Well above the rail width so the snap fires while the
 * pointer is still moving, and below SIDEBAR_MIN_WIDTH so an ordinary resize
 * never crosses it by accident.
 */
export const SIDEBAR_COLLAPSE_AT = 120

/** Keyboard nudge, and the coarse step when shift is held. */
export const SIDEBAR_KEY_STEP = 8
export const SIDEBAR_KEY_STEP_COARSE = 32

/** `width` is meaningful in both states: while collapsed it is the expand-back
 *  target. */
export interface SidebarLayout {
  collapsed: boolean
  width: number
}

/**
 * Round and clamp into the expanded column's range. Whole pixels only — a
 * fractional edge blurs the 1px divider on a fractional-scale display.
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
 * Layout for a drag from `start` that has travelled `deltaX`. Measured from the
 * gesture origin, not accumulated per move, so overshooting an end and coming
 * back lands exactly on the pointer — and makes collapse reversible mid-gesture.
 */
export function layoutForDrag(start: SidebarLayout, deltaX: number): SidebarLayout {
  const pointed = sidebarColumnWidth(start) + deltaX
  if (pointed < SIDEBAR_COLLAPSE_AT) {
    // Keep the expanded width — it is what "expand" restores.
    return { collapsed: true, width: start.width }
  }
  return { collapsed: false, width: clampSidebarWidth(pointed) }
}

/**
 * Layout after a keyboard nudge, or null for an unhandled key (the caller uses
 * that to decide whether to swallow the event).
 *
 * The rail is the far left of the range: `Home` and a left arrow at minimum width
 * both collapse; a right arrow out of the rail restores the remembered width.
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
