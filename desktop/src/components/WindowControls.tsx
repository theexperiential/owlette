import { getCurrentWindow } from '@tauri-apps/api/window'
import { Copy, Minus, Square, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { cn } from '@/lib/utils'

/**
 * Minimise, maximise/restore and close, for a window with no native titlebar.
 *
 * The app header is the titlebar now, so these have to look and behave like the
 * ones Windows draws: far right, 46 px wide, the middle one swapping between
 * maximise and restore, and close going red on hover. Everything is painted
 * from design tokens so the light theme and any future accent change follow
 * along.
 *
 * Nothing here carries `data-tauri-drag-region` — that attribute only applies to
 * the element it is on, so the buttons sit inside the drag surface without
 * becoming part of it.
 */
/**
 * The window handle, or null when there is no Tauri bridge.
 *
 * `getCurrentWindow()` reads the bridge's metadata synchronously and throws
 * when it is absent, which is exactly the case in `npm run dev` — the browser-
 * only workflow the readme documents. Letting that throw would blank the whole
 * app during render; here it simply leaves the controls inert.
 */
function currentWindow(): ReturnType<typeof getCurrentWindow> | null {
  try {
    return getCurrentWindow()
  } catch {
    return null
  }
}

export function WindowControls({ className }: { className?: string }) {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    const appWindow = currentWindow()
    if (!appWindow) return
    let disposed = false
    let unlisten: (() => void) | undefined

    const sync = () => {
      void appWindow
        .isMaximized()
        .then((value) => {
          if (!disposed) setMaximized(value)
        })
        .catch(() => {
          /* no bridge — the controls simply stay in their default state */
        })
    }

    sync()
    // Maximising, restoring, snapping and a double-click on the drag region all
    // land here as a resize.
    void appWindow
      .onResized(sync)
      .then((stop) => {
        if (disposed) stop()
        else unlisten = stop
      })
      .catch(() => {})

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  const minimize = useCallback(() => void currentWindow()?.minimize().catch(() => {}), [])
  const toggle = useCallback(() => void currentWindow()?.toggleMaximize().catch(() => {}), [])
  const close = useCallback(() => void currentWindow()?.close().catch(() => {}), [])

  const button =
    'inline-flex h-full w-[46px] items-center justify-center text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden'

  return (
    <div className={cn('flex h-full items-stretch', className)}>
      <button type="button" aria-label="minimise" className={cn(button, 'hover:bg-accent')} onClick={minimize}>
        <Minus className="size-4" />
      </button>
      <button
        type="button"
        aria-label={maximized ? 'restore' : 'maximise'}
        data-testid="window-maximize"
        data-maximized={maximized || undefined}
        className={cn(button, 'hover:bg-accent')}
        onClick={toggle}
      >
        {maximized ? <Copy className="size-3.5 -scale-x-100" /> : <Square className="size-3.5" />}
      </button>
      <button
        type="button"
        aria-label="close"
        className={cn(button, 'hover:bg-destructive hover:text-white')}
        onClick={close}
      >
        <X className="size-4" />
      </button>
    </div>
  )
}
