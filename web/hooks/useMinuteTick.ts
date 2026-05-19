'use client';

/**
 * useMinuteTick Hook
 *
 * Subscribe to a wall-clock minute tick. Returns a number that increments
 * once per minute, on the wall-clock minute boundary, shared across the
 * entire app via a single setInterval. Used to drive live re-renders of
 * machine local clocks under each hostname.
 *
 * Implementation: a module-level singleton owns ONE setTimeout (to align
 * with the next minute boundary) and then ONE setInterval (60_000ms).
 * All subscribers are notified via useSyncExternalStore. The timer is
 * lazy — it starts when the first subscriber mounts and stops when the
 * last one unmounts. Because the first fire is aligned to the wall-clock
 * minute, every machine card/row updates simultaneously when the minute
 * changes.
 *
 * Replaces the previous per-component setInterval pattern that created N
 * independent timers (one per visible machine) and used a `void clockTick;`
 * anti-pattern to suppress unused-var warnings. With 50 machines on the
 * dashboard, that was 50 unsynchronized timers — now it's just one.
 *
 * SSR-safe: returns 0 during the server render.
 */

import { useSyncExternalStore } from 'react';

let tick = 0;
let intervalId: ReturnType<typeof setInterval> | null = null;
let timeoutId: ReturnType<typeof setTimeout> | null = null;
const subscribers = new Set<() => void>();

function notifyAll() {
  tick++;
  subscribers.forEach((notify) => notify());
}

function startTicking() {
  // Align the first fire to the next wall-clock minute boundary so every
  // subscribed machine clock updates in lockstep when the minute changes.
  const now = new Date();
  const msUntilNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
  timeoutId = setTimeout(() => {
    timeoutId = null;
    notifyAll();
    intervalId = setInterval(notifyAll, 60_000);
  }, msUntilNextMinute);
}

function stopTicking() {
  if (timeoutId !== null) {
    clearTimeout(timeoutId);
    timeoutId = null;
  }
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

function subscribe(notify: () => void) {
  subscribers.add(notify);
  if (subscribers.size === 1) startTicking();
  return () => {
    subscribers.delete(notify);
    if (subscribers.size === 0) stopTicking();
  };
}

function getSnapshot() {
  return tick;
}

function getServerSnapshot() {
  return 0;
}

export function useMinuteTick(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
