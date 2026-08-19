/**
 * "A process row is being dragged right now."
 *
 * The process list reorders itself with pointer events, and a later wave adds
 * an OS file-drop target over the whole window (Tauri's `onDragDropEvent`).
 * Those are different gestures that look alike from the window's point of view,
 * so the internal one announces itself here and the drop overlay can ignore it.
 *
 * Published two ways on purpose: subscribers for react, and
 * `document.body[data-row-dragging]` for anything that would rather write a css
 * rule or a selector than import a module.
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
