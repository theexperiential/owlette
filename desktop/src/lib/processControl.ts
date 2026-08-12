/**
 * Stopping a process the way the service expects.
 *
 * Kill and restart are the same act with one deliberate difference, and the
 * difference is a single line in `tmp/app_states.json`:
 *
 * - **kill** terminates the process and writes a `KILLED` marker. The service
 *   reads that marker on its next tick, treats the exit as intentional, and
 *   neither logs a crash nor relaunches.
 * - **restart** terminates the process and writes nothing. The service sees a
 *   monitored process that is simply gone and relaunches it through its normal
 *   autolaunch path, within one 5 s tick.
 *
 * Both flows are purely local — no command is dispatched to the cloud — which
 * is exactly how the legacy GUI does it (`owlette_gui.py:1182-1303`).
 */

import { terminatePid, type TerminateMethod } from '@/lib/ipc'
import { expectedImagesFor, type ProcessEntry } from '@/lib/owletteConfig'
import { livePidForProcess, markKilled, type AppStates } from '@/lib/processStatus'

export type StopMode = 'kill' | 'restart'

export interface StopResult {
  pid: number
  method: TerminateMethod
  /** True when a `KILLED` marker was written (kill only). */
  marked: boolean
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
 * Stop the live instance of `entry`, optionally marking it as operator-killed.
 *
 * The marker is written *after* the process is gone, as in the legacy GUI: a
 * marker on a process that then refuses to die would tell the service a lie it
 * cannot check.
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

  const pid = livePidForProcess(await deps.readStates(), entry.id)
  if (pid === null) throw new NoLiveInstanceError(name)

  const outcome = await terminateAs(pid, images)
  if (outcome.method === 'not_found') throw new NoLiveInstanceError(name)

  if (mode === 'kill') {
    await deps.mutateStates((states) => markKilled(states, pid, entry.id))
  }

  return { pid, method: outcome.method, marked: mode === 'kill' }
}
