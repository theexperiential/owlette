/**
 * @jest-environment jsdom
 *
 * Unit tests for `useTrialBannerDismissal` (billing-system wave 3.1).
 *
 * The hook's whole contract is "not now" ≠ "never": a dismissal is persisted
 * to the account (Firestore, never localStorage) and expires after a week, so
 * an owner who waves the trial countdown away still hears about it again
 * before the clock runs out. The window boundary and the storage location are
 * both pinned below.
 */

import { act, renderHook, waitFor } from '@testing-library/react';

// Override the global `{ db: null }` mock from jest.setup.js — the hook
// early-returns when db is null, which would skip hydration entirely.
jest.mock('@/lib/firebase', () => ({ db: {} }));

let mockUid: string | null = 'uid-owner';
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: mockUid ? { uid: mockUid } : null }),
}));

const mockGetDoc = jest.fn();
const mockSetDoc = jest.fn();
const mockDoc = jest.fn((...segments: unknown[]) => ({ path: segments.slice(1).join('/') }));
jest.mock('firebase/firestore', () => ({
  doc: (...a: unknown[]) => mockDoc(...a),
  getDoc: (...a: unknown[]) => mockGetDoc(...a),
  setDoc: (...a: unknown[]) => mockSetDoc(...a),
}));

import {
  DISMISSAL_WINDOW_DAYS,
  TRIAL_BANNER_DISMISSED_FIELD,
  isDismissalActive,
  useTrialBannerDismissal,
} from '@/hooks/useTrialBannerDismissal';

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_MS = DISMISSAL_WINDOW_DAYS * DAY_MS;

/** Serve a `devicePrefs/global` doc carrying `data` (or no doc at all). */
function storedPrefs(data: Record<string, unknown> | null) {
  mockGetDoc.mockResolvedValue({ exists: () => data !== null, data: () => data ?? undefined });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUid = 'uid-owner';
  mockSetDoc.mockResolvedValue(undefined);
  storedPrefs(null);
});

describe('isDismissalActive', () => {
  const now = 1_800_000_000_000;

  it('holds for the full window and expires on the boundary', () => {
    expect(isDismissalActive(now, now)).toBe(true);
    expect(isDismissalActive(now - (WINDOW_MS - 1), now)).toBe(true);
    expect(isDismissalActive(now - WINDOW_MS, now)).toBe(false);
    expect(isDismissalActive(now - 30 * DAY_MS, now)).toBe(false);
  });

  it('ignores a future-dated or unreadable stamp', () => {
    // A clock-skewed write must not be able to hide the banner indefinitely.
    expect(isDismissalActive(now + DAY_MS, now)).toBe(false);
    expect(isDismissalActive(Number.NaN, now)).toBe(false);
    expect(isDismissalActive('yesterday', now)).toBe(false);
    expect(isDismissalActive(undefined, now)).toBe(false);
  });
});

describe('useTrialBannerDismissal', () => {
  it('reports no dismissal when the prefs doc does not exist', async () => {
    const { result } = renderHook(() => useTrialBannerDismissal());

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.dismissed).toBe(false);
  });

  it('reads the dismissal from the shared per-user prefs doc', async () => {
    storedPrefs({ [TRIAL_BANNER_DISMISSED_FIELD]: Date.now() - DAY_MS });

    const { result } = renderHook(() => useTrialBannerDismissal());

    await waitFor(() => expect(result.current.dismissed).toBe(true));
    // Same document the sidebar and device prefs use — one doc per account.
    expect(mockDoc).toHaveBeenCalledWith({}, 'users', 'uid-owner', 'devicePrefs', 'global');
  });

  it('lets the banner return once the window has passed', async () => {
    storedPrefs({ [TRIAL_BANNER_DISMISSED_FIELD]: Date.now() - (WINDOW_MS + DAY_MS) });

    const { result } = renderHook(() => useTrialBannerDismissal());

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.dismissed).toBe(false);
  });

  it('persists the dismissal instant by merge, not by overwrite', async () => {
    const { result } = renderHook(() => useTrialBannerDismissal());
    await waitFor(() => expect(result.current.ready).toBe(true));

    const before = Date.now();
    act(() => result.current.dismiss());

    expect(result.current.dismissed).toBe(true);
    expect(mockSetDoc).toHaveBeenCalledTimes(1);
    const [, payload, options] = mockSetDoc.mock.calls[0];
    // Merge matters: this doc also holds the sidebar and device-picker prefs.
    expect(options).toEqual({ merge: true });
    expect(payload[TRIAL_BANNER_DISMISSED_FIELD]).toBeGreaterThanOrEqual(before);
  });

  it('shows the banner rather than hiding it when the prefs read fails', async () => {
    mockGetDoc.mockRejectedValue(new Error('permission-denied'));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    const { result } = renderHook(() => useTrialBannerDismissal());

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.dismissed).toBe(false);
    consoleError.mockRestore();
  });

  it('reads nothing when signed out', async () => {
    mockUid = null;

    const { result } = renderHook(() => useTrialBannerDismissal());

    expect(result.current.ready).toBe(true);
    expect(result.current.dismissed).toBe(false);
    expect(mockGetDoc).not.toHaveBeenCalled();
  });
});
