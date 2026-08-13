import { useCallback, useEffect, useRef, useState } from 'react'
import { setSidebarWidth, sidebarWidth } from '@/lib/ipc'
import { clampSidebarWidth, SIDEBAR_DEFAULT_WIDTH } from '@/lib/sidebarWidth'

/**
 * How long a width sits before it is written.
 *
 * A drag emits a move per frame and each write is a read-modify-write of the
 * layout file, so the writes are batched behind this: one gesture, one file
 * write. `commit()` shortcuts it when the gesture ends.
 */
export const SIDEBAR_PERSIST_DELAY_MS = 250

export interface SidebarWidthHandle {
  /** Current width in logical pixels — always inside the clamp. */
  width: number
  /** Set the width now, persist it shortly. */
  set: (width: number) => void
  /** Write a pending width immediately; called when a gesture ends. */
  commit: () => void
}

/**
 * The remembered width of the process-list sidebar.
 *
 * The host owns the value: it is read once at mount and written back debounced.
 * Until that read resolves the sidebar renders at its pre-resizable width, which
 * is also what a machine with no layout file gets — so a first run looks exactly
 * as it did before this existed.
 */
export function useSidebarWidth(): SidebarWidthHandle {
  const [width, setWidth] = useState(SIDEBAR_DEFAULT_WIDTH)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef<number | null>(null)
  /** True once the operator has touched the divider; stops a slow read from
   *  landing on top of a width they have already dragged to. */
  const touched = useRef(false)

  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
    const next = pending.current
    if (next === null) return
    pending.current = null
    void setSidebarWidth(next).catch(() => {
      // No bridge, or the file could not be written. The width still applies to
      // this session; it just will not be there next time.
    })
  }, [])

  useEffect(() => {
    let disposed = false
    void sidebarWidth()
      .then((stored) => {
        if (!disposed && !touched.current) setWidth(clampSidebarWidth(stored))
      })
      .catch(() => {
        // No bridge (browser dev run) — the default width stands.
      })
    return () => {
      disposed = true
    }
  }, [])

  // A width left in the debounce when this unmounts would be lost. The window
  // hiding does not unmount anything, so in the app this only fires on teardown.
  useEffect(() => () => flush(), [flush])

  const set = useCallback(
    (next: number) => {
      const clamped = clampSidebarWidth(next)
      touched.current = true
      setWidth(clamped)
      pending.current = clamped
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(flush, SIDEBAR_PERSIST_DELAY_MS)
    },
    [flush],
  )

  return { width, set, commit: flush }
}
