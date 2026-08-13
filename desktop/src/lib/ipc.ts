/**
 * Typed access to the Rust host.
 *
 * Every Tauri command has exactly one wrapper here and nothing else in the app
 * calls `invoke` directly — the command names and argument shapes live in one
 * place, so a rename in `src-tauri/src/commands.rs` breaks the build instead of
 * failing at runtime.
 *
 * The host mirrors the python service's file seam: JSON reads and writes go
 * through the `Global\OwletteJsonFileMutex` named mutex and land atomically,
 * and the three files the service publishes are watched rather than polled.
 */

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

/** Seam files, addressed relative to the owlette data root. */
export const OWLETTE_FILES = {
  config: 'config/config.json',
  appStates: 'tmp/app_states.json',
  serviceStatus: 'tmp/service_status.json',
} as const

/** Discriminant carried by a file-changed event. */
export type OwletteFile = 'config' | 'app_states' | 'service_status'

/**
 * The service rewrites `service_status.json` on a 30 s throttle, so a file
 * older than this is not slow — it means nothing is writing it.
 */
export const SERVICE_STATUS_STALE_SECONDS = 120

/** Event names emitted by the host (see `src-tauri/src/lib.rs`). */
const EVENT_FILE_CHANGED = 'owlette://file-changed'
const EVENT_SECOND_INSTANCE = 'owlette://second-instance'

/**
 * How the cross-process mutex behaved for one operation.
 *
 * `acquired` is the normal result: the service creates the mutex with an
 * explicit descriptor that lets this process wait on it. `unavailable` means the
 * agent on this machine predates that fix and left the object with LocalSystem's
 * default DACL, which shuts out non-elevated processes. The write is still
 * atomic either way, so it costs a lost update at worst, never a torn file.
 */
export type LockOutcome = 'acquired' | 'abandoned' | 'timeout' | 'unavailable'

export interface WriteOutcome {
  lock: LockOutcome
  /** Time spent waiting on the mutex. */
  waitedMs: number
  /** Attempts used; more than one means the file was locked or being replaced. */
  attempts: number
  bytes: number
}

export interface FileChange {
  file: OwletteFile
  /** Absolute path of the file that changed. */
  path: string
  /** Unix milliseconds. */
  at: number
}

export interface SecondInstancePayload {
  argv: string[]
  cwd: string
}

export interface StatusFileInfo {
  exists: boolean
  /** Seconds since the last write, when the file exists. */
  ageSecs: number | null
  /** True when missing or older than {@link SERVICE_STATUS_STALE_SECONDS}. */
  stale: boolean
}

export type ServiceState =
  | 'running'
  | 'stopped'
  | 'start_pending'
  | 'stop_pending'
  | 'continue_pending'
  | 'pause_pending'
  | 'paused'
  | 'unknown'

export type ServiceStartType =
  | 'auto_start'
  | 'on_demand'
  | 'disabled'
  | 'system_start'
  | 'boot_start'
  | 'unknown'

export interface ServiceStatus {
  /** False when OwletteService is not registered on this machine. */
  installed: boolean
  running: boolean
  state: ServiceState
  startType: ServiceStartType
  statusFile: StatusFileInfo
}

export interface ServiceCommandOutcome {
  /** `scm` issued directly, `elevated` via a UAC prompt, `noop` already there. */
  method: 'scm' | 'elevated' | 'noop'
  /**
   * State observed before the request. An elevated start only confirms the
   * shell accepted it, so callers poll {@link serviceStatus} for the result.
   */
  stateBefore: ServiceState
}

export type TerminateMethod = 'not_found' | 'wm_close' | 'terminated'

export interface TerminateOutcome {
  method: TerminateMethod
  waitedMs: number
  /** Top-level windows that were sent WM_CLOSE. */
  windowsClosed: number
  imagePath: string | null
}

/** Absolute path of the owlette data root (`%PROGRAMDATA%\Owlette`). */
export function owletteDataRoot(): Promise<string> {
  return invoke<string>('owlette_data_root')
}

/** Argument the service passes to ask for a tray icon with no window. */
export const ARG_TRAY = '--tray'

/** Argument the service passes when a process has exhausted its relaunch budget. */
export const ARG_RESTART_PROMPT = '--restart-prompt'

/**
 * argv this process was launched with, including argv[0].
 *
 * Only describes the *first* launch. A second launch is folded into this
 * instance by the single-instance plugin, which forwards its argv through
 * {@link onSecondInstance} instead — so anything reacting to
 * {@link ARG_RESTART_PROMPT} has to read both.
 */
export function launchArgs(): Promise<string[]> {
  return invoke<string[]>('launch_args')
}

/** This machine's name, as the fleet knows it (`COMPUTERNAME`). */
export function hostname(): Promise<string> {
  return invoke<string>('hostname')
}

/**
 * Read a JSON file from the owlette tree under the cross-process mutex.
 *
 * A missing file resolves to `{}` — `app_states.json` does not exist until the
 * service has launched something. Content that will not parse rejects rather
 * than resolving empty, so a torn read can never be mistaken for an empty
 * config and written back over the real one.
 */
export function readOwletteJson<T = Record<string, unknown>>(path: string): Promise<T> {
  return invoke<T>('read_owlette_json', { path })
}

/**
 * Write a JSON file into the owlette tree: serialised with the service's own
 * 4-space indentation, written to a scratch file and renamed over the target.
 *
 * There is no read-modify-write here — callers that update part of a document
 * must read it, merge, and write the whole thing back, preserving keys they do
 * not understand (the `firebase` block above all).
 */
export function writeOwletteJson(path: string, json: unknown): Promise<WriteOutcome> {
  return invoke<WriteOutcome>('write_owlette_json', { path, json })
}

/** SCM state of OwletteService plus the freshness of `service_status.json`. */
export function serviceStatus(): Promise<ServiceStatus> {
  return invoke<ServiceStatus>('service_status')
}

/** Start OwletteService. May raise a UAC prompt; poll {@link serviceStatus}. */
export function serviceStart(): Promise<ServiceCommandOutcome> {
  return invoke<ServiceCommandOutcome>('service_start')
}

/** Stop OwletteService. May raise a UAC prompt; poll {@link serviceStatus}. */
export function serviceStop(): Promise<ServiceCommandOutcome> {
  return invoke<ServiceCommandOutcome>('service_stop')
}

/**
 * Close a process gracefully (WM_CLOSE, then terminate), but only if the pid is
 * still running `expectedExe`. A pid the service has already recycled rejects
 * instead of killing an unrelated process.
 */
export function terminatePid(
  pid: number,
  expectedExe: string,
  gracefulTimeoutMs?: number,
): Promise<TerminateOutcome> {
  return invoke<TerminateOutcome>('terminate_pid', {
    pid,
    expectedExe,
    gracefulTimeoutMs: gracefulTimeoutMs ?? null,
  })
}

/**
 * Is owlette supervising this machine right now?
 *
 * Both halves matter: a service that is running but has stopped refreshing
 * `service_status.json` for two minutes is wedged, and the footer must say so
 * rather than showing a green light.
 */
export function isServiceDown(status: ServiceStatus): boolean {
  return !status.installed || !status.running || status.statusFile.stale
}

/** Subscribe to every seam-file change. */
export function onOwletteFileChanged(handler: (change: FileChange) => void): Promise<UnlistenFn> {
  return listen<FileChange>(EVENT_FILE_CHANGED, (event) => handler(event.payload))
}

/** Subscribe to changes of one seam file. */
export function onOwletteFileChangedFor(
  file: OwletteFile,
  handler: (change: FileChange) => void,
): Promise<UnlistenFn> {
  return onOwletteFileChanged((change) => {
    if (change.file === file) handler(change)
  })
}

/**
 * Subscribe to relaunch attempts. A second launch does not open a window: the
 * host focuses this one and forwards its argv here, which is how `--tray` and
 * `--restart-prompt` reach an already-running app.
 */
export function onSecondInstance(
  handler: (payload: SecondInstancePayload) => void,
): Promise<UnlistenFn> {
  return listen<SecondInstancePayload>(EVENT_SECOND_INSTANCE, (event) => handler(event.payload))
}
