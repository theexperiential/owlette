import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { OwletteConfig } from '@/lib/owletteConfig'
import {
  deriveFooterState,
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
  starting: boolean
  onStart: () => void
}

/**
 * The one line that says whether this machine is being looked after.
 *
 * Left to right: the connection state, the site this machine belongs to, and
 * the version of the service that is running — which is the version that
 * matters, not this app's.
 */
export function StatusFooter({ status, statusFile, config, starting, onStart }: StatusFooterProps) {
  const state = deriveFooterState({ status, statusFile, config })
  const site = siteIdOf(config, statusFile)
  const version = statusFile?.service?.version

  return (
    <footer className="flex items-center gap-3 border-t px-4 py-2 text-xs">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex items-center gap-2" data-testid="footer-status">
            <span
              aria-hidden
              className={cn('size-2 shrink-0 rounded-full', FOOTER_DOT_CLASS[state.tone])}
            />
            <span className={FOOTER_TONE_CLASS[state.tone]}>{state.label}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent>{state.detail ?? `owlette is connected to ${site || 'no site'}`}</TooltipContent>
      </Tooltip>

      {site && (
        <>
          <span aria-hidden className="text-border">
            ·
          </span>
          <span className="truncate text-muted-foreground" title={site}>
            {site}
          </span>
        </>
      )}

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
