/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * Render + interaction tests for /admin/customers (billing-system task 4.1).
 *
 * The page owns no billing logic — every decision is the route's. What it does
 * own, and what is tested here, is the operator-safety surface: which state
 * the table is in, that a failed load clears the rows rather than leaving an
 * override aimed at stale data, and that each row action posts the exact
 * operation body the route expects.
 */

import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Indirected through arrows so the factory never dereferences these consts at
// hoist time — jest.mock() runs before the module-scope bindings initialise.
const mockToastSuccess = jest.fn();
const mockToastError = jest.fn();
jest.mock('@/lib/toast', () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

import AdminCustomersPage from '@/app/admin/customers/page';
import type { AdminBillingCustomer } from '@/lib/types/billingAdmin';

const TRIAL_ENDS = Date.UTC(2026, 7, 20);

function customer(overrides: Partial<AdminBillingCustomer> = {}): AdminBillingCustomer {
  return {
    uid: 'u1',
    email: 'ana@fleet.test',
    displayName: 'Ana',
    deleted: false,
    billingState: 'trialing',
    staleMirror: null,
    subscriptionStatus: null,
    subscriptionTier: null,
    comped: false,
    comp: null,
    trialEndsAt: TRIAL_ENDS,
    currentPeriodEnd: null,
    hasSubscription: false,
    alertEmailsMuted: false,
    ...overrides,
  };
}

function listBody(customers: AdminBillingCustomer[]) {
  return { customers, matched: customers.length, total: customers.length, truncated: false };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

let originalFetch: typeof global.fetch;
let fetchMock: jest.Mock;

/** Route every request to a queued handler keyed on method. */
function installFetch(
  listResponse: Response | (() => Response),
  postResponse: Response = jsonResponse(200, {
    uid: 'u1',
    operation: 'extend_trial',
    previousBillingState: 'expired',
    billingState: 'trialing',
    trialEndsAt: TRIAL_ENDS,
    subscriptionTier: null,
    comped: false,
    clearedTrialEmailMarkers: [],
    clearedAlertMute: false,
  }),
) {
  fetchMock = jest.fn(async (_url: string, init?: RequestInit) =>
    init?.method === 'POST'
      ? postResponse
      : typeof listResponse === 'function'
        ? listResponse()
        : listResponse,
  );
  global.fetch = fetchMock as unknown as typeof fetch;
}

beforeEach(() => {
  originalFetch = global.fetch;
  mockToastSuccess.mockClear();
  mockToastError.mockClear();
});

afterEach(() => {
  global.fetch = originalFetch;
});

/* ─── load states ──────────────────────────────────────────────────────── */

describe('/admin/customers — load states', () => {
  it('shows a loading state before the first response lands', async () => {
    installFetch(jsonResponse(200, listBody([])));
    render(<AdminCustomersPage />);

    expect(screen.getByText(/loading customers/i)).toBeInTheDocument();
    // Let the debounced load settle inside the test, so the state updates it
    // schedules land under act() rather than after teardown.
    await screen.findByText(/no accounts match these filters/i);
  });

  it('renders a row per account with its state and trial clock', async () => {
    installFetch(
      jsonResponse(
        200,
        listBody([
          customer(),
          customer({
            uid: 'u2',
            email: 'bo@fleet.test',
            displayName: null,
            billingState: 'expired',
            trialEndsAt: Date.UTC(2026, 6, 1),
          }),
        ]),
      ),
    );

    render(<AdminCustomersPage />);

    const row = await screen.findByTestId('customer-row-u1');
    expect(within(row).getByText('ana@fleet.test')).toBeInTheDocument();
    expect(within(row).getByText('trialing')).toBeInTheDocument();

    const expiredRow = screen.getByTestId('customer-row-u2');
    expect(within(expiredRow).getByText('expired')).toBeInTheDocument();
    expect(screen.getByText('2 accounts')).toBeInTheDocument();
  });

  it('marks a comped tier and its reason', async () => {
    installFetch(
      jsonResponse(
        200,
        listBody([
          customer({
            subscriptionTier: 'pro',
            comped: true,
            comp: { at: TRIAL_ENDS, by: 'uid_admin', note: 'conference sponsor' },
          }),
        ]),
      ),
    );

    render(<AdminCustomersPage />);

    const row = await screen.findByTestId('customer-row-u1');
    expect(within(row).getByText('comped')).toBeInTheDocument();
    expect(within(row).getByText('conference sponsor')).toBeInTheDocument();
  });

  it('surfaces a muted account', async () => {
    installFetch(jsonResponse(200, listBody([customer({ alertEmailsMuted: true })])));
    render(<AdminCustomersPage />);
    expect(await screen.findByText('alerts muted')).toBeInTheDocument();
  });

  it('renders an empty state when nothing matches', async () => {
    installFetch(jsonResponse(200, listBody([])));
    render(<AdminCustomersPage />);
    expect(await screen.findByText(/no accounts match these filters/i)).toBeInTheDocument();
  });

  it('clears the table when the load fails, rather than leaving stale rows', async () => {
    let response = jsonResponse(200, listBody([customer()]));
    installFetch(() => response);

    render(<AdminCustomersPage />);
    await screen.findByTestId('customer-row-u1');

    response = jsonResponse(500, { detail: 'firestore unavailable' });
    await userEvent.click(screen.getByRole('button', { name: /refresh customers/i }));

    await waitFor(() => {
      expect(screen.getByText(/could not load customers/i)).toBeInTheDocument();
    });
    expect(screen.queryByTestId('customer-row-u1')).toBeNull();
    expect(screen.getByText('firestore unavailable')).toBeInTheDocument();
  });
});

/* ─── row actions ──────────────────────────────────────────────────────── */

describe('/admin/customers — row actions', () => {
  it('posts an extension with the chosen day count', async () => {
    const user = userEvent.setup();
    installFetch(jsonResponse(200, listBody([customer()])));

    render(<AdminCustomersPage />);
    const row = await screen.findByTestId('customer-row-u1');

    await user.click(within(row).getByRole('button', { name: /extend/i }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();

    const daysInput = screen.getByLabelText(/days to add/i);
    await user.clear(daysInput);
    await user.type(daysInput, '30');
    await user.click(screen.getByRole('button', { name: /extend by 30 days/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/admin/billing/customers/u1',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ operation: 'extend_trial', days: 30 }),
        }),
      );
    });
    expect(mockToastSuccess).toHaveBeenCalled();
  });

  it('blocks an extension with a non-numeric day count', async () => {
    const user = userEvent.setup();
    installFetch(jsonResponse(200, listBody([customer()])));

    render(<AdminCustomersPage />);
    const row = await screen.findByTestId('customer-row-u1');

    await user.click(within(row).getByRole('button', { name: /extend/i }));
    const daysInput = await screen.findByLabelText(/days to add/i);
    await user.clear(daysInput);

    expect(screen.getByText(/between 1 and 365/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /extend by 0 days/i })).toBeDisabled();
  });

  it('requires a reason before a comp can be submitted', async () => {
    const user = userEvent.setup();
    installFetch(jsonResponse(200, listBody([customer()])));

    render(<AdminCustomersPage />);
    const row = await screen.findByTestId('customer-row-u1');

    await user.click(within(row).getByRole('button', { name: /set tier/i }));
    expect(await screen.findByText(/a reason is required/i)).toBeInTheDocument();

    const submit = screen.getByRole('button', { name: /comp to pro/i });
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText(/reason/i), 'conference sponsor');
    expect(submit).toBeEnabled();
    await user.click(submit);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/admin/billing/customers/u1',
        expect.objectContaining({
          body: JSON.stringify({
            operation: 'set_tier',
            tier: 'pro',
            note: 'conference sponsor',
          }),
        }),
      );
    });
  });

  it('posts a force expire from the destructive confirm', async () => {
    const user = userEvent.setup();
    installFetch(jsonResponse(200, listBody([customer()])));

    render(<AdminCustomersPage />);
    const row = await screen.findByTestId('customer-row-u1');

    await user.click(within(row).getByRole('button', { name: /expire/i }));
    await user.click(await screen.findByRole('button', { name: /end trial now/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/admin/billing/customers/u1',
        expect.objectContaining({ body: JSON.stringify({ operation: 'force_expire' }) }),
      );
    });
  });

  it('reports a rejected override and keeps the dialog open', async () => {
    const user = userEvent.setup();
    installFetch(
      jsonResponse(200, listBody([customer()])),
      jsonResponse(404, { detail: 'no billing customer for u1' }),
    );

    render(<AdminCustomersPage />);
    const row = await screen.findByTestId('customer-row-u1');

    await user.click(within(row).getByRole('button', { name: /expire/i }));
    await user.click(await screen.findByRole('button', { name: /end trial now/i }));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('override failed', {
        description: 'no billing customer for u1',
      });
    });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
