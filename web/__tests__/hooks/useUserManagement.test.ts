/**
 * @jest-environment jsdom
 *
 * Unit tests for `useUserManagement` — the realtime user list, soft-delete
 * flagging, role counts that exclude deleted users, and the non-fatal
 * `/api/users/activity` merge.
 */
import { renderHook, waitFor } from '@testing-library/react';

// Override the global `{ db: null }` mock from jest.setup.js — the hook
// early-returns when db is null, which would skip the snapshot effect.
jest.mock('@/lib/firebase', () => ({ db: {} }));

// Inert query builders; onSnapshot synchronously emits a fake snapshot.
let snapshotDocs: Array<{ id: string; data: () => Record<string, unknown> }> = [];
const unsubscribe = jest.fn();

jest.mock('firebase/firestore', () => ({
  collection: jest.fn(() => ({})),
  query: jest.fn(() => ({})),
  orderBy: jest.fn(() => ({})),
  onSnapshot: jest.fn(
    (_q: unknown, onNext: (snap: { forEach: (cb: (doc: unknown) => void) => void }) => void) => {
      onNext({
        forEach: (cb: (doc: unknown) => void) => snapshotDocs.forEach(cb),
      });
      return unsubscribe;
    }
  ),
}));

import { useUserManagement } from '@/hooks/useUserManagement';

const activeDoc = (uid: string, role: string) => ({
  id: uid,
  data: () => ({ email: `${uid}@example.com`, role }),
});

const deletedDoc = (uid: string, role: string, deletedAt: number) => ({
  id: uid,
  data: () => ({ email: `${uid}@example.com`, role, deletedAt, deletedBy: 'admin-1' }),
});

beforeEach(() => {
  snapshotDocs = [];
  unsubscribe.mockClear();
});

afterEach(() => {
  jest.restoreAllMocks();
  delete (global as { fetch?: unknown }).fetch;
});

describe('useUserManagement — soft delete', () => {
  it('flags a doc with deletedAt and leaves an active doc unflagged', async () => {
    snapshotDocs = [
      activeDoc('u-active', 'member'),
      deletedDoc('u-deleted', 'admin', 1700000000000),
    ];
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ activity: {} }) });

    const { result } = renderHook(() => useUserManagement());
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());

    const active = result.current.users.find((u) => u.uid === 'u-active');
    const deleted = result.current.users.find((u) => u.uid === 'u-deleted');
    expect(active?.deletedAt).toBeUndefined();
    expect(deleted?.deletedAt).toBe(1700000000000);
    expect(deleted?.deletedBy).toBe('admin-1');
  });
});

describe('useUserManagement — getUserCounts', () => {
  it('excludes deleted users from total/role counts and reports deleted count', async () => {
    snapshotDocs = [
      activeDoc('u-sa', 'superadmin'),
      activeDoc('u-admin', 'admin'),
      activeDoc('u-member', 'member'),
      deletedDoc('u-del-1', 'member', 1700000000000),
      deletedDoc('u-del-2', 'admin', 1700000000001),
    ];
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ activity: {} }) });

    const { result } = renderHook(() => useUserManagement());
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());

    const counts = result.current.getUserCounts();
    expect(counts.total).toBe(3);
    expect(counts.superadmins).toBe(1);
    expect(counts.admins).toBe(1);
    expect(counts.members).toBe(1);
    expect(counts.deleted).toBe(2);
  });
});

describe('useUserManagement — activity', () => {
  it('populates activity from /api/users/activity merged by uid', async () => {
    snapshotDocs = [activeDoc('u-1', 'member'), activeDoc('u-2', 'admin')];
    const activityPayload = {
      'u-1': { lastSignInTime: '2026-05-01T00:00:00Z', lastRefreshTime: null, disabled: false },
      'u-2': { lastSignInTime: null, lastRefreshTime: '2026-05-02T00:00:00Z', disabled: true },
    };
    const fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ activity: activityPayload }) });
    global.fetch = fetchMock;

    const { result } = renderHook(() => useUserManagement());

    await waitFor(() => {
      expect(result.current.activity['u-1']).toBeDefined();
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/users/activity');
    expect(result.current.activity['u-1'].lastSignInTime).toBe('2026-05-01T00:00:00Z');
    expect(result.current.activity['u-2'].disabled).toBe(true);
  });

  it('leaves users intact and activity empty when the fetch fails (non-fatal)', async () => {
    snapshotDocs = [activeDoc('u-1', 'member')];
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    global.fetch = jest.fn().mockRejectedValue(new Error('network down'));

    const { result } = renderHook(() => useUserManagement());

    await waitFor(() => {
      expect(consoleSpy).toHaveBeenCalled();
    });
    expect(result.current.users).toHaveLength(1);
    expect(result.current.users[0].uid).toBe('u-1');
    expect(result.current.activity).toEqual({});
  });

  it('treats a non-ok response as non-fatal and keeps activity empty', async () => {
    snapshotDocs = [activeDoc('u-1', 'member')];
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });

    const { result } = renderHook(() => useUserManagement());

    await waitFor(() => {
      expect(consoleSpy).toHaveBeenCalled();
    });
    expect(result.current.users).toHaveLength(1);
    expect(result.current.activity).toEqual({});
  });
});
