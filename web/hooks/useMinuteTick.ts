'use client';

/**
 * A counter that increments once per WALL-CLOCK minute, shared app-wide via one
 * timer. Drives live re-renders of the per-machine local clocks.
 *
 * A module-level singleton owns one setTimeout (to align with the next minute
 * boundary) then one 60s setInterval, fanned out through useSyncExternalStore.
 * Lazy: starts on the first subscriber, stops after the last. Boundary
 * alignment is what makes every machine row update simultaneously.
 *
 * Replaces a per-component setInterval — 50 machines meant 50 unsynchronized
 * timers. SSR-safe: returns 0 on the server render.
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
  // Align the first fire to the minute boundary so all clocks tick in lockstep.
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
