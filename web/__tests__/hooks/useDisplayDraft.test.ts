/**
 * @jest-environment jsdom
 *
 * Unit tests for `useDisplayDraft` — the local draft buffer that powers
 * the assigned-tab editor. Exercises the invariants that matter for
 * correctness:
 *
 *   - Draft is null outside edit mode; seeded from assigned when edit
 *     mode opens.
 *   - Edits never mutate the `assigned` input (isolation).
 *   - Single-primary invariant: `updateMonitor({primary: true})` clears
 *     it on every other monitor.
 *   - Primary is pinned at (0, 0) — `updateMonitor` drops position
 *     updates targeting the primary, and `shiftSecondariesBy` only
 *     moves non-primary monitors.
 *   - `isDirty` reflects whether the draft has diverged from baseline.
 *   - `resetToAssigned` / `resetToLive` / `clearDraft` behave as their
 *     names suggest.
 *   - sessionStorage round-trip: edits persist across an unmount/mount
 *     within the same session, but stale drafts (edidHash set no longer
 *     matching assigned) are discarded in favour of a fresh clone.
 */

import { act, renderHook } from '@testing-library/react';

import { useDisplayDraft } from '@/hooks/useDisplayDraft';
import type { AssignedLayout, MonitorInfo } from '@/hooks/useDisplayState';

/**
 * Mount the hook the way the panel does: start in view mode, transition
 * to edit. The hook's draft is only seeded on a view -> edit *transition*,
 * not on mount, so tests that want an edited draft must go through this
 * same gateway.
 */
function renderDraftInEditMode(assigned: AssignedLayout) {
  return renderHook(
    ({ mode }: { mode: 'view' | 'edit' }) =>
      useDisplayDraft({ ...ARGS_BASE, assigned, mode }),
    { initialProps: { mode: 'view' as 'view' | 'edit' } },
  );
}

function monitor(overrides: Partial<MonitorInfo> = {}): MonitorInfo {
  return {
    id: 'm1',
    edidHash: 'aaaaaaaa',
    manufacturerId: 'DEL',
    productCode: '1',
    serialNumber: 's1',
    friendlyName: 'DELL 1',
    position: { x: 0, y: 0 },
    resolution: { width: 1920, height: 1080 },
    refreshHz: 60,
    rotation: 0,
    scalePct: 100,
    primary: true,
    connectionType: 'dp',
    adapterLuid: '0x0',
    targetId: 1,
    ...overrides,
  };
}

function assignedOf(monitors: MonitorInfo[]): AssignedLayout {
  return { monitors, capturedAt: 1_700_000_000_000 };
}

function twoMonitorAssigned(): AssignedLayout {
  return assignedOf([
    monitor({ id: 'm1', edidHash: 'aaaaaaaa', primary: true, position: { x: 0, y: 0 } }),
    monitor({
      id: 'm2',
      edidHash: 'bbbbbbbb',
      primary: false,
      position: { x: 1920, y: 0 },
    }),
  ]);
}

const ARGS_BASE = { siteId: 'site-a', machineId: 'machine-a' as const };

beforeEach(() => {
  window.sessionStorage.clear();
});

describe('useDisplayDraft — lifecycle', () => {
  it('holds no draft while in view mode', () => {
    const { result } = renderHook(() =>
      useDisplayDraft({
        ...ARGS_BASE,
        assigned: twoMonitorAssigned(),
        mode: 'view',
      }),
    );
    expect(result.current.draft).toBeNull();
    expect(result.current.isDirty).toBe(false);
  });

  it('seeds draft from assigned on view -> edit', () => {
    const assigned = twoMonitorAssigned();
    const { result, rerender } = renderHook(
      ({ mode }: { mode: 'view' | 'edit' }) =>
        useDisplayDraft({ ...ARGS_BASE, assigned, mode }),
      { initialProps: { mode: 'view' } },
    );
    expect(result.current.draft).toBeNull();
    rerender({ mode: 'edit' });
    expect(result.current.draft).toHaveLength(2);
    expect(result.current.draft?.[0].id).toBe('m1');
    expect(result.current.isDirty).toBe(false);
  });

  it('drops draft back to null on edit -> view', () => {
    const assigned = twoMonitorAssigned();
    const { result, rerender } = renderDraftInEditMode(assigned);
    rerender({ mode: 'edit' });
    expect(result.current.draft).not.toBeNull();
    rerender({ mode: 'view' });
    expect(result.current.draft).toBeNull();
  });
});

describe('useDisplayDraft — updateMonitor', () => {
  it('updates only the target monitor', () => {
    const assigned = twoMonitorAssigned();
    const { result, rerender } = renderDraftInEditMode(assigned);
    rerender({ mode: 'edit' });
    act(() => result.current.updateMonitor('m2', { rotation: 90 }));
    expect(result.current.draft?.[0].rotation).toBe(0);
    expect(result.current.draft?.[1].rotation).toBe(90);
  });

  it('does not mutate the input assigned layout', () => {
    const assigned = twoMonitorAssigned();
    const snapshot = JSON.parse(JSON.stringify(assigned));
    const { result, rerender } = renderDraftInEditMode(assigned);
    rerender({ mode: 'edit' });
    act(() => result.current.updateMonitor('m2', { position: { x: 100, y: 50 } }));
    expect(assigned).toEqual(snapshot);
  });

  it('setting primary=true clears primary on every other monitor (single-primary invariant)', () => {
    const assigned = twoMonitorAssigned();
    const { result, rerender } = renderDraftInEditMode(assigned);
    rerender({ mode: 'edit' });
    // m1 starts as primary; flip to m2.
    act(() => result.current.updateMonitor('m2', { primary: true }));
    const primaries = (result.current.draft ?? []).filter((m) => m.primary);
    expect(primaries).toHaveLength(1);
    expect(primaries[0].id).toBe('m2');
  });

  it('drops position updates on the primary monitor (Windows pins primary at origin)', () => {
    const assigned = twoMonitorAssigned();
    const { result, rerender } = renderDraftInEditMode(assigned);
    rerender({ mode: 'edit' });
    act(() => result.current.updateMonitor('m1', { position: { x: 500, y: 500 } }));
    expect(result.current.draft?.[0].position).toEqual({ x: 0, y: 0 });
  });

  it('re-normalizes positions to keep the new primary at (0, 0)', () => {
    // After making m2 (originally at 1920,0) the primary, every monitor
    // shifts so m2 lands at the origin.
    const assigned = twoMonitorAssigned();
    const { result, rerender } = renderDraftInEditMode(assigned);
    rerender({ mode: 'edit' });
    act(() => result.current.updateMonitor('m2', { primary: true }));
    const byId = new Map(result.current.draft?.map((m) => [m.id, m]));
    expect(byId.get('m2')?.position).toEqual({ x: 0, y: 0 });
    expect(byId.get('m1')?.position).toEqual({ x: -1920, y: 0 });
  });
});

describe('useDisplayDraft — shiftSecondariesBy', () => {
  it('translates non-primary monitors only', () => {
    const assigned = twoMonitorAssigned();
    const { result, rerender } = renderDraftInEditMode(assigned);
    rerender({ mode: 'edit' });
    act(() => result.current.shiftSecondariesBy(10, -5));
    const byId = new Map(result.current.draft?.map((m) => [m.id, m]));
    expect(byId.get('m1')?.position).toEqual({ x: 0, y: 0 });
    expect(byId.get('m2')?.position).toEqual({ x: 1930, y: -5 });
  });

  it('is a no-op when dx and dy are both zero', () => {
    const assigned = twoMonitorAssigned();
    const { result, rerender } = renderDraftInEditMode(assigned);
    rerender({ mode: 'edit' });
    const draftBefore = result.current.draft;
    act(() => result.current.shiftSecondariesBy(0, 0));
    // Identity equality proves the hook skipped the setState.
    expect(result.current.draft).toBe(draftBefore);
  });
});

describe('useDisplayDraft — isDirty', () => {
  it('is false when draft matches assigned', () => {
    const assigned = twoMonitorAssigned();
    const { result, rerender } = renderDraftInEditMode(assigned);
    rerender({ mode: 'edit' });
    expect(result.current.isDirty).toBe(false);
  });

  it('flips to true after an edit and back to false on reset', () => {
    const assigned = twoMonitorAssigned();
    const { result, rerender } = renderDraftInEditMode(assigned);
    rerender({ mode: 'edit' });
    act(() => result.current.updateMonitor('m2', { rotation: 180 }));
    expect(result.current.isDirty).toBe(true);
    act(() => result.current.resetToAssigned());
    expect(result.current.isDirty).toBe(false);
  });
});

describe('useDisplayDraft — reset + clear', () => {
  it('resetToLive replaces the draft with a fresh clone of the live list', () => {
    const assigned = twoMonitorAssigned();
    const { result, rerender } = renderDraftInEditMode(assigned);
    rerender({ mode: 'edit' });
    const live: MonitorInfo[] = [
      monitor({ id: 'mX', edidHash: 'xxxxxxxx', primary: true, position: { x: 0, y: 0 } }),
    ];
    act(() => result.current.resetToLive(live));
    expect(result.current.draft).toHaveLength(1);
    expect(result.current.draft?.[0].id).toBe('mX');
  });

  it('clearDraft nulls state and removes the sessionStorage entry', () => {
    const assigned = twoMonitorAssigned();
    const { result, rerender } = renderDraftInEditMode(assigned);
    rerender({ mode: 'edit' });
    act(() => result.current.updateMonitor('m2', { rotation: 90 }));
    const key = `displayDraft:${ARGS_BASE.siteId}:${ARGS_BASE.machineId}`;
    expect(window.sessionStorage.getItem(key)).not.toBeNull();
    act(() => result.current.clearDraft());
    expect(result.current.draft).toBeNull();
    expect(window.sessionStorage.getItem(key)).toBeNull();
  });
});

describe('useDisplayDraft — sessionStorage', () => {
  it('persists dirty draft edits under the per-(site, machine) key', () => {
    const assigned = twoMonitorAssigned();
    const { result, rerender } = renderDraftInEditMode(assigned);
    rerender({ mode: 'edit' });
    act(() => result.current.updateMonitor('m2', { rotation: 270 }));
    const key = `displayDraft:${ARGS_BASE.siteId}:${ARGS_BASE.machineId}`;
    const stored = JSON.parse(window.sessionStorage.getItem(key) ?? '[]');
    expect(stored).toHaveLength(2);
    expect(stored[1].rotation).toBe(270);
  });

  it('restores a matching draft from sessionStorage on re-entering edit mode', () => {
    const assigned = twoMonitorAssigned();
    // First session: enter edit, make an edit, exit edit mode.
    const { result, rerender } = renderDraftInEditMode(assigned);
    rerender({ mode: 'edit' });
    act(() => result.current.updateMonitor('m2', { rotation: 90 }));
    rerender({ mode: 'view' });
    expect(result.current.draft).toBeNull();
    // Re-enter edit mode; draft should hydrate from the stored entry.
    rerender({ mode: 'edit' });
    expect(result.current.draft?.[1].rotation).toBe(90);
  });

  it('discards a stored draft whose edidHash set no longer matches assigned', () => {
    const key = `displayDraft:${ARGS_BASE.siteId}:${ARGS_BASE.machineId}`;
    // Seed storage with a draft describing a monitor set that no longer
    // matches the current `assigned` — e.g. another admin saved a new layout
    // while the tab was closed.
    window.sessionStorage.setItem(
      key,
      JSON.stringify([
        monitor({ id: 'oldM', edidHash: 'zzzzzzzz', primary: true }),
      ]),
    );
    const assigned = twoMonitorAssigned();
    const { result, rerender } = renderDraftInEditMode(assigned);
    rerender({ mode: 'edit' });
    // Hook should have cloned assigned fresh, not resurrected the stale
    // single-monitor draft, and purged the stale entry.
    expect(result.current.draft).toHaveLength(2);
    expect(window.sessionStorage.getItem(key)).toBeNull();
  });
});
