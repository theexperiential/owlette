/**
 * `tmp/app_states.json` — the service's live process table — and the join that
 * turns it into a dot next to a name.
 *
 * The file is keyed by OS pid, and each value carries the config entry it
 * belongs to plus the last status the service wrote for it:
 *
 * ```json
 * { "18244": { "id": "e38d36a5-…", "status": "RUNNING", "timestamp": 1786562574 } }
 * ```
 *
 * A config entry can own several pids at once — the service leaves the previous
 * generation behind when a process crashes and is relaunched, and pids are
 * recycled by Windows — so every lookup here has to pick one deliberately.
 */

export const PROCESS_STATUSES = [
  'RUNNING',
  'LAUNCHING',
  'RESTARTING',
  'QUEUED',
  'LAUNCH_FAILED',
  'KILLED',
  'STOPPED',
  'INACTIVE',
] as const

export type ProcessStatus = (typeof PROCESS_STATUSES)[number]

/**
 * The two statuses this app writes itself, both of them a message to the
 * service about an exit it is about to see (`owlette_service.py:2598-2630`).
 *
 * `KILLED` says "intended, leave it alone"; `RESTARTING` says "intended, and
 * the operator asked for it" — same suppression of the crash alert, plus a
 * `process_restarted` audit event, and the relaunch decided by launch mode as
 * usual. Everything else in {@link PROCESS_STATUSES} is the service's to write.
 */
export type ProcessMarker = Extract<ProcessStatus, 'KILLED' | 'RESTARTING'>

export interface AppState {
  id?: string
  status?: string
  timestamp?: number
  [key: string]: unknown
}

export type AppStates = Record<string, AppState>

/**
 * Take the parsed document down to the entries we can actually use.
 *
 * The service has written malformed entries before (a `None` pid key was a real
 * bug), and this file is read on every watcher event, so anything that is not a
 * numeric pid mapping to an object is dropped rather than crashing the list.
 * Unknown keys inside an entry are kept — a status write must not lose them.
 */
export function parseAppStates(raw: unknown): AppStates {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}

  const states: AppStates = {}
  for (const [pid, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^\d+$/.test(pid)) continue
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    states[pid] = value as AppState
  }
  return states
}

function entriesFor(states: AppStates, processId: string): [number, AppState][] {
  return Object.entries(states)
    .filter(([, state]) => state.id === processId)
    .map(([pid, state]) => [Number(pid), state] as [number, AppState])
}

/** Newest first, by the service's timestamp, with the higher pid breaking ties. */
function byRecency(a: [number, AppState], b: [number, AppState]): number {
  const at = typeof a[1].timestamp === 'number' ? a[1].timestamp : 0
  const bt = typeof b[1].timestamp === 'number' ? b[1].timestamp : 0
  return bt - at || b[0] - a[0]
}

function asStatus(value: unknown): ProcessStatus | null {
  return typeof value === 'string' && (PROCESS_STATUSES as readonly string[]).includes(value)
    ? (value as ProcessStatus)
    : null
}

/**
 * The status to show for a config entry: the most recent generation's.
 *
 * Deliberately not "prefer RUNNING" — a killed process keeps its timestamp when
 * the marker is written, so preferring RUNNING would leave a stale green dot on
 * a process the operator just stopped. An entry the service has never launched,
 * or one whose statuses are all unrecognised, reads INACTIVE.
 */
export function statusForProcess(states: AppStates, processId: string): ProcessStatus {
  const [newest] = entriesFor(states, processId).sort(byRecency)
  return (newest && asStatus(newest[1].status)) ?? 'INACTIVE'
}

/**
 * The pid to act on for a kill or restart.
 *
 * Mirrors `owlette_gui.get_os_pid_by_process_id`: a RUNNING generation wins
 * (newest, if there are several), otherwise the newest generation of any status
 * — it may well be dead, which is exactly what the caller's identity check on
 * `terminate_pid` is there to find out.
 */
export function livePidForProcess(states: AppStates, processId: string): number | null {
  const entries = entriesFor(states, processId)
  if (!entries.length) return null

  const running = entries.filter(([, state]) => state.status === 'RUNNING').sort(byRecency)
  const chosen = running[0] ?? entries.sort(byRecency)[0]
  return chosen ? chosen[0] : null
}

/**
 * Stamp a marker on one pid, leaving the rest of the document alone.
 *
 * Same shape as `shared_utils.update_process_status_in_json`: the status is
 * replaced and the config id is (re)asserted, while the timestamp and anything
 * else the service put there is preserved.
 */
export function markProcess(
  states: AppStates,
  pid: number,
  processId: string,
  marker: ProcessMarker,
): AppStates {
  const key = String(pid)
  return { ...states, [key]: { ...states[key], status: marker, id: processId } }
}

/** "The operator killed it" — no crash alert, no audit event, no relaunch of ours. */
export function markKilled(states: AppStates, pid: number, processId: string): AppStates {
  return markProcess(states, pid, processId, 'KILLED')
}

/** "The operator restarted it" — no crash alert, but a `process_restarted` event. */
export function markRestarting(states: AppStates, pid: number, processId: string): AppStates {
  return markProcess(states, pid, processId, 'RESTARTING')
}

/**
 * Put a pid's row back the way it was.
 *
 * `RESTARTING` has to be written before the process is terminated, which means
 * it is sometimes written for a termination that does not happen — the pid had
 * already exited, or refused to. Left in place it would be a claim nothing ever
 * corrects: the service only rewrites rows for processes it is monitoring, so
 * an unmanaged entry would sit at "restarting" until the next reboot, and a
 * process that really had just crashed would have its crash alert suppressed.
 */
export function restoreState(states: AppStates, pid: number, previous: AppState): AppStates {
  return { ...states, [String(pid)]: previous }
}

/**
 * Dot colours.
 *
 * The hues are `shared_utils.STATUS_COLORS`, which are the same tailwind steps
 * the web dashboard paints its process badges with (green for running, red for
 * the failure family, slate for idle). INACTIVE is a hollow ring rather than a
 * filled dot, as in the legacy GUI.
 */
export const STATUS_DOT: Record<ProcessStatus, string> = {
  RUNNING: 'bg-green-500',
  LAUNCHING: 'bg-yellow-400',
  RESTARTING: 'bg-yellow-400',
  QUEUED: 'bg-orange-400',
  LAUNCH_FAILED: 'bg-red-500',
  KILLED: 'bg-red-400',
  STOPPED: 'bg-red-400',
  INACTIVE: 'bg-transparent border border-slate-400/80',
}

/** Text colour for the status word in the detail panel. */
export const STATUS_TEXT: Record<ProcessStatus, string> = {
  RUNNING: 'text-green-500',
  LAUNCHING: 'text-yellow-400',
  RESTARTING: 'text-yellow-400',
  QUEUED: 'text-orange-400',
  LAUNCH_FAILED: 'text-red-500',
  KILLED: 'text-red-400',
  STOPPED: 'text-red-400',
  INACTIVE: 'text-muted-foreground',
}

/** Lowercase copy for a status, matching the dashboard's badge wording. */
export function statusLabel(status: ProcessStatus): string {
  return status === 'LAUNCH_FAILED' ? 'failed' : status.toLowerCase()
}
