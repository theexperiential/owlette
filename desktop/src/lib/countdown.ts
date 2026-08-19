/**
 * The reboot countdown, as a value.
 *
 * Ported from `agent/src/prompt_restart.py` (:12-76), which the service spawned
 * when a process burned through its relaunch budget. The rules are unchanged: a
 * two-minute wait, a pause the operator can hold indefinitely, and a reboot the
 * moment it runs out. Only the shell is new — the prompt is a window inside this
 * app now rather than its own python process, which is why
 * `owlette_service._is_restart_prompt_active` tracks its own launch instead of
 * scanning for one.
 *
 * The state lives here rather than in the component so the arithmetic is
 * testable without a clock.
 */

/**
 * Seconds on the clock when the prompt opens.
 *
 * The legacy dialog printed "2:00" and started its ticker at 119, so it reached
 * zero 120 ticks later; 120 here is the same two minutes said plainly.
 */
export const RESTART_COUNTDOWN_SECONDS = 120

export interface CountdownState {
  /** Seconds left. Never below zero. */
  remaining: number
  /** True while the operator is holding the clock. */
  paused: boolean
}

export function startCountdown(seconds: number = RESTART_COUNTDOWN_SECONDS): CountdownState {
  return { remaining: Math.max(0, Math.floor(seconds)), paused: false }
}

/** One second passing. A paused or expired clock does not move. */
export function tick(state: CountdownState): CountdownState {
  if (state.paused || state.remaining <= 0) return state
  return { ...state, remaining: state.remaining - 1 }
}

export function togglePause(state: CountdownState): CountdownState {
  return { ...state, paused: !state.paused }
}

/** True once the machine should be restarted. */
export function hasExpired(state: CountdownState): boolean {
  return state.remaining <= 0
}

/** `m:ss`, the format the legacy dialog used. */
export function formatRemaining(seconds: number): string {
  const clamped = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(clamped / 60)
  const rest = clamped % 60
  return `${minutes}:${String(rest).padStart(2, '0')}`
}
