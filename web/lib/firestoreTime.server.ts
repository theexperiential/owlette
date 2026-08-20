/**
 * Server-side Firestore timestamp helpers: any shape firebase-admin can hand
 * back → Unix ms or ISO-8601.
 *
 * Handles admin `Timestamp`, anything with `toMillis()`/`toDate()`, plain
 * `{seconds, nanoseconds?}` (cache rehydration), legacy `{_seconds, _nanoseconds?}`,
 * `Date`, `number` (assumed Unix ms) and ISO-8601 strings. Anything else returns
 * null rather than throwing — these run on untrusted Firestore payloads inside
 * route handlers.
 *
 * Client components use `firestoreTsToMs` from `@/hooks/useFirestore` instead
 * (same shapes, client-sdk Timestamp).
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

/** Any Firestore timestamp shape → Unix ms; null when unparseable. */
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

    // Plain { seconds, nanoseconds } — client-sdk rehydration shape.
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

/** Any Firestore timestamp shape → ISO-8601; null when unparseable. */
export function timestampToIso(value: unknown): string | null {
  const ms = timestampToMs(value);
  if (ms === null) return null;
  return new Date(ms).toISOString();
}
