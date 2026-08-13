import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { InlineNotice } from '@/components/ui/inline-notice'
import { startAgentRun } from '@/lib/agentCli'
import { serviceStart, serviceStatus, serviceStop } from '@/lib/ipc'

interface LeaveSiteDialogProps {
  open: boolean
  /** The site this machine currently belongs to, for the confirmation copy. */
  siteId: string
  onClose: () => void
  onLeft: () => void
  /**
   * Claim the service's state for the duration of the teardown
   * ({@link import('@/hooks/useServiceHealth').ServiceHealthStore.hold}), so
   * nothing else in the window starts it back up mid-leave. Returns the
   * release, which is called however the sequence ends.
   */
  onHold: () => () => void
}

type Phase = 'confirm' | 'working' | 'left' | 'failed'

/**
 * Which step gave up. The two are worlds apart for the operator: a stop that
 * did not happen means nothing was touched, while a helper that failed leaves a
 * machine whose membership has to be looked at.
 */
type Failure = 'stop' | 'leave'

interface Result {
  /** False when the machine's row could not be deleted from the dashboard. */
  deregistered: boolean
  /** True when we stopped the service and could not start it again. */
  serviceDown: boolean
}

/** How often the SCM is re-queried while waiting for a stop or a start. */
const POLL_MS = 500

/** How long the service gets to stop before the leave is abandoned. */
const STOP_TIMEOUT_MS = 45_000

/** How long the service gets to come back up before the operator is told. */
const START_TIMEOUT_MS = 45_000

/**
 * After the helper's last line, how long to wait for the process to actually
 * exit. It exits immediately after speaking; the bound is only there so a
 * wedged interpreter cannot trap a dialog that refuses to close while it works.
 */
const HELPER_EXIT_GRACE_MS = 5_000

/**
 * Status lines the helper emits about the service.
 *
 * `configure_site.py --leave` still asks NSSM to stop and start the service
 * itself. It runs unelevated, so both calls fail and it carries on — which is
 * the whole reason this dialog stops the service first. Echoing those two lines
 * would narrate a step that is not happening here.
 */
const HELPER_SERVICE_STATUSES = new Set(['stopping the service', 'restarting the service'])

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The host's elevation failure, in words that name what the operator saw. */
function stopReason(error: string): string {
  return /elevation was declined/i.test(error)
    ? 'the administrator prompt was declined or could not be shown'
    : error
}

/**
 * Wait for the SCM to report the state that was asked for.
 *
 * An elevated start or stop only confirms that the shell accepted the request,
 * so the result has to be observed rather than assumed. A query that throws is
 * treated as "not yet" — the SCM is briefly unhelpful while a service
 * transitions — and a service that is not installed counts as stopped.
 */
async function waitForService(want: 'running' | 'stopped', timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const status = await serviceStatus()
      const there =
        want === 'running' ? status.running : !status.installed || status.state === 'stopped'
      if (there) return true
    } catch {
      // Treated as "not yet".
    }
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}

interface HelperOutcome {
  ok: boolean
  deregistered: boolean
  /** What to show when `ok` is false. */
  error: string | null
}

/**
 * Run `configure_site.py --leave` to completion.
 *
 * The exit is waited for, not just the terminal line: the service must not be
 * started again while the helper is still deleting the machine document, which
 * is the one way a deleted row comes back.
 */
async function runLeaveHelper(onStatus: (status: string) => void): Promise<HelperOutcome> {
  // Held in an object rather than a `let`: it is written from a callback and
  // read after an await, and a property survives that without narrowing games.
  const state: { terminal: HelperOutcome | null; spoke: (() => void) | null } = {
    terminal: null,
    spoke: null,
  }
  const spoken = new Promise<void>((resolve) => {
    state.spoke = resolve
  })

  const run = await startAgentRun('leave', {
    onEvent: (event) => {
      switch (event.event) {
        case 'status':
          if (!HELPER_SERVICE_STATUSES.has(event.value)) onStatus(event.value)
          return
        case 'done':
          state.terminal = {
            ok: true,
            deregistered: event.value.deregistered !== false,
            error: null,
          }
          state.spoke?.()
          return
        case 'error':
          state.terminal = { ok: false, deregistered: false, error: event.value }
          state.spoke?.()
          return
        default:
          return
      }
    },
  })

  await Promise.race([
    run.completed,
    spoken.then(() => new Promise((resolve) => setTimeout(resolve, HELPER_EXIT_GRACE_MS))),
  ])

  if (state.terminal) return state.terminal

  const outcome = await run.completed
  return {
    ok: false,
    deregistered: false,
    error: outcome.stderr.trim() || 'the leave helper stopped before it finished',
  }
}

/** What to tell the operator once the machine is out of the site. */
function leftCopy(site: string, result: Result): string {
  const lines = [`this machine has left ${site} and is no longer monitored.`]
  if (!result.deregistered) {
    lines.push('its row is still on the dashboard — you can remove it there.')
  }
  if (result.serviceDown) {
    lines.push('the owlette service is still stopped — use start service in the footer to start it.')
  }
  return lines.join(' ')
}

/** What to tell the operator when a step gave up. */
function failedCopy(failure: Failure, site: string, result: Result): string {
  if (failure === 'stop') {
    // Nothing has been written at this point, and saying so plainly is the
    // whole value of stopping the service before the teardown rather than
    // during it.
    return `leaving stops the owlette service first, and it is still running. nothing on this machine changed — it is still paired to ${site}.`
  }
  const lines = [`leaving ${site} did not finish. the footer shows whether this machine is still in the site.`]
  if (result.serviceDown) {
    lines.push('the owlette service is still stopped — use start service in the footer to start it.')
  }
  return lines.join(' ')
}

/**
 * Leaving a site: confirm, then watch it happen.
 *
 * The order is the legacy GUI's, with the one step it could never actually
 * perform moved to where it can be. Cloud sync is switched off in `config.json`
 * and the machine document is deleted with the service *stopped*, so nothing
 * recreates the row between the delete and the restart
 * (`owlette_gui.on_leave_site_click`, :1994-2074).
 *
 * The stop is done here rather than in the helper because the helper cannot do
 * it: `configure_site.py` runs as the logged-in user and NSSM needs
 * SERVICE_STOP, which a standard user does not have — so it asked, was refused,
 * and carried on regardless. The host elevates (`service_ctl.rs`), which turns
 * a silent best-effort teardown into one that either happens properly or does
 * not start. Declining the prompt therefore costs nothing: it aborts before the
 * first byte of `config.json` is rewritten.
 *
 * The steps are shown as they happen because this stops and starts a service:
 * a window that just froze for fifteen seconds looks broken.
 */
export function LeaveSiteDialog({ open, siteId, onClose, onLeft, onHold }: LeaveSiteDialogProps) {
  const [phase, setPhase] = useState<Phase>('confirm')
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [failure, setFailure] = useState<Failure>('stop')
  const [result, setResult] = useState<Result>({ deregistered: true, serviceDown: false })

  useEffect(() => {
    if (!open) return
    setPhase('confirm')
    setStatus('')
    setError(null)
    setFailure('stop')
    setResult({ deregistered: true, serviceDown: false })
  }, [open])

  const site = siteId || 'its site'

  const leave = useCallback(async () => {
    setPhase('working')
    setStatus('stopping the owlette service')
    setError(null)
    setResult({ deregistered: true, serviceDown: false })

    const release = onHold()
    try {
      // 1. Stop the service, elevating if this session cannot. Everything
      //    after this point changes the machine; nothing before it does.
      let stopped = false
      try {
        const before = await serviceStatus()
        if (before.installed && (before.running || before.state === 'start_pending')) {
          await serviceStop()
          if (!(await waitForService('stopped', STOP_TIMEOUT_MS))) {
            throw new Error('the service was still running after 45 seconds')
          }
          stopped = true
        }
      } catch (cause) {
        setFailure('stop')
        setError(stopReason(message(cause)))
        setPhase('failed')
        return
      }

      // 2. Tear down. The helper owns this half: it holds the cloud client and
      //    the encrypted token store, which this app deliberately does not.
      //    A helper that could not even be spawned is reported like one that
      //    failed, rather than thrown — the service is stopped at this point
      //    and step 3 has to run whatever happened here.
      setStatus('leaving the site')
      let outcome: HelperOutcome
      try {
        outcome = await runLeaveHelper(setStatus)
      } catch (cause) {
        outcome = { ok: false, deregistered: false, error: message(cause) }
      }

      // 3. Put the service back exactly as it was found, whichever way the
      //    teardown went — a machine with no supervisor is worse than one that
      //    is still on a dashboard.
      let serviceDown = false
      if (stopped) {
        setStatus('starting the owlette service')
        serviceDown = !(await serviceStart()
          .then(() => waitForService('running', START_TIMEOUT_MS))
          .catch(() => false))
      }

      setResult({ deregistered: outcome.deregistered, serviceDown })
      if (!outcome.ok) {
        setFailure('leave')
        setError(outcome.error)
        setPhase('failed')
        return
      }

      setPhase('left')
      onLeft()
    } finally {
      release()
    }
  }, [onHold, onLeft])

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // The teardown stops and starts a service; closing the window would not
        // stop it, so the dialog stays put until it is done.
        if (!next && phase !== 'working') onClose()
      }}
    >
      <DialogContent className="sm:max-w-md" showCloseButton={false} data-testid="leave-site-dialog">
        <DialogHeader>
          <DialogTitle>leave site</DialogTitle>
          <DialogDescription>
            {phase === 'confirm'
              ? `remove this machine from ${site}? the owlette service is stopped while the machine is deregistered, then started again — windows will ask you to approve that. pairing it again needs a new phrase.`
              : phase === 'left'
                ? leftCopy(site, result)
                : phase === 'failed'
                  ? failedCopy(failure, site, result)
                  : 'this takes a few seconds. the owlette service is stopped while it happens, then started again.'}
          </DialogDescription>
        </DialogHeader>

        {phase === 'failed' && error && (
          <InlineNotice data-testid="leave-error">
            <p className="font-mono text-xs text-muted-foreground">{error}</p>
          </InlineNotice>
        )}

        {phase === 'working' && (
          <p className="text-sm text-amber-400" data-testid="leave-status">
            {status}…
          </p>
        )}

        <DialogFooter>
          {phase === 'confirm' ? (
            <>
              <Button variant="outline" onClick={onClose}>
                cancel
              </Button>
              <Button variant="destructive" onClick={() => void leave()}>
                leave site
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={onClose} disabled={phase === 'working'}>
                close
              </Button>
              {/*
                Only offered for a stop that did not happen: that is the one
                failure where nothing was written, so running it again starts
                from exactly where it started the first time.
              */}
              {phase === 'failed' && failure === 'stop' && (
                <Button variant="destructive" onClick={() => void leave()}>
                  try again
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
