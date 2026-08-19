/**
 * @jest-environment jsdom
 *
 * Regression tests for the client-side heartbeat staleness override in
 * `useMachines`.
 *
 * Incident (2026-08-13 ~14:17): an agent service was stopped without flushing
 * `online: false`, so the machine doc stayed `online: true` with a frozen
 * `lastHeartbeat`. The dashboard kept rendering the machine as ONLINE well past
 * the 300s staleness threshold (observed at a heartbeat age of 374s).
 *
 * The two paths that must both call it offline with no Firestore write:
 *   1. the snapshot parse (dashboard opened while the doc is already stale), and
 *   2. the periodic re-evaluation (dashboard already open when the agent dies).
 */
import { renderHook, act, waitFor } from '@testing-library/react';

// Override the global `{ db: null }` mock from jest.setup.js — the hook
// early-returns when db is null, which would skip the snapshot effect.
jest.mock('@/lib/firebase', () => ({ db: {} }));

type SnapshotDoc = { id: string; data: () => Record<string, unknown> };
type CollectionListener = (snap: {
  metadata: { fromCache: boolean };
  forEach: (cb: (doc: SnapshotDoc) => void) => void;
}) => void;

// Collection listeners registered by the hook, keyed by slash-joined path.
// `sites/<id>/machines` is the status listener; `config/<id>/machines` is the
// launch-mode/restart-schedule override listener.
const collectionListeners = new Map<string, CollectionListener>();
const unsubscribe = jest.fn();

jest.mock('firebase/firestore', () => ({
  Timestamp: class {},
  collection: jest.fn((_db: unknown, ...path: string[]) => ({
    __kind: 'collection' as const,
    __path: path.join('/'),
  })),
  doc: jest.fn((_db: unknown, ...path: string[]) => ({
    __kind: 'doc' as const,
    __path: path.join('/'),
  })),
  getDoc: jest.fn(async () => ({ exists: () => false })),
  onSnapshot: jest.fn((ref: { __kind: string; __path: string }, onNext: CollectionListener) => {
    // Per-machine hardware/profile doc listeners are supplementary — register
    // them so teardown works, but never emit (no profile in these fixtures).
    if (ref.__kind === 'collection') collectionListeners.set(ref.__path, onNext);
    return unsubscribe;
  }),
}));

import { useMachines } from '@/hooks/useFirestore';

const SITE_ID = 'site1';
const NOW_MS = 1_760_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);

/** Emit a machines-collection snapshot for the site under test. */
function emitMachines(
  docs: SnapshotDoc[],
  { fromCache = false }: { fromCache?: boolean } = {},
) {
  const listener = collectionListeners.get(`sites/${SITE_ID}/machines`);
  if (!listener) throw new Error('machines listener not registered');
  listener({
    metadata: { fromCache },
    forEach: (cb) => docs.forEach(cb),
  });
}

const machineDoc = (id: string, data: Record<string, unknown>): SnapshotDoc => ({
  id,
  data: () => data,
});

beforeEach(() => {
  collectionListeners.clear();
  unsubscribe.mockClear();
  jest.useFakeTimers();
  jest.setSystemTime(NOW_MS);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('useMachines — heartbeat staleness override', () => {
  it('computes a machine with online:true and a 374s-old heartbeat as OFFLINE on first snapshot', async () => {
    const { result } = renderHook(() => useMachines(SITE_ID));

    act(() => {
      emitMachines([
        machineDoc('kiosk-01', { online: true, lastHeartbeat: NOW_SEC - 374 }),
      ]);
    });

    await waitFor(() => expect(result.current.machines).toHaveLength(1));
    expect(result.current.machines[0].online).toBe(false);
  });

  it('flips a machine to OFFLINE on its own once the heartbeat ages past 300s, with no new snapshot', async () => {
    const { result } = renderHook(() => useMachines(SITE_ID));

    // Healthy machine at mount: heartbeat 10s old, agent alive.
    act(() => {
      emitMachines([
        machineDoc('kiosk-01', { online: true, lastHeartbeat: NOW_SEC - 10 }),
      ]);
    });

    await waitFor(() => expect(result.current.machines).toHaveLength(1));
    expect(result.current.machines[0].online).toBe(true);

    // Agent service is killed — no further Firestore writes, no new snapshots.
    // Wall clock advances to a heartbeat age of 374s (the observed incident age).
    await act(async () => {
      jest.advanceTimersByTime(364_000);
    });

    expect(result.current.machines[0].online).toBe(false);
  });

  it('recovers to ONLINE when the agent reports in with a fresh heartbeat', async () => {
    const { result } = renderHook(() => useMachines(SITE_ID));

    act(() => {
      emitMachines([
        machineDoc('kiosk-01', { online: true, lastHeartbeat: NOW_SEC - 374 }),
      ]);
    });

    await waitFor(() => expect(result.current.machines).toHaveLength(1));
    expect(result.current.machines[0].online).toBe(false);

    // Agent comes back — the staleness override must not latch the machine off.
    act(() => {
      emitMachines([
        machineDoc('kiosk-01', { online: true, lastHeartbeat: NOW_SEC - 5 }),
      ]);
    });

    await waitFor(() => expect(result.current.machines[0].online).toBe(true));
  });

  it('still calls a stale machine offline when the snapshot is served from cache', async () => {
    const { result } = renderHook(() => useMachines(SITE_ID));

    // A cache-served snapshot on remount: the heartbeat is genuinely 374s old,
    // so the machine must not be shown as online while we wait for the server.
    act(() => {
      emitMachines(
        [machineDoc('kiosk-01', { online: true, lastHeartbeat: NOW_SEC - 374 })],
        { fromCache: true },
      );
    });

    await waitFor(() => expect(result.current.machines).toHaveLength(1));
    expect(result.current.machines[0].online).toBe(false);
  });
});
