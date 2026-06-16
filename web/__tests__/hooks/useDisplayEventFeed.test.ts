/**
 * @jest-environment jsdom
 *
 * Unit tests for `useDisplayEventFeed`. Guards the two regressions the events
 * tab has been bitten by:
 *   1. a query with no `orderBy('timestamp')` (Firestore then returns docs in
 *      random UUID document-ID order, so the limit slices a time-agnostic
 *      subset and recent events vanish); and
 *   2. over-fetching all logs + filtering `display_*` client-side, which lets a
 *      burst of unrelated logs push recent display events out of the window.
 * The fix filters by action server-side and orders by timestamp — asserted here.
 */
import { renderHook, waitFor } from '@testing-library/react';

// Override the global `{ db: null }` mock — the hook early-returns on null db.
jest.mock('@/lib/firebase', () => ({ db: {} }));
// Force the non-demo path so the Firestore subscription actually runs.
jest.mock('@/contexts/DemoContext', () => ({ useDemoContext: () => false }));

// Inert query builders; onSnapshot synchronously emits a fake `{ docs }` snap.
let snapshotDocs: Array<{ id: string; data: () => Record<string, unknown> }> = [];
const unsubscribe = jest.fn();

jest.mock('firebase/firestore', () => ({
  collection: jest.fn(() => ({})),
  query: jest.fn(() => ({})),
  where: jest.fn(() => ({})),
  orderBy: jest.fn(() => ({})),
  limit: jest.fn(() => ({})),
  onSnapshot: jest.fn(
    (_q: unknown, onNext: (snap: { docs: unknown[] }) => void) => {
      onNext({ docs: snapshotDocs });
      return unsubscribe;
    }
  ),
}));

import { useDisplayEventFeed, DISPLAY_EVENT_ACTIONS } from '@/hooks/useDisplayEventFeed';
import { where, orderBy, onSnapshot } from 'firebase/firestore';

const doc = (id: string, data: Record<string, unknown>) => ({ id, data: () => data });

beforeEach(() => {
  snapshotDocs = [];
  unsubscribe.mockClear();
  jest.mocked(where).mockClear();
  jest.mocked(orderBy).mockClear();
  jest.mocked(onSnapshot).mockClear();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('useDisplayEventFeed — query shape', () => {
  it('filters by machineId + display actions server-side and orders by timestamp desc', async () => {
    snapshotDocs = [doc('a', { action: 'display_monitor_removed', timestamp: 1, machineId: 'm1' })];

    const { result } = renderHook(() => useDisplayEventFeed('site1', 'm1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(where).toHaveBeenCalledWith('machineId', '==', 'm1');
    expect(where).toHaveBeenCalledWith('action', 'in', [...DISPLAY_EVENT_ACTIONS]);
    // The regression guard: the ordering must be present and descending.
    expect(orderBy).toHaveBeenCalledWith('timestamp', 'desc');
  });
});

describe('useDisplayEventFeed — mapping', () => {
  it('maps snapshot docs to events newest-first', async () => {
    snapshotDocs = [
      doc('old', { action: 'display_monitor_added', timestamp: 1000, machineId: 'm1', level: 'info' }),
      doc('new', { action: 'display_monitor_removed', timestamp: 5000, machineId: 'm1', level: 'critical' }),
    ];

    const { result } = renderHook(() => useDisplayEventFeed('site1', 'm1'));
    await waitFor(() => expect(result.current.events).toHaveLength(2));

    expect(result.current.events[0].id).toBe('new');
    expect(result.current.events[0].action).toBe('display_monitor_removed');
    expect(result.current.events[0].level).toBe('critical');
    expect(result.current.events[1].id).toBe('old');
  });
});

describe('useDisplayEventFeed — disabled', () => {
  it('does not subscribe when enabled is false', () => {
    renderHook(() => useDisplayEventFeed('site1', 'm1', { enabled: false }));
    expect(onSnapshot).not.toHaveBeenCalled();
  });
});

describe('DISPLAY_EVENT_ACTIONS — invariants', () => {
  it('stays within the Firestore `in` limit and has no duplicates', () => {
    // Firestore caps `in` at 30 values; a regression past that throws at query
    // time. Duplicates would silently waste a slot.
    expect(DISPLAY_EVENT_ACTIONS.length).toBeLessThanOrEqual(30);
    expect(new Set(DISPLAY_EVENT_ACTIONS).size).toBe(DISPLAY_EVENT_ACTIONS.length);
    // Every entry must be a display_* action (the contract with the agent).
    for (const action of DISPLAY_EVENT_ACTIONS) {
      expect(action.startsWith('display_')).toBe(true);
    }
  });
});
