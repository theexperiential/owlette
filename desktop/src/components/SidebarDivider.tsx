import { useRef, useState } from 'react'
import {
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  widthForDrag,
  widthForKey,
} from '@/lib/sidebarWidth'
import { cn } from '@/lib/utils'

interface SidebarDividerProps {
  /** Current sidebar width, in logical pixels. */
  width: number
  /** Called continuously while dragging — cheap, local state only. */
  onWidth: (width: number) => void
  /** Called once when the gesture ends, to persist what was landed on. */
  onCommit?: () => void
  className?: string
}

/**
 * The line between the process list and the detail pane, and the handle that
 * moves it.
 *
 * It is the border it replaces — one hairline, painted in the same token — until
 * a pointer approaches, so nothing about the window advertises that this is a
 * control until it is useful. The grab area is nine pixels wide even though the
 * line is one: a 1 px hit target is a game, not an affordance.
 *
 * Dragged to the far left, the sidebar parks at its minimum rather than
 * disappearing. That is the collapse gesture — there is no second control to
 * find, and a list that is still 200 px wide is still a list.
 */
export function SidebarDivider({ width, onWidth, onCommit, className }: SidebarDividerProps) {
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null)
  const [dragging, setDragging] = useState(false)

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    // Without this the drag selects the text either side of the divider.
    event.preventDefault()
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: width,
    }
    // Capture keeps the moves coming while the pointer is over the webview's
    // other panes — and over the detail pane's inputs, which would otherwise
    // swallow them.
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragging(true)
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const state = drag.current
    if (!state || state.pointerId !== event.pointerId) return
    onWidth(widthForDrag(state.startWidth, event.clientX - state.startX))
  }

  /** Ends the gesture — on release, and on a cancel the OS decides to send. */
  function endDrag(event: React.PointerEvent<HTMLDivElement>) {
    const state = drag.current
    if (!state || state.pointerId !== event.pointerId) return
    drag.current = null
    setDragging(false)
    // Pointer capture is released implicitly after this event, as it is in the
    // process list's own drag.
    onCommit?.()
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const next = widthForKey(width, event.key, event.shiftKey)
    if (next === null) return
    event.preventDefault()
    onWidth(next)
  }

  return (
    <div
      // The window-splitter pattern: a focusable separator carrying the range it
      // moves through, so the width is legible to a screen reader and to the
      // keyboard without a visible label.
      role="separator"
      aria-orientation="vertical"
      aria-label="resize the process list"
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_MIN_WIDTH}
      aria-valuemax={SIDEBAR_MAX_WIDTH}
      tabIndex={0}
      data-testid="sidebar-divider"
      data-dragging={dragging || undefined}
      className={cn(
        'relative z-10 w-px shrink-0 cursor-col-resize touch-none select-none bg-border outline-hidden transition-colors',
        'hover:bg-ring focus-visible:bg-ring',
        dragging && 'bg-ring',
        className,
      )}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={handleKeyDown}
      onKeyUp={() => onCommit?.()}
      onBlur={() => onCommit?.()}
    >
      {/* One pixel is the look; nine pixels is the target. Absolutely
          positioned so widening it moves nothing either side. */}
      <span aria-hidden className="absolute inset-y-0 -left-1 -right-1" />
    </div>
  )
}
