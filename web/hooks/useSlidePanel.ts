'use client';

/**
 * Height-slide a single panel open/closed — the imperative parts CSS can't do:
 * mount the panel clipped at height 0 then transition to the measured pixel
 * height; settle at `auto` so later content changes reflow without animating;
 * on close snap `auto` -> pixels, reflow, then transition to 0 while keeping the
 * previous panel mounted ("held") so there is content to interpolate over; and a
 * ResizeObserver to re-target the height when dynamic-imported children paint
 * after the open measurement.
 *
 * Caller keys select the behaviour: **slide** (open/close, or `reanimateKey`
 * change between two non-null values), **reflow** (`reflowKey` change only —
 * release the pixel lock back to `auto` next frame, no slide), **silent** (same
 * key tuple, held value updates with no DOM reset).
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

interface UseSlidePanelArgs<T> {
  value: T | null;
  /**
   * Identity key (machineId on the dashboard). Two objects returning the same
   * string are the same panel — no slide.
   */
  reanimateKey: (v: T) => string;
  /**
   * Same identity, different panel kind: snap back to `auto` after the new
   * content mounts so a stale pixel lock can't clip it. Omit to opt out.
   */
  reflowKey?: (v: T) => string;
}

interface UseSlidePanelResult<T> {
  wrapperRef: React.RefCallback<HTMLDivElement>;
  contentRef: React.RefObject<HTMLDivElement | null>;
  held: T | null;
  slideAnimating: boolean;
}

const SAFETY_MS = 260;

export function useSlidePanel<T>({
  value,
  reanimateKey,
  reflowKey,
}: UseSlidePanelArgs<T>): UseSlidePanelResult<T> {
  const [held, setHeld] = useState<T | null>(value);
  const [slideAnimating, setSlideAnimating] = useState(false);

  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  // Seeded with the initial value so the first run diffs against itself and
  // short-circuits — the "panel already open on mount" case.
  const prevValueRef = useRef<T | null>(value);

  const heldRef = useRef<T | null>(value);
  const setHeldAndSync = useCallback((next: T | null) => {
    heldRef.current = next;
    setHeld(next);
  }, []);

  // Seed the resting height as soon as the node attaches. MUST be a callback
  // ref, not `useLayoutEffect([])`: callers render the wrapper behind a loading
  // gate, so a one-shot mount effect latches on the wrapper-less first commit
  // and leaves height at `auto` — the inner padding then shows as a phantom gap
  // below the header. Reads `heldRef` so the stable callback can't go stale.
  const wrapperRefCallback = useCallback((node: HTMLDivElement | null) => {
    wrapperRef.current = node;
    if (node) node.style.height = heldRef.current ? 'auto' : '0px';
  }, []);

  const timersRef = useRef<{
    fallback: ReturnType<typeof setTimeout> | null;
    raf: number | null;
    cleanupListener: (() => void) | null;
    observer: ResizeObserver | null;
  }>({ fallback: null, raf: null, cleanupListener: null, observer: null });

  useLayoutEffect(() => {
    const timers = timersRef.current;
    const wrapperEl = wrapperRef.current;

    // Terminal-state guarantee: teardown always leaves a stable height matching
    // the visual state, so a mid-transition panel switch can't leave a stuck
    // pixel value clipping taller content.
    const clearAll = () => {
      if (timers.fallback != null) { clearTimeout(timers.fallback); timers.fallback = null; }
      if (timers.raf != null) { cancelAnimationFrame(timers.raf); timers.raf = null; }
      if (timers.cleanupListener) { timers.cleanupListener(); timers.cleanupListener = null; }
      if (timers.observer) { timers.observer.disconnect(); timers.observer = null; }
      if (wrapperEl) {
        wrapperEl.style.height = heldRef.current ? 'auto' : '0px';
      }
    };

    const prev = prevValueRef.current;
    const prevOpen = prev != null;
    const nextOpen = value != null;

    // Open/close edges and machine swaps both slide — content height can jump.
    const identityChanged =
      prevOpen && nextOpen && reanimateKey(prev!) !== reanimateKey(value!);
    const isOpenClose = prevOpen !== nextOpen || identityChanged;

    // same identity, different panel kind: re-measure next frame and snap to `auto`
    const isKindSwap =
      prevOpen && nextOpen && !identityChanged && reflowKey != null &&
      reflowKey(prev!) !== reflowKey(value!);

    if (!isOpenClose) {
      prevValueRef.current = value;
      if (value) setHeldAndSync(value);
      if (isKindSwap && wrapperEl) {
        if (timers.raf != null) { cancelAnimationFrame(timers.raf); }
        timers.raf = requestAnimationFrame(() => {
          timers.raf = null;
          // browsers can't interpolate to/from `auto`, so this snaps — no flash
          wrapperEl.style.height = 'auto';
        });
      }
      return clearAll;
    }
    prevValueRef.current = value;

    // else a mid-slide panel switch leaves timers/listeners firing at the new target
    clearAll();

    const wrapper = wrapperRef.current;
    const content = contentRef.current;
    if (!wrapper) return clearAll;

    const onSlideEnd = (run: () => void): (() => void) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        if (timers.fallback != null) { clearTimeout(timers.fallback); timers.fallback = null; }
        wrapper.removeEventListener('transitionend', handler);
        run();
      };
      const handler = (e: TransitionEvent) => {
        if (e.target !== wrapper) return;
        // ignore nested child transitions (hover tweens, inner fade-ins)
        if (e.propertyName !== 'height') return;
        finish();
      };
      wrapper.addEventListener('transitionend', handler);
      // 60ms past the 200ms transition: `transitionend` can never fire (tab
      // hidden mid-animation, reduced-motion snap-to-end on some engines).
      timers.fallback = setTimeout(finish, SAFETY_MS);
      return () => {
        wrapper.removeEventListener('transitionend', handler);
      };
    };

    if (value) {
      // Open/swap: mount synchronously so children lay out this commit, clipped
      // to 0 so they don't flash at full height before the next frame.
      setHeldAndSync(value);
      wrapper.style.height = '0px';
      // force a reflow, else the browser coalesces both writes and skips the transition
      void wrapper.offsetHeight;
      setSlideAnimating(true);
      timers.raf = requestAnimationFrame(() => {
        timers.raf = null;
        // measure the inner node: wrapper.scrollHeight is 0 under overflow:hidden + inline height
        const measured = content ? content.scrollHeight : wrapper.scrollHeight;
        wrapper.style.height = `${measured}px`;

        // Dynamic-imported children can parse after this measurement on a cold
        // first click, making `measured` 0/partial. Keep the pixel target in sync
        // through the open ramp only — disconnected at transitionend below.
        if (content && typeof ResizeObserver !== 'undefined') {
          const observer = new ResizeObserver(() => {
            const h = wrapper.style.height;
            if (h === 'auto' || h === '0px' || h === '') return;
            const next = content.scrollHeight;
            if (next > 0) wrapper.style.height = `${next}px`;
          });
          observer.observe(content);
          timers.observer = observer;
        }

        timers.cleanupListener = onSlideEnd(() => {
          timers.cleanupListener = null;
          // disconnect before switching to `auto` so a late callback can't race the settle
          if (timers.observer) { timers.observer.disconnect(); timers.observer = null; }
          wrapper.style.height = 'auto';
          setSlideAnimating(false);
        });
      });
      return clearAll;
    }

    // Close: can't transition from `auto`, so snap to the measured height, force
    // a reflow, then go to 0 next frame. Held value stays mounted meanwhile.
    const currentMeasured = content ? content.scrollHeight : wrapper.scrollHeight;
    wrapper.style.height = `${currentMeasured}px`;
    void wrapper.offsetHeight;
    setSlideAnimating(true);
    timers.raf = requestAnimationFrame(() => {
      timers.raf = null;
      wrapper.style.height = '0px';
      timers.cleanupListener = onSlideEnd(() => {
        timers.cleanupListener = null;
        setHeldAndSync(null);
        setSlideAnimating(false);
      });
    });
    return clearAll;
    // Key fns are excluded on purpose: callers pass fresh references each render
    // and both are only invoked against `value`/`prev`, which are tracked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, setHeldAndSync]);

  // else an in-flight slide fires callbacks against detached nodes
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      if (timers.fallback != null) { clearTimeout(timers.fallback); timers.fallback = null; }
      if (timers.raf != null) { cancelAnimationFrame(timers.raf); timers.raf = null; }
      if (timers.cleanupListener) { timers.cleanupListener(); timers.cleanupListener = null; }
      if (timers.observer) { timers.observer.disconnect(); timers.observer = null; }
    };
  }, []);

  return { wrapperRef: wrapperRefCallback, contentRef, held, slideAnimating };
}
