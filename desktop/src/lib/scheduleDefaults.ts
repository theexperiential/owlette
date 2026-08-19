/**
 * The schedule palette and the default windows, ported from
 * `web/lib/scheduleDefaults.ts`.
 *
 * Two of the web module's exports deliberately did not come across:
 * `BUILT_IN_PRESETS` and `ensureBlockColors` belong to the preset bar of the
 * web's standalone schedule dialog, and presets live in Firestore — this app
 * only ever sees `config.json`, so it ports the process-dialog composition
 * (`web/app/dashboard/components/ProcessDialog.tsx:223-248`), which has no
 * preset bar and never stamps a colour onto a block it did not create.
 */

import type { ScheduleBlock } from '@/lib/owletteConfig'

/** Colour palette for schedule blocks — maximally distinct, never adjacent similar hues */
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
 * Default schedule offered when a scheduled entry has no windows of its own.
 *
 * Never mutated: every edit in the blocks editor copies the array and the block
 * it touches, so this constant can be handed straight to the editor as its
 * seed — which is exactly what the web's process dialog does.
 */
export const DEFAULT_SCHEDULE: ScheduleBlock[] = [
  { days: ['mon', 'tue', 'wed', 'thu', 'fri'], ranges: [{ start: '09:00', stop: '17:00' }] },
]
