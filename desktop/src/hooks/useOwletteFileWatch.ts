import { useEffect, useRef } from 'react'
import { onOwletteFileChangedFor, type OwletteFile } from '@/lib/ipc'

/**
 * Run `onChange` whenever the host reports a seam file was replaced.
 *
 * The host coalesces one atomic replace's event burst, but the service rewrites
 * two of the three files on a timer while the app writes them too, so a short
 * trailing debounce stops one change scheduling two re-reads.
 *
 * Subscribing rejects with no Tauri bridge (`npm run dev` in a browser); that's
 * not an error — the app just never sees a change there.
 */
export function useOwletteFileWatch(file: OwletteFile, onChange: () => void, debounceMs = 80): void {
  const handler = useRef(onChange)

  useEffect(() => {
    handler.current = onChange
  }, [onChange])

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    let timer: ReturnType<typeof setTimeout> | undefined

    void onOwletteFileChangedFor(file, () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => handler.current(), debounceMs)
    })
      .then((stop) => {
        if (disposed) stop()
        else unlisten = stop
      })
      .catch(() => {
        /* no bridge — nothing to watch */
      })

    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
      unlisten?.()
    }
  }, [file, debounceMs])
}
