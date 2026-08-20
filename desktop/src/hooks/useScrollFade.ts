import { useCallback, useLayoutEffect, useRef, type RefCallback, type RefObject } from 'react'

/**
 * How tall the fade at the top of a scrolled container is once it is fully in.
 *
 * Short enough to read as an edge rather than as a vignette: a row passes under
 * whatever sits above it over about two thirds of its own height.
 */
const SCROLL_FADE_PX = 24

/** Paint the fade for wherever a scroller currently sits. */
function paint(scroller: HTMLElement | null) {
  if (!scroller) return
  const fade = Math.min(scroller.scrollTop, SCROLL_FADE_PX)
  scroller.style.maskImage =
    fade > 0 ? `linear-gradient(to bottom, transparent, #000 ${fade}px)` : ''
}

/**
 * Dissolves the top edge of a scroll container instead of cutting it.
 *
 * Content that has scrolled past the top of a pane is otherwise guillotined by
 * a boundary that draws nothing — a half-row hanging under a header reads as a
 * clipping fault rather than as scrolling. This fades it out over the last
 * {@link SCROLL_FADE_PX} instead.
 *
 * The mask is grown from nothing across the first {@link SCROLL_FADE_PX} of
 * travel, so there is no pop as it arrives and nothing is washed out while the
 * container sits at rest at the top. It is painted in the scrollport's own
 * coordinates, so it stays at the top edge while the content moves under it.
 *
 * Written straight to the node rather than held in state: it is a paint detail,
 * and a re-render for each of the first 24 pixels of a flick would take every
 * child with it. The listener is `passive`, and is added directly rather than
 * through React so that a caller which already owns an `onScroll` keeps it.
 *
 * **A mask fades the element's own background and border along with its
 * content**, so this belongs on scrollers that share their parent's ground. A
 * box that draws its own fill or outline will fade that too, and notch itself.
 *
 * It returns a **callback ref**, not a ref object, and that is load-bearing: a
 * scroller that only exists once something opens is not there when the hook
 * owner first commits, and an effect keyed on a ref object never re-runs to
 * notice — the object's identity is the same whether it holds a node or null.
 * React calls a callback ref with the node the moment it mounts, so the fade is
 * live on the first scroll rather than on the next unrelated render.
 *
 * ```tsx
 * const scroller = useScrollFade<HTMLDivElement>()
 * return <div ref={scroller} className="overflow-y-auto">…</div>
 * ```
 *
 * Pass an existing ref to keep it pointed at the same node, for a caller that
 * reads the element itself. Use the returned callback as the `ref`, not the one
 * passed in:
 *
 * ```tsx
 * const containerRef = useRef<HTMLDivElement>(null)
 * const scroller = useScrollFade(containerRef)
 * return <div ref={scroller} className="overflow-y-auto">…</div>
 * ```
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
