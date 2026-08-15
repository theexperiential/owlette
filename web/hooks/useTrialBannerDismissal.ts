'use client';

/**
 * Dismissal state for the dashboard trial banner (billing-system wave 3.1).
 *
 * Stored on the shared per-user prefs doc — `users/{uid}/devicePrefs/global`,
 * the same document `useDevicePrefs`, `useDevicePrefFlag`, and
 * `useHootSidebarPrefs` write to — under `trialBannerDismissedAt`, an epoch
 * milliseconds number. Firestore, never `localStorage`: user state belongs to
 * the account, so dismissing the banner on a laptop must not make it reappear
 * on the desk machine an hour later.
 *
 * ## A dismissal expires; it does not silence the banner forever
 *
 * "Not now" is not "never". A trial that is running out is information the
 * owner needs more than once, so a dismissal only holds for
 * {@link DISMISSAL_WINDOW_DAYS} days and the banner returns afterwards.
 * Callers keep this hook away from the *locked* (expired / canceled) banner
 * entirely — that one has no close affordance at all, because the account is
 * read-only until a plan is chosen and hiding the reason would leave the
 * owner guessing why their controls stopped working.
 *
 * ## Why the window is evaluated once, in the hydration callback
 *
 * The comparison against `Date.now()` runs inside the async `getDoc` callback
 * rather than during render: `react-hooks/purity` (correctly) flags reading a
 * clock while rendering, and a seven-day window has nothing to gain from
 * re-evaluating mid-session. The answer is settled when the page loads and
 * stays settled until the next one.
 *
 * `ready` stays false until that read resolves so the banner can hold off
 * rendering rather than flashing in and then vanishing on a dismissed account.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { useAuth } from '@/contexts/AuthContext';
import { db } from '@/lib/firebase';

/** How long a dismissal suppresses the banner before it returns. */
export const DISMISSAL_WINDOW_DAYS = 7;

const DISMISSAL_WINDOW_MS = DISMISSAL_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** Field on `users/{uid}/devicePrefs/global` holding the dismissal instant. */
export const TRIAL_BANNER_DISMISSED_FIELD = 'trialBannerDismissedAt';

/**
 * True when a dismissal stamped at `dismissedAtMs` still suppresses the
 * banner as of `nowMs`. Exported for the tests that pin the window boundary.
 *
 * A non-finite or future-dated value reads as "no dismissal in effect": a
 * clock-skewed write must not be able to hide the banner indefinitely.
 */
export function isDismissalActive(dismissedAtMs: unknown, nowMs: number): boolean {
  if (typeof dismissedAtMs !== 'number' || !Number.isFinite(dismissedAtMs)) return false;
  const age = nowMs - dismissedAtMs;
  return age >= 0 && age < DISMISSAL_WINDOW_MS;
}

export interface TrialBannerDismissal {
  /** True while a dismissal from the last {@link DISMISSAL_WINDOW_DAYS} days holds. */
  dismissed: boolean;
  /** Hide the banner now and persist the instant. */
  dismiss: () => void;
  /** False until the stored value has been read (or determined absent). */
  ready: boolean;
}

export function useTrialBannerDismissal(): TrialBannerDismissal {
  const { user } = useAuth();
  const uid = user?.uid ?? null;

  const [dismissed, setDismissed] = useState(false);
  const [ready, setReady] = useState(false);

  const uidRef = useRef<string | null>(uid);
  useEffect(() => {
    uidRef.current = uid;
  }, [uid]);

  // Hydrate once per uid. setState lives in the async callback (not the
  // synchronous effect body) so it doesn't trip the cascading-render lint rule.
  useEffect(() => {
    if (!db || !uid) return;
    let cancelled = false;
    getDoc(doc(db, 'users', uid, 'devicePrefs', 'global'))
      .then((snap) => {
        if (cancelled) return;
        const stored = snap.exists()
          ? (snap.data() as Record<string, unknown>)[TRIAL_BANNER_DISMISSED_FIELD]
          : undefined;
        setDismissed(isDismissalActive(stored, Date.now()));
        setReady(true);
      })
      .catch((err) => {
        console.error('Failed to read trial banner dismissal:', err);
        // Fail open: an unreadable pref shows the banner rather than hiding a
        // trial that is about to expire.
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
      // A different sign-in must re-hydrate before its stored value is trusted.
      setReady(false);
      setDismissed(false);
    };
  }, [uid]);

  const dismiss = useCallback(() => {
    setDismissed(true);
    const currentUid = uidRef.current;
    if (!db || !currentUid) return;
    // Written immediately rather than debounced: dismissing is a single
    // deliberate click, not a toggle a user can drum on, and the component
    // unmounts on the same interaction path that hides the banner.
    setDoc(
      doc(db, 'users', currentUid, 'devicePrefs', 'global'),
      { [TRIAL_BANNER_DISMISSED_FIELD]: Date.now() },
      { merge: true },
    ).catch((err) => console.error('Failed to persist trial banner dismissal:', err));
  }, []);

  // Nothing to hydrate when signed out (or firestore is unavailable), so the
  // default is already the final answer — report ready immediately.
  return { dismissed, dismiss, ready: ready || !db || !uid };
}
