import { useEffect, useState } from 'react'
import { exeIcon } from '@/lib/ipc'

/**
 * Icons already asked for, by the path they were asked about.
 *
 * Two maps rather than one: the promise so several rows mounting in the same
 * frame — which is what happens on every launch — share one host call instead of
 * racing each other, and the settled value so a row that already knows its icon
 * can render it on the first paint rather than flashing the fallback for a
 * frame. The host caches as well, by path and modified time; this pair exists so
 * a re-render costs nothing at all.
 *
 * Keyed by the path as written in `config.json`, not normalised: two spellings
 * of the same file are two entries here and one extraction there, which is a
 * cheaper trade than reimplementing the host's normalisation on this side.
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
 * The icon for an executable, as a `data:` URL, or null while it is loading and
 * for anything that has none.
 *
 * Null is not an error state — most of the time it means "not yet" — so the
 * caller draws its fallback glyph in the same box and swaps the image in when
 * it arrives. Nothing here reports a failure: an icon that could not be read is
 * indistinguishable, on screen, from a file type that has none.
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

    // Nothing is known about this path yet, and whatever is on screen belongs to
    // the previous one — an operator retyping an exe would otherwise keep the
    // old application's icon until the new one resolved.
    setIcon(null)

    // …and a path that changes again while this is in flight must not take the
    // answer to the question it replaced.
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
