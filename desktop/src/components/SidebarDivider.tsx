import { useRef, useState } from 'react'
import {
  layoutForDrag,
  layoutForKey,
  sidebarColumnWidth,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_RAIL_WIDTH,
  type SidebarLayout,
} from '@/lib/sidebarWidth'
import { cn } from '@/lib/utils'

interface SidebarDividerProps {
  /** Current sidebar layout: collapsed or not, and how wide when not. */
  layout: SidebarLayout
  /** Called continuously while dragging — cheap, local state only. */
  onLayout: (layout: SidebarLayout) => void
  /** Called once when the gesture ends, to persist what was landed on. */
  onCommit?: () => void
  /**
   * Drag start/end. The aside animates width for toggle/keyboard collapses but
   * must NOT during a drag — an eased width fighting the cursor reads as lag.
   */
  onDraggingChange?: (dragging: boolean) => void
  className?: string
}

/**
 * The line between the process list and the detail pane, plus its drag handle.
 *
 * Renders as the hairline border it replaces (same token) until a pointer
 * approaches, so it doesn't advertise itself. The grab area is 9px wide though
 * the line is 1px — a 1px hit target is not an affordance.
 *
 * Dragged far enough left it collapses to the icon rail rather than vanishing;
 * dragging back out restores the previous width. The rail's toggle reaches the
 * same state by click, for operators who never think to drag a border.
 */
export function SidebarDivider({
  layout,
  onLayout,
  onCommit,
  onDraggingChange,
  className,
}: SidebarDividerProps) {
  const drag = useRef<{ pointerId: number; startX: number; start: SidebarLayout } | null>(null)
  const [dragging, setDragging] = useState(false)

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    // Without this the drag selects the text either side of the divider.
    event.preventDefault()
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      start: layout,
    }
    // Capture keeps moves flowing over the other panes — the detail pane's
    // inputs would otherwise swallow them.
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragging(true)
    onDraggingChange?.(true)
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const state = drag.current
    if (!state || state.pointerId !== event.pointerId) return
    onLayout(layoutForDrag(state.start, event.clientX - state.startX))
  }

  /** Ends the gesture — on release, and on a cancel the OS decides to send. */
  function endDrag(event: React.PointerEvent<HTMLDivElement>) {
    const state = drag.current
    if (!state || state.pointerId !== event.pointerId) return
    drag.current = null
    setDragging(false)
    onDraggingChange?.(false)
    // Capture releases implicitly after this event.
    onCommit?.()
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const next = layoutForKey(layout, event.key, event.shiftKey)
    if (next === null) return
    event.preventDefault()
    onLayout(next)
  }

  return (
    <div
      // Window-splitter pattern: a focusable separator carrying its range, so
      // the width is legible to a screen reader without a visible label. The
      // rail is the bottom of that range — one width below the column minimum.
      role="separator"
      aria-orientation="vertical"
      aria-label="resize the process list"
      aria-valuenow={sidebarColumnWidth(layout)}
      aria-valuemin={SIDEBAR_RAIL_WIDTH}
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
