import type { RestartScheduleEntry } from '@/hooks/useFirestore';

export interface RestartPresetDefinition {
  name: string;
  description?: string;
  enabled?: boolean;
  entries: RestartScheduleEntry[];
}

/**
 * Built-in restart presets shipped with the app.
 * Merged client-side with site-level custom presets in useRestartPresets.
 *
 * Built-in entry IDs use a stable `builtin-*` prefix so they don't collide with
 * crypto.randomUUID()-generated IDs from user-created entries.
 */
export const BUILT_IN_RESTART_PRESETS: RestartPresetDefinition[] = [
  {
    name: '2am daily',
    description: 'restart every day at 2:00 AM',
    enabled: true,
    entries: [
      {
        id: 'builtin-2am-daily',
        days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
        time: '02:00',
      },
    ],
  },
];
