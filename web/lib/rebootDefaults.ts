import type { RebootScheduleEntry } from '@/hooks/useFirestore';

export interface RebootPresetDefinition {
  name: string;
  description?: string;
  entries: RebootScheduleEntry[];
}

/**
 * Built-in reboot presets shipped with the app.
 * Merged client-side with site-level custom presets in useRebootPresets.
 *
 * Built-in entry IDs use a stable `builtin-*` prefix so they don't collide with
 * crypto.randomUUID()-generated IDs from user-created entries.
 */
export const BUILT_IN_REBOOT_PRESETS: RebootPresetDefinition[] = [
  {
    name: '2am daily',
    description: 'reboot every day at 2:00 AM',
    entries: [
      {
        id: 'builtin-2am-daily',
        days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
        time: '02:00',
      },
    ],
  },
];
