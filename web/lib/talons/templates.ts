/**
 * Built-in talon presets — the templates every site starts with.
 *
 * Parallel to `@/lib/restartDefaults`, `@/lib/scheduleDefaults` and
 * `@/lib/projectDistributionDefaults`: a plain data module, merged client-side
 * over the site's own `config/{siteId}/talon_presets` docs. CLIENT-SAFE — no
 * server imports, no Firestore — so the editor and the preset routes can both
 * read it.
 *
 * Every `template` here is fed straight to `validateTalonPresetInput`, and
 * `templates.test.ts` proves each one passes. Ship nothing that does not.
 *
 * Two rules, both load-bearing:
 *   - `name` is an IDENTITY. `builtInId()` derives `builtin-<slug>` from it, so
 *     renaming one orphans every site's override of it into the "custom"
 *     bucket. Change the description, never the name.
 *   - No `scope`, no `enabled`, and no `processId` on a command output — see
 *     `TalonPresetTemplate`. All three are per-site, per-instance decisions.
 */
import type { TalonPresetRequirement, TalonPresetTemplate } from './types';

/**
 * `requires` is machine-checked, not documentation: the test asserts that a
 * template declaring `process_target` fails validation on exactly that path,
 * and that one declaring nothing passes outright. `llm_key` is the author's own
 * key (`users/{uid}/settings/llm`) the store checks at create, update and
 * enable; `process_target` is a field the template deliberately leaves blank
 * because a process id does not travel between sites.
 */
export interface TalonTemplateDefinition {
  /** Deterministic `builtin-<slug>`, matching `useRestartPresets`' `builtInId()`. */
  id: string;
  /** Lowercase and STABLE — renaming orphans a site's override of this preset. */
  name: string;
  /** Lowercase one-liner, in the voice of the other preset families. */
  description: string;
  /** Picker one-liner, lowercase. */
  summary: string;
  requires: TalonPresetRequirement[];
  template: TalonPresetTemplate;
}

/** Every day of the week, in canonical order — what the validator normalizes to. */
const EVERY_DAY = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

/**
 * The wall-check expectation. The vision prompt already treats black screens,
 * the desktop, error dialogs and "no signal" cards as failures, so spelling
 * them out changes no behaviour — it is here because the operator reads and
 * edits this sentence, and a concrete one is easier to adapt than an abstract
 * one.
 */
const WALL_EXPECTATION =
  'the screen should be showing the content loop. it should not show the windows ' +
  'desktop or taskbar, an error dialog, a black or blank screen, or a "no signal" card.';

/**
 * Cooldown convention. A cooldown is global to the TALON, not per machine, so a
 * fleet-wide event template with a long one silently drops the second machine's
 * event — those get 5 minutes. Schedule templates carry the 60-minute default,
 * which is inert for them (`nextRunAt` already spaces the runs).
 */
const EVENT_COOLDOWN_MINUTES = 5;
const DEFAULT_COOLDOWN_MINUTES = 60;

export const BUILT_IN_TALON_PRESETS: TalonTemplateDefinition[] = [
  {
    id: 'builtin-morning-wall-check',
    name: 'morning wall check',
    description: 'at 8 am, look at every screen and email if it is not showing content',
    summary: 'the walk-the-floor check, done by hoot before anyone arrives',
    requires: ['llm_key'],
    template: {
      name: 'morning wall check',
      description: 'at 8 am, look at every screen and email if it is not showing content',
      trigger: {
        type: 'schedule',
        entries: [{ id: 'tpl-morning-wall-check', days: [...EVERY_DAY], time: '08:00' }],
      },
      condition: { type: 'visual_check', expectation: WALL_EXPECTATION },
      outputs: [{ type: 'email' }],
      cooldownMinutes: DEFAULT_COOLDOWN_MINUTES,
    },
  },
  {
    id: 'builtin-crash-triage',
    name: 'crash triage',
    description: 'when a process crashes, hoot investigates and writes up what it found',
    summary: 'the diagnosis is waiting in a chat before anyone opens the dashboard',
    requires: ['llm_key'],
    template: {
      name: 'crash triage',
      description: 'when a process crashes, hoot investigates and writes up what it found',
      trigger: { type: 'event', eventTypes: ['process_crash', 'process_start_failed'] },
      condition: { type: 'none' },
      outputs: [
        {
          type: 'cortex',
          // Deliberately forbids acting: this template does not opt into
          // `allowActions`, so the turn only has read-only tools and an
          // instruction to restart something would just fail confusingly.
          directive:
            'a monitored process just went down on this machine. work out why: check the ' +
            'windows event log around the crash, recent cpu, memory and gpu load, free disk ' +
            'space, and whether the executable is still where owlette expects it. do not try ' +
            'to restart anything — report what you found and what you would do next.',
        },
      ],
      cooldownMinutes: 30,
    },
  },
  {
    id: 'builtin-weekly-health-report',
    name: 'weekly health report',
    description: 'every monday at 9 am, hoot writes a plain-language health report',
    summary: 'a monday-morning readout of what each machine has been putting up with',
    requires: ['llm_key'],
    template: {
      name: 'weekly health report',
      description: 'every monday at 9 am, hoot writes a plain-language health report',
      trigger: {
        type: 'schedule',
        entries: [{ id: 'tpl-weekly-health-report', days: ['mon'], time: '09:00' }],
      },
      condition: { type: 'none' },
      outputs: [
        {
          type: 'cortex',
          // Every item maps to a tool an unattended (tier-1) turn actually has:
          // get_disk_usage, get_event_logs, check_pending_reboot, and
          // get_service_status for wuauserv. Nothing here asks for a tier-2+
          // capability, so the report can never come back half-empty.
          directive:
            'write a short health report for this machine in plain language, for someone who ' +
            'is not a windows administrator. cover: free disk space on every drive, recent ' +
            'errors in the windows event log, whether a reboot is pending and why, and ' +
            'whether windows update is healthy. finish with one paragraph saying whether ' +
            'this machine is fine, worth watching, or needs attention, and why.',
        },
      ],
      cooldownMinutes: DEFAULT_COOLDOWN_MINUTES,
    },
  },
  {
    id: 'builtin-exe-went-missing',
    name: 'exe went missing',
    description: 'email when a process executable is no longer where owlette expects it',
    summary: 'an app update moved the exe and the process can never launch again',
    requires: [],
    template: {
      name: 'exe went missing',
      description: 'email when a process executable is no longer where owlette expects it',
      trigger: { type: 'event', eventTypes: ['exe_missing'] },
      condition: { type: 'none' },
      outputs: [{ type: 'email' }],
      cooldownMinutes: EVENT_COOLDOWN_MINUTES,
    },
  },
  {
    id: 'builtin-wall-check-after-restart',
    name: 'wall check after restart',
    description: 'three minutes after a process restarts, confirm the screen came back',
    summary: 'catches the restart that technically worked but left a black screen',
    requires: ['llm_key'],
    template: {
      name: 'wall check after restart',
      description: 'three minutes after a process restarts, confirm the screen came back',
      trigger: {
        type: 'event',
        eventTypes: ['process_restarted'],
        // The reason delays exist: a screenshot taken the instant a process
        // restarts catches a splash screen, and a slow-starting show app reads
        // as a failure. Three minutes is past that and well inside the window
        // where a genuinely dead wall is still news.
        delayMinutes: 3,
      },
      condition: {
        type: 'visual_check',
        expectation:
          'after the restart the screen should be back on its content loop. it should not ' +
          'show the windows desktop or taskbar, an error dialog, a loading indicator that ' +
          'never finishes, or a black or blank screen.',
      },
      outputs: [{ type: 'email' }],
      cooldownMinutes: EVENT_COOLDOWN_MINUTES,
    },
  },
];
