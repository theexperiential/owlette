import { getCurrentWebview } from '@tauri-apps/api/webview'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { useEffect, useRef, useState } from 'react'
import { isRowDragging } from '@/lib/rowDrag'

/**
 * OS file drops onto the window. Mount once at the app root — the whole window
 * is the drop target.
 *
 * Tauri events, not html5: with `dragDropEnabled` (tauri.conf.json) the webview
 * routes drops to the host so `ondrop` never fires, and html5 would only give a
 * `File` where the service needs absolute paths.
 *
 * Pointer-drag reorders in `ProcessList` look identical from here, so they flag
 * themselves via `rowDrag` and are ignored to avoid a mid-reorder overlay.
 */
export function useFileDrop(onDrop: (paths: string[]) => void): boolean {
  const [dragOver, setDragOver] = useState(false)

  // Ref so a caller re-creating its handler each render doesn't re-register the
  // host subscription.
  const handler = useRef(onDrop)
  handler.current = onDrop

  useEffect(() => {
    let disposed = false
    let unlisten: UnlistenFn | undefined

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload

        // Leave always clears, flag or not — nothing is over the window.
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
        // No Tauri host (`npm run dev` in a plain browser) — no OS drops exist.
      })

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  return dragOver
}
