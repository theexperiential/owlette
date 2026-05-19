/**
 * Firestore timestamp helpers for server-side routes.
 *
 * Converts any shape Firestore / firebase-admin can hand back into either
 * Unix milliseconds or an ISO-8601 string. Callers read from Firestore and
 * hand the raw field value in; these helpers do the shape-sniffing.
 *
 * Shapes handled:
 *   - null / undefined                          → null
 *   - firebase-admin `Timestamp` instance       → via toMillis / toDate
 *   - any object with a `toMillis()` method     → via toMillis (firestore-lite, client sdk)
 *   - any object with a `toDate()`   method     → via toDate
 *   - plain `{ seconds, nanoseconds? }`         → cache rehydration shape
 *   - legacy `{ _seconds, _nanoseconds? }`      → older admin SDK payloads
 *   - `Date` instance                           → defensive; some code paths return Date
 *   - `number`                                  → assumed to be Unix milliseconds
 *   - ISO-8601 `string`                         → parsed via Date.parse
 *
 * Returns null for any other input rather than throwing — route handlers
 * pass untrusted Firestore payloads through these, so silently degrading
 * to null is safer than surfacing parse errors to clients.
 *
 * Client components should import `firestoreTsToMs` from
 * `@/hooks/useFirestore` instead — it handles the same shapes but uses
 * the client-side `firebase/firestore` Timestamp rather than the admin
 * one.
 */

import { Timestamp } from 'firebase-admin/firestore';

type TimestampLike =
  | Timestamp
  | Date
  | number
  | string
  | { toMillis?: () => number; toDate?: () => Date }
  | { seconds: number; nanoseconds?: number }
  | { _seconds: number; _nanoseconds?: number }
  | null
  | undefined;

/**
 * Convert any Firestore timestamp shape to Unix milliseconds.
 * Returns null for null/undefined or anything we can't parse.
 */
export function timestampToMs(value: unknown): number | null {
  if (value === null || value === undefined) return null;

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }

  if (value instanceof Timestamp) {
    return value.toMillis();
  }

  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }

  if (typeof value === 'object') {
    const v = value as TimestampLike;

    if (v && typeof (v as { toMillis?: () => number }).toMillis === 'function') {
      const ms = (v as { toMillis: () => number }).toMillis();
      return Number.isFinite(ms) ? ms : null;
    }

    if (v && typeof (v as { toDate?: () => Date }).toDate === 'function') {
      const ms = (v as { toDate: () => Date }).toDate().getTime();
      return Number.isFinite(ms) ? ms : null;
    }

    // Plain { seconds, nanoseconds } (client-sdk rehydration shape)
    const plain = v as { seconds?: number; nanoseconds?: number };
    if (typeof plain.seconds === 'number') {
      const ns = typeof plain.nanoseconds === 'number' ? plain.nanoseconds : 0;
      return plain.seconds * 1000 + Math.floor(ns / 1e6);
    }

    // Legacy admin-SDK { _seconds, _nanoseconds }
    const legacy = v as { _seconds?: number; _nanoseconds?: number };
    if (typeof legacy._seconds === 'number') {
      const ns = typeof legacy._nanoseconds === 'number' ? legacy._nanoseconds : 0;
      return legacy._seconds * 1000 + Math.floor(ns / 1e6);
    }
  }

  return null;
}

/**
 * Convert any Firestore timestamp shape to an ISO-8601 string.
 * Returns null for null/undefined or anything we can't parse.
 */
export function timestampToIso(value: unknown): string | null {
  const ms = timestampToMs(value);
  if (ms === null) return null;
  return new Date(ms).toISOString();
}
