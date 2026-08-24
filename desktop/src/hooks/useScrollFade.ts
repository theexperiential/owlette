import { useCallback, useLayoutEffect, useRef, type RefCallback, type RefObject } from 'react'

/** Height of the top fade once fully in — short enough to read as an edge, not a vignette. */
const SCROLL_FADE_PX = 24

/** Paint the fade for wherever a scroller currently sits. */
function paint(scroller: HTMLElement | null) {
  if (!scroller) return
  const fade = Math.min(scroller.scrollTop, SCROLL_FADE_PX)
  scroller.style.maskImage =
    fade > 0 ? `linear-gradient(to bottom, transparent, #000 ${fade}px)` : ''
}

/**
 * Dissolves the top edge of a scroll container instead of cutting it: a half-row hanging
 * under a header otherwise reads as a clipping fault rather than as scrolling.
 *
 * The mask grows from nothing across the first {@link SCROLL_FADE_PX} of travel (no pop on
 * arrival, nothing washed out at rest) and is painted in the scrollport's own coordinates,
 * so it stays at the top edge while content moves under it.
 *
 * Written straight to the node rather than held in state — a re-render for each of the
 * first 24 pixels of a flick would take every child with it. The listener is `passive` and
 * added directly, not through React, so a caller that already owns `onScroll` keeps it.
 *
 * A mask fades the element's own background and border along with its content, so use it
 * only on scrollers that share their parent's ground; a box with its own fill notches itself.
 *
 * Returns a **callback ref**, and that is load-bearing: a scroller that only exists once
 * something opens isn't there when the hook owner first commits, and an effect keyed on a
 * ref object never re-runs to notice (identical identity whether it holds a node or null).
 *
 * ```tsx
 * const scroller = useScrollFade<HTMLDivElement>()
 * return <div ref={scroller} className="overflow-y-auto">…</div>
 * ```
 *
 * Pass an existing ref to keep it pointed at the same node, but still use the returned
 * callback as the element's `ref`.
 */
export function useScrollFade<T extends HTMLElement>(
  existingRef?: RefObject<T | null>,
): RefCallback<T> {
  const node = useRef<T | null>(null)

  // Content that shortens can leave the scroller somewhere it can no longer
  // reach, and the browser corrects that without always firing `scroll`.
  useLayoutEffect(() => {
    paint(node.current)
  })

  return useCallback(
    (element: T | null) => {
      node.current = element
      if (existingRef) existingRef.current = element
      if (!element) return
      paint(element)
      const onScroll = () => paint(element)
      element.addEventListener('scroll', onScroll, { passive: true })
      return () => {
        element.removeEventListener('scroll', onScroll)
        node.current = null
        if (existingRef) existingRef.current = null
      }
    },
    [existingRef],
  )
}
