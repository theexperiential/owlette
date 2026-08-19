/**
 * Stopping a process the way the service expects.
 *
 * Kill and restart are the same act with one deliberate difference, and the
 * difference is a single line in `tmp/app_states.json`:
 *
 * - **kill** terminates the process and then writes a `KILLED` marker. The
 *   service reads that marker on its next tick, treats the exit as intentional,
 *   and neither logs a crash nor records anything.
 * - **restart** writes a `RESTARTING` marker on both sides of the kill. The
 *   service likewise skips the crash alert, the screenshot and the Cortex
 *   event, writes a `process_restarted` audit event because a human asked for
 *   this, and relaunches through its normal launch-mode path within one tick
 *   (`owlette_service.py:2598-2630`).
 *
 * **The markers are written on different sides of the kill, on purpose.**
 * `KILLED` claims the process is gone, so writing it before the kill would be a
 * lie whenever the kill fails. `RESTARTING` claims only an intent, and it needs
 * to be on disk on *both* sides:
 *
 * - *Before*, because the service polls: an exit it sees before the marker
 *   lands is an exit it reports as a crash — alert, screenshot, Cortex event —
 *   for a restart the operator asked for.
 * - *After*, because closing a process is not instant, and every tick the
 *   service takes while it is still closing writes `RUNNING` over the marker.
 *   Both halves are needed; each one alone loses a race that was reproduced on
 *   a live agent.
 *
 * Writing it first does mean it can be written for a kill that then does not
 * happen, so that case is undone explicitly — see {@link stopProcess}.
 *
 * Both flows are purely local — no command is dispatched to the cloud — which
 * is exactly how the legacy GUI does it (`owlette_gui.py:1182-1303`).
 */

import { terminatePid, type TerminateMethod } from '@/lib/ipc'
import { expectedImagesFor, type ProcessEntry } from '@/lib/owletteConfig'
import {
  livePidForProcess,
  markKilled,
  markRestarting,
  restoreState,
  type AppStates,
  type ProcessMarker,
} from '@/lib/processStatus'

export type StopMode = 'kill' | 'restart'

/** The marker each mode leaves behind for the service to find. */
const MARKERS: Record<StopMode, ProcessMarker> = {
  kill: 'KILLED',
  restart: 'RESTARTING',
}

export interface StopResult {
  pid: number
  method: TerminateMethod
  /** The marker written to `app_states.json` for the service to read. */
  marker: ProcessMarker
}

/** Raised when there is nothing running to act on — a normal outcome, not a fault. */
export class NoLiveInstanceError extends Error {
  constructor(processName: string) {
    super(`no running instance of ${processName} was found`)
    this.name = 'NoLiveInstanceError'
  }
}

export interface StopDeps {
  /** Fresh read of `app_states.json` — never a cached copy; pids go stale fast. */
  readStates: () => Promise<AppStates>
  /** Read-modify-write of `app_states.json`. */
  mutateStates: (transform: (states: AppStates) => AppStates) => Promise<AppStates>
}

/** The host's wording when a pid turns out to be running something else entirely. */
const IDENTITY_MISMATCH = 'refusing to terminate'

function isIdentityMismatch(error: unknown): boolean {
  return String(error instanceof Error ? error.message : error).includes(IDENTITY_MISMATCH)
}

/**
 * Terminate `pid`, trying each acceptable image in turn.
 *
 * The host refuses to terminate a pid whose image does not match what the
 * caller expected, which is the whole point of the check — but "what the
 * operator configured" and "what is actually running" legitimately differ when
 * the service adopted a process it did not launch. So the full path is offered
 * first and the bare file name second, mirroring `shared_utils.pid_matches_exe`.
 * Anything that is not an identity mismatch (access denied, a pid that will not
 * die) aborts immediately.
 */
async function terminateAs(pid: number, images: string[]) {
  let lastError: unknown = new Error('no executable to identify the process by')

  for (const image of images) {
    try {
      return await terminatePid(pid, image)
    } catch (cause) {
      if (!isIdentityMismatch(cause)) throw cause
      lastError = cause
    }
  }

  throw lastError
}

/**
 * Stop the live instance of `entry`, marking the exit as the operator's.
 *
 * See the module note for why a restart marks both sides of the kill and a kill
 * marks only the far side.
 */
export async function stopProcess(
  entry: ProcessEntry,
  mode: StopMode,
  deps: StopDeps,
): Promise<StopResult> {
  const name = String(entry.name ?? entry.id)
  const images = expectedImagesFor(entry)
  if (!images.length) {
    throw new Error(`${name} has no exe path, so there is no way to identify its process`)
  }

  const states = await deps.readStates()
  const pid = livePidForProcess(states, entry.id)
  if (pid === null) throw new NoLiveInstanceError(name)

  if (mode === 'restart') {
    const previous = states[String(pid)]
    await deps.mutateStates((current) => markRestarting(current, pid, entry.id))

    try {
      const result = await terminate(pid, images, name, mode)

      // And again, now that the process really is gone. Closing one takes
      // seconds — WM_CLOSE, a grace period, then a terminate — and every tick
      // the service takes in that window writes `RUNNING` over the marker,
      // because from where it stands the process is alive and well. Measured on
      // a live agent: the marker was written, overwritten, and the exit was
      // reported as a crash, screenshot and all.
      await deps.mutateStates((current) => markRestarting(current, pid, entry.id))
      return result
    } catch (cause) {
      // The kill did not happen — the pid was already gone, or would not die —
      // so the marker is a claim about an exit that is not ours. Taking it back
      // is best effort: if this write fails too, the original failure is still
      // what the operator is told about.
      await deps
        .mutateStates((current) => restoreState(current, pid, previous))
        .catch(() => undefined)
      throw cause
    }
  }

  const result = await terminate(pid, images, name, mode)
  await deps.mutateStates((current) => markKilled(current, pid, entry.id))
  return result
}

/** Terminate, and refuse to call a pid that was already gone a stop. */
async function terminate(
  pid: number,
  images: string[],
  name: string,
  mode: StopMode,
): Promise<StopResult> {
  const outcome = await terminateAs(pid, images)
  if (outcome.method === 'not_found') throw new NoLiveInstanceError(name)
  return { pid, method: outcome.method, marker: MARKERS[mode] }
}
