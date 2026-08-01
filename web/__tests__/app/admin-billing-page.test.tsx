/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * Render tests for /admin/billing (billing-system task 4.2).
 *
 * The arithmetic belongs to the route; what the page owes is honest
 * presentation of it — chiefly that the MRR tile is labelled a projection and
 * says so more loudly when the usage coverage behind it is partial.
 */

import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import AdminBillingPage from '@/app/admin/billing/page';
import type {
  AdminBillingOverviewResponse,
  AdminBillingStorageRow,
} from '@/lib/types/billingAdmin';

const TIB = 1024 ** 4;

function storageRow(overrides: Partial<AdminBillingStorageRow> = {}): AdminBillingStorageRow {
  return {
    uid: 'u_pro',
    email: 'pro@fleet.test',
    siteCount: 1,
    usedBytes: 1.2 * TIB,
    includedBytes: TIB,
    usedFraction: 1.2,
    overageBytes: 0.2 * TIB,
    ...overrides,
  };
}

function overview(
  overrides: Partial<AdminBillingOverviewResponse> = {},
): AdminBillingOverviewResponse {
  return {
    generatedAt: Date.UTC(2026, 7, 1, 12),
    customers: {
      total: 7,
      byState: { trialing: 2, active: 3, expired: 1, canceled: 1 },
      byTier: { core: 2, pro: 3, none: 2 },
      comped: 1,
    },
    mrr: { projectedUsd: 270.5, accounts: 3, withUsage: 3, latestPeriod: '2026-07-31' },
    conversion: { converted: 2, expired: 1, rate: 2 / 3 },
    storage: {
      alertThreshold: 0.9,
      topAccounts: [storageRow()],
      approachingOverage: [storageRow()],
    },
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

let originalFetch: typeof global.fetch;

function installFetch(response: Response | (() => Response)) {
  global.fetch = jest.fn(async () =>
    typeof response === 'function' ? response() : response,
  ) as unknown as typeof fetch;
}

beforeEach(() => {
  originalFetch = global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe('/admin/billing', () => {
  it('shows a loading state before the overview lands', async () => {
    installFetch(jsonResponse(200, overview()));
    render(<AdminBillingPage />);

    expect(screen.getByText(/loading billing overview/i)).toBeInTheDocument();
    // Let the in-flight load settle inside the test, so the state updates it
    // schedules land under act() rather than after teardown.
    await screen.findByText('$270.50');
  });

  it('renders the headline tiles', async () => {
    installFetch(jsonResponse(200, overview()));
    render(<AdminBillingPage />);

    expect(await screen.findByText('$270.50')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('66.7%')).toBeInTheDocument();
    expect(screen.getByText('1 comped')).toBeInTheDocument();
    expect(screen.getByText('2 converted · 1 expired')).toBeInTheDocument();
  });

  it('labels the mrr as a projection over the subscribed accounts', async () => {
    installFetch(jsonResponse(200, overview()));
    render(<AdminBillingPage />);

    expect(
      await screen.findByText(/projection at list price across 3 subscribed accounts/i),
    ).toBeInTheDocument();
  });

  it('warns that the mrr is a floor when usage coverage is partial', async () => {
    installFetch(
      jsonResponse(
        200,
        overview({
          mrr: { projectedUsd: 250, accounts: 3, withUsage: 2, latestPeriod: '2026-07-31' },
        }),
      ),
    );
    render(<AdminBillingPage />);

    expect(await screen.findByText(/so this is a floor/i)).toBeInTheDocument();
    expect(screen.getByText(/usage data for 2 of 3 subscribed accounts/i)).toBeInTheDocument();
  });

  it('breaks the population down by state and tier', async () => {
    installFetch(jsonResponse(200, overview()));
    render(<AdminBillingPage />);

    expect(await screen.findByTestId('state-count-trialing')).toHaveTextContent('2');
    expect(screen.getByTestId('state-count-active')).toHaveTextContent('3');
    expect(screen.getByTestId('state-count-expired')).toHaveTextContent('1');
    expect(screen.getByTestId('state-count-canceled')).toHaveTextContent('1');
    expect(screen.getByTestId('tier-count-core')).toHaveTextContent('2');
    expect(screen.getByTestId('tier-count-pro')).toHaveTextContent('3');
    expect(screen.getByTestId('tier-count-none')).toHaveTextContent('2');
  });

  it('renders the storage leaderboard with the overage called out', async () => {
    installFetch(jsonResponse(200, overview()));
    render(<AdminBillingPage />);

    const rows = await screen.findAllByTestId('storage-row-u_pro');
    // Same account appears on both tables (top-by-usage and approaching).
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText('pro@fleet.test')).toBeInTheDocument();
    expect(within(rows[0]).getByText('120.0%')).toBeInTheDocument();
    expect(within(rows[0]).getByText(/over by/i)).toBeInTheDocument();
  });

  it('renders a core account with no allowance as an em dash, not zero percent', async () => {
    installFetch(
      jsonResponse(
        200,
        overview({
          storage: {
            alertThreshold: 0.9,
            topAccounts: [
              storageRow({
                uid: 'u_core',
                email: 'core@fleet.test',
                usedBytes: 5 * 1024 ** 3,
                includedBytes: 0,
                usedFraction: null,
                overageBytes: 0,
              }),
            ],
            approachingOverage: [],
          },
        }),
      ),
    );
    render(<AdminBillingPage />);

    const row = await screen.findByTestId('storage-row-u_core');
    expect(within(row).getAllByText('—')).toHaveLength(2);
    expect(within(row).queryByText(/over by/i)).toBeNull();
  });

  it('renders empty copy when nothing is stored or at risk', async () => {
    installFetch(
      jsonResponse(
        200,
        overview({
          storage: { alertThreshold: 0.9, topAccounts: [], approachingOverage: [] },
        }),
      ),
    );
    render(<AdminBillingPage />);

    expect(await screen.findByText(/no roost storage is in use yet/i)).toBeInTheDocument();
    expect(screen.getByText(/no account is near its included storage/i)).toBeInTheDocument();
  });

  it('shows the failure reason and no stale figures when the load fails', async () => {
    let response = jsonResponse(200, overview());
    installFetch(() => response);

    render(<AdminBillingPage />);
    await screen.findByText('$270.50');

    response = jsonResponse(503, { detail: 'firestore unavailable' });
    await userEvent.click(screen.getByRole('button', { name: /refresh overview/i }));

    await waitFor(() => {
      expect(screen.getByText(/could not load the billing overview/i)).toBeInTheDocument();
    });
    expect(screen.queryByText('$270.50')).toBeNull();
    expect(screen.getByText('firestore unavailable')).toBeInTheDocument();
  });
});
