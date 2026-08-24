'use client';

/**
 * Per-machine countdown for the post-apply "keep this layout?" banner, held in a
 * module-level store keyed by `(siteId, machineId)` so it survives the panel
 * closing — otherwise the operator loses the deadline (and any way to ack)
 * before the agent's auto-revert watchdog fires.
 *
 * One shared 250ms interval ticks every countdown and fires the auto-revert
 * toast exactly once per deadline, subscribed panel or not.
 *
 * In-memory only, deliberately: no localStorage (machine state belongs in
 * Firestore), and the agent owns ground truth via its on-disk sentinel +
 * watchdog. This is a UI affordance for the tab that initiated the apply.
 */

import { useSyncExternalStore } from 'react';
import { toast } from '@/lib/toast';

interface AckEntry {
  ackDeadlineMs: number;
  pendingApplyId: string;
  ackInFlight: boolean;
}

const entries = new Map<string, AckEntry>();
const subscribers = new Set<() => void>();
let tickIntervalId: ReturnType<typeof setInterval> | null = null;
let snapshotVersion = 0;
// Wall clock from the last tick; render derives `ackSecondsLeft` from it
// because `Date.now()` during render trips react-hooks/purity.
let lastTickMs = 0;

function machineKey(siteId: string, machineId: string): string {
  // `|` can't appear in a Firestore id or a pair phrase, so it's a safe separator.
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
    // Nothing expired, but subscribers still need a re-render to tick the number.
    bump();
    return;
  }
  for (const key of expired) {
    entries.delete(key);
  }
  // One toast per expired deadline, fired here (not in the panel's effect) so it
  // shows even if the panel was closed mid-countdown.
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
 * Start/restart the ack countdown. `deadlineMs` is absolute wall clock. A second
 * call replaces the entry — the agent also tracks one in-flight apply per machine.
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
  // Seed `lastTickMs` so the first render doesn't wait ~250ms for a tick.
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
 * Mark the ack in flight, disabling "keep" while the write runs so a double-click
 * can't dispatch two acks. No-op without an active entry.
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
 * Subscribe to the per-machine ack banner: re-renders each 250ms tick while
 * active, plus on start/clear and in-flight transitions.
 */
export function useAckBanner(siteId: string, machineId: string): AckBannerState {
  // The snapshot is just a version number — machine state is derived from the
  // module map below; useSyncExternalStore re-renders whenever `bump()` fires.
  useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  if (!siteId || !machineId) {
    return { ackSecondsLeft: null, pendingApplyId: null, ackInFlight: false };
  }
  const entry = entries.get(machineKey(siteId, machineId));
  if (!entry) {
    return { ackSecondsLeft: null, pendingApplyId: null, ackInFlight: false };
  }
  // From `lastTickMs`, not `Date.now()` during render (react-hooks/purity); the
  // 250ms cadence keeps it within a quarter-second of wall clock.
  const ackSecondsLeft = Math.max(
    0, Math.ceil((entry.ackDeadlineMs - lastTickMs) / 1000),
  );
  return {
    ackSecondsLeft,
    pendingApplyId: entry.pendingApplyId,
    ackInFlight: entry.ackInFlight,
  };
}
