'use client';

/**
 * useAckBanner Hook (Wave 6.5f)
 *
 * Per-machine countdown state for the post-apply "keep this layout?" banner.
 * The state lives in a module-level store keyed by `(siteId, machineId)` so
 * the banner survives the panel closing and re-opening — without this the
 * countdown would lose its deadline whenever the operator closed the panel
 * mid-window, leaving them no in-UI affordance to ack the change before the
 * agent's auto-revert watchdog fired.
 *
 * One shared `setInterval(250ms)` ticks all active countdowns and fires the
 * "no confirmation sent — agent will auto-revert" toast exactly once per
 * countdown when the absolute deadline elapses, regardless of whether any
 * panel is currently subscribed. Dashboard-level subscribers can render a
 * machine-row badge that survives the panel.
 *
 * Persistence is in-memory only — by design (per the project's
 * `feedback_no_localstorage` rule, machine state belongs in Firestore, not
 * the browser). The agent already owns the ground truth via the on-disk
 * sentinel + watchdog; this hook is purely a UI affordance for the operator
 * who initiated the apply, in the tab that initiated it.
 */

import { useSyncExternalStore } from 'react';
import { toast } from 'sonner';

interface AckEntry {
  ackDeadlineMs: number;
  pendingApplyId: string;
  ackInFlight: boolean;
}

const entries = new Map<string, AckEntry>();
const subscribers = new Set<() => void>();
let tickIntervalId: ReturnType<typeof setInterval> | null = null;
let snapshotVersion = 0;
// Wall-clock millisecond reading captured by the most recent tick. Stored on
// the module so the render path can derive `ackSecondsLeft` from a stable
// value (calling `Date.now()` during render is flagged by react-hooks/purity).
let lastTickMs = 0;

function machineKey(siteId: string, machineId: string): string {
  // `|` is invalid in both Firestore IDs (slash- and dot-restricted) and
  // pair phrases, so it cleanly separates the composite key.
  return `${siteId}|${machineId}`;
}

function bump() {
  snapshotVersion++;
  subscribers.forEach((notify) => notify());
}

function tick() {
  if (entries.size === 0) return;
  lastTickMs = Date.now();
  const expired: string[] = [];
  for (const [key, entry] of entries) {
    if (lastTickMs >= entry.ackDeadlineMs) {
      expired.push(key);
    }
  }
  if (expired.length === 0) {
    // Pure tick — no entry expired, but subscribers still need a re-render
    // so the per-second countdown number ticks down.
    bump();
    return;
  }
  for (const key of expired) {
    entries.delete(key);
  }
  // One toast per expired deadline. Fired here (not in the panel's effect)
  // so it shows up even if the operator closed the panel mid-countdown.
  for (let i = 0; i < expired.length; i++) {
    toast.error('no confirmation sent — agent will auto-revert');
  }
  bump();
}

function ensureTicking() {
  if (tickIntervalId !== null) return;
  tickIntervalId = setInterval(tick, 250);
}

function maybeStopTicking() {
  if (tickIntervalId === null) return;
  if (entries.size > 0) return;
  if (subscribers.size > 0) return;
  clearInterval(tickIntervalId);
  tickIntervalId = null;
}

function subscribe(notify: () => void) {
  subscribers.add(notify);
  ensureTicking();
  return () => {
    subscribers.delete(notify);
    maybeStopTicking();
  };
}

function getSnapshot() {
  return snapshotVersion;
}

function getServerSnapshot() {
  return 0;
}

/**
 * Start (or restart) the post-apply ack countdown for a given machine.
 * `deadlineMs` is the absolute wall-clock deadline (Date.now() + window).
 * Calling again for the same machine replaces the prior entry, mirroring
 * the agent which only tracks one in-flight apply per machine.
 */
export function startAckCountdown(
  siteId: string,
  machineId: string,
  applyId: string,
  deadlineMs: number,
): void {
  if (!siteId || !machineId || !applyId) return;
  entries.set(machineKey(siteId, machineId), {
    ackDeadlineMs: deadlineMs,
    pendingApplyId: applyId,
    ackInFlight: false,
  });
  // Seed `lastTickMs` so the first render after start derives a sensible
  // countdown without waiting for the first interval tick (~250ms).
  lastTickMs = Date.now();
  ensureTicking();
  bump();
}

/** Clear the countdown for a machine (e.g. on successful ack). */
export function clearAckCountdown(siteId: string, machineId: string): void {
  if (!siteId || !machineId) return;
  if (entries.delete(machineKey(siteId, machineId))) {
    bump();
  }
  maybeStopTicking();
}

/**
 * Mark the in-flight ack flag for a machine. Used to disable the "keep"
 * button while the Firestore write is in progress so a double-click can't
 * dispatch two ack commands. No-op when the machine has no active entry.
 */
export function setAckInFlight(
  siteId: string,
  machineId: string,
  inFlight: boolean,
): void {
  if (!siteId || !machineId) return;
  const key = machineKey(siteId, machineId);
  const entry = entries.get(key);
  if (!entry) return;
  if (entry.ackInFlight === inFlight) return;
  entries.set(key, { ...entry, ackInFlight: inFlight });
  bump();
}

export interface AckBannerState {
  /** Seconds remaining until auto-revert; null when no countdown active. */
  ackSecondsLeft: number | null;
  /** Apply generation token to thread back into the ack command. */
  pendingApplyId: string | null;
  /** Disable the "keep" button while the ack write is in flight. */
  ackInFlight: boolean;
}

/**
 * Subscribe a component to the per-machine ack banner state. Re-renders on
 * every 250ms tick while the countdown is active, on start/clear, and on
 * in-flight transitions.
 */
export function useAckBanner(siteId: string, machineId: string): AckBannerState {
  // Subscribe to the tick stream; the snapshot itself is just a version
  // number, so we derive the actual machine-specific state below from the
  // module map. useSyncExternalStore guarantees a re-render whenever
  // `bump()` fires.
  useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  if (!siteId || !machineId) {
    return { ackSecondsLeft: null, pendingApplyId: null, ackInFlight: false };
  }
  const entry = entries.get(machineKey(siteId, machineId));
  if (!entry) {
    return { ackSecondsLeft: null, pendingApplyId: null, ackInFlight: false };
  }
  // Derived from `lastTickMs` (refreshed by the shared 250ms tick) rather
  // than calling `Date.now()` during render — react-hooks/purity flags the
  // latter, and the tick cadence is fast enough that the displayed value
  // stays accurate to within a quarter-second of the wall clock.
  const ackSecondsLeft = Math.max(
    0, Math.ceil((entry.ackDeadlineMs - lastTickMs) / 1000),
  );
  return {
    ackSecondsLeft,
    pendingApplyId: entry.pendingApplyId,
    ackInFlight: entry.ackInFlight,
  };
}
