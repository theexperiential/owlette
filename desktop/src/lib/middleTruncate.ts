/**
 * Shortening a path so an operator can still tell which one it is.
 *
 * Cutting the end off `C:/Program Files/Derivative/TouchDesigner.2025.32820/…`
 * throws away the only part anyone reads. But the front is not worth much
 * either: `C:/Program Files/Derivative` is a given on every machine in the
 * fleet, while `TouchDesigner.2025.32820` is the build actually installed — the
 * one thing that distinguishes this entry from the next one.
 *
 * So the cut is made early and the tail is kept:
 * `C:/…/TouchDesigner.2025.32820/bin/TouchDesigner.exe`. The drive survives
 * because a path that does not start with one reads as a fragment; everything
 * after it gives way, whole segment at a time, until what is left fits.
 *
 * Measurement belongs to the caller: this module has no opinion about fonts,
 * and the one place that uses it measures the real input with the real font
 * (`components/PathInput.tsx`). Here `fits` is any predicate that gets shorter-
 * or-equal strings right, which is what makes the whole thing testable without
 * a layout engine.
 */

/** One character, so the cut costs as little width as it can. */
export const ELLIPSIS = '…'

const SEPARATORS = new Set(['/', '\\'])

/**
 * The part of a path that is kept whatever else goes: a drive (`C:/`) or a UNC
 * share (`\\host\share\`). Empty for anything else — a bare file name, or the
 * command-line arguments `file_path` holds as often as it holds a path.
 */
function rootOf(value: string): string {
  const drive = /^[a-z]:[\\/]/i.exec(value)
  if (drive) return drive[0]

  const unc = /^[\\/]{2}[^\\/]+[\\/][^\\/]+[\\/]/.exec(value)
  return unc ? unc[0] : ''
}

/** Where each path segment starts, after `from` — the places a cut can land. */
function cutPoints(value: string, from: number): number[] {
  const cuts: number[] = []
  for (let index = from; index < value.length; index += 1) {
    if (SEPARATORS.has(value[index])) cuts.push(index)
  }
  return cuts
}

/**
 * The longest candidate that fits, out of a list ordered longest-first, or null
 * when even the shortest does not.
 *
 * A binary search rather than a walk: acceptance is monotonic — every candidate
 * after the first one that fits also fits — so a 260-character path is measured
 * a handful of times instead of once per segment.
 */
function longestFitting(count: number, build: (index: number) => string, fits: (candidate: string) => boolean): string | null {
  let low = 0
  let high = count - 1
  let best: string | null = null
  while (low <= high) {
    const middle = (low + high) >> 1
    const candidate = build(middle)
    if (fits(candidate)) {
      best = candidate
      high = middle - 1
    } else {
      low = middle + 1
    }
  }
  return best
}

/**
 * `value` shortened until `fits` accepts it, keeping its root and as much of its
 * tail as will go. Returns `value` itself when it already fits, which is how the
 * caller knows there is nothing to draw over.
 *
 * Four shapes, in order of preference:
 *
 * * `C:/…/TouchDesigner.2025.32820/bin/TouchDesigner.exe` — the drive, then
 *   whole segments from the end.
 * * `…/bin/TouchDesigner.exe` — when not even the drive and one segment fit.
 * * `…ouchDesigner.exe` — when a single segment is too long for the box; the
 *   end is kept, because that is where the extension is.
 * * `…` — when nothing at all fits, which beats overflowing the box.
 */
export function middleTruncate(value: string, fits: (candidate: string) => boolean): string {
  if (!value || fits(value)) return value

  const root = rootOf(value)
  const cuts = cutPoints(value, root.length)

  // Longest first: the earliest cut keeps the most segments.
  const withRoot = longestFitting(
    cuts.length,
    (index) => root + ELLIPSIS + value.slice(cuts[index]),
    fits,
  )
  if (withRoot !== null) return withRoot

  // The drive is worth less than the segments it was protecting.
  const withoutRoot = longestFitting(
    cuts.length,
    (index) => ELLIPSIS + value.slice(cuts[index]),
    fits,
  )
  if (withoutRoot !== null) return withoutRoot

  // No separator at all, or one segment longer than the box: trim characters
  // off the front until the rest fits.
  const trimmed = longestFitting(
    value.length,
    (index) => ELLIPSIS + value.slice(index + 1),
    fits,
  )
  return trimmed ?? ELLIPSIS
}
