'use client';

/**
 * useSlidePanel
 *
 * Reveal/hide a single panel beneath a list with a smooth height
 * transition. The hook owns the imperative dance that pure CSS can't
 * pull off on its own:
 *
 *  - mount the next panel synchronously on open so it lays out *inside*
 *    a clipped wrapper (height: 0), then transition the wrapper to the
 *    measured pixel height once layout stabilizes;
 *  - on close, snap from `auto` to the measured pixel height, force a
 *    reflow, then transition to 0;
 *  - settle at `height: auto` after open so later content changes
 *    (tab switch, time-range tweak) reflow naturally with no animation;
 *  - keep the previous panel mounted ("held") for the duration of the
 *    close transition so the slide has visual content to interpolate
 *    over;
 *  - tolerate dynamic-imported children whose first paint lands AFTER
 *    the open measurement via a ResizeObserver that re-targets the
 *    pixel height while the wrapper is still in its transitioning
 *    phase.
 *
 * The hook distinguishes three kinds of state changes via caller-
 * supplied keys:
 *
 *  - **slide**: panel opens, closes, or `reanimateKey` changes between
 *    two non-null values (e.g. machine swap). Full height animation.
 *  - **reflow**: same `reanimateKey` but `reflowKey` changes (e.g.
 *    display ↔ metric panel on the same machine). The wrapper is
 *    locked at the previous content's pixel height under
 *    `overflow: hidden`; releasing it back to `auto` on the next frame
 *    lets the new content reflow without a slide.
 *  - **silent**: same key tuple (e.g. tab change inside the panel).
 *    The held value updates but no DOM-level reset runs.
 *
 * Returns refs the caller wires to the wrapper and inner content nodes,
 * the held panel value (for rendering), and a `slideAnimating` flag
 * (e.g. for content-visibility hints on offscreen siblings during the
 * transition).
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

interface UseSlidePanelArgs<T> {
  value: T | null;
  /**
   * Identity key — when this differs across two non-null values (or
   * value goes null↔non-null), run the full height-slide animation.
   * For the dashboard / demo this is the machineId. The function is
   * invoked with the held / next non-null value; if it returns the
   * same string for two different objects they're treated as the same
   * panel (no slide).
   */
  reanimateKey: (v: T) => string;
  /**
   * Reflow key — when the identity is unchanged but this differs
   * (display↔metric panel kind on the same machine), snap the wrapper
   * back to `auto` after the new content mounts so the differing
   * natural height isn't clipped by a stale pixel lock. Optional;
   * omit to opt out of reflow handling.
   */
  reflowKey?: (v: T) => string;
}

interface UseSlidePanelResult<T> {
  wrapperRef: React.RefObject<HTMLDivElement | null>;
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

  // Tracks the value seen by the previous effect run. Seeded with the
  // initial value so the first run diffs against itself and short-
  // circuits — matches the "panel already open on mount" case.
  const prevValueRef = useRef<T | null>(value);

  const heldRef = useRef<T | null>(value);
  const setHeldAndSync = useCallback((next: T | null) => {
    heldRef.current = next;
    setHeld(next);
  }, []);

  const timersRef = useRef<{
    fallback: ReturnType<typeof setTimeout> | null;
    raf: number | null;
    cleanupListener: (() => void) | null;
    observer: ResizeObserver | null;
  }>({ fallback: null, raf: null, cleanupListener: null, observer: null });

  // Seed wrapper height to match initial state synchronously, before
  // first paint, so a persisted-open panel doesn't flash collapsed on
  // mount and a closed panel doesn't render at full height before the
  // first transition runs.
  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    wrapper.style.height = value ? 'auto' : '0px';
    // Initial-mount only — subsequent renders are driven by the
    // animation effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    const timers = timersRef.current;
    const wrapperEl = wrapperRef.current;

    // Defensive terminal-state guarantee: whenever in-flight
    // transition work tears down, the wrapper ends on a stable height
    // matching the current visual state — `auto` if visually open
    // (held value still mounted), `0px` if closed. Prevents stuck
    // pixel values from clipping subsequent (taller) content when the
    // user switches panels mid-transition.
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

    // Identity-level change drives the slide. Open/close edges always
    // qualify; identity-change between two non-null values (e.g.
    // machine swap) does too because the natural content height can
    // jump dramatically.
    const identityChanged =
      prevOpen && nextOpen && reanimateKey(prev!) !== reanimateKey(value!);
    const isOpenClose = prevOpen !== nextOpen || identityChanged;

    // Reflow case: same identity but different `reflowKey` (panel kind
    // swap). Re-measure on next frame and snap to `auto`.
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
          // Browsers can't interpolate to/from `auto`, so writing
          // `'auto'` while the wrapper holds a pixel value snaps
          // instantly — no transition flash.
          wrapperEl.style.height = 'auto';
        });
      }
      return clearAll;
    }
    prevValueRef.current = value;

    // Cancel any pending work from a previous transition so clicking
    // between panels mid-slide can't leave dangling timers/listeners
    // firing against the new target.
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
        // Filters nested child transitions (hover tweens, fade-ins
        // on inner content) so only the slide settling triggers.
        if (e.propertyName !== 'height') return;
        finish();
      };
      wrapper.addEventListener('transitionend', handler);
      // 60ms past the 200ms transition duration — covers the
      // pathological case where `transitionend` doesn't fire (tab
      // hidden during animation, reduced-motion snap-to-end on some
      // engines). On the happy path the listener fires first and
      // clears this timer.
      timers.fallback = setTimeout(finish, SAFETY_MS);
      return () => {
        wrapper.removeEventListener('transitionend', handler);
      };
    };

    if (value) {
      // Opening (or machine swap while open). Mount the next held
      // value synchronously so children lay out inside the wrapper on
      // this same commit; clip to 0 immediately so they don't flash
      // at full height before the next frame applies the target.
      setHeldAndSync(value);
      wrapper.style.height = '0px';
      // Force a reflow so the browser commits height: 0 before the
      // target write — otherwise it may collapse the two writes and
      // skip the transition entirely.
      void wrapper.offsetHeight;
      setSlideAnimating(true);
      timers.raf = requestAnimationFrame(() => {
        timers.raf = null;
        // Measure inner container — wrapper.scrollHeight collapses
        // to 0 because of overflow: hidden + the inline height style.
        const measured = content ? content.scrollHeight : wrapper.scrollHeight;
        wrapper.style.height = `${measured}px`;

        // Dynamic-imported children may finish parsing AFTER this
        // measurement on a cold first-click — `measured` reads 0 or
        // a partial value. ResizeObserver keeps the wrapper's pixel
        // target in sync while content grows during the open ramp.
        // Scoped to the open phase only: disconnected on
        // transitionend (or safety timer) below, recreated on next
        // open. Once settled at `auto`, natural reflow handles
        // subsequent size changes.
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
          // Disconnect observer BEFORE switching to `auto` so a final
          // content-size callback can't race the settle write.
          if (timers.observer) { timers.observer.disconnect(); timers.observer = null; }
          wrapper.style.height = 'auto';
          setSlideAnimating(false);
        });
      });
      return clearAll;
    }

    // Closing. Can't transition from `auto`; snap to the current
    // measured height first, force a reflow, then transition to 0
    // on the next frame. Held value stays mounted for the duration
    // so the slide has smooth visual content to interpolate over.
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
    // `reanimateKey` and `reflowKey` are caller-provided functions; we
    // intentionally don't depend on them to avoid re-running this
    // effect when callers pass fresh function references each render.
    // The functions are only invoked against `value` and `prev`, both
    // of which are tracked through React state / the prev ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, setHeldAndSync]);

  // Cleanup any pending timers / observers on unmount so a slide in
  // progress when the parent unmounts doesn't fire callbacks against
  // detached nodes.
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      if (timers.fallback != null) { clearTimeout(timers.fallback); timers.fallback = null; }
      if (timers.raf != null) { cancelAnimationFrame(timers.raf); timers.raf = null; }
      if (timers.cleanupListener) { timers.cleanupListener(); timers.cleanupListener = null; }
      if (timers.observer) { timers.observer.disconnect(); timers.observer = null; }
    };
  }, []);

  return { wrapperRef, contentRef, held, slideAnimating };
}
