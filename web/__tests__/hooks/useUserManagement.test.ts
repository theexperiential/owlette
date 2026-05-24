/**
 * @jest-environment jsdom
 *
 * Unit tests for `useUserManagement` — the realtime user list, soft-delete
 * flagging, and role counts that exclude deleted users. (Last-seen/activity
 * is fetched page-side in app/admin/users, not by this shared hook.)
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
});

describe('useUserManagement — soft delete', () => {
  it('flags a doc with deletedAt and leaves an active doc unflagged', async () => {
    snapshotDocs = [
      activeDoc('u-active', 'member'),
      deletedDoc('u-deleted', 'admin', 1700000000000),
    ];

    const { result } = renderHook(() => useUserManagement());
    await waitFor(() => expect(result.current.users).toHaveLength(2));

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

    const { result } = renderHook(() => useUserManagement());
    await waitFor(() => expect(result.current.users).toHaveLength(5));

    const counts = result.current.getUserCounts();
    expect(counts.total).toBe(3);
    expect(counts.superadmins).toBe(1);
    expect(counts.admins).toBe(1);
    expect(counts.members).toBe(1);
    expect(counts.deleted).toBe(2);
  });
});
