/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * Pro-tier gating branch of /settings/webhooks (billing-system wave 3.2).
 *
 * Webhooks are site-scoped — `POST /api/webhooks` gates on `requirePro` for
 * the site in the query string — so this page reads `useSiteTier()` for
 * whichever site the picker has selected.
 *
 * `POST` is also the *only* thing that route gates: its own header says "GET
 * is not tier-gated, so a downgraded site can still audit what it has
 * subscribed", and PATCH / DELETE / rotate-secret / retry carry no gate
 * either. So a core site with subscriptions keeps the list and every per-row
 * control, and loses only the create button; a core site with none gets the
 * full card.
 *
 * The other wiring detail worth its own test: the site picker stays *outside*
 * the gate. It is a gated user's only route from a core site to one of their
 * pro sites, and burying it behind the upgrade card would strand them.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

let siteTierValue: 'core' | 'pro' | undefined = 'core';

// Stable identity, deliberately. `user` is in the page's fetch-effect
// dependency array, so a fresh object per render would re-enter the effect on
// every state update and pin the page in its loading branch forever.
const mockAuthValue = {
  user: { uid: 'u1' },
  loading: false,
  userSites: ['site-a', 'site-b'],
  lastSiteId: 'site-a',
};
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => mockAuthValue,
}));

jest.mock('@/hooks/useSiteTier', () => ({
  useSiteTier: () => siteTierValue,
}));

jest.mock('@/components/billing/ChoosePlanDialog', () => ({
  ChoosePlanDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="choose-plan" /> : null,
}));

jest.mock('@/components/PageHeader', () => ({
  PageHeader: () => <header data-testid="page-header" />,
}));

jest.mock('@/components/CopyButton', () => ({
  CopyButton: () => <button type="button">copy</button>,
}));

jest.mock('@/app/settings/webhooks/CreateWebhookDialog', () => ({
  CreateWebhookDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="create-webhook-dialog" /> : null,
}));

// Carries a delete button so the tests can prove the page keeps that path
// wired while gated, not merely that a row rendered.
jest.mock('@/app/settings/webhooks/WebhookCard', () => ({
  WebhookCard: ({
    webhook,
    onChanged,
  }: {
    webhook: { id: string };
    onChanged: () => void;
  }) => (
    <div data-testid="webhook-card" data-webhook-id={webhook.id}>
      <button type="button" onClick={onChanged}>
        delete {webhook.id}
      </button>
    </div>
  ),
}));

jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

// One stable router object: the page's fetch effect lists `router` in its
// dependency array, so a fresh object per render would re-fire the fetch on
// every state update and leave the page pinned in its loading branch.
const mockRouter = { push: jest.fn(), replace: jest.fn() };
jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
}));

import WebhooksSettingsPage from '@/app/settings/webhooks/page';

const WEBHOOK_FIXTURE = {
  id: 'wh-1',
  url: 'https://example.com/hook',
  events: ['version.published'],
  description: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  disabledAt: null,
};

describe('/settings/webhooks — pro tier gate', () => {
  let originalFetch: typeof global.fetch;
  let webhooksFixture: (typeof WEBHOOK_FIXTURE)[] = [WEBHOOK_FIXTURE];

  beforeEach(() => {
    webhooksFixture = [WEBHOOK_FIXTURE];
    originalFetch = global.fetch;
    global.fetch = jest.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ webhooks: webhooksFixture, nextPageToken: '' }),
        }) as unknown as Response,
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('keeps the subscription list and drops only the create cta on a core site', async () => {
    siteTierValue = 'core';

    render(<WebhooksSettingsPage />);

    await waitFor(() => expect(screen.getByTestId('webhook-card')).toBeInTheDocument());
    expect(screen.getByTestId('pro-tier-gate-inline')).toBeInTheDocument();
    expect(screen.getByText('creating new webhooks requires pro')).toBeInTheDocument();
    expect(screen.queryByTestId('pro-tier-gate')).toBeNull();
    expect(screen.queryByRole('button', { name: /create webhook/i })).toBeNull();
    // The page stays a page: title and the dev-preview delivery caveat, which
    // still applies to the subscriptions this site has.
    expect(screen.getByRole('heading', { name: /webhooks/i })).toBeInTheDocument();
    expect(screen.getByText('developer preview')).toBeInTheDocument();
  });

  it('leaves per-row actions wired on a core site', async () => {
    // PATCH / DELETE / rotate-secret / retry carry no tier gate server-side,
    // so a downgraded site must keep every one of them.
    siteTierValue = 'core';
    const user = userEvent.setup();

    render(<WebhooksSettingsPage />);

    await waitFor(() => expect(screen.getByTestId('webhook-card')).toBeInTheDocument());
    const fetchCallsBefore = (global.fetch as jest.Mock).mock.calls.length;

    await user.click(screen.getByRole('button', { name: /delete wh-1/i }));

    // `onChanged` is the page's `refresh`, so a re-list proves the callback
    // reached the page rather than dying inside the mock.
    await waitFor(() =>
      expect((global.fetch as jest.Mock).mock.calls.length).toBeGreaterThan(
        fetchCallsBefore,
      ),
    );
  });

  it('renders the full card on a core site with no subscriptions', async () => {
    siteTierValue = 'core';
    webhooksFixture = [];

    render(<WebhooksSettingsPage />);

    await waitFor(() => expect(screen.getByTestId('pro-tier-gate')).toBeInTheDocument());
    expect(
      screen.getByRole('heading', { name: 'webhook delivery is a pro feature.' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /upgrade to pro/i })).toBeInTheDocument();
    expect(screen.queryByTestId('pro-tier-gate-inline')).toBeNull();
    expect(screen.queryByRole('button', { name: /create webhook/i })).toBeNull();
    expect(screen.queryByText('developer preview')).toBeNull();
  });

  it('keeps the site picker reachable whenever the page still renders', async () => {
    // The full-card branch drops it with everything else, so the case that
    // matters is the one a downgraded site actually lands on with data.
    siteTierValue = 'core';

    render(<WebhooksSettingsPage />);

    await waitFor(() => expect(screen.getByTestId('pro-tier-gate-inline')).toBeInTheDocument());
    expect(screen.getByRole('combobox')).toBeInTheDocument();
  });

  it('renders the subscription list on a pro site', async () => {
    siteTierValue = 'pro';

    render(<WebhooksSettingsPage />);

    await waitFor(() => expect(screen.getByTestId('webhook-card')).toBeInTheDocument());
    expect(screen.queryByTestId('pro-tier-gate')).toBeNull();
    expect(screen.queryByTestId('pro-tier-gate-inline')).toBeNull();
    expect(screen.getByRole('button', { name: /create webhook/i })).toBeInTheDocument();
    expect(screen.getByText('developer preview')).toBeInTheDocument();
  });

  it('gates nothing on a pro site with no subscriptions', async () => {
    siteTierValue = 'pro';
    webhooksFixture = [];

    render(<WebhooksSettingsPage />);

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /create your first webhook/i }),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('pro-tier-gate')).toBeNull();
    expect(screen.queryByTestId('pro-tier-gate-inline')).toBeNull();
  });

  it('renders the subscription list while the site tier is still resolving', async () => {
    siteTierValue = undefined;

    render(<WebhooksSettingsPage />);

    await waitFor(() => expect(screen.getByTestId('webhook-card')).toBeInTheDocument());
    expect(screen.queryByTestId('pro-tier-gate')).toBeNull();
    expect(screen.queryByTestId('pro-tier-gate-inline')).toBeNull();
  });
});
