'use client';

/**
 * useBillingSnapshot Hook (billing-system wave 2.5)
 *
 * Fetches `GET /api/billing/snapshot` — the account's billing state, trial
 * clock, owned sites, latest usage mirror, and projected bill — for the
 * billing tab in account settings.
 *
 * ## Fetch on open, never on a timer
 *
 * One request per rising edge of `enabled`, and nothing on a timer. This route
 * fans out to a machines subcollection read per owned site, and the billing tab
 * lives inside a dialog that is closed almost all the time — polling would bill
 * us Firestore reads for a panel nobody is looking at. Billing numbers also
 * move on the scale of days (a daily usage cron, a monthly invoice), so there
 * is nothing for a poll to catch. Callers that need fresher data after an
 * action — returning from checkout, say — call `refetch()`.
 *
 * `enabled` defaults to `true`, which makes *mounting* the rising edge. That is
 * how `BillingTab` uses it: account settings renders only the visible section,
 * so the component exists exactly when the tab is open. Pass `enabled`
 * explicitly from a caller that stays mounted while hidden.
 *
 * Follows the same shape as `usePasskeys`: `useCallback` fetcher +
 * `{ data, loading, error, refetch }`, with the route's problem+json `detail`
 * surfaced as the error message so the tab can explain itself rather than
 * showing a generic failure.
 *
 * Usage:
 *   const { snapshot, loading, error, refetch } = useBillingSnapshot();
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { BillingSnapshotResponse } from '@/lib/types/billingSnapshot';

export type { BillingSnapshotResponse };

export interface UseBillingSnapshotResult {
  snapshot: BillingSnapshotResponse | null;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

export function useBillingSnapshot(enabled: boolean = true): UseBillingSnapshotResult {
  const [snapshot, setSnapshot] = useState<BillingSnapshotResponse | null>(null);
  // Seeded from `enabled` so an enabled hook reports `loading` on its very
  // first render. Starting at `false` would render one frame of "no data, not
  // loading" before the effect fires — a visible flash of an empty panel.
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  // Guards a late response from a request whose component has since unmounted,
  // and drops a stale response when `refetch()` overtakes an in-flight fetch.
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refetch = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    try {
      const res = await fetch('/api/billing/snapshot');
      const data = await res.json().catch(() => null);
      if (!mountedRef.current || requestId !== requestIdRef.current) return;

      if (!res.ok) {
        setError(
          (data && typeof data.detail === 'string' && data.detail) ||
            'could not load billing details',
        );
        return;
      }
      setSnapshot(data as BillingSnapshotResponse);
      setError(null);
    } catch {
      if (!mountedRef.current || requestId !== requestIdRef.current) return;
      setError('could not load billing details');
    } finally {
      if (mountedRef.current && requestId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }, []);

  // Rising edge only: `enabled` going false leaves the last snapshot in state
  // so reopening the tab renders instantly while the refresh is in flight.
  const wasEnabledRef = useRef(false);
  useEffect(() => {
    if (enabled && !wasEnabledRef.current) {
      wasEnabledRef.current = true;
      void refetch();
    } else if (!enabled) {
      wasEnabledRef.current = false;
    }
  }, [enabled, refetch]);

  return { snapshot, loading, error, refetch };
}
