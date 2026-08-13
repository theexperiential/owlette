import { Copy, FilePlus2, GripVertical, Plus, RotateCcw, Square, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ProcessListEmpty } from '@/components/ProcessListEmpty'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { ProcessEntry } from '@/lib/owletteConfig'
import { STATUS_DOT, statusForProcess, statusLabel, type AppStates } from '@/lib/processStatus'
import { setRowDragging } from '@/lib/rowDrag'
import { MENU_SURFACE } from '@/lib/surfaces'
import { cn } from '@/lib/utils'

/** Everything the context menu can ask for. Order lives on the list itself. */
export type ProcessAction = 'restart' | 'kill' | 'duplicate' | 'delete'

/** How far the pointer travels before a click becomes a drag. */
const DRAG_THRESHOLD_PX = 4

interface ProcessListProps {
  processes: ProcessEntry[]
  states: AppStates
  selectedId: string | null
  onSelect: (id: string) => void
  onAdd: () => void
  onAction: (action: ProcessAction, id: string) => void
  /** Commit a new position. Called once, on drop. */
  onReorder: (id: string, toIndex: number) => void
  /** True while an OS file drag is over the window; lights up the empty state. */
  dragOver?: boolean
}

interface MenuAnchor {
  id: string
  x: number
  y: number
}

/** The row geometry captured when a drag starts, and where it has got to. */
interface DragState {
  id: string
  from: number
  pointerId: number
  startY: number
  midpoints: number[]
  active: boolean
  gap: number
}

/**
 * The process list: what this machine is supposed to be running, whether it is,
 * and in what order it starts.
 *
 * Every row is a config entry joined to the service's live table, so the dot is
 * the service's own opinion — not something this app inferred by looking at the
 * process table itself.
 *
 * Rows are dragged to reorder because `processes[]` order *is* the launch
 * sequence. The drag is hand-rolled on pointer events for two reasons: html5
 * drag-and-drop is unreliable in a webview that has `dragDropEnabled` claiming
 * OS drops, and a flat vertical list needs neither a library nor the bundle
 * weight of one.
 */
export function ProcessList({
  processes,
  states,
  selectedId,
  onSelect,
  onAdd,
  onAction,
  onReorder,
  dragOver = false,
}: ProcessListProps) {
  // Right-click opens a menu at the pointer. Radix positions against a trigger,
  // so the trigger is a zero-size element parked at the click — the same shape
  // as a native context menu without pulling in another primitive.
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null)

  const listRef = useRef<HTMLUListElement>(null)
  const dragRef = useRef<DragState | null>(null)
  // Mirrors the ref so the indicator re-renders; the ref is what the pointer
  // handlers read, because they run between renders.
  const [dropGap, setDropGap] = useState<number | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)

  const index = anchor ? processes.findIndex((process) => process.id === anchor.id) : -1

  function act(action: ProcessAction) {
    if (!anchor) return
    const { id } = anchor
    setAnchor(null)
    onAction(action, id)
  }

  const endDrag = useCallback(() => {
    dragRef.current = null
    setRowDragging(false)
    setDraggingId(null)
    setDropGap(null)
  }, [])

  /** Where the row would land: the number of row midpoints above the pointer. */
  function gapFor(midpoints: number[], y: number): number {
    let gap = 0
    while (gap < midpoints.length && y > midpoints[gap]) gap += 1
    return gap
  }

  function handlePointerDown(event: React.PointerEvent<HTMLButtonElement>, id: string, from: number) {
    if (event.button !== 0 || processes.length < 2) return

    const rows = listRef.current?.querySelectorAll('[data-testid="process-row"]') ?? []
    const midpoints = [...rows].map((row) => {
      const rect = row.getBoundingClientRect()
      return rect.top + rect.height / 2
    })

    dragRef.current = {
      id,
      from,
      pointerId: event.pointerId,
      startY: event.clientY,
      midpoints,
      active: false,
      gap: from,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function handlePointerMove(event: React.PointerEvent<HTMLButtonElement>) {
    const state = dragRef.current
    if (!state || state.pointerId !== event.pointerId) return

    if (!state.active) {
      if (Math.abs(event.clientY - state.startY) < DRAG_THRESHOLD_PX) return
      state.active = true
      setRowDragging(true)
      setDraggingId(state.id)
    }

    state.gap = gapFor(state.midpoints, event.clientY)
    setDropGap(state.gap)
  }

  function handlePointerUp(event: React.PointerEvent<HTMLButtonElement>) {
    const state = dragRef.current
    if (!state || state.pointerId !== event.pointerId) return

    const { active, from, gap, id } = state
    endDrag()
    if (!active) return

    // The gap counts positions in the list as it stands, including the row
    // being dragged; dropping below its own position closes that hole by one.
    const target = from < gap ? gap - 1 : gap
    if (target !== from) onReorder(id, target)
  }

  // Escape abandons a drag, as it does in every list that has one.
  useEffect(() => {
    if (!draggingId) return
    const cancel = (event: KeyboardEvent) => {
      if (event.key === 'Escape') endDrag()
    }
    window.addEventListener('keydown', cancel)
    return () => window.removeEventListener('keydown', cancel)
  }, [draggingId, endDrag])

  // A drag that outlives its component would leave the flag set for the file
  // drop overlay, which would then ignore real drops.
  useEffect(() => endDrag, [endDrag])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between px-4 pt-4 pb-3">
        <h2 className="text-sm font-medium text-muted-foreground">processes</h2>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="icon-sm" variant="secondary" onClick={onAdd} aria-label="add process">
              <Plus />
            </Button>
          </TooltipTrigger>
          <TooltipContent>add process</TooltipContent>
        </Tooltip>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {processes.length === 0 ? (
          <ProcessListEmpty dragOver={dragOver} />
        ) : (
          // At least the height of the scroller, so the hint below can take the
          // space the rows leave; past that the column grows and the hint tucks
          // in under the last row.
          <div className="flex min-h-full flex-col">
            <ul ref={listRef} className="flex flex-col gap-0.5">
              {processes.map((process, position) => {
                const status = statusForProcess(states, process.id)
                const selected = process.id === selectedId
                const dragged = draggingId === process.id
                // No indicator for a drop that would change nothing.
                const showGap =
                  dropGap !== null && dragRef.current !== null
                    ? dropGap !== dragRef.current.from && dropGap !== dragRef.current.from + 1
                    : false

                return (
                  <li key={process.id} className="relative">
                    {showGap && dropGap === position && (
                      <span
                        aria-hidden
                        data-testid="drop-indicator"
                        className="absolute -top-px left-2 right-2 z-10 h-0.5 rounded-full bg-primary"
                      />
                    )}
                    {showGap && dropGap === processes.length && position === processes.length - 1 && (
                      <span
                        aria-hidden
                        data-testid="drop-indicator"
                        className="absolute -bottom-px left-2 right-2 z-10 h-0.5 rounded-full bg-primary"
                      />
                    )}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          data-testid="process-row"
                          data-process-id={process.id}
                          data-status={status}
                          data-dragging={dragged || undefined}
                          aria-current={selected}
                          className={cn(
                            'group flex w-full touch-none items-center gap-2 rounded-md px-1.5 py-2 text-left text-sm transition-colors select-none',
                            // The grab hand lives on the grip alone; the row is a
                            // click-to-select surface. A drag can still start
                            // anywhere on the row — once it does, the whole row
                            // reads as grabbed.
                            draggingId ? 'cursor-grabbing' : 'cursor-pointer',
                            selected
                              ? 'bg-accent text-accent-foreground'
                              : 'text-foreground/90 hover:bg-accent/50',
                            dragged && 'opacity-90 shadow-lg ring-1 ring-border',
                          )}
                          onClick={() => onSelect(process.id)}
                          onPointerDown={(event) => handlePointerDown(event, process.id, position)}
                          onPointerMove={handlePointerMove}
                          onPointerUp={handlePointerUp}
                          onPointerCancel={endDrag}
                          onContextMenu={(event) => {
                            event.preventDefault()
                            onSelect(process.id)
                            setAnchor({ id: process.id, x: event.clientX, y: event.clientY })
                          }}
                        >
                          <GripVertical
                            aria-hidden
                            className={cn(
                              'size-3.5 shrink-0 text-muted-foreground transition-opacity',
                              dragged ? 'opacity-70' : 'opacity-0 group-hover:opacity-60',
                              !draggingId && 'cursor-grab',
                            )}
                          />
                          <span
                            aria-hidden
                            className={cn('size-2 shrink-0 rounded-full', STATUS_DOT[status])}
                          />
                          <span className="truncate">{process.name || 'untitled process'}</span>
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="right">{statusLabel(status)}</TooltipContent>
                    </Tooltip>
                  </li>
                )
              })}
            </ul>

            {/*
              Once there are rows, the empty state's lesson — that a file dropped
              on this window becomes a process — has nowhere left to be said.
              This is that sentence, at a whisper, floating in whatever room the
              list leaves.

              It is inert (`pointer-events-none`) and outside the `ul`, so it
              cannot take a drag away from a row, an OS drop from the window, or
              a right-click from the context menu.
            */}
            <div className="flex flex-1 items-center justify-center px-3 py-6">
              <p
                data-testid="process-list-drop-hint"
                className="pointer-events-none flex flex-col items-center gap-2 text-center text-sm leading-relaxed text-muted-foreground"
              >
                <FilePlus2 aria-hidden className="size-4 shrink-0" />
                {/* max-w forces the copy onto two lines so the hint reads as a
                    compact stack instead of one wide strip. */}
                <span className="min-w-0 max-w-36">drop an app or script here to add it</span>
              </p>
            </div>
          </div>
        )}
      </div>

      {anchor && index >= 0 && (
        <DropdownMenu open onOpenChange={(open) => !open && setAnchor(null)}>
          <DropdownMenuTrigger asChild>
            <span
              aria-hidden
              className="pointer-events-none fixed size-0"
              style={{ left: anchor.x, top: anchor.y }}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="bottom" sideOffset={2} className={MENU_SURFACE}>
            <DropdownMenuItem onSelect={() => act('restart')}>
              <RotateCcw />
              restart process
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => act('kill')}>
              <Square />
              kill process
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => act('duplicate')}>
              <Copy />
              duplicate
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => act('delete')}>
              <Trash2 />
              delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}
