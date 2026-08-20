import { AppWindow } from 'lucide-react'
import { useExeIcon } from '@/hooks/useExeIcon'
import { cn } from '@/lib/utils'

interface ProcessIconProps {
  /** The entry's `exe_path` — the *application*, not its document: a `.toe` is
   * TouchDesigner, a script is python. */
  exePath?: string
  /** Sizing lives here; the box is the same in both states. */
  className?: string
}

/**
 * Windows' own icon for the executable, or a lucide glyph when there isn't one
 * (empty/mistyped path, iconless target, failed host call). Both occupy the same
 * box, so a late-arriving icon swaps in without shifting the name beside it.
 *
 * Decorative in both cases — the process name is always beside it or in the
 * tooltip, so an icon that read itself out would be noise.
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
