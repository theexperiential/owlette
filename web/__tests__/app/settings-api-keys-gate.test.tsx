/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * Pro-tier gating branch of /settings/api-keys (billing-system wave 3.2).
 *
 * Api keys are the one *account*-scoped pro feature, so this page reads
 * `useAccountTier()` rather than `useSiteTier()`.
 *
 * The gate has two shapes here, and which one shows turns on whether the
 * account has keys on file. Only `POST /api/account/api-keys` is pro-gated;
 * listing, rotating, and revoking are not, and revocation is a security action
 * that must not depend on a subscription. So a downgraded account with keys
 * keeps the whole list and loses only the create button, while one with no
 * keys — nothing to audit, nothing to revoke — gets the full card.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

let accountTierValue: 'core' | 'pro' | undefined = 'core';

// Stable identity, deliberately. `user` is in the page's fetch-effect
// dependency array, so a fresh object per render would re-enter the effect on
// every state update and pin the page in its loading branch forever.
const mockAuthValue = { user: { uid: 'u1' }, loading: false };
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => mockAuthValue,
}));

jest.mock('@/hooks/useAccountTier', () => ({
  useAccountTier: () => accountTierValue,
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

jest.mock('@/app/settings/api-keys/CreateKeyDialog', () => ({
  CreateKeyDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="create-key-dialog" /> : null,
}));

// Carries a revoke button so the tests can prove the page keeps that path
// wired while gated, not merely that a row rendered.
jest.mock('@/app/settings/api-keys/KeyCard', () => ({
  KeyCard: ({
    apiKey,
    onRevoked,
  }: {
    apiKey: { id: string };
    onRevoked: () => void;
  }) => (
    <div data-testid="key-card" data-key-id={apiKey.id}>
      <button type="button" onClick={onRevoked}>
        revoke {apiKey.id}
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

import ApiKeysSettingsPage from '@/app/settings/api-keys/page';

const KEY_FIXTURE = {
  id: 'key-1',
  name: 'ci',
  keyPrefix: 'owk_live_ab',
  scopes: [],
  createdAt: 1_700_000_000_000,
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
  environment: 'live',
};

describe('/settings/api-keys — pro tier gate', () => {
  let originalFetch: typeof global.fetch;
  let keysFixture: (typeof KEY_FIXTURE)[] = [KEY_FIXTURE];

  beforeEach(() => {
    keysFixture = [KEY_FIXTURE];
    originalFetch = global.fetch;
    global.fetch = jest.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ success: true, keys: keysFixture }),
        }) as unknown as Response,
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('keeps the key list and drops only the create cta for a core account with keys', async () => {
    accountTierValue = 'core';

    render(<ApiKeysSettingsPage />);

    await waitFor(() => expect(screen.getByTestId('key-card')).toBeInTheDocument());
    // Inline gate in the create button's place; no page-sized card.
    expect(screen.getByTestId('pro-tier-gate-inline')).toBeInTheDocument();
    expect(screen.getByText('creating new api keys requires pro')).toBeInTheDocument();
    expect(screen.queryByTestId('pro-tier-gate')).toBeNull();
    expect(screen.queryByRole('button', { name: /create key/i })).toBeNull();
    // The page itself still renders — heading included.
    expect(screen.getByRole('heading', { name: /api keys/i })).toBeInTheDocument();
  });

  it('leaves revoke wired for a core account', async () => {
    // `DELETE /api/keys/{id}` is not tier-gated, and revocation is a security
    // action. A gate that took it away would strip a control the api honours.
    accountTierValue = 'core';
    const user = userEvent.setup();

    render(<ApiKeysSettingsPage />);

    await waitFor(() => expect(screen.getByTestId('key-card')).toBeInTheDocument());
    const fetchCallsBefore = (global.fetch as jest.Mock).mock.calls.length;

    await user.click(screen.getByRole('button', { name: /revoke key-1/i }));

    // `onRevoked` is the page's `refresh`, so a re-list proves the callback
    // reached the page rather than dying inside the mock.
    await waitFor(() =>
      expect((global.fetch as jest.Mock).mock.calls.length).toBeGreaterThan(
        fetchCallsBefore,
      ),
    );
  });

  it('renders the full card for a core account with no keys', async () => {
    accountTierValue = 'core';
    keysFixture = [];

    render(<ApiKeysSettingsPage />);

    await waitFor(() => expect(screen.getByTestId('pro-tier-gate')).toBeInTheDocument());
    expect(
      screen.getByRole('heading', { name: 'api access is a pro feature.' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /upgrade to pro/i })).toBeInTheDocument();
    // Nothing to audit here, so the whole surface is the card.
    expect(screen.queryByTestId('pro-tier-gate-inline')).toBeNull();
    expect(screen.queryByRole('button', { name: /create key/i })).toBeNull();
    expect(screen.queryByRole('heading', { name: /^api keys$/i })).toBeNull();
  });

  it('renders the key management ui for a pro account', async () => {
    accountTierValue = 'pro';

    render(<ApiKeysSettingsPage />);

    await waitFor(() => expect(screen.getByTestId('key-card')).toBeInTheDocument());
    expect(screen.queryByTestId('pro-tier-gate')).toBeNull();
    expect(screen.queryByTestId('pro-tier-gate-inline')).toBeNull();
    expect(screen.getByRole('button', { name: /create key/i })).toBeInTheDocument();
  });

  it('gates nothing for a pro account with no keys', async () => {
    // The empty state keeps its own "create your first key" cta.
    accountTierValue = 'pro';
    keysFixture = [];

    render(<ApiKeysSettingsPage />);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /create your first key/i })).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('pro-tier-gate')).toBeNull();
    expect(screen.queryByTestId('pro-tier-gate-inline')).toBeNull();
  });

  it('renders the key management ui while the account tier is still resolving', async () => {
    accountTierValue = undefined;

    render(<ApiKeysSettingsPage />);

    await waitFor(() => expect(screen.getByTestId('key-card')).toBeInTheDocument());
    expect(screen.queryByTestId('pro-tier-gate')).toBeNull();
    expect(screen.queryByTestId('pro-tier-gate-inline')).toBeNull();
  });

  it('keeps the page header outside the gate', async () => {
    accountTierValue = 'core';
    keysFixture = [];

    render(<ApiKeysSettingsPage />);

    await waitFor(() => expect(screen.getByTestId('pro-tier-gate')).toBeInTheDocument());
    expect(screen.getByTestId('page-header')).toBeInTheDocument();
  });
});
