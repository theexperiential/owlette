/**
 * Sequential toast draining over sonner.
 *
 * The bug this exists for: sonner starts EVERY toast's dismiss timer on mount and only
 * pauses it for hover-expand / interaction / hidden document — stack position is never
 * consulted (dist/index.mjs ~605). Fire three toasts together and all three timers burn
 * concurrently, so the ones behind the front expire unseen and the stack vanishes.
 *
 * The fix keeps sonner's stacked visual exactly as-is: every toast is handed to sonner
 * immediately but with `duration: Infinity` (sonner skips its own timer for Infinity),
 * and THIS module times only the stack's front toast. When the front's time is up, or
 * the user swipes it away, the next steps forward with its own full duration — the
 * stack drains one at a time, newest-first, matching sonner's visual order.
 *
 * Also here, because sonner's equivalents die with its timers: hover pause (pointer
 * over the toaster halts the drain) and burst dedupe (an identical (kind, string
 * message) already in the stack is dropped, so a retry loop can't queue N copies).
 *
 * Import `toast` from here everywhere; `<Toaster />` still comes from 'sonner'. Only
 * success / error / info / warning / dismiss are exposed — add passthroughs here so the
 * sequential behaviour stays in one place.
 */

import { toast as sonnerToast, type ExternalToast, type ToastT } from 'sonner';

type ToastKind = 'success' | 'error' | 'info' | 'warning';
type ToastMessage = Parameters<(typeof sonnerToast)['error']>[0];

/** Matches sonner's TOAST_LIFETIME default; layout.tsx's Toaster sets none. */
const DEFAULT_DURATION_MS = 4_000;

interface ShownToast {
  id: string | number;
  kind: ToastKind;
  message: ToastMessage;
  durationMs: number;
  onAutoClose?: ExternalToast['onAutoClose'];
  onDismiss?: ExternalToast['onDismiss'];
}

/** Arrival order. Sonner renders the NEWEST toast at the stack front, so the
 *  front — the one whose clock runs — is the LAST entry here. */
const shown: ShownToast[] = [];

let timer: ReturnType<typeof setTimeout> | null = null;
let timerStartedAt = 0;
let remainingMs = 0;
let hoverPaused = false;
/** Set just before a controller-initiated dismiss so the resulting sonner
 *  onDismiss callback (fired for programmatic dismissals too) is not treated
 *  as a user swipe and double-advances the drain. */
let autoClosingId: string | number | null = null;
let listenersReady = false;

function front(): ShownToast | undefined {
  return shown[shown.length - 1];
}

function clearTimer() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

function startTimer(ms: number) {
  clearTimer();
  remainingMs = ms;
  timerStartedAt = Date.now();
  if (hoverPaused) return; // resume() re-arms with the remaining time
  timer = setTimeout(autoDismissFront, ms);
}

/** (Re)start the clock for whatever is at the front now. A toast displaced
 *  from the front mid-count gets a FULL duration when it returns — partial
 *  stage time is not a fair showing. */
function retime() {
  const current = front();
  if (current) startTimer(current.durationMs);
  else clearTimer();
}

function removeById(id: string | number) {
  const index = shown.findIndex(t => t.id === id);
  if (index !== -1) shown.splice(index, 1);
}

function autoDismissFront() {
  const current = front();
  if (!current) return;
  autoClosingId = current.id;
  sonnerToast.dismiss(current.id);
  // Sonner's own onAutoClose can never fire under duration:Infinity — honour
  // any caller-provided handler here, where the auto-close actually happens.
  current.onAutoClose?.({ id: current.id } as ToastT);
  removeById(current.id);
  retime();
}

/** Wired as every toast's sonner onDismiss. Handles user-initiated closes
 *  (swipe / close button); controller-initiated ones are identified by
 *  autoClosingId and already fully handled in autoDismissFront. */
function handleSonnerDismiss(t: ToastT) {
  if (autoClosingId === t.id) {
    autoClosingId = null;
    return;
  }
  const wasFront = front()?.id === t.id;
  const entry = shown.find(s => s.id === t.id);
  entry?.onDismiss?.(t);
  removeById(t.id);
  if (wasFront) retime();
}

/* Hover pause — mirrors sonner's own pause-on-hover, which duration:Infinity disables.
 * Pointer anywhere over the toaster halts the drain so the user can read the (possibly
 * expanded) stack; leaving resumes the front toast's remaining time. */
function pauseDrain() {
  if (hoverPaused) return;
  hoverPaused = true;
  if (timer) {
    clearTimer();
    remainingMs = Math.max(0, remainingMs - (Date.now() - timerStartedAt));
  }
}

function resumeDrain() {
  if (!hoverPaused) return;
  hoverPaused = false;
  // Never resume into an instant dismissal — give at least a beat.
  if (front()) startTimer(Math.max(remainingMs, 400));
}

function inToaster(node: EventTarget | null): boolean {
  return node instanceof Element && node.closest('[data-sonner-toaster]') !== null;
}

function ensureListeners() {
  if (listenersReady || typeof window === 'undefined') return;
  listenersReady = true;
  window.addEventListener('mouseover', event => {
    if (inToaster(event.target)) pauseDrain();
  });
  window.addEventListener('mouseout', event => {
    if (inToaster(event.target) && !inToaster(event.relatedTarget)) resumeDrain();
  });
}

function enqueue(kind: ToastKind, message: ToastMessage, opts: ExternalToast = {}) {
  ensureListeners();

  // Burst dedupe: an identical notification already on screen would drain as a duplicate
  // full-duration toast. Non-string (JSX) messages are never deduped.
  if (typeof message === 'string' && shown.some(t => t.kind === kind && t.message === message)) {
    return;
  }

  const { duration, onAutoClose, onDismiss, ...rest } = opts;
  const id = sonnerToast[kind](message, {
    ...rest,
    duration: Infinity, // the controller owns dismissal — see module comment
    onDismiss: handleSonnerDismiss,
  });

  shown.push({
    id,
    kind,
    message,
    durationMs: duration ?? DEFAULT_DURATION_MS,
    onAutoClose,
    onDismiss,
  });

  // The new arrival is the new visual front — its clock starts now.
  retime();
}

export const toast = {
  success: (message: ToastMessage, opts?: ExternalToast) => enqueue('success', message, opts),
  error: (message: ToastMessage, opts?: ExternalToast) => enqueue('error', message, opts),
  info: (message: ToastMessage, opts?: ExternalToast) => enqueue('info', message, opts),
  warning: (message: ToastMessage, opts?: ExternalToast) => enqueue('warning', message, opts),
  /** Passthrough. Clears controller state for whatever it dismisses. */
  dismiss: (id?: string | number) => {
    if (id === undefined) {
      shown.length = 0;
      clearTimer();
    } else {
      const wasFront = front()?.id === id;
      autoClosingId = id; // suppress the resulting onDismiss round-trip
      removeById(id);
      if (wasFront) retime();
    }
    return sonnerToast.dismiss(id);
  },
};
