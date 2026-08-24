import { useCallback, useEffect, useRef, useState } from 'react'
import { setSidebarCollapsed, setSidebarWidth, sidebarCollapsed, sidebarWidth } from '@/lib/ipc'
import {
  clampSidebarWidth,
  sidebarColumnWidth,
  SIDEBAR_DEFAULT_WIDTH,
  type SidebarLayout,
} from '@/lib/sidebarWidth'

/**
 * Debounce before a layout is written. A drag emits a move per frame and each
 * write is a read-modify-write of the layout file, so this batches them to one
 * write per changed setting per gesture. `commit()` shortcuts it on gesture end.
 */
export const SIDEBAR_PERSIST_DELAY_MS = 250

export interface SidebarLayoutHandle extends SidebarLayout {
  /** What the column measures right now — the rail's width while collapsed. */
  columnWidth: number
  /** Apply a layout now, persist it shortly. */
  set: (layout: SidebarLayout) => void
  /** Collapse or expand without disturbing the remembered width. */
  setCollapsed: (collapsed: boolean) => void
  /** Write a pending layout immediately; called when a gesture ends. */
  commit: () => void
}

const INITIAL: SidebarLayout = { collapsed: false, width: SIDEBAR_DEFAULT_WIDTH }

/**
 * Remembered shape of the process-list sidebar (width + collapsed). The host
 * owns both: read once at mount, written back debounced. Until those reads
 * resolve the sidebar renders expanded at its pre-resizable width, same as a
 * machine with no layout file.
 *
 * The two settings persist independently: a drag that never crosses the
 * collapse threshold must not rewrite the collapsed flag, and the rail toggle
 * must not rewrite the width.
 */
export function useSidebarLayout(): SidebarLayoutHandle {
  const [layout, setLayout] = useState<SidebarLayout>(INITIAL)
  // Handlers run between renders (several moves per frame), so state alone
  // would be a move behind.
  const latest = useRef<SidebarLayout>(INITIAL)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** What still has to reach the host; a key is absent once it is written. */
  const pending = useRef<Partial<SidebarLayout>>({})
  /** True once the operator has touched the sidebar; stops a slow read from
   *  landing on top of a layout they have already changed. */
  const touched = useRef(false)

  const apply = useCallback((next: SidebarLayout) => {
    latest.current = next
    setLayout(next)
  }, [])

  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
    const { width, collapsed } = pending.current
    pending.current = {}

    // No bridge, or an unwritable file. The layout still applies this session.
    if (width !== undefined) void setSidebarWidth(width).catch(() => {})
    if (collapsed !== undefined) void setSidebarCollapsed(collapsed).catch(() => {})
  }, [])

  const schedule = useCallback(
    (change: Partial<SidebarLayout>) => {
      pending.current = { ...pending.current, ...change }
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(flush, SIDEBAR_PERSIST_DELAY_MS)
    },
    [flush],
  )

  useEffect(() => {
    let disposed = false
    const adopt = (change: Partial<SidebarLayout>) => {
      if (disposed || touched.current) return
      apply({ ...latest.current, ...change })
    }

    // Two reads, so a setting the host can't answer for doesn't cost the
    // other its stored value.
    void sidebarWidth()
      .then((stored) => adopt({ width: clampSidebarWidth(stored) }))
      .catch(() => {
        // No bridge (browser dev run) — the default width stands.
      })
    void sidebarCollapsed()
      .then((stored) => adopt({ collapsed: stored }))
      .catch(() => {
        // Likewise: expanded is the default.
      })

    return () => {
      disposed = true
    }
  }, [apply])

  // Flush the debounce; window-hide doesn't unmount, so this is teardown only.
  useEffect(() => () => flush(), [flush])

  const set = useCallback(
    (next: SidebarLayout) => {
      const clamped: SidebarLayout = {
        collapsed: next.collapsed,
        width: clampSidebarWidth(next.width),
      }
      const previous = latest.current
      touched.current = true
      apply(clamped)

      // Only what moved is queued, so a drag inside the expanded range never
      // rewrites the collapsed flag, and vice versa.
      const change: Partial<SidebarLayout> = {}
      if (clamped.width !== previous.width) change.width = clamped.width
      if (clamped.collapsed !== previous.collapsed) change.collapsed = clamped.collapsed
      if (change.width !== undefined || change.collapsed !== undefined) schedule(change)
    },
    [apply, schedule],
  )

  const setCollapsed = useCallback(
    (collapsed: boolean) => {
      if (latest.current.collapsed === collapsed) return
      touched.current = true
      apply({ ...latest.current, collapsed })
      schedule({ collapsed })
    },
    [apply, schedule],
  )

  return {
    ...layout,
    columnWidth: sidebarColumnWidth(layout),
    set,
    setCollapsed,
    commit: flush,
  }
}
