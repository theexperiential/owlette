import { Button } from '@/components/ui/button'
import type { OwletteConfig } from '@/lib/owletteConfig'
import {
  deriveFooterState,
  footerSentence,
  isPaired,
  FOOTER_DOT_CLASS,
  FOOTER_TONE_CLASS,
  siteIdOf,
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
 * The one line that says whether this machine is being looked after, phrased
 * as a sentence — "TEC-A4D is connected to default_site" — with the status
 * word carrying the tone colour. Right edge: the version of the service that
 * is running, which is the version that matters, not this app's.
 *
 * At most one call to action sits beside the sentence, and it is always the
 * thing the state calls for: `start service` when nothing is supervising this
 * machine, `join site` when it is supervised but belongs to no site. The two
 * are mutually exclusive on purpose — a machine with a dead service cannot
 * usefully be paired, and two buttons competing in a status line is how neither
 * gets read.
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
  const site = siteIdOf(config, statusFile)
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
        // `disabled` and `removed from site` both describe a machine that is
        // running fine and belongs to nothing. Until this button existed the
        // only way back was a menu a new operator has no reason to open.
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
