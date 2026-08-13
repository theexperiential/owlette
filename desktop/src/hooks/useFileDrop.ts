import { getCurrentWebview } from '@tauri-apps/api/webview'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { useEffect, useRef, useState } from 'react'
import { isRowDragging } from '@/lib/rowDrag'

/**
 * OS file drops onto the window.
 *
 * Tauri's own drag-drop events are used rather than the html5 ones, and that is
 * not a preference: with `dragDropEnabled` on (`tauri.conf.json`) the webview
 * hands drops to the host instead of the page, so `ondrop` never fires — and
 * the html5 event would only carry a `File`, while this carries the absolute
 * paths the service needs to launch anything.
 *
 * The window is the drop target, all of it, so this hook lives once at the top
 * of the app and reports whether something is currently hovering it.
 *
 * Reordering the process list is a *pointer* drag inside the same window
 * (`ProcessList`), which is a different gesture that happens to look identical
 * from here. It announces itself through `rowDrag`, and this hook ignores
 * everything while it is in progress rather than lighting up the drop overlay
 * mid-reorder.
 */
export function useFileDrop(onDrop: (paths: string[]) => void): boolean {
  const [dragOver, setDragOver] = useState(false)

  // Kept in a ref so a caller that re-creates its handler every render — which
  // is what a handler closing over the config normally does — does not tear
  // down and re-register the host subscription with it.
  const handler = useRef(onDrop)
  handler.current = onDrop

  useEffect(() => {
    let disposed = false
    let unlisten: UnlistenFn | undefined

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload

        // A leave always clears, flag or not: nothing is over the window any
        // more, whatever gesture put the overlay up.
        if (payload.type === 'leave') {
          setDragOver(false)
          return
        }
        if (isRowDragging()) return

        if (payload.type === 'drop') {
          setDragOver(false)
          if (payload.paths.length) handler.current(payload.paths)
          return
        }

        setDragOver(true)
      })
      .then((fn) => {
        if (disposed) fn()
        else unlisten = fn
      })
      .catch(() => {
        // No host — `npm run dev` in a plain browser. There are no OS drops to
        // receive there, and the rest of the window still works.
      })

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  return dragOver
}
