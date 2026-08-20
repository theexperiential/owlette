import { Check, Copy, ExternalLink } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
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
import {
  startAgentRun,
  openExternalUrl,
  type AgentRun,
  type PairPhrase,
} from '@/lib/agentCli'
import { copyText } from '@/lib/clipboard'

interface JoinSiteDialogProps {
  open: boolean
  /** Closes the dialog. Any run still in flight is cancelled first. */
  onClose: () => void
  /**
   * Called on success with the joined site's id — an id, not a label: the
   * display name is unknown here until the service connects and publishes it.
   * Treat it as a signal, never as copy.
   */
  onJoined: (siteId: string) => void
}

type Phase = 'starting' | 'waiting' | 'joined' | 'failed'

/**
 * Device-code pairing, driven by `configure_site.py --json-progress`: it
 * streams the phrase as soon as the server issues it, then polls until someone
 * approves. Cancel kills the helper and lets the code expire server-side, as
 * the legacy GUI's Cancel did.
 *
 * No token handling here — the helper writes `.tokens.enc` and restarts the
 * service; this window only watches.
 */
export function JoinSiteDialog({ open, onClose, onJoined }: JoinSiteDialogProps) {
  const [phase, setPhase] = useState<Phase>('starting')
  const [phrase, setPhrase] = useState<PairPhrase | null>(null)
  const [status, setStatus] = useState('requesting a pairing phrase')
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const run = useRef<AgentRun | null>(null)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // In a ref so an inline parent callback can't re-run the effect and start a
  // second pairing attempt.
  const joined = useRef(onJoined)
  joined.current = onJoined

  useEffect(() => {
    if (!open) return

    let disposed = false
    // Set by a terminal event; the exit handler only invents a failure if unset.
    let settled = false

    setPhase('starting')
    setPhrase(null)
    setStatus('requesting a pairing phrase')
    setError(null)
    setCopied(false)

    void startAgentRun('join', {
      onEvent: (event) => {
        if (disposed) return
        switch (event.event) {
          case 'phrase':
            setPhrase(event.value)
            setPhase('waiting')
            return
          case 'status':
            setStatus(event.value)
            return
          case 'authorized':
            settled = true
            setPhase('joined')
            setStatus(
              event.value.serviceRestarted
                ? 'paired — the service is restarting'
                : 'paired — restart the service from the tray menu to finish',
            )
            joined.current(event.value.siteId)
            return
          case 'error':
            settled = true
            setPhase('failed')
            setError(event.value)
            return
          default:
            return
        }
      },
    })
      .then((started) => {
        run.current = started
        if (disposed) void started.cancel()
        return started.completed
      })
      .then((outcome) => {
        // A helper dying without an error event still has to close "waiting".
        if (disposed || settled) return
        setPhase('failed')
        setError(outcome.stderr.trim() || 'the pairing helper stopped unexpectedly')
      })
      .catch((cause: unknown) => {
        if (disposed) return
        settled = true
        setPhase('failed')
        setError(cause instanceof Error ? cause.message : String(cause))
      })

    return () => {
      disposed = true
      void run.current?.cancel()
      run.current = null
    }
  }, [open])

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
    },
    [],
  )

  const handleCopy = useCallback(() => {
    if (!phrase) return
    void copyText(phrase.pairPhrase).then((ok) => {
      setCopied(ok)
      if (!ok) return
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopied(false), 2000)
    })
  }, [phrase])

  const handleOpen = useCallback(() => {
    const url = phrase?.pairingUrl || phrase?.verificationUri
    if (!url) return
    void openExternalUrl(url).catch(() => {
      setError('could not open a browser on this machine — use the phrase from another device')
    })
  }, [phrase])

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md" data-testid="join-site-dialog">
        <DialogHeader>
          <DialogTitle>join a site</DialogTitle>
          <DialogDescription>
            approve this machine at owlette.app/add — from here or from any other device.
          </DialogDescription>
        </DialogHeader>

        {phase === 'failed' && error ? (
          <InlineNotice data-testid="join-error">
            <p className="text-sm">pairing failed</p>
            <p className="font-mono text-xs text-muted-foreground">{error}</p>
          </InlineNotice>
        ) : phase === 'joined' ? (
          <p className="text-sm text-green-500" data-testid="join-status">
            {status}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <button
              type="button"
              disabled={!phrase}
              onClick={handleCopy}
              data-testid="join-phrase"
              className="btn-sweep flex items-center justify-center gap-2 rounded-md border bg-secondary px-4 py-4 font-mono text-xl font-semibold tracking-tight text-primary disabled:opacity-60"
            >
              {phrase?.pairPhrase ?? '…'}
              {phrase &&
                (copied ? (
                  <Check className="size-4 text-green-500" />
                ) : (
                  <Copy className="size-4 text-muted-foreground" />
                ))}
            </button>
            <p className="text-center text-xs text-muted-foreground">
              {phrase ? (copied ? 'copied to clipboard' : 'click to copy') : 'asking owlette…'}
            </p>
            <p className="text-center text-sm text-amber-400" data-testid="join-status">
              {status}
            </p>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {phase === 'joined' || phase === 'failed' ? 'close' : 'cancel'}
          </Button>
          {phase === 'waiting' && (
            <Button onClick={handleOpen} disabled={!phrase?.pairingUrl && !phrase?.verificationUri}>
              <ExternalLink className="size-4" />
              open owlette.app/add
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
