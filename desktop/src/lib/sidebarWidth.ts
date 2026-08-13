/**
 * Geometry of the resizable process-list sidebar.
 *
 * The numbers here are mirrored in `src-tauri/src/window_state.rs`, which is the
 * authority — it clamps again on the way to disk, so a bug on this side can make
 * the drag feel wrong but can never persist a width the divider cannot produce.
 *
 * The lower bound doubles as the collapse affordance: dragging the divider all
 * the way left parks the list at its narrowest useful width rather than hiding
 * it, which keeps the process rows (and the selection) reachable with no second
 * control to discover.
 */

export const SIDEBAR_MIN_WIDTH = 200
export const SIDEBAR_MAX_WIDTH = 400
/** `w-72` — what the sidebar measured before it became resizable. */
export const SIDEBAR_DEFAULT_WIDTH = 288

/** Keyboard nudge, and the coarse step when shift is held. */
export const SIDEBAR_KEY_STEP = 8
export const SIDEBAR_KEY_STEP_COARSE = 32

/**
 * Round and clamp a width into the range the divider offers.
 *
 * Whole pixels only: the width lands in an inline style and in a JSON file, and
 * a fractional column edge blurs the 1 px divider line on a fractional-scale
 * display.
 */
export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)))
}

/**
 * Width for a drag that began at `startWidth` and has travelled `deltaX`.
 *
 * Measured from where the gesture started rather than accumulated per move, so
 * a pointer that runs past either end and comes back lands exactly where it
 * points instead of trailing by however far it overshot.
 */
export function widthForDrag(startWidth: number, deltaX: number): number {
  return clampSidebarWidth(startWidth + deltaX)
}

/**
 * Width after a keyboard nudge on the divider, or null for a key we do not
 * handle — the caller uses that to decide whether to swallow the event.
 */
export function widthForKey(width: number, key: string, coarse = false): number | null {
  const step = coarse ? SIDEBAR_KEY_STEP_COARSE : SIDEBAR_KEY_STEP
  switch (key) {
    case 'ArrowLeft':
      return clampSidebarWidth(width - step)
    case 'ArrowRight':
      return clampSidebarWidth(width + step)
    case 'Home':
      return SIDEBAR_MIN_WIDTH
    case 'End':
      return SIDEBAR_MAX_WIDTH
    default:
      return null
  }
}
