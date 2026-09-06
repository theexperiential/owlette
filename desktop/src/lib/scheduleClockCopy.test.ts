import { describe, expect, it } from 'vitest'
import { scheduleClockDescription, shortZoneName } from './scheduleClockCopy'

/**
 * FROZEN. Captured from `ScheduleEditor` before the site-time branch existed —
 * the state every recorded tutorial frame was shot in, and the state of every
 * site that has not answered the dashboard's opt-in banner. A refactor that
 * rewords it breaks footage; this is the guard that says so.
 */
const MACHINE_CLOCK_COPY =
  "the service runs this process during these windows and stops it outside them. times run on this machine's own clock."

describe('scheduleClockDescription', () => {
  it('keeps the machine-clock sentence byte for byte when there is no site clock', () => {
    expect(scheduleClockDescription('')).toBe(MACHINE_CLOCK_COPY)
  })

  it('names the site clock once the service publishes one', () => {
    expect(scheduleClockDescription('America/New_York')).toBe(
      "the service runs this process during these windows and stops it outside them. times run on the site's clock (New York).",
    )
  })

  it('says the same thing the dashboard says — same words, this machine as the subject', () => {
    // web/lib/scheduleClockCopy.ts: "times run on the site's clock (New York)"
    // over there, "each machine's own clock" for the fleet. One window, one box,
    // so the fallback is "this machine" — everything else matches word for word.
    expect(scheduleClockDescription('America/New_York')).toContain(
      "times run on the site's clock (New York)",
    )
    expect(scheduleClockDescription('')).toContain("times run on this machine's own clock")
  })
})

describe('shortZoneName', () => {
  it('reads as a city, not a database key', () => {
    expect(shortZoneName('America/New_York')).toBe('New York')
    expect(shortZoneName('Australia/Broken_Hill')).toBe('Broken Hill')
    expect(shortZoneName('America/Argentina/Buenos_Aires')).toBe('Buenos Aires')
  })

  it('hands back a zone with no region prefix unchanged', () => {
    expect(shortZoneName('UTC')).toBe('UTC')
  })
})
