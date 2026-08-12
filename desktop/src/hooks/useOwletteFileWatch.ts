import { useEffect, useRef } from 'react'
import { onOwletteFileChangedFor, type OwletteFile } from '@/lib/ipc'

/**
 * Run `onChange` whenever the host says a seam file was replaced.
 *
 * The host already coalesces the burst of events a single atomic replace
 * produces (write scratch file, rename over the target), but two of the three
 * files are rewritten by the service on a timer while the app is also writing
 * them, so a short trailing debounce keeps a re-read from being scheduled twice
 * for what is really one change.
 *
 * Subscribing rejects when there is no Tauri bridge — `npm run dev` in a plain
 * browser — and that is not an error worth surfacing: the app simply never sees
 * a change there, which is the only honest behaviour available.
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
