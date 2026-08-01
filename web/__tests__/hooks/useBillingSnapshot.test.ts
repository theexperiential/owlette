/**
 * @jest-environment jsdom
 *
 * Unit tests for `useBillingSnapshot` (billing-system wave 2.5).
 *
 * The hook's whole contract is "fetch once when the tab opens, never poll,
 * expose a refetch". The cases below pin that: the rising edge fires exactly
 * one request, a disabled hook fires none, and a stale in-flight response can
 * never overwrite a newer one.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { useBillingSnapshot } from '@/hooks/useBillingSnapshot';
import type { BillingSnapshotResponse } from '@/lib/types/billingSnapshot';

function snapshotBody(overrides: Partial<BillingSnapshotResponse> = {}): BillingSnapshotResponse {
  return {
    billingState: 'trialing',
    trialEndsAt: null,
    goLiveAt: null,
    daysLeft: null,
    subscriptionTier: null,
    currentPeriodEnd: null,
    stripeConfigured: false,
    hasBillingAccount: false,
    sites: [],
    usage: null,
    projectedBill: { perSite: [], totalUsd: 0 },
    ...overrides,
  };
}

/** A minimal Response — the hook only reads `ok` and `json()`. */
function fakeResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

describe('useBillingSnapshot', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('fetches the snapshot on the enabled rising edge', async () => {
    const body = snapshotBody({ billingState: 'active', subscriptionTier: 'pro' });
    const fetchMock = jest.fn(async () => fakeResponse(body));
    global.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() => useBillingSnapshot(true));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/billing/snapshot');
    expect(result.current.snapshot).toEqual(body);
    expect(result.current.error).toBeNull();
  });

  it('fetches nothing while disabled', async () => {
    const fetchMock = jest.fn(async () => fakeResponse(snapshotBody()));
    global.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() => useBillingSnapshot(false));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.snapshot).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('reports loading on the very first render, before the effect fires', async () => {
    // Starting at `false` would render one frame of "no data, not loading" —
    // a visible flash of an empty billing panel.
    global.fetch = jest.fn(
      async () => fakeResponse(snapshotBody()),
    ) as unknown as typeof fetch;

    const { result } = renderHook(() => useBillingSnapshot());
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));
  });

  it('fetches once when enabled turns on, and not again on re-render', async () => {
    // The route fans out to a machines read per owned site — a re-render must
    // not spend those reads again.
    const fetchMock = jest.fn(async () => fakeResponse(snapshotBody()));
    global.fetch = fetchMock as unknown as typeof fetch;

    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useBillingSnapshot(enabled),
      { initialProps: { enabled: false } },
    );
    expect(fetchMock).not.toHaveBeenCalled();

    rerender({ enabled: true });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    rerender({ enabled: true });
    rerender({ enabled: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refetches on the next rising edge after being disabled', async () => {
    const fetchMock = jest.fn(async () => fakeResponse(snapshotBody()));
    global.fetch = fetchMock as unknown as typeof fetch;

    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useBillingSnapshot(enabled),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    rerender({ enabled: false });
    // Closing the tab keeps the last snapshot so reopening renders instantly.
    expect(result.current.snapshot).not.toBeNull();

    rerender({ enabled: true });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it('exposes a manual refetch', async () => {
    const fetchMock = jest.fn(async () => fakeResponse(snapshotBody()));
    global.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() => useBillingSnapshot(true));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.refetch();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('surfaces the route problem+json detail as the error message', async () => {
    global.fetch = jest.fn(async () =>
      fakeResponse({ code: 'unauthorized', detail: 'your session expired' }, false, 401),
    ) as unknown as typeof fetch;

    const { result } = renderHook(() => useBillingSnapshot(true));

    await waitFor(() => expect(result.current.error).toBe('your session expired'));
    expect(result.current.snapshot).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('falls back to a generic message when the error body has no detail', async () => {
    global.fetch = jest.fn(async () => fakeResponse({}, false, 500)) as unknown as typeof fetch;

    const { result } = renderHook(() => useBillingSnapshot(true));

    await waitFor(() => expect(result.current.error).toBe('could not load billing details'));
  });

  it('reports a network failure without throwing', async () => {
    global.fetch = jest.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useBillingSnapshot(true));

    await waitFor(() => expect(result.current.error).toBe('could not load billing details'));
    expect(result.current.loading).toBe(false);
  });

  it('clears a previous error once a refetch succeeds', async () => {
    let shouldFail = true;
    global.fetch = jest.fn(async () =>
      shouldFail ? fakeResponse({}, false, 500) : fakeResponse(snapshotBody()),
    ) as unknown as typeof fetch;

    const { result } = renderHook(() => useBillingSnapshot(true));
    await waitFor(() => expect(result.current.error).not.toBeNull());

    shouldFail = false;
    await act(async () => {
      await result.current.refetch();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.snapshot).not.toBeNull();
  });

  it('drops a stale response when a refetch overtakes it', async () => {
    // A slow first request must not clobber the fresher answer a refetch
    // already applied.
    const first = snapshotBody({ billingState: 'trialing' });
    const second = snapshotBody({ billingState: 'active' });

    let releaseFirst: (() => void) | null = null;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    let call = 0;
    global.fetch = jest.fn(async () => {
      call += 1;
      if (call === 1) {
        await firstGate;
        return fakeResponse(first);
      }
      return fakeResponse(second);
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useBillingSnapshot(true));

    await act(async () => {
      await result.current.refetch();
    });
    expect(result.current.snapshot).toEqual(second);

    await act(async () => {
      releaseFirst?.();
      await firstGate;
    });

    expect(result.current.snapshot).toEqual(second);
  });
});
