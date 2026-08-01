/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * Pro-tier gating branch of the roosts page (billing-system wave 3.2).
 *
 * Wave 3.2 replaced this page's hand-rolled upgrade card with the shared
 * `ProTierGate`. What that refactor must not lose is asserted here: a core
 * site still gets the gate instead of the roost list, and the page chrome a
 * gated user needs — the header with its site switcher, the site dialogs —
 * still renders around it, so they can leave for a pro site without going
 * back through the url bar.
 *
 * Panel/selection wiring lives in `roosts-page.swap.test.tsx`, which pins
 * `useSiteTier` to `'pro'`; this file is the other side of the branch.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: jest.fn().mockImplementation((query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    addListener: jest.fn(),
    removeListener: jest.fn(),
    dispatchEvent: jest.fn(),
  })),
});

let siteTierValue: 'core' | 'pro' | undefined = 'core';

jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { uid: 'u1' },
    loading: false,
    role: 'admin',
    isSuperadmin: false,
    isSiteAdmin: () => true,
    userSites: ['site-a'],
    lastSiteId: 'site-a',
    lastMachineIds: {},
    userPreferences: {
      timezone: 'UTC',
      timeFormat: '12h',
      timeDisplayMode: 'machine',
    },
    updateLastSite: jest.fn(),
  }),
}));

jest.mock('@/hooks/useFirestore', () => ({
  useSites: () => ({
    sites: [{ id: 'site-a', name: 'site a', timezone: 'UTC' }],
    loading: false,
    error: null,
    createSite: jest.fn(),
    updateSite: jest.fn(),
    deleteSite: jest.fn(),
  }),
  useMachines: () => ({ machines: [], profiles: {}, loading: false, error: null }),
  firestoreTsToMs: (ts: unknown) => (typeof ts === 'number' ? ts : 0),
}));

jest.mock('@/hooks/useProjectDistributions', () => ({
  useProjectDistributionManager: () => ({
    presets: [],
    createDistribution: jest.fn(),
  }),
}));

jest.mock('@/hooks/useRoosts', () => ({
  useRoosts: () => ({ roosts: [], loading: false, error: null }),
}));

jest.mock('@/hooks/useSelectedRoost', () => ({
  useSelectedRoost: () => ({ selectedRoostId: null, setSelectedRoostId: jest.fn() }),
}));

jest.mock('@/hooks/useSiteTier', () => ({
  useSiteTier: () => siteTierValue,
}));

jest.mock('@/hooks/useRoostUpload', () => ({
  useRoostUpload: () => ({
    state: { status: 'idle' },
    start: jest.fn(),
    cancel: jest.fn(),
    reset: jest.fn(),
  }),
}));

// The plan picker is exercised in its own suite; here it only has to exist so
// `ProTierGate` renders for real.
jest.mock('@/components/billing/ChoosePlanDialog', () => ({
  ChoosePlanDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="choose-plan" /> : null,
}));

jest.mock('@/components/roost/RoostDetailPanel', () => ({
  RoostDetailPanel: () => <div data-testid="panel" />,
}));

jest.mock('@/components/roost/RoostMobileSheet', () => ({
  RoostMobileSheet: () => null,
}));

jest.mock('@/components/RoostTargetRow', () => ({
  RoostStatusPill: () => <span />,
  RoostTargetsList: () => <div />,
}));

jest.mock('@/components/EmptyStateUpload', () => ({
  EmptyStateUpload: () => <div data-testid="empty-state" />,
}));

jest.mock('@/components/ProjectDistributionDialog', () => ({
  __esModule: true,
  default: ({ open }: { open: boolean }) =>
    open ? <div data-testid="distribution-dialog" /> : null,
}));

jest.mock('@/components/ConfirmDialog', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('@/components/MinimizedUploadCard', () => ({
  MinimizedUploadCard: () => <div data-testid="minimized-upload-card" />,
}));

jest.mock('@/components/ManageSitesDialog', () => ({
  ManageSitesDialog: () => <div data-testid="manage-sites-dialog" />,
}));

jest.mock('@/components/CreateSiteDialog', () => ({
  CreateSiteDialog: () => <div data-testid="create-site-dialog" />,
}));

jest.mock('@/components/AccountSettingsDialog', () => ({
  AccountSettingsDialog: () => <div data-testid="account-settings-dialog" />,
}));

jest.mock('@/components/PageHeader', () => ({
  PageHeader: () => <header data-testid="page-header" />,
}));

jest.mock('@/components/DownloadButton', () => ({
  __esModule: true,
  default: () => <button type="button">download</button>,
}));

jest.mock('@/components/LoadingWord', () => ({
  LoadingWord: () => <span>loading</span>,
}));

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    forward: jest.fn(),
    refresh: jest.fn(),
    prefetch: jest.fn(),
  }),
  usePathname: () => '/roosts',
  useSearchParams: () => new URLSearchParams(),
}));

jest.mock('sonner', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

import RoostsPage from '@/app/roosts/RoostsPageClient';

describe('roosts page — pro tier gate', () => {
  it('renders the shared gate instead of the roost list on a core site', () => {
    siteTierValue = 'core';

    render(<RoostsPage />);

    expect(screen.getByTestId('pro-tier-gate')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'roost is a pro feature.' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /upgrade to pro/i })).toBeInTheDocument();
    // The list, its "new roost" cta, and the empty state are all gone.
    expect(screen.queryByRole('button', { name: /new roost/i })).toBeNull();
    expect(screen.queryByTestId('empty-state')).toBeNull();
  });

  it('keeps the page chrome around the gate so a gated user can switch sites', () => {
    siteTierValue = 'core';

    render(<RoostsPage />);

    expect(screen.getByTestId('page-header')).toBeInTheDocument();
    expect(screen.getByTestId('manage-sites-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('create-site-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('account-settings-dialog')).toBeInTheDocument();
  });

  it('renders the roost ui on a pro site', () => {
    siteTierValue = 'pro';

    render(<RoostsPage />);

    expect(screen.queryByTestId('pro-tier-gate')).toBeNull();
    expect(screen.getByRole('button', { name: /new roost/i })).toBeInTheDocument();
  });

  it('renders the roost ui while the tier is still resolving', () => {
    siteTierValue = undefined;

    render(<RoostsPage />);

    expect(screen.queryByTestId('pro-tier-gate')).toBeNull();
    expect(screen.getByRole('button', { name: /new roost/i })).toBeInTheDocument();
  });
});
