/**
 * @jest-environment jsdom
 *
 * Regression tests for the heartbeat staleness override in `useMachines`.
 *
 * Incident 2026-08-13: a stopped agent never flushed `online: false`, leaving
 * the doc `online: true` with a frozen `lastHeartbeat`, and the dashboard kept
 * rendering ONLINE past the 300s threshold (observed at 374s).
 *
 * Both paths must call it offline with no Firestore write: the snapshot parse
 * (opened while already stale) and the periodic re-evaluation (open when the
 * agent dies).
 */
import { renderHook, act, waitFor } from '@testing-library/react';

// Override jest.setup.js's `{ db: null }` — the hook early-returns on null db
// and would skip the snapshot effect.
jest.mock('@/lib/firebase', () => ({ db: {} }));

type SnapshotDoc = { id: string; data: () => Record<string, unknown> };
type CollectionListener = (snap: {
  metadata: { fromCache: boolean };
  forEach: (cb: (doc: SnapshotDoc) => void) => void;
}) => void;

// Hook listeners keyed by slash-joined path: `sites/<id>/machines` is status,
// `config/<id>/machines` is the launch-mode/restart-schedule override.
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
    // Register per-machine profile doc listeners so teardown works, but never
    // emit — these fixtures have no profile.
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

    // Healthy at mount: heartbeat 10s old.
    act(() => {
      emitMachines([
        machineDoc('kiosk-01', { online: true, lastHeartbeat: NOW_SEC - 10 }),
      ]);
    });

    await waitFor(() => expect(result.current.machines).toHaveLength(1));
    expect(result.current.machines[0].online).toBe(true);

    // Agent killed: no writes, no snapshots. Clock advances to the incident's
    // observed heartbeat age of 374s.
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

    // The staleness override must not latch the machine off.
    act(() => {
      emitMachines([
        machineDoc('kiosk-01', { online: true, lastHeartbeat: NOW_SEC - 5 }),
      ]);
    });

    await waitFor(() => expect(result.current.machines[0].online).toBe(true));
  });

  it('still calls a stale machine offline when the snapshot is served from cache', async () => {
    const { result } = renderHook(() => useMachines(SITE_ID));

    // Cache-served on remount, heartbeat genuinely 374s old — must not read as
    // online while waiting for the server.
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
