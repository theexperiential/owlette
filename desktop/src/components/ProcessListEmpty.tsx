import { FilePlus2 } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ProcessListEmptyProps {
  /**
   * True while a file is being dragged over the window.
   *
   * The drop handling itself belongs to the drag-and-drop task; this component
   * only has to be ready to light up when it lands, which is why the state is a
   * prop rather than something it works out for itself.
   */
  dragOver?: boolean
  className?: string
}

/**
 * What a fresh install looks like: nothing to supervise yet, and the fastest
 * way to change that.
 *
 * Dropping a file is the primary route on purpose — it is one gesture against a
 * form with nine fields — so it gets the drop-zone framing, and the button in
 * the header is named as the alternative rather than repeated as one.
 */
export function ProcessListEmpty({ dragOver = false, className }: ProcessListEmptyProps) {
  return (
    <div
      data-testid="process-list-empty"
      data-drag-over={dragOver || undefined}
      className={cn(
        'm-2 flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-4 py-10 text-center transition-colors',
        dragOver && 'border-primary bg-primary/5',
        className,
      )}
    >
      <FilePlus2
        aria-hidden
        className={cn('size-6 text-muted-foreground', dragOver && 'text-primary')}
      />
      <p className="text-sm font-medium">no processes yet</p>
      <p className="text-xs leading-relaxed text-muted-foreground">
        drag a script, app, or touchdesigner file anywhere in this window to add it
      </p>
      <p className="text-xs text-muted-foreground/70">or use add process, above</p>
    </div>
  )
}
