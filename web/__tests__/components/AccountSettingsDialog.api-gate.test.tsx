/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * Pro-tier gating of the account-settings "api" section (billing-system
 * wave 3.2).
 *
 * This section is the *other* door into api-key creation — the discoverable
 * one, since /settings/api-keys is only linked from inside it. Gating one and
 * not the other would leave a core account a working create form one click
 * away from the gate that just told them they can't have keys.
 *
 * It gates the same two ways as the page: full card when there are no keys to
 * audit, inline row in the create form's place when there are. Only creation
 * is pro-gated server-side, and revocation is a security action that must not
 * depend on a subscription.
 *
 * Only the gating branch is under test here; the section's own behaviour
 * (create, revoke, the scope presets) is untouched by 3.2.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

let accountTierValue: 'core' | 'pro' | undefined = 'core';
const useAccountTierMock = jest.fn(() => accountTierValue);

// Stable identity — this dialog re-renders a lot and `userPreferences` feeds
// a mount effect.
const mockAuthValue = {
  user: {
    uid: 'u1',
    email: 'someone@example.com',
    displayName: 'someone',
    photoURL: null,
    providerData: [{ providerId: 'password' }],
  },
  userPreferences: {
    temperatureUnit: 'C' as const,
    timezone: 'UTC',
    timeFormat: '12h' as const,
    timeDisplayMode: 'machine' as const,
    healthAlerts: true,
    processAlerts: true,
    thresholdAlerts: true,
    cortexAlerts: true,
    displayAlerts: true,
    alertCcEmails: [],
  },
  updateUserProfile: jest.fn(),
  updateUserPhoto: jest.fn(),
  updatePassword: jest.fn(),
  updateUserPreferences: jest.fn(),
  deleteAccount: jest.fn(),
};
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => mockAuthValue,
}));

jest.mock('@/hooks/useAccountTier', () => ({
  useAccountTier: (enabled?: boolean) => useAccountTierMock(enabled),
}));

jest.mock('@/components/billing/ChoosePlanDialog', () => ({
  ChoosePlanDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="choose-plan" /> : null,
}));

jest.mock('@/components/BillingTab', () => ({
  BillingTab: () => <div data-testid="billing-tab" />,
}));

jest.mock('@/components/PasskeyManager', () => ({
  PasskeyManager: () => <div data-testid="passkey-manager" />,
}));

jest.mock('@/components/UserAvatar', () => ({
  UserAvatar: () => <div data-testid="user-avatar" />,
}));

jest.mock('@/components/TimezoneSelect', () => ({
  TimezoneSelect: () => <div data-testid="timezone-select" />,
}));

jest.mock('@/components/CopyButton', () => ({
  CopyButton: () => <button type="button">copy</button>,
}));

jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

import { AccountSettingsDialog } from '@/components/AccountSettingsDialog';

function renderApiSection() {
  return render(
    <AccountSettingsDialog open onOpenChange={jest.fn()} initialSection="api" />,
  );
}

const KEY_FIXTURE = {
  id: 'key-1',
  name: 'ci',
  keyPrefix: 'owk_live_ab',
  createdAt: 1_700_000_000_000,
  lastUsedAt: null,
};

describe('AccountSettingsDialog — api section pro gate', () => {
  let originalFetch: typeof global.fetch;
  let keysFixture: (typeof KEY_FIXTURE)[] = [];

  beforeEach(() => {
    accountTierValue = 'core';
    keysFixture = [];
    originalFetch = global.fetch;
    global.fetch = jest.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ success: true, keys: keysFixture, configured: false }),
        }) as unknown as Response,
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('renders the full card for a core account with no keys', async () => {
    accountTierValue = 'core';

    renderApiSection();

    await waitFor(() => expect(screen.getByTestId('pro-tier-gate')).toBeInTheDocument());
    expect(
      screen.getByRole('heading', { name: 'api access is a pro feature.' }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('pro-tier-gate-inline')).toBeNull();
    expect(screen.queryByLabelText('key name')).toBeNull();
    expect(screen.queryByRole('button', { name: /create key/i })).toBeNull();
  });

  it('keeps the key list and replaces only the create form for a core account with keys', async () => {
    accountTierValue = 'core';
    keysFixture = [KEY_FIXTURE];

    renderApiSection();

    // Wait on the list, not the gate: `apiKeysLoading` suppresses the
    // full-card branch too, so the inline row is on screen a beat before the
    // keys land and asserting on it first would pass vacuously.
    await waitFor(() => expect(screen.getByText('active keys')).toBeInTheDocument());

    expect(screen.getByTestId('pro-tier-gate-inline')).toBeInTheDocument();
    expect(screen.getByText('creating new api keys requires pro')).toBeInTheDocument();
    expect(screen.queryByTestId('pro-tier-gate')).toBeNull();
    // Create form gone…
    expect(screen.queryByLabelText('key name')).toBeNull();
    expect(screen.queryByRole('button', { name: /create key/i })).toBeNull();
    // …list and its revoke button still there. `DELETE /api/keys/{id}` is
    // ungated, and revocation must not depend on a subscription.
    expect(screen.getByText('ci')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'revoke ci' })).toBeInTheDocument();
  });

  it('leaves the revoke confirmation reachable for a core account', async () => {
    accountTierValue = 'core';
    keysFixture = [KEY_FIXTURE];
    const user = userEvent.setup();

    renderApiSection();

    await waitFor(() => expect(screen.getByText('active keys')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'revoke ci' }));

    expect(screen.getByText('revoke?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'yes' })).toBeInTheDocument();
  });

  it('renders the key form for a pro account', async () => {
    accountTierValue = 'pro';

    renderApiSection();

    await waitFor(() => expect(screen.getByLabelText('key name')).toBeInTheDocument());
    expect(screen.queryByTestId('pro-tier-gate')).toBeNull();
    expect(screen.queryByTestId('pro-tier-gate-inline')).toBeNull();
    expect(screen.getByRole('button', { name: /create key/i })).toBeInTheDocument();
  });

  it('renders the key form while the account tier is still resolving', async () => {
    accountTierValue = undefined;

    renderApiSection();

    await waitFor(() => expect(screen.getByLabelText('key name')).toBeInTheDocument());
    expect(screen.queryByTestId('pro-tier-gate')).toBeNull();
    expect(screen.queryByTestId('pro-tier-gate-inline')).toBeNull();
  });

  it('only enables the account-tier fetch while the api section is on screen', () => {
    accountTierValue = 'core';

    renderApiSection();

    expect(useAccountTierMock).toHaveBeenCalledWith(true);

    useAccountTierMock.mockClear();
    render(
      <AccountSettingsDialog open onOpenChange={jest.fn()} initialSection="profile" />,
    );

    expect(useAccountTierMock).toHaveBeenCalledWith(false);
    expect(useAccountTierMock).not.toHaveBeenCalledWith(true);
  });

  it('does not enable the fetch for a closed dialog', () => {
    render(
      <AccountSettingsDialog
        open={false}
        onOpenChange={jest.fn()}
        initialSection="api"
      />,
    );

    expect(useAccountTierMock).not.toHaveBeenCalledWith(true);
  });
});
