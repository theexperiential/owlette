import type { ScheduleBlock } from '@/hooks/useFirestore';

export interface SchedulePresetDefinition {
  name: string;
  description: string;
  blocks: ScheduleBlock[];
}

/** Color palette for schedule blocks — maximally distinct, never adjacent similar hues */
export const BLOCK_COLORS = [
  { pill: 'bg-blue-600',    pillText: 'text-white', bar: 'bg-blue-500',    label: 'text-blue-400' },
  { pill: 'bg-amber-500',   pillText: 'text-white', bar: 'bg-amber-500',   label: 'text-amber-400' },
  { pill: 'bg-emerald-600', pillText: 'text-white', bar: 'bg-emerald-500', label: 'text-emerald-400' },
  { pill: 'bg-rose-600',    pillText: 'text-white', bar: 'bg-rose-500',    label: 'text-rose-400' },
  { pill: 'bg-violet-600',  pillText: 'text-white', bar: 'bg-violet-500',  label: 'text-violet-400' },
  { pill: 'bg-cyan-500',    pillText: 'text-white', bar: 'bg-cyan-500',    label: 'text-cyan-400' },
  { pill: 'bg-orange-600',  pillText: 'text-white', bar: 'bg-orange-500',  label: 'text-orange-400' },
  { pill: 'bg-pink-600',    pillText: 'text-white', bar: 'bg-pink-500',    label: 'text-pink-400' },
] as const;

/** Ensure all blocks have unique colorIndex values assigned */
export function ensureBlockColors(blocks: ScheduleBlock[]): ScheduleBlock[] {
  const usedColors = new Set<number>();
  const result: ScheduleBlock[] = [];

  // First pass: collect already-assigned colors
  for (const block of blocks) {
    if (block.colorIndex != null) {
      usedColors.add(block.colorIndex);
    }
  }

  // Second pass: assign missing colors
  for (const block of blocks) {
    if (block.colorIndex != null) {
      result.push(block);
    } else {
      let nextColor = 0;
      while (usedColors.has(nextColor)) nextColor++;
      usedColors.add(nextColor);
      result.push({ ...block, colorIndex: nextColor });
    }
  }

  return result;
}

/** Default schedule applied when first activating "Scheduled" mode */
export const DEFAULT_SCHEDULE: ScheduleBlock[] = [
  { days: ['mon', 'tue', 'wed', 'thu', 'fri'], ranges: [{ start: '09:00', stop: '17:00' }] },
];

/** Built-in preset definitions seeded into Firestore */
export const BUILT_IN_PRESETS: SchedulePresetDefinition[] = [
  {
    name: 'business hours',
    description: 'weekdays 9 am – 5 pm',
    blocks: [
      { days: ['mon', 'tue', 'wed', 'thu', 'fri'], ranges: [{ start: '09:00', stop: '17:00' }] },
    ],
  },
  {
    name: 'extended hours',
    description: 'weekdays 7 am – 10 pm',
    blocks: [
      { days: ['mon', 'tue', 'wed', 'thu', 'fri'], ranges: [{ start: '07:00', stop: '22:00' }] },
    ],
  },
  {
    name: 'weekday 24h',
    description: 'weekdays around the clock',
    blocks: [
      { days: ['mon', 'tue', 'wed', 'thu', 'fri'], ranges: [{ start: '00:00', stop: '23:59' }] },
    ],
  },
  {
    name: '24/7',
    description: 'every day, all day',
    blocks: [
      { days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], ranges: [{ start: '00:00', stop: '23:59' }] },
    ],
  },
];
