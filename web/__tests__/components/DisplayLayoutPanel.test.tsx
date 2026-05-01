/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * Render tests for the auto-restore UI added in C3.3 + C3.4 of the display
 * layout panel. Covers:
 *  - the toggle's permission gate (visible iff `isSiteAdmin(siteId)`)
 *  - the toggle's disabled-state for the no-stored-layout / mosaic-active
 *    branches and that the tooltip text matches the spec
 *  - the toggle calls `useDisplayActions.setAutoRestore` with the right
 *    next-value + operator email
 *  - the breaker-tripped banner forks between admin (red, with reset) and
 *    read-only (amber, no button) variants
 *  - the reset button calls `useDisplayActions.resetAutoRestoreBreaker`
 *
 * The panel pulls in a few peer hooks (useDisplayDraft, useDisplayModes,
 * useDisplayEventFeed) — all mocked to inert state so the panel renders
 * with a single source of truth (the controlled mocks below) and the
 * tests don't depend on real Firestore / sessionStorage / subscriptions.
 */

import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  AssignedLayout,
  DisplayAutoRestoreState,
  DisplayProfile,
  MonitorInfo,
} from '@/hooks/useDisplayState';

// ----------------------------------------------------------------------------
// Mocks — set up before importing the component under test.
// ----------------------------------------------------------------------------

// Preserve the pure helpers (`computeDisplayDrift`, `totalDriftCount`,
// `normalizePrimaryToOrigin`) the panel imports alongside the hook. Only
// `useDisplayState` itself becomes a controllable jest mock.
jest.mock('@/hooks/useDisplayState', () => {
  const actual = jest.requireActual('@/hooks/useDisplayState');
  return {
    ...actual,
    useDisplayState: jest.fn(),
  };
});

jest.mock('@/hooks/useDisplayActions', () => ({
  useDisplayActions: jest.fn(),
}));

jest.mock('@/hooks/useDisplayDraft', () => ({
  useDisplayDraft: jest.fn(),
}));

jest.mock('@/hooks/useDisplayModes', () => ({
  useDisplayModes: jest.fn(),
}));

jest.mock('@/hooks/useDisplayEventFeed', () => ({
  useDisplayEventFeed: jest.fn(),
}));

jest.mock('@/contexts/AuthContext', () => ({
  useAuth: jest.fn(),
}));

jest.mock('sonner', () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
  },
}));

// Heavy children we don't need to exercise here. Stubs keep the render
// tree small + deterministic and avoid pulling in canvas/DOM-measurement
// code that jsdom can't satisfy.
jest.mock('@/components/charts/DisplayCanvas', () => ({
  DisplayCanvas: () => <div data-testid="display-canvas-stub" />,
}));
jest.mock('@/components/charts/DisplayMonitorTable', () => ({
  DisplayMonitorTable: () => <div data-testid="display-monitor-table-stub" />,
}));
jest.mock('@/components/charts/DisplayEditorDialog', () => ({
  DisplayEditorDialog: () => null,
}));
jest.mock('@/components/ConfirmDialog', () => ({
  __esModule: true,
  default: ({
    open,
    title,
    confirmText,
    onConfirm,
  }: {
    open: boolean;
    title: string;
    confirmText: string;
    onConfirm: () => void | Promise<void>;
  }) =>
    open ? (
      <div role="dialog" aria-label={title}>
        <button onClick={onConfirm}>{confirmText}</button>
      </div>
    ) : null,
}));

import { DisplayLayoutPanel } from '@/components/charts/DisplayLayoutPanel';
import { useDisplayState } from '@/hooks/useDisplayState';
import { useDisplayActions } from '@/hooks/useDisplayActions';
import { useDisplayDraft } from '@/hooks/useDisplayDraft';
import { useDisplayModes } from '@/hooks/useDisplayModes';
import { useDisplayEventFeed } from '@/hooks/useDisplayEventFeed';
import { useAuth } from '@/contexts/AuthContext';
import { TooltipProvider } from '@/components/ui/tooltip';

const mockedUseDisplayState = useDisplayState as jest.MockedFunction<typeof useDisplayState>;
const mockedUseDisplayActions = useDisplayActions as jest.MockedFunction<typeof useDisplayActions>;
const mockedUseDisplayDraft = useDisplayDraft as jest.MockedFunction<typeof useDisplayDraft>;
const mockedUseDisplayModes = useDisplayModes as jest.MockedFunction<typeof useDisplayModes>;
const mockedUseDisplayEventFeed = useDisplayEventFeed as jest.MockedFunction<typeof useDisplayEventFeed>;
const mockedUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;

// ----------------------------------------------------------------------------
// Fixture builders
// ----------------------------------------------------------------------------

function makeMonitor(overrides: Partial<MonitorInfo> = {}): MonitorInfo {
  return {
    id: 'monitor-1',
    edidHash: 'hash-1',
    manufacturerId: 'DEL',
    productCode: '1234',
    serialNumber: 'SN-1',
    friendlyName: 'Dell U2723QE',
    position: { x: 0, y: 0 },
    resolution: { width: 3840, height: 2160 },
    refreshHz: 60,
    rotation: 0,
    scalePct: 100,
    primary: true,
    connectionType: 'dp',
    adapterLuid: 'luid-1',
    targetId: 1,
    ...overrides,
  };
}

function makeProfile(overrides: Partial<DisplayProfile> = {}): DisplayProfile {
  return {
    schemaVersion: 1,
    signatureHash: 'sig-abc',
    capturedAt: 1_700_000_000_000,
    monitors: [makeMonitor()],
    mosaicActive: false,
    ...overrides,
  };
}

function makeAssigned(overrides: Partial<AssignedLayout> = {}): AssignedLayout {
  return {
    monitors: [makeMonitor()],
    capturedAt: 1_700_000_000_000,
    capturedBy: 'admin@example.com',
    ...overrides,
  };
}

function makeAutoRestore(
  overrides: Partial<DisplayAutoRestoreState> = {},
): DisplayAutoRestoreState {
  return {
    enabled: false,
    circuitBreaker: { tripped: false, failures: 0 },
    ...overrides,
  };
}

interface SetupOptions {
  canSiteAdmin?: boolean;
  userEmail?: string | null;
  hasAssignedLayout?: boolean;
  hasLiveProfile?: boolean;
  mosaicActive?: boolean;
  remoteApplyEnabled?: boolean;
  autoRestore?: Partial<DisplayAutoRestoreState>;
}

interface SetupResult {
  setAutoRestore: jest.Mock;
  resetAutoRestoreBreaker: jest.Mock;
  captureLayout: jest.Mock;
  applyLayout: jest.Mock;
  ackLayout: jest.Mock;
  clearLayout: jest.Mock;
  enumerateDisplayModes: jest.Mock;
  testDisplayApply: jest.Mock;
  setRemoteApplyEnabled: jest.Mock;
}

/**
 * Wire all five jest.fn-backed hooks to a controlled state. Returns the
 * action spies so individual tests can assert on them.
 */
function setup(options: SetupOptions = {}): SetupResult {
  const {
    canSiteAdmin = true,
    userEmail = 'admin@example.com',
    hasAssignedLayout = true,
    hasLiveProfile = true,
    mosaicActive = false,
    remoteApplyEnabled = true,
    autoRestore = {},
  } = options;

  // Auth — only `isSiteAdmin` and `user.email` are consumed by the panel.
  // The full `AuthContextType` shape is large; cast the partial mock to
  // the return type to keep test inputs focused.
  mockedUseAuth.mockReturnValue({
    isSiteAdmin: () => canSiteAdmin,
    user: userEmail ? ({ email: userEmail } as never) : null,
  } as unknown as ReturnType<typeof useAuth>);

  mockedUseDisplayState.mockReturnValue({
    profile: hasLiveProfile ? makeProfile({ mosaicActive }) : null,
    assigned: hasAssignedLayout ? makeAssigned() : null,
    autoRestore: makeAutoRestore(autoRestore),
    remoteApplyEnabled,
    loading: false,
    error: null,
  });

  mockedUseDisplayDraft.mockReturnValue({
    draft: null,
    isDirty: false,
    updateMonitor: jest.fn(),
    shiftSecondariesBy: jest.fn(),
    resetToAssigned: jest.fn(),
    resetToLive: jest.fn(),
    clearDraft: jest.fn(),
  });

  mockedUseDisplayModes.mockReturnValue({
    catalogue: null,
    loading: false,
    error: null,
    requestEnumerate: jest.fn(),
  });

  mockedUseDisplayEventFeed.mockReturnValue({
    events: [],
    loading: false,
    error: null,
  });

  const setAutoRestore = jest.fn().mockResolvedValue(undefined);
  const resetAutoRestoreBreaker = jest.fn().mockResolvedValue(undefined);
  const captureLayout = jest.fn().mockResolvedValue(undefined);
  const applyLayout = jest.fn().mockResolvedValue({ commandId: 'cmd', applyId: 'apply' });
  const ackLayout = jest.fn().mockResolvedValue('ack');
  const clearLayout = jest.fn().mockResolvedValue(undefined);
  const enumerateDisplayModes = jest.fn().mockResolvedValue('enum');
  const testDisplayApply = jest.fn().mockResolvedValue('test-cmd');
  const setRemoteApplyEnabled = jest.fn().mockResolvedValue(undefined);

  mockedUseDisplayActions.mockReturnValue({
    captureLayout,
    clearLayout,
    applyLayout,
    ackLayout,
    testDisplayApply,
    enumerateDisplayModes,
    setRemoteApplyEnabled,
    setAutoRestore,
    resetAutoRestoreBreaker,
    applying: false,
  });

  return {
    setAutoRestore,
    resetAutoRestoreBreaker,
    captureLayout,
    applyLayout,
    ackLayout,
    clearLayout,
    enumerateDisplayModes,
    testDisplayApply,
    setRemoteApplyEnabled,
  };
}

function renderPanel() {
  // Mirror the app's `layout.tsx` wrap so the panel's Radix Tooltips can
  // resolve their TooltipProvider context. Without this every render throws
  // "`Tooltip` must be used within `TooltipProvider`".
  return render(
    <TooltipProvider>
      <DisplayLayoutPanel
        machineId="machine-1"
        machineName="Lobby Display"
        siteId="site-a"
        onClose={jest.fn()}
      />
    </TooltipProvider>,
  );
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

describe('DisplayLayoutPanel — auto-restore UI', () => {
  it('renders the toggle when canSiteAdmin is true', () => {
    setup({ canSiteAdmin: true });
    renderPanel();
    expect(screen.getByTestId('display-auto-restore-toggle')).toBeInTheDocument();
    expect(screen.getByText('auto-restore')).toBeInTheDocument();
  });

  it('hides the toggle when canSiteAdmin is false', () => {
    setup({ canSiteAdmin: false });
    renderPanel();
    expect(screen.queryByTestId('display-auto-restore-toggle')).not.toBeInTheDocument();
    expect(screen.queryByText('auto-restore')).not.toBeInTheDocument();
  });

  it('toggle calls setAutoRestore(true, userEmail) when initially disabled', async () => {
    const user = userEvent.setup();
    const { setAutoRestore } = setup({
      canSiteAdmin: true,
      userEmail: 'admin@example.com',
      autoRestore: { enabled: false },
    });
    renderPanel();

    await user.click(screen.getByTestId('display-auto-restore-toggle'));

    expect(setAutoRestore).toHaveBeenCalledTimes(1);
    expect(setAutoRestore).toHaveBeenCalledWith(true, 'admin@example.com');
  });

  it('toggle calls setAutoRestore(false, userEmail) when initially enabled', async () => {
    const user = userEvent.setup();
    const { setAutoRestore } = setup({
      canSiteAdmin: true,
      userEmail: 'admin@example.com',
      autoRestore: { enabled: true },
    });
    renderPanel();

    await user.click(screen.getByTestId('display-auto-restore-toggle'));

    expect(setAutoRestore).toHaveBeenCalledTimes(1);
    expect(setAutoRestore).toHaveBeenCalledWith(false, 'admin@example.com');
  });

  it('toggle is disabled when no assigned layout exists', () => {
    setup({ canSiteAdmin: true, hasAssignedLayout: false });
    renderPanel();
    const toggle = screen.getByTestId('display-auto-restore-toggle');
    // Radix Switch surfaces disabled via both the data-disabled attr and the
    // underlying button's disabled DOM prop — assert on the prop directly so
    // we're testing the actual user-facing state, not implementation detail.
    expect(toggle).toBeDisabled();
  });

  it('toggle is disabled when nvidia mosaic is active', () => {
    setup({ canSiteAdmin: true, hasAssignedLayout: true, mosaicActive: true });
    renderPanel();
    expect(screen.getByTestId('display-auto-restore-toggle')).toBeDisabled();
  });

  it('toggle is disabled when remote display apply is off', () => {
    setup({ canSiteAdmin: true, hasAssignedLayout: true, remoteApplyEnabled: false });
    renderPanel();
    expect(screen.getByTestId('display-auto-restore-toggle')).toBeDisabled();
  });

  it('renders an enable action when remote display apply is off', async () => {
    const user = userEvent.setup();
    const { setRemoteApplyEnabled } = setup({
      canSiteAdmin: true,
      hasAssignedLayout: true,
      remoteApplyEnabled: false,
    });
    renderPanel();

    await user.click(screen.getByTestId('display-enable-remote-apply-button'));
    const dialog = screen.getByRole('dialog', {
      name: /enable restore/i,
    });
    expect(dialog).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /^enable restore$/i }));

    expect(setRemoteApplyEnabled).toHaveBeenCalledWith(true);
  });

  it('renders the admin breaker banner with a reset button when tripped + canSiteAdmin', () => {
    setup({
      canSiteAdmin: true,
      autoRestore: {
        enabled: true,
        circuitBreaker: {
          tripped: true,
          failures: 3,
          lastError: 'monitor disconnected',
        },
      },
    });
    renderPanel();

    expect(screen.getByTestId('display-auto-restore-breaker-banner')).toBeInTheDocument();
    expect(screen.getByTestId('display-auto-restore-reset-button')).toBeInTheDocument();
    // The banner copy carries the agent's last-error string so an admin can
    // diagnose without opening the events tab.
    expect(screen.getByText(/monitor disconnected/)).toBeInTheDocument();
    expect(
      screen.queryByTestId('display-auto-restore-breaker-readonly'),
    ).not.toBeInTheDocument();
  });

  it('renders the read-only breaker banner when tripped + not canSiteAdmin', () => {
    setup({
      canSiteAdmin: false,
      autoRestore: {
        enabled: true,
        circuitBreaker: {
          tripped: true,
          failures: 3,
          lastError: 'apply timeout',
        },
      },
    });
    renderPanel();

    expect(screen.getByTestId('display-auto-restore-breaker-readonly')).toBeInTheDocument();
    expect(
      screen.queryByTestId('display-auto-restore-breaker-banner'),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId('display-auto-restore-reset-button')).not.toBeInTheDocument();
    expect(screen.getByText(/apply timeout/)).toBeInTheDocument();
  });

  it('renders no breaker banner when the breaker is not tripped', () => {
    setup({
      canSiteAdmin: true,
      autoRestore: {
        enabled: true,
        circuitBreaker: { tripped: false, failures: 0 },
      },
    });
    renderPanel();

    expect(
      screen.queryByTestId('display-auto-restore-breaker-banner'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('display-auto-restore-breaker-readonly'),
    ).not.toBeInTheDocument();
  });

  it('reset button calls resetAutoRestoreBreaker', async () => {
    const user = userEvent.setup();
    const { resetAutoRestoreBreaker } = setup({
      canSiteAdmin: true,
      autoRestore: {
        enabled: true,
        circuitBreaker: {
          tripped: true,
          failures: 3,
          lastError: 'monitor disconnected',
        },
      },
    });
    renderPanel();

    await user.click(screen.getByTestId('display-auto-restore-reset-button'));

    expect(resetAutoRestoreBreaker).toHaveBeenCalledTimes(1);
  });
});

describe('DisplayLayoutPanel — drift dot persistence', () => {
  // Repro for "does the orange drift dot dismiss itself when the user clicks
  // the 'stored' pill?" The dot is purely derived from
  // `mode !== 'edit' && hasDrift` — clicking the pill only flips `activeTab`,
  // so the dot must survive the click. If a future refactor accidentally
  // ties the dot to `activeTab` or to a "seen" flag, this test catches it.
  it('keeps the drift dot on the "stored" pill after clicking it', async () => {
    const user = userEvent.setup();

    setup({ canSiteAdmin: true });
    // Override useDisplayState with a profile/assigned pair that drifts on
    // position. Same edidHash so the monitor matches; different x so
    // computeDisplayDrift records a per-field drift entry.
    mockedUseDisplayState.mockReturnValue({
      profile: makeProfile({
        monitors: [makeMonitor({ position: { x: 100, y: 0 } })],
      }),
      assigned: makeAssigned({
        monitors: [makeMonitor({ position: { x: 0, y: 0 } })],
      }),
      autoRestore: makeAutoRestore(),
      remoteApplyEnabled: true,
      loading: false,
      error: null,
    });

    renderPanel();

    // The badge-bearing pill carries an aria-label with the drift count.
    // No badge -> aria-label is just "stored". So this query is a strict
    // proxy for "dot is rendered".
    const storedButton = screen.getByRole('button', {
      name: /stored, \d+ display change/,
    });
    expect(storedButton).toBeInTheDocument();

    await user.click(storedButton);

    expect(
      screen.getByRole('button', { name: /stored, \d+ display change/ }),
    ).toBeInTheDocument();
  });
});
