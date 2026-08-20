/**
 * Schedule palette and default windows, ported from `web/lib/scheduleDefaults.ts`.
 *
 * `BUILT_IN_PRESETS` and `ensureBlockColors` deliberately did NOT come across:
 * presets live in Firestore and this app only sees `config.json`. It ports the
 * process-dialog composition instead, which has no preset bar and never stamps
 * a colour onto a block it didn't create.
 */

import type { ScheduleBlock } from '@/lib/owletteConfig'

/** Schedule-block palette — maximally distinct, no adjacent similar hues. */
export const BLOCK_COLORS = [
  { pill: 'bg-blue-600', pillText: 'text-white', bar: 'bg-blue-500', label: 'text-blue-400' },
  { pill: 'bg-amber-500', pillText: 'text-white', bar: 'bg-amber-500', label: 'text-amber-400' },
  { pill: 'bg-emerald-600', pillText: 'text-white', bar: 'bg-emerald-500', label: 'text-emerald-400' },
  { pill: 'bg-rose-600', pillText: 'text-white', bar: 'bg-rose-500', label: 'text-rose-400' },
  { pill: 'bg-violet-600', pillText: 'text-white', bar: 'bg-violet-500', label: 'text-violet-400' },
  { pill: 'bg-cyan-500', pillText: 'text-white', bar: 'bg-cyan-500', label: 'text-cyan-400' },
  { pill: 'bg-orange-600', pillText: 'text-white', bar: 'bg-orange-500', label: 'text-orange-400' },
  { pill: 'bg-pink-600', pillText: 'text-white', bar: 'bg-pink-500', label: 'text-pink-400' },
] as const

/**
 * Default schedule for an entry with no windows of its own.
 *
 * Safe to pass straight to the blocks editor as a seed: every edit there copies
 * the array and the touched block, so this constant is never mutated.
 */
export const DEFAULT_SCHEDULE: ScheduleBlock[] = [
  { days: ['mon', 'tue', 'wed', 'thu', 'fri'], ranges: [{ start: '09:00', stop: '17:00' }] },
]
