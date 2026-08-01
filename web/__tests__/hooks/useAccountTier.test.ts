/**
 * @jest-environment jsdom
 *
 * Unit tests for `useAccountTier` (billing-system wave 3.2).
 *
 * The hook is the client half of `requireProAccount()`. These cases pin it to
 * the server's two-step rule in the server's order — a divergence here shows
 * up as a gate a customer sees while the API happily serves them, or (worse)
 * an ungated form that 403s on submit.
 */

import { renderHook, waitFor } from '@testing-library/react';
import { useAccountTier } from '@/hooks/useAccountTier';
import type {
  BillingSnapshotResponse,
  BillingSnapshotSite,
} from '@/lib/types/billingSnapshot';

function site(siteId: string, tier: 'core' | 'pro'): BillingSnapshotSite {
  return { siteId, name: siteId, tier, activeMachineCount: 1 };
}

function snapshotBody(
  overrides: Partial<BillingSnapshotResponse> = {},
): BillingSnapshotResponse {
  return {
    billingState: 'active',
    trialEndsAt: null,
    daysLeft: null,
    subscriptionTier: null,
    currentPeriodEnd: null,
    stripeConfigured: true,
    hasBillingAccount: true,
    sites: [],
    usage: null,
    projectedBill: { perSite: [], totalUsd: 0 },
    ...overrides,
  };
}

/** A minimal Response — `useBillingSnapshot` only reads `ok` and `json()`. */
function fakeResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

function mockSnapshot(body: BillingSnapshotResponse) {
  global.fetch = jest.fn(async () => fakeResponse(body)) as unknown as typeof fetch;
}

describe('useAccountTier', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('resolves pro when any owned site is pro', async () => {
    mockSnapshot(snapshotBody({ sites: [site('a', 'core'), site('b', 'pro')] }));

    const { result } = renderHook(() => useAccountTier());

    await waitFor(() => expect(result.current).toBe('pro'));
  });

  it('resolves core when every owned site is core', async () => {
    mockSnapshot(snapshotBody({ sites: [site('a', 'core'), site('b', 'core')] }));

    const { result } = renderHook(() => useAccountTier());

    await waitFor(() => expect(result.current).toBe('core'));
  });

  it('resolves core for a subscribed account that owns no sites', async () => {
    // Matches `AccountBillingSnapshot.accountTier`: no owned site means no pro
    // entitlement to point at. Deliberate, and documented as such server-side.
    mockSnapshot(snapshotBody({ sites: [] }));

    const { result } = renderHook(() => useAccountTier());

    await waitFor(() => expect(result.current).toBe('core'));
  });

  it('resolves pro while trialing regardless of the site tiers', async () => {
    mockSnapshot(snapshotBody({ billingState: 'trialing', sites: [site('a', 'core')] }));

    const { result } = renderHook(() => useAccountTier());

    await waitFor(() => expect(result.current).toBe('pro'));
  });

  it('resolves pro while trialing with no sites at all', async () => {
    // The case the trial short-circuit exists for: the site scan alone would
    // say core, and the server would still mint the key.
    mockSnapshot(snapshotBody({ billingState: 'trialing', sites: [] }));

    const { result } = renderHook(() => useAccountTier());

    await waitFor(() => expect(result.current).toBe('pro'));
  });

  it('applies the site rule to an expired account rather than short-circuiting', async () => {
    // Lockout is the trial banner's story (task 3.1) and a `402` server-side;
    // the tier half still reads off the sites.
    mockSnapshot(snapshotBody({ billingState: 'expired', sites: [site('a', 'pro')] }));

    const { result } = renderHook(() => useAccountTier());

    await waitFor(() => expect(result.current).toBe('pro'));
  });

  it('stays undefined until the snapshot lands', async () => {
    mockSnapshot(snapshotBody({ sites: [site('a', 'core')] }));

    const { result } = renderHook(() => useAccountTier());

    expect(result.current).toBeUndefined();
    await waitFor(() => expect(result.current).toBe('core'));
  });

  it('stays undefined when disabled, and fetches nothing', () => {
    const fetchMock = jest.fn(async () => fakeResponse(snapshotBody()));
    global.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() => useAccountTier(false));

    expect(result.current).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stays undefined when the snapshot request fails', async () => {
    // Fail open: a transient snapshot failure must never gate a paying
    // customer out of their own api keys. The server still enforces.
    global.fetch = jest.fn(async () =>
      fakeResponse({ detail: 'nope' }, false, 500),
    ) as unknown as typeof fetch;

    const { result } = renderHook(() => useAccountTier());

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
    expect(result.current).toBeUndefined();
  });
});
