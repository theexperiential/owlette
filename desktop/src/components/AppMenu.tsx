import { BookOpen, Bug, FileCog, LogIn, LogOut, Menu, ScrollText } from 'lucide-react'
import { useCallback } from 'react'
import { toast } from 'sonner'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { openExternalUrl, openOwlettePath } from '@/lib/agentCli'
import { OWLETTE_FILES } from '@/lib/ipc'
import { MENU_SURFACE } from '@/lib/surfaces'

/** Where the logs the operator wants live, relative to the data root. */
export const LOGS_DIR = 'logs'

/** Public documentation. Both environments read the same site. */
export const DOCS_URL = 'https://owlette.app/docs'

interface AppMenuProps {
  /** True when this machine belongs to a site — decides join vs leave. */
  paired: boolean
  onJoinSite: () => void
  onLeaveSite: () => void
  onReportIssue: () => void
}

/**
 * The overflow menu, ported from the legacy GUI's `···` panel
 * (`owlette_gui._toggle_overflow_menu`, :2524-2574).
 *
 * Same four items in the same order — config, logs, docs, feedback — plus the
 * site action the legacy GUI kept in its firebase status footer.
 *
 * Both places carry it now, for different readers. This menu is where an
 * operator who knows the app looks for `leave site`; the footer's `join site`
 * button is for the one who does not yet know this menu exists, and a machine
 * that belongs to no site cannot be talked about without offering the way back.
 * The footer shows only that one, only while the service is up, so it never
 * competes with `start service`.
 *
 * Opening a file, a folder or a link goes through the host
 * (`src-tauri/src/shell_open.rs`), which is what `os.startfile` was doing under
 * the legacy items; nothing is spawned from here.
 */
export function AppMenu({ paired, onJoinSite, onLeaveSite, onReportIssue }: AppMenuProps) {
  const open = useCallback((path: string, what: string) => {
    void openOwlettePath(path).catch((cause: unknown) => {
      toast.error(`could not open ${what}`, {
        description: cause instanceof Error ? cause.message : String(cause),
      })
    })
  }, [])

  const openDocs = useCallback(() => {
    void openExternalUrl(DOCS_URL).catch((cause: unknown) => {
      toast.error('could not open the documentation', {
        description: cause instanceof Error ? cause.message : String(cause),
      })
    })
  }, [])

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="menu"
        data-testid="app-menu-trigger"
        className="inline-flex h-full w-[46px] items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-hidden"
      >
        <Menu className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className={`${MENU_SURFACE} w-52`}>
        {paired ? (
          <DropdownMenuItem data-testid="menu-leave-site" onSelect={onLeaveSite}>
            <LogOut aria-hidden className="size-4" />
            leave site
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem data-testid="menu-join-site" onSelect={onJoinSite}>
            <LogIn aria-hidden className="size-4" />
            join site
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          data-testid="menu-config"
          onSelect={() => open(OWLETTE_FILES.config, 'config.json')}
        >
          <FileCog aria-hidden className="size-4" />
          config
        </DropdownMenuItem>
        <DropdownMenuItem data-testid="menu-logs" onSelect={() => open(LOGS_DIR, 'the logs folder')}>
          <ScrollText aria-hidden className="size-4" />
          logs
        </DropdownMenuItem>
        <DropdownMenuItem data-testid="menu-docs" onSelect={openDocs}>
          <BookOpen aria-hidden className="size-4" />
          docs
        </DropdownMenuItem>
        <DropdownMenuItem data-testid="menu-report-issue" onSelect={onReportIssue}>
          <Bug aria-hidden className="size-4" />
          submit bug report
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
