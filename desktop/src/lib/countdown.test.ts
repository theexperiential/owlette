import { describe, expect, it } from 'vitest'
import {
  formatRemaining,
  hasExpired,
  RESTART_COUNTDOWN_SECONDS,
  startCountdown,
  tick,
  togglePause,
  type CountdownState,
} from './countdown'

describe('the reboot countdown', () => {
  it('starts at the two minutes the legacy dialog gave the operator', () => {
    // prompt_restart.py printed "2:00" and reached zero 120 ticks later.
    expect(RESTART_COUNTDOWN_SECONDS).toBe(120)
    expect(startCountdown()).toEqual({ remaining: 120, paused: false })
    expect(formatRemaining(startCountdown().remaining)).toBe('2:00')
  })

  it('counts down one second at a time and stops at zero', () => {
    let state = startCountdown(3)
    const seen: number[] = [state.remaining]
    for (let i = 0; i < 5; i += 1) {
      state = tick(state)
      seen.push(state.remaining)
    }
    expect(seen).toEqual([3, 2, 1, 0, 0, 0])
  })

  it('holds the clock while paused and resumes from where it stopped', () => {
    let state = startCountdown(10)
    state = tick(state)
    state = togglePause(state)
    expect(state.paused).toBe(true)

    for (let i = 0; i < 20; i += 1) state = tick(state)
    expect(state.remaining).toBe(9)

    state = togglePause(state)
    state = tick(state)
    expect(state).toEqual({ remaining: 8, paused: false })
  })

  it('reports expiry only once the clock is actually out', () => {
    expect(hasExpired({ remaining: 1, paused: false })).toBe(false)
    expect(hasExpired({ remaining: 0, paused: false })).toBe(true)
    // A paused clock at zero has still expired — pausing after the fact must not
    // cancel a reboot the countdown already reached.
    expect(hasExpired({ remaining: 0, paused: true })).toBe(true)
  })

  it('never advertises a negative or fractional clock', () => {
    expect(startCountdown(-5)).toEqual({ remaining: 0, paused: false })
    expect(startCountdown(2.9).remaining).toBe(2)
    expect(formatRemaining(-1)).toBe('0:00')
  })

  it('formats m:ss the way the legacy label did', () => {
    const cases: [number, string][] = [
      [120, '2:00'],
      [119, '1:59'],
      [61, '1:01'],
      [60, '1:00'],
      [59, '0:59'],
      [9, '0:09'],
      [0, '0:00'],
    ]
    for (const [seconds, label] of cases) expect(formatRemaining(seconds)).toBe(label)
  })

  it('treats state as immutable so react re-renders on every tick', () => {
    const state: CountdownState = startCountdown(5)
    const next = tick(state)
    expect(next).not.toBe(state)
    expect(state.remaining).toBe(5)
  })
})
