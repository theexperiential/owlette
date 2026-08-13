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

interface LeaveSiteDialogProps {
  open: boolean
  /** The site this machine currently belongs to, for the confirmation copy. */
  siteId: string
  onClose: () => void
  onLeft: () => void
}

type Phase = 'confirm' | 'running' | 'left' | 'failed'

/**
 * Leaving a site: confirm, then watch the agent do it.
 *
 * The teardown itself is `configure_site.py --leave`, which repeats the legacy
 * GUI's order for the reasons that order exists — cloud sync is switched off in
 * `config.json` first, and the service is stopped, so nothing recreates the
 * machine document between the delete and the restart
 * (`owlette_gui.on_leave_site_click`, :1994-2074).
 *
 * The steps are shown as they happen because the middle of it stops the service:
 * a window that just froze for eight seconds looks broken.
 */
export function LeaveSiteDialog({ open, siteId, onClose, onLeft }: LeaveSiteDialogProps) {
  const [phase, setPhase] = useState<Phase>('confirm')
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [outcome, setOutcome] = useState({ deregistered: true, serviceStopped: true })

  useEffect(() => {
    if (!open) return
    setPhase('confirm')
    setStatus('')
    setError(null)
    setOutcome({ deregistered: true, serviceStopped: true })
  }, [open])

  const leave = useCallback(() => {
    setPhase('running')
    setStatus('starting')
    setError(null)

    let settled = false
    void startAgentRun('leave', {
      onEvent: (event) => {
        switch (event.event) {
          case 'status':
            setStatus(event.value)
            return
          case 'done':
            settled = true
            setOutcome({
              deregistered: event.value.deregistered !== false,
              serviceStopped: event.value.serviceStopped !== false,
            })
            setPhase('left')
            onLeft()
            return
          case 'error':
            settled = true
            setError(event.value)
            setPhase('failed')
            return
          default:
            return
        }
      },
    })
      .then((run) => run.completed)
      .then((outcome) => {
        if (settled) return
        setError(outcome.stderr.trim() || 'the agent helper stopped unexpectedly')
        setPhase('failed')
      })
      .catch((cause: unknown) => {
        settled = true
        setError(cause instanceof Error ? cause.message : String(cause))
        setPhase('failed')
      })
  }, [onLeft])

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // The teardown stops and starts a service; closing the window would not
        // stop it, so the dialog stays put until it is done.
        if (!next && phase !== 'running') onClose()
      }}
    >
      <DialogContent className="sm:max-w-md" showCloseButton={false} data-testid="leave-site-dialog">
        <DialogHeader>
          <DialogTitle>leave site</DialogTitle>
          <DialogDescription>
            {phase === 'confirm'
              ? `remove this machine from ${siteId || 'its site'}? cloud sync is switched off, the machine is deregistered, and the service restarts. pairing it again needs a new phrase.`
              : phase === 'left'
                ? !outcome.deregistered
                  ? 'cloud sync is off on this machine, but the dashboard row could not be removed — delete it from the dashboard.'
                  : !outcome.serviceStopped
                    ? // The service kept running through the delete, so it may
                      // have written the machine document straight back.
                      'this machine has left the site. the service could not be stopped first, so check the dashboard and remove the row if it is still there.'
                    : 'this machine has left the site and is no longer monitored.'
                : 'this takes a few seconds — the service is restarted as part of it.'}
          </DialogDescription>
        </DialogHeader>

        {phase === 'failed' && error && (
          <InlineNotice data-testid="leave-error">
            <p className="text-sm">could not leave the site</p>
            <p className="font-mono text-xs text-muted-foreground">{error}</p>
          </InlineNotice>
        )}

        {phase === 'running' && (
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
              <Button variant="destructive" onClick={leave}>
                leave site
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={onClose} disabled={phase === 'running'}>
              close
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
