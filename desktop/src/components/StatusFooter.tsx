import { Button } from '@/components/ui/button'
import type { OwletteConfig } from '@/lib/owletteConfig'
import {
  deriveFooterState,
  footerSentence,
  isPaired,
  FOOTER_DOT_CLASS,
  FOOTER_TONE_CLASS,
  siteNameOf,
  type ServiceStatusFile,
} from '@/lib/serviceHealth'
import type { ServiceStatus } from '@/lib/ipc'
import { cn } from '@/lib/utils'

interface StatusFooterProps {
  status: ServiceStatus | null
  statusFile: ServiceStatusFile | null
  config: OwletteConfig | null
  /** COMPUTERNAME, shown as-is — machine names keep their real casing. */
  hostname?: string | null
  starting: boolean
  onStart: () => void
  /** Open the pairing dialog. */
  onJoin: () => void
}

/**
 * One sentence saying whether this machine is looked after — "TEC-A4D is
 * connected to TEC" — with the status word carrying the tone colour, and the
 * running SERVICE version (not this app's) on the right.
 *
 * At most one call to action: `start service` when nothing supervises the
 * machine, `join site` when it is supervised but unpaired. Mutually exclusive on
 * purpose — a dead service can't usefully be paired, and two competing buttons
 * in a status line means neither is read.
 */
export function StatusFooter({
  status,
  statusFile,
  config,
  hostname,
  starting,
  onStart,
  onJoin,
}: StatusFooterProps) {
  const state = deriveFooterState({ status, statusFile, config })
  // Name when the service knows it, id until then: operators know the place as
  // "TEC", not "default_site".
  const site = siteNameOf(config, statusFile)
  const sentence = footerSentence(state, site, hostname ?? null)
  const version = statusFile?.service?.version

  return (
    <footer className="flex items-center gap-3 border-t px-4 py-2 text-xs">
      <span className="flex min-w-0 items-center gap-2" data-testid="footer-status">
        <span
          aria-hidden
          className={cn('size-2 shrink-0 rounded-full', FOOTER_DOT_CLASS[state.tone])}
        />
        <span className="truncate text-muted-foreground">
          {sentence.before}
          <span className={FOOTER_TONE_CLASS[state.tone]}>{state.label}</span>
          {sentence.after}
        </span>
      </span>

      {state.serviceDown ? (
        <Button size="sm" variant="secondary" className="h-6 px-2" disabled={starting} onClick={onStart}>
          {starting ? 'starting…' : 'start service'}
        </Button>
      ) : (
        // `disabled` and `removed from site` both mean a healthy machine that
        // belongs to nothing; without this button the only way back is a menu a
        // new operator has no reason to open.
        isPaired(config) === false && (
          <Button size="sm" variant="secondary" className="h-6 px-2" onClick={onJoin}>
            join site
          </Button>
        )
      )}

      <span className="flex-1" />

      {version && <span className="text-muted-foreground">v{version}</span>}
    </footer>
  )
}
