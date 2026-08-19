import { AppWindow } from 'lucide-react'
import { useExeIcon } from '@/hooks/useExeIcon'
import { cn } from '@/lib/utils'

interface ProcessIconProps {
  /**
   * The entry's `exe_path` — the *application*, not its document. A `.toe`
   * entry is TouchDesigner and a script is python, which is what an operator
   * recognises in a list of rows.
   */
  exePath?: string
  /** Sizing lives here; the box is the same in both states. */
  className?: string
}

/**
 * The icon for one process entry.
 *
 * Windows' own icon for the executable when there is one, and a lucide glyph
 * when there is not — a path that is empty or mistyped, a target that has no
 * icon, a host call that failed. The two occupy exactly the same box, so an
 * icon arriving a moment after the row was drawn swaps in without moving the
 * name beside it.
 *
 * Decorative in both cases: every place this appears, the process name is
 * either beside it or in the tooltip, and an icon that read itself out would
 * just be noise.
 */
export function ProcessIcon({ exePath, className }: ProcessIconProps) {
  const icon = useExeIcon(exePath)
  const box = cn('size-4 shrink-0', className)

  if (!icon) {
    return <AppWindow aria-hidden data-testid="process-icon-fallback" className={box} />
  }

  return (
    <img
      src={icon}
      alt=""
      aria-hidden
      data-testid="process-icon"
      // `object-contain` because not every icon is square once Windows has
      // scaled it, and a stretched application icon is worse than a small one.
      className={cn(box, 'object-contain')}
    />
  )
}
