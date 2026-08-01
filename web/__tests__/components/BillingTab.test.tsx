/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * Render tests for `BillingTab` (billing-system wave 2.5).
 *
 * The tab is the only place a customer sees what they are about to be charged,
 * so the cases below pin the four states that would each mislead them if they
 * regressed:
 *
 *   - **trialing**: a countdown, and — crucially — the pre-go-live sentinel
 *     (`trialEndsAt: null`) reading as "free during beta" rather than a
 *     fabricated "0 days left",
 *   - **active**: the tier and renewal date, with the portal as the action,
 *   - **expired**: a reactivation prompt, with checkout as the action,
 *   - **stripe unconfigured** (every deployment today): the trial information
 *     still renders and the dead-end buttons are replaced by an explanation.
 *
 * Also pinned: the projection numbers themselves, the 3-machine pro minimum
 * being labelled rather than silently inflating the machine count, and the
 * storage bar staying hidden when there is no usage data to draw it from.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BillingTab } from '@/components/BillingTab';
import { projectAccountBill, BYTES_PER_GB } from '@/lib/billing/pricing';
import type { BillingSnapshotResponse, BillingSnapshotSite } from '@/lib/types/billingSnapshot';

const mockToastError = jest.fn();
jest.mock('@/lib/toast', () => ({
  toast: {
    error: (...a: unknown[]) => mockToastError(...a),
    success: jest.fn(),
    info: jest.fn(),
    warning: jest.fn(),
  },
}));

const TIB = 1024 ** 4;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Build a snapshot whose `projectedBill` is computed by the real pricing
 * module — a hand-written projection would let the component and the money
 * math drift apart without a test noticing.
 */
function snapshotBody(
  overrides: Partial<BillingSnapshotResponse> = {},
  sites: (BillingSnapshotSite & { storageBytes?: number | null })[] = [],
): BillingSnapshotResponse {
  const siteRows: BillingSnapshotSite[] = sites.map(({ storageBytes: _ignored, ...s }) => s);
  return {
    billingState: 'trialing',
    trialEndsAt: null,
    daysLeft: null,
    subscriptionTier: null,
    currentPeriodEnd: null,
    stripeConfigured: true,
    hasBillingAccount: false,
    sites: siteRows,
    usage: null,
    projectedBill: projectAccountBill(
      sites.map((s) => ({
        siteId: s.siteId,
        tier: s.tier,
        activeMachineCount: s.activeMachineCount,
        storageBytes: s.storageBytes ?? null,
      })),
    ),
    ...overrides,
  };
}

function fakeResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

/** Mock `fetch` so the snapshot GET resolves with `body`. */
function mockSnapshot(body: BillingSnapshotResponse) {
  const fetchMock = jest.fn(async () => fakeResponse(body));
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe('BillingTab', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  /* --------------------------- trialing --------------------------- */

  it('counts down the free trial', async () => {
    mockSnapshot(
      snapshotBody({ billingState: 'trialing', trialEndsAt: Date.now() + 6 * DAY_MS, daysLeft: 6 }),
    );

    render(<BillingTab />);

    expect(await screen.findByText('6 days left in your free trial')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /choose a plan/i })).toBeInTheDocument();
  });

  it('says "1 day", not "1 days", on the last full day', async () => {
    mockSnapshot(
      snapshotBody({ billingState: 'trialing', trialEndsAt: Date.now() + DAY_MS, daysLeft: 1 }),
    );

    render(<BillingTab />);

    expect(await screen.findByText('1 day left in your free trial')).toBeInTheDocument();
  });

  it('reads the null trial clock as beta, never as an expired countdown', async () => {
    // `trialEndsAt: null` is the pre-go-live sentinel — the clock has not been
    // started. Rendering "0 days left" here would tell every existing beta
    // account they are about to be locked out.
    mockSnapshot(snapshotBody({ billingState: 'trialing', trialEndsAt: null, daysLeft: null }));

    render(<BillingTab />);

    expect(await screen.findByText("free during beta — billing hasn't started")).toBeInTheDocument();
    expect(screen.queryByText(/days left/i)).toBeNull();
  });

  /* ---------------------------- active ---------------------------- */

  it('shows the current tier and renewal date when subscribed', async () => {
    const renews = new Date('2026-09-15T00:00:00.000Z').getTime();
    mockSnapshot(
      snapshotBody({
        billingState: 'active',
        subscriptionTier: 'pro',
        currentPeriodEnd: renews,
        hasBillingAccount: true,
      }),
    );

    render(<BillingTab />);

    const expected = `you're on pro — renews ${new Date(renews).toLocaleDateString()}`;
    expect(await screen.findByText(expected)).toBeInTheDocument();
  });

  it('offers the portal but not checkout while subscribed', async () => {
    mockSnapshot(
      snapshotBody({ billingState: 'active', subscriptionTier: 'core', hasBillingAccount: true }),
    );

    render(<BillingTab />);

    expect(await screen.findByRole('button', { name: /manage billing/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /choose a plan/i })).toBeNull();
  });

  /* ---------------------------- expired --------------------------- */

  it('prompts reactivation when the trial has ended', async () => {
    mockSnapshot(
      snapshotBody({ billingState: 'expired', trialEndsAt: Date.now() - DAY_MS, daysLeft: null }),
    );

    render(<BillingTab />);

    expect(
      await screen.findByText('your trial ended — choose a plan to reactivate'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /choose a plan/i })).toBeInTheDocument();
  });

  it('prompts reactivation after a cancellation too', async () => {
    mockSnapshot(snapshotBody({ billingState: 'canceled', hasBillingAccount: true }));

    render(<BillingTab />);

    expect(
      await screen.findByText('your subscription was canceled — choose a plan to reactivate'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /choose a plan/i })).toBeInTheDocument();
  });

  /* ------------------------ stripe unconfigured -------------------- */

  it('still shows the trial info when stripe is not configured, with no dead-end buttons', async () => {
    mockSnapshot(
      snapshotBody({
        billingState: 'trialing',
        trialEndsAt: Date.now() + 9 * DAY_MS,
        daysLeft: 9,
        stripeConfigured: false,
        hasBillingAccount: false,
      }),
    );

    render(<BillingTab />);

    expect(await screen.findByText('9 days left in your free trial')).toBeInTheDocument();
    expect(
      screen.getByText(
        /billing setup in progress — plan changes and payment management aren't available yet/i,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /choose a plan/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /manage billing/i })).toBeNull();
  });

  /* ---------------------------- sites ----------------------------- */

  it('renders zero sites as an empty state, not an error', async () => {
    mockSnapshot(snapshotBody());

    render(<BillingTab />);

    expect(await screen.findByText(/you don't own any sites yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/estimated monthly total/i)).toBeNull();
  });

  it('lists each site with its tier, machine count, and projection', async () => {
    mockSnapshot(
      snapshotBody({ billingState: 'trialing' }, [
        { siteId: 'a', name: 'atrium', tier: 'core', activeMachineCount: 4 },
        { siteId: 'b', name: 'lobby', tier: 'pro', activeMachineCount: 6 },
      ]),
    );

    render(<BillingTab />);

    expect(await screen.findByText('atrium')).toBeInTheDocument();
    expect(screen.getByText('lobby')).toBeInTheDocument();
    expect(screen.getByText('4 active machines')).toBeInTheDocument();
    expect(screen.getByText('6 active machines')).toBeInTheDocument();
    // 4 × $10 and 6 × $50
    expect(screen.getByText('$40/mo')).toBeInTheDocument();
    expect(screen.getByText('$300/mo')).toBeInTheDocument();
    // $40 + $300
    expect(screen.getByText('$340/mo')).toBeInTheDocument();
  });

  it('labels the pro 3-machine minimum instead of inflating the machine count', async () => {
    mockSnapshot(
      snapshotBody({}, [{ siteId: 'a', name: 'kiosk', tier: 'pro', activeMachineCount: 1 }]),
    );

    render(<BillingTab />);

    expect(
      await screen.findByText('1 active machine — billed at the 3-machine pro minimum'),
    ).toBeInTheDocument();
    expect(screen.getAllByText('$150/mo').length).toBeGreaterThan(0);
  });

  /* --------------------------- storage ---------------------------- */

  it('hides the storage bar entirely when there is no usage data', async () => {
    // Drawing it at 0% would read as "you've used none of your 1 TiB" when the
    // truth is "the daily usage job hasn't reported yet".
    mockSnapshot(
      snapshotBody({}, [{ siteId: 'a', name: 'lobby', tier: 'pro', activeMachineCount: 5 }]),
    );

    render(<BillingTab />);

    await screen.findByText('lobby');
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByText(/roost storage/i)).toBeNull();
  });

  it('draws the storage bar against the 1 TiB inclusion when usage exists', async () => {
    mockSnapshot(
      snapshotBody(
        {
          usage: {
            period: '2026-07-31',
            sites: [{ siteId: 'a', activeMachineCount: 5, storageBytes: TIB / 2 }],
            totals: { activeMachineCount: 5, storageBytes: TIB / 2 },
          },
        },
        [
          {
            siteId: 'a',
            name: 'lobby',
            tier: 'pro',
            activeMachineCount: 5,
            storageBytes: TIB / 2,
          },
        ],
      ),
    );

    render(<BillingTab />);

    const bar = await screen.findByRole('progressbar', { name: /roost storage used/i });
    expect(bar).toHaveAttribute('aria-valuenow', '50');
    expect(screen.getByText('512.0 GB of 1.00 TB')).toBeInTheDocument();
    // Under the inclusion — no overage line.
    expect(screen.queryByText(/over —/i)).toBeNull();
  });

  it('projects the overage once a pro site passes its inclusion', async () => {
    const used = TIB + 100 * BYTES_PER_GB;
    mockSnapshot(
      snapshotBody(
        {
          usage: {
            period: '2026-07-31',
            sites: [{ siteId: 'a', activeMachineCount: 5, storageBytes: used }],
            totals: { activeMachineCount: 5, storageBytes: used },
          },
        },
        [{ siteId: 'a', name: 'lobby', tier: 'pro', activeMachineCount: 5, storageBytes: used }],
      ),
    );

    render(<BillingTab />);

    // 100 GB over × $0.05 = $5/mo
    expect(await screen.findByText('100.0 GB over — $5/mo at $0.05/gb')).toBeInTheDocument();
    // 5 × $50 + $5 — on the site row and, as the only site, on the total row.
    expect(screen.getAllByText('$255/mo')).toHaveLength(2);
    const bar = screen.getByRole('progressbar', { name: /roost storage used/i });
    expect(bar).toHaveAttribute('aria-valuenow', '100');
  });

  /* ----------------------------- errors ---------------------------- */

  it('explains a failed snapshot fetch and offers a retry', async () => {
    let calls = 0;
    global.fetch = jest.fn(async () => {
      calls += 1;
      return calls === 1
        ? fakeResponse({ detail: 'billing is temporarily unavailable' }, false, 503)
        : fakeResponse(snapshotBody({ billingState: 'trialing', daysLeft: 3, trialEndsAt: Date.now() + 3 * DAY_MS }));
    }) as unknown as typeof fetch;

    render(<BillingTab />);

    expect(await screen.findByText('billing is temporarily unavailable')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /try again/i }));

    expect(await screen.findByText('3 days left in your free trial')).toBeInTheDocument();
  });

  /* ----------------------------- portal ---------------------------- */

  it('opens the stripe portal url returned by the route', async () => {
    const assignedUrls: string[] = [];
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        ...window.location,
        set href(url: string) {
          assignedUrls.push(url);
        },
        get href() {
          return assignedUrls[assignedUrls.length - 1] ?? '';
        },
      },
    });

    global.fetch = jest.fn(async (input: unknown, init?: { method?: string }) => {
      if (String(input).includes('/api/billing/portal') && init?.method === 'POST') {
        return fakeResponse({ success: true, url: 'https://billing.stripe.com/session/abc' });
      }
      return fakeResponse(
        snapshotBody({ billingState: 'active', subscriptionTier: 'pro', hasBillingAccount: true }),
      );
    }) as unknown as typeof fetch;

    render(<BillingTab />);

    await userEvent.click(await screen.findByRole('button', { name: /manage billing/i }));

    await waitFor(() =>
      expect(assignedUrls).toContain('https://billing.stripe.com/session/abc'),
    );
  });

  it('surfaces the portal route problem detail as a toast', async () => {
    global.fetch = jest.fn(async (input: unknown, init?: { method?: string }) => {
      if (String(input).includes('/api/billing/portal') && init?.method === 'POST') {
        return fakeResponse(
          { code: 'no_billing_account', detail: 'this account has no billing profile yet' },
          false,
          409,
        );
      }
      return fakeResponse(
        snapshotBody({ billingState: 'active', subscriptionTier: 'pro', hasBillingAccount: true }),
      );
    }) as unknown as typeof fetch;

    render(<BillingTab />);

    await userEvent.click(await screen.findByRole('button', { name: /manage billing/i }));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith('this account has no billing profile yet'),
    );
  });

  /* ----------------------------- copy ------------------------------ */

  it('keeps every string it renders lowercase', async () => {
    mockSnapshot(
      snapshotBody({ billingState: 'trialing', trialEndsAt: Date.now() + 4 * DAY_MS, daysLeft: 4 }, [
        { siteId: 'a', name: 'atrium', tier: 'pro', activeMachineCount: 2 },
      ]),
    );

    const { container } = render(<BillingTab />);
    await screen.findByText('4 days left in your free trial');

    // Site names, dates, and money are user/system data, not copy — exclude
    // them by only checking that no rendered word is Title-Cased or SHOUTED.
    const text = container.textContent ?? '';
    const offenders = text
      .split(/\s+/)
      .filter((w) => /^[A-Z]/.test(w))
      // `atrium` is lowercase already; a real site name could legitimately be
      // capitalised, so nothing here should trip on user data.
      .filter((w) => w.length > 1);
    expect(offenders).toEqual([]);
  });
});
