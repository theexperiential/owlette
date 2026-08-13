import { Button } from '@/components/ui/button'
import type { OwletteConfig } from '@/lib/owletteConfig'
import {
  deriveFooterState,
  footerSentence,
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
}

/**
 * The one line that says whether this machine is being looked after, phrased
 * as a sentence — "TEC-A4D is connected to default_site" — with the status
 * word carrying the tone colour. Right edge: the version of the service that
 * is running, which is the version that matters, not this app's.
 */
export function StatusFooter({ status, statusFile, config, hostname, starting, onStart }: StatusFooterProps) {
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

      {state.serviceDown && (
        <Button size="sm" variant="secondary" className="h-6 px-2" disabled={starting} onClick={onStart}>
          {starting ? 'starting…' : 'start service'}
        </Button>
      )}

      <span className="flex-1" />

      {version && <span className="text-muted-foreground">v{version}</span>}
    </footer>
  )
}
