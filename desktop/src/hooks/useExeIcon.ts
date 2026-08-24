import { useEffect, useState } from 'react'
import { exeIcon } from '@/lib/ipc'

/**
 * Icons already asked for, keyed by path.
 *
 * Two maps: the promise so rows mounting in the same frame share one host call
 * instead of racing, and the settled value so a known icon paints on the first
 * frame rather than flashing the fallback. The host caches too (by path +
 * mtime); this pair makes a re-render free.
 *
 * Keyed by the path as written in `config.json`, unnormalised — two spellings
 * cost two entries and one extraction, cheaper than reimplementing the host's
 * normalisation here.
 */
const inflight = new Map<string, Promise<string | null>>()
const settled = new Map<string, string | null>()

/** Ask for a path's icon, sharing a call already in flight for it. */
export function loadExeIcon(path: string): Promise<string | null> {
  const cached = inflight.get(path)
  if (cached) return cached

  const request = exeIcon(path)
    .catch(() => null)
    .then((icon) => {
      settled.set(path, icon)
      return icon
    })
  inflight.set(path, request)
  return request
}

/** What is already known about a path: the icon, null for none, undefined for
 *  "not asked yet". */
export function knownExeIcon(path: string): string | null | undefined {
  return settled.get(path)
}

/** Forget everything asked for so far. Tests only; the app never needs it. */
export function resetExeIconCache(): void {
  inflight.clear()
  settled.clear()
}

/**
 * An executable's icon as a `data:` URL; null while loading and for anything
 * without one. Null is not an error — usually it means "not yet" — so callers
 * draw a fallback glyph and swap the image in. Nothing here reports failure: an
 * unreadable icon looks the same on screen as a file type with none.
 */
export function useExeIcon(path: string | undefined): string | null {
  const [icon, setIcon] = useState<string | null>(() => knownExeIcon(path?.trim() ?? '') ?? null)

  useEffect(() => {
    const target = path?.trim()
    if (!target) {
      setIcon(null)
      return
    }

    const known = knownExeIcon(target)
    if (known !== undefined) {
      setIcon(known)
      return
    }

    // Whatever is on screen belongs to the previous path — an operator retyping
    // an exe would otherwise keep the old icon until the new one resolved.
    setIcon(null)

    // A path that changes again in flight must not take the old answer.
    let current = true
    void loadExeIcon(target).then((loaded) => {
      if (current) setIcon(loaded)
    })
    return () => {
      current = false
    }
  }, [path])

  return icon
}
