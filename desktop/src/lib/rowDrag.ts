/**
 * "A process row is being dragged right now."
 *
 * A pointer-drag reorder of the process list is indistinguishable from an OS
 * file drop (Tauri `onDragDropEvent`) at the window level, so the internal
 * gesture flags itself here and the drop overlay skips it.
 *
 * Published twice on purpose: subscribers for react, and
 * `document.body[data-row-dragging]` for css/selector consumers.
 */

let dragging = false
const listeners = new Set<(dragging: boolean) => void>()

export function isRowDragging(): boolean {
  return dragging
}

export function setRowDragging(next: boolean): void {
  if (dragging === next) return
  dragging = next

  if (typeof document !== 'undefined') {
    if (next) document.body.dataset.rowDragging = 'true'
    else delete document.body.dataset.rowDragging
  }

  for (const listener of listeners) listener(next)
}

export function subscribeRowDragging(listener: (dragging: boolean) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
