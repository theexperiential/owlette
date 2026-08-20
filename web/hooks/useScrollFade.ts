'use client';

import { useCallback, useLayoutEffect, useRef, type RefCallback, type RefObject } from 'react';

/** Fade height at full extent — short enough to read as an edge, not a vignette. */
const SCROLL_FADE_PX = 24;

/** Paint the fade for wherever a scroller currently sits. */
function paint(scroller: HTMLElement | null) {
  if (!scroller) return;
  const fade = Math.min(scroller.scrollTop, SCROLL_FADE_PX);
  scroller.style.maskImage =
    fade > 0 ? `linear-gradient(to bottom, transparent, #000 ${fade}px)` : '';
}

/**
 * Dissolves the top edge of a scroll container instead of cutting it: a half-row
 * hanging under a header reads as a clipping fault, not as scrolling.
 *
 * The mask grows from nothing over the first {@link SCROLL_FADE_PX} of travel,
 * painted in the scrollport's own coordinates so it stays at the top edge.
 * Written straight to the node, not state — a re-render per pixel of a flick
 * would take every child with it. The `passive` listener is attached directly
 * rather than through React so a caller's own `onScroll` survives.
 *
 * CAVEAT: a mask fades the element's own background and border too, so use this
 * only on scrollers that share their parent's ground — a box with `border` or
 * `bg-background/50` notches itself. On a short fixed-height list 24px is a
 * tenth of the box and reads as a vignette.
 *
 * Returns a CALLBACK ref, and that is load-bearing: a scroller inside a dialog
 * doesn't exist until it opens, and an effect keyed on a ref object never
 * re-runs to notice (same object identity either way), so the listener would
 * only ever attach if the node happened to be mounted on the first commit.
 *
 * Pass an existing ref to keep it pointed at the same node; still use the
 * RETURNED callback as `ref`, not the one passed in.
 *
 * ```tsx
 * const scroller = useScrollFade<HTMLDivElement>();
 * return <div ref={scroller} className="overflow-y-auto">…</div>;
 * ```
 */
export function useScrollFade<T extends HTMLElement>(
  existingRef?: RefObject<T | null>,
): RefCallback<T> {
  const node = useRef<T | null>(null);

  // Content that shortens can leave the scroller somewhere it can no longer
  // reach, and the browser corrects that without always firing `scroll`.
  useLayoutEffect(() => {
    paint(node.current);
  });

  return useCallback(
    (element: T | null) => {
      node.current = element;
      if (existingRef) existingRef.current = element;
      if (!element) return;
      paint(element);
      const onScroll = () => paint(element);
      element.addEventListener('scroll', onScroll, { passive: true });
      return () => {
        element.removeEventListener('scroll', onScroll);
        node.current = null;
        if (existingRef) existingRef.current = null;
      };
    },
    [existingRef],
  );
}
