/**
 * Shorten a path so an operator can still identify it: keep the drive and the
 * tail, cut the middle — `C:/…/TouchDesigner.2025.32820/bin/TouchDesigner.exe`.
 * The tail carries the version and file name; the front is identical fleet-wide.
 * The drive stays because a path without one reads as a fragment.
 *
 * Measurement is the caller's: `fits` is any predicate correct on shorter-or-
 * equal strings, which makes this testable without a layout engine. The real
 * caller measures with the real font (`components/PathInput.tsx`).
 */

/** One character, so the cut costs as little width as it can. */
export const ELLIPSIS = '…'

const SEPARATORS = new Set(['/', '\\'])

/**
 * The part kept whatever else goes: a drive (`C:/`) or UNC share
 * (`\\host\share\`). Empty otherwise — bare file names, or the command-line
 * arguments `file_path` holds as often as a path.
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
 * Longest fitting candidate from a longest-first list, or null. Binary search,
 * not a walk: acceptance is monotonic, so a 260-char path costs a handful of
 * measurements instead of one per segment.
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
 * `value` shortened until `fits` accepts it, keeping the root and as much tail
 * as will go. Returns `value` unchanged when it already fits — that is how the
 * caller knows there is nothing to draw over.
 *
 * Preference order: `C:/…/TouchDesigner.2025.32820/bin/TouchDesigner.exe`,
 * then `…/bin/TouchDesigner.exe`, then `…ouchDesigner.exe` (keep the end, the
 * extension lives there), then bare `…`.
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

  // No separator, or one over-long segment: trim from the front.
  const trimmed = longestFitting(
    value.length,
    (index) => ELLIPSIS + value.slice(index + 1),
    fits,
  )
  return trimmed ?? ELLIPSIS
}
