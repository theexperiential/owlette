/**
 * `config/config.json` as this app touches it, plus the pure transforms behind
 * every write.
 *
 * Two rules shape everything here, both inherited from the service seam:
 *
 * 1. **Nothing is ever rebuilt from scratch.** Each transform takes the parsed
 *    document and returns a new one made by spreading, so keys this app has
 *    never heard of — `firebase`, `displays`, `sentry`, `rebootSchedule`, and
 *    the per-process `processId` / `schedulePresetId` the web writes — survive
 *    untouched. Combined with serde_json's `preserve_order` on the Rust side,
 *    a desktop write leaves the `firebase` block byte-identical.
 * 2. **Spreading also preserves key order.** Assigning an existing key on a
 *    spread object updates it in place; only genuinely new keys are appended.
 *
 * Field names are the python service's, snake_case and all: this module is a
 * view over its file format, not a place to invent a nicer one.
 */

/** `off` is unmanaged, `always` is 24/7 with crash recovery, `scheduled` runs windows. */
export type LaunchMode = 'off' | 'always' | 'scheduled'

/** CPU priority classes the service knows how to apply. */
export const PRIORITIES = ['Low', 'Normal', 'High', 'Realtime'] as const
export type Priority = (typeof PRIORITIES)[number]

/** Window visibility on launch. Legacy configs say `Show` / `Hide`. */
export const VISIBILITIES = ['Normal', 'Hidden'] as const
export type Visibility = (typeof VISIBILITIES)[number]

/**
 * One window of a schedule block, `HH:MM` on a 24-hour clock.
 *
 * A `stop` earlier than its `start` is an overnight window: it opens on each
 * scheduled day and closes the following morning (`shared_utils.is_within_schedule`).
 */
export interface ScheduleRange {
  start: string
  stop: string
}

/**
 * One schedule block: a set of days, and the windows that apply to them.
 *
 * Field for field the web's `ScheduleBlock` (`web/hooks/useFirestore.ts:150-160`),
 * because both apps write this array into the same `config.json` and the same
 * python service reads it. `name` and `colorIndex` are the editor's own
 * bookkeeping — the service ignores them, and neither app may drop one it did
 * not add.
 *
 * `days` and `ranges` are required, as they are on the web: that is the shape
 * every writer produces. Readers here still check before walking one, because
 * the file can also be edited by hand.
 */
export interface ScheduleBlock {
  /** The operator's label for the block, e.g. `morning shift`. */
  name?: string
  /** Stable colour slot, so deleting a block does not recolour its neighbours. */
  colorIndex?: number
  days: string[]
  ranges: ScheduleRange[]
}

/**
 * One entry of `processes[]`.
 *
 * Everything but `id` is optional because entries in the field predate several
 * of these fields, and the numeric ones are strings the moment a human types
 * them — the service reads both, so we never coerce a value we did not touch.
 */
export interface ProcessEntry {
  id: string
  name?: string
  exe_path?: string
  file_path?: string
  cwd?: string
  priority?: string
  visibility?: string
  time_delay?: string | number
  time_to_init?: string | number
  relaunch_attempts?: string | number
  launch_mode?: string
  autolaunch?: boolean
  schedules?: ScheduleBlock[] | null
  [key: string]: unknown
}

export interface OwletteConfig {
  processes?: ProcessEntry[]
  [key: string]: unknown
}

/** The fields the detail form edits as free text (everything else is a select). */
export const TEXT_FIELDS = [
  'name',
  'exe_path',
  'file_path',
  'cwd',
  'time_delay',
  'time_to_init',
  'relaunch_attempts',
] as const

export type TextField = (typeof TEXT_FIELDS)[number]
export type ProcessForm = Record<TextField, string>

/** Defaults the legacy GUI writes for a brand new entry (`owlette_gui.new_process`). */
export const NEW_PROCESS_DEFAULTS = {
  name: 'untitled process',
  time_delay: '0',
  time_to_init: '10',
  relaunch_attempts: '5',
} as const

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value)
}

/** `processes[]`, or an empty list when the document has never held one. */
export function processesOf(config: OwletteConfig): ProcessEntry[] {
  return Array.isArray(config.processes) ? config.processes : []
}

export function findProcess(config: OwletteConfig, id: string): ProcessEntry | undefined {
  return processesOf(config).find((process) => process.id === id)
}

export function indexOfProcess(config: OwletteConfig, id: string): number {
  return processesOf(config).findIndex((process) => process.id === id)
}

/** Launch mode, falling back to the pre-`launch_mode` `autolaunch` boolean. */
export function launchModeOf(process: ProcessEntry): LaunchMode {
  const mode = process.launch_mode
  if (mode === 'off' || mode === 'always' || mode === 'scheduled') return mode
  return process.autolaunch ? 'always' : 'off'
}

/** Visibility, mapping the legacy `Show` / `Hide` spellings onto today's. */
export function visibilityOf(process: ProcessEntry): Visibility {
  const value = text(process.visibility)
  if (value === 'Hidden' || value === 'Hide') return 'Hidden'
  return 'Normal'
}

export function priorityOf(process: ProcessEntry): Priority {
  const value = text(process.priority)
  return (PRIORITIES as readonly string[]).includes(value) ? (value as Priority) : 'Normal'
}

export function formFromProcess(process: ProcessEntry): ProcessForm {
  return {
    name: text(process.name),
    exe_path: text(process.exe_path),
    file_path: text(process.file_path),
    cwd: text(process.cwd),
    time_delay: text(process.time_delay),
    time_to_init: text(process.time_to_init),
    relaunch_attempts: text(process.relaunch_attempts),
  }
}

export function formsEqual(a: ProcessForm, b: ProcessForm): boolean {
  return TEXT_FIELDS.every((field) => a[field] === b[field])
}

/**
 * What a blur/enter save is allowed to write.
 *
 * The legacy GUI calls this a "soft save": a nonsense number is replaced by the
 * default rather than thrown back at the operator mid-edit, because the event
 * fires on every focus change. The rules are `owlette_gui.py:886-945` — delay
 * must parse and be >= 0, time-to-initialize must be >= 10, relaunch attempts
 * must be a whole number >= 0 (0 meaning unlimited).
 *
 * Trimming is ours, not python's: a trailing space in an exe path is a launch
 * failure nobody can see on screen.
 */
export function coerceForm(form: ProcessForm): ProcessForm {
  const delay = Number(form.time_delay.trim())
  const init = Number(form.time_to_init.trim())
  const attempts = Number(form.relaunch_attempts.trim())

  return {
    name: form.name.trim(),
    exe_path: form.exe_path.trim(),
    file_path: form.file_path.trim(),
    cwd: form.cwd.trim(),
    time_delay:
      form.time_delay.trim() === '' || !Number.isFinite(delay) || delay < 0
        ? NEW_PROCESS_DEFAULTS.time_delay
        : form.time_delay.trim(),
    time_to_init:
      form.time_to_init.trim() === '' || !Number.isFinite(init) || init < 10
        ? NEW_PROCESS_DEFAULTS.time_to_init
        : form.time_to_init.trim(),
    relaunch_attempts:
      form.relaunch_attempts.trim() === '' ||
      !Number.isInteger(attempts) ||
      attempts < 0
        ? NEW_PROCESS_DEFAULTS.relaunch_attempts
        : form.relaunch_attempts.trim(),
  }
}

/** Replace `processes[]`, leaving every other top-level key exactly where it was. */
function withProcesses(config: OwletteConfig, processes: ProcessEntry[]): OwletteConfig {
  return { ...config, processes }
}

/**
 * Apply `update` to one entry.
 *
 * Throws when the id is gone: that means the entry was deleted between the read
 * and this call, and writing it back would resurrect it.
 */
export function updateProcess(
  config: OwletteConfig,
  id: string,
  update: (process: ProcessEntry) => ProcessEntry,
): OwletteConfig {
  const processes = processesOf(config)
  const index = processes.findIndex((process) => process.id === id)
  if (index < 0) throw new Error(`process ${id} is no longer in config.json`)

  const next = processes.slice()
  next[index] = update({ ...processes[index] })
  return withProcesses(config, next)
}

/** Write the seven text fields onto an entry, keeping every other key. */
export function applyForm(process: ProcessEntry, form: ProcessForm): ProcessEntry {
  return {
    ...process,
    name: form.name,
    exe_path: form.exe_path,
    file_path: form.file_path,
    cwd: form.cwd,
    time_delay: form.time_delay,
    time_to_init: form.time_to_init,
    relaunch_attempts: form.relaunch_attempts,
  }
}

/**
 * Set the launch mode, keeping the legacy `autolaunch` mirror in step.
 *
 * The service still reads `autolaunch` on entries written before launch modes
 * existed, and the web app writes both; letting them disagree would make a
 * process the UI calls "off" launch anyway.
 */
export function setLaunchMode(process: ProcessEntry, mode: LaunchMode): ProcessEntry {
  return { ...process, launch_mode: mode, autolaunch: mode !== 'off' }
}

export function setPriority(process: ProcessEntry, priority: Priority): ProcessEntry {
  return { ...process, priority }
}

export function setVisibility(process: ProcessEntry, visibility: Visibility): ProcessEntry {
  return { ...process, visibility }
}

/**
 * Replace the schedule windows.
 *
 * `schedulePresetId` — the web's record of which preset the blocks came from —
 * is deliberately left alone rather than cleared. The presets themselves live in
 * Firestore, so this app cannot tell whether the edited blocks still match the
 * named preset or have diverged from it; the web's own process dialog edits
 * these blocks without touching the field either
 * (`web/app/dashboard/components/ProcessDialog.tsx:241-245`).
 */
export function setSchedules(process: ProcessEntry, schedules: ScheduleBlock[]): ProcessEntry {
  return { ...process, schedules }
}

/**
 * Can this entry be switched out of `off`?
 *
 * The legacy GUI also stats the executable (`os.path.isfile`), which the
 * desktop app cannot do — it has no filesystem command and is not getting one
 * for a validation nicety. Presence is checked here; a path that does not
 * resolve is reported by the service as LAUNCH_FAILED, which the list shows.
 */
export function launchModeBlockedReason(process: ProcessEntry): string | null {
  if (!text(process.name).trim()) return 'name is required before a launch mode can be set'
  if (!text(process.exe_path).trim()) return 'an exe path is required before a launch mode can be set'
  return null
}

/** A fresh entry with the legacy GUI's defaults. `id` comes from `crypto.randomUUID()`. */
export function createProcessEntry(id: string, name = NEW_PROCESS_DEFAULTS.name): ProcessEntry {
  return {
    id,
    name,
    exe_path: '',
    file_path: '',
    cwd: '',
    priority: 'Normal',
    visibility: 'Normal',
    time_delay: NEW_PROCESS_DEFAULTS.time_delay,
    time_to_init: NEW_PROCESS_DEFAULTS.time_to_init,
    relaunch_attempts: NEW_PROCESS_DEFAULTS.relaunch_attempts,
    launch_mode: 'off',
    autolaunch: false,
    schedules: null,
  }
}

export function addProcess(config: OwletteConfig, entry: ProcessEntry): OwletteConfig {
  return withProcesses(config, [...processesOf(config), entry])
}

export function removeProcess(config: OwletteConfig, id: string): OwletteConfig {
  return withProcesses(
    config,
    processesOf(config).filter((process) => process.id !== id),
  )
}

/**
 * `name (copy)`, `name (copy 2)`, … — the first spelling nothing else uses.
 *
 * The web API rejects duplicate process names with a 409, so a clone that
 * reuses a name would fail to sync the moment the service uploads the config.
 */
export function uniqueCopyName(existing: readonly string[], baseName: string): string {
  const taken = new Set(existing)
  let candidate = `${baseName} (copy)`
  let n = 2
  while (taken.has(candidate)) {
    candidate = `${baseName} (copy ${n})`
    n += 1
  }
  return candidate
}

/**
 * Clone an entry, deeply.
 *
 * The clone starts with launch mode off — duplicating an always-on entry and
 * having the service immediately start a second copy of the same executable is
 * never what the operator meant. `processId` (the web's mirror of `id`) is
 * re-pointed too, otherwise the clone syncs as an edit of its original.
 */
export function duplicateProcess(config: OwletteConfig, id: string, newId: string): OwletteConfig {
  const original = findProcess(config, id)
  if (!original) throw new Error(`process ${id} is no longer in config.json`)

  const clone = structuredClone(original) as ProcessEntry
  clone.id = newId
  if ('processId' in clone) clone.processId = newId
  clone.name = uniqueCopyName(
    processesOf(config).map((process) => text(process.name)),
    text(original.name),
  )
  clone.launch_mode = 'off'
  if ('autolaunch' in clone) clone.autolaunch = false

  return addProcess(config, clone)
}

/**
 * Move an entry to `toIndex`.
 *
 * The order of `processes[]` is not cosmetic — the service walks it in order on
 * startup, so it is the launch sequence, which is why the list is drag-ordered
 * rather than sorted. A move that changes nothing, or that names an entry or a
 * position which does not exist, returns the document untouched so it never
 * causes a write.
 */
export function reorderProcess(config: OwletteConfig, id: string, toIndex: number): OwletteConfig {
  const processes = processesOf(config)
  const from = processes.findIndex((process) => process.id === id)
  if (from < 0 || toIndex < 0 || toIndex >= processes.length || toIndex === from) return config

  const next = processes.slice()
  const [moved] = next.splice(from, 1)
  next.splice(toIndex, 0, moved)
  return withProcesses(config, next)
}

/**
 * One-line summary of a scheduled entry's windows, in the wording the legacy
 * GUI shows beside the launch mode (`owlette_gui.py:784-800`).
 *
 * The empty case is not "nothing runs": the service treats a scheduled entry
 * with no windows as always in window (`shared_utils.is_within_schedule`
 * returns True for an empty schedule), so the note says so rather than leaving
 * the operator to assume the opposite.
 */
export function scheduleSummary(process: ProcessEntry): string {
  const blocks = Array.isArray(process.schedules) ? process.schedules : []
  const parts = blocks
    .map((block) => {
      const days = Array.isArray(block.days) && block.days.length ? block.days.join(', ') : 'all days'
      const ranges = Array.isArray(block.ranges)
        ? block.ranges
            .filter((range) => range?.start && range?.stop)
            .map((range) => `${range.start}-${range.stop}`)
            .join(', ')
        : ''
      return ranges ? `${days}: ${ranges}` : null
    })
    .filter((part): part is string => part !== null)

  return parts.length ? parts.join(' | ') : '(no schedule set — runs at all times)'
}

/**
 * The image name to hand `terminate_pid` for its identity check, most specific
 * first.
 *
 * A `.bat` / `.cmd` entry runs as a `cmd.exe`, so the configured path can never
 * match the running image — `shared_utils.pid_matches_exe` special-cases it the
 * same way. For everything else the full path is tried first and the bare file
 * name second, which is the fallback python allows for a process the service
 * adopted rather than launched (a different TouchDesigner build opened by file
 * association, say).
 */
export function expectedImagesFor(process: ProcessEntry): string[] {
  const exe = text(process.exe_path).trim()
  if (!exe) return []
  if (/\.(bat|cmd)$/i.test(exe)) return ['cmd.exe']

  const fileName = exe.replace(/\//g, '\\').split('\\').pop() ?? exe
  return fileName && fileName !== exe ? [exe, fileName] : [exe]
}
