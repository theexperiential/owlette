'use client';

/**
 * useDisplayDraft — local draft state for editing a machine's display layout.
 *
 * Holds an editable clone of `assigned.monitors` while the panel is in edit
 * mode, persists dirty drafts to sessionStorage so a mid-edit reload doesn't
 * lose work, and exposes a small API for partial monitor updates + explicit
 * reset/discard. The draft is only auto-seeded on entering edit mode —
 * changes to `assigned` while editing do NOT clobber in-flight edits.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  normalizePrimaryToOrigin,
  type AssignedLayout,
  type MonitorInfo,
} from '@/hooks/useDisplayState';

export interface UseDisplayDraftArgs {
  siteId: string;
  machineId: string;
  assigned: AssignedLayout | null | undefined;
  mode: 'view' | 'edit';
}

export interface UseDisplayDraftResult {
  draft: MonitorInfo[] | null;
  isDirty: boolean;
  updateMonitor: (id: string, partial: Partial<MonitorInfo>) => void;
  /**
   * Translate every non-primary monitor by (dx, dy) while the primary stays
   * pinned at (0, 0). Exists so the canvas can offer primary-drag UX: the
   * user visually drags the primary rect, but the data model shifts the
   * world around it instead. Pass incremental (frame-over-frame) deltas —
   * `updateMonitor` cannot absorb an absolute primary-position update
   * because each call compounds the shift on top of the already-shifted
   * state.
   */
  shiftSecondariesBy: (dx: number, dy: number) => void;
  resetToAssigned: () => void;
  resetToLive: (liveMonitors: MonitorInfo[]) => void;
  clearDraft: () => void;
}

function storageKey(siteId: string, machineId: string): string {
  return `displayDraft:${siteId}:${machineId}`;
}

function deepClone<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function isMonitorArray(value: unknown): value is MonitorInfo[] {
  if (!Array.isArray(value)) return false;
  return value.every((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const m = entry as Partial<MonitorInfo>;
    return (
      typeof m.id === 'string' &&
      !!m.position &&
      typeof m.position.x === 'number' &&
      typeof m.position.y === 'number' &&
      !!m.resolution &&
      typeof m.resolution.width === 'number' &&
      typeof m.resolution.height === 'number'
    );
  });
}

function readFromSession(key: string): MonitorInfo[] | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!isMonitorArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeToSession(key: string, value: MonitorInfo[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota or serialization failure — drafts are best-effort; swallow.
  }
}

function deleteFromSession(key: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // ignore
  }
}

/**
 * True when the draft's physical identity set still matches the current
 * assigned layout. Used to decide whether a sessionStorage-restored draft
 * is still applicable: if another admin saved a different layout while the
 * tab was closed, or a monitor was swapped out, the draft now describes a
 * topology that no longer exists and must be discarded. Edid hash is the
 * right key — monitor.id can change on reconnect even when the physical
 * panel is identical.
 */
function draftMatchesAssigned(
  draft: MonitorInfo[],
  assigned: MonitorInfo[] | undefined,
): boolean {
  if (!assigned) return false;
  if (draft.length !== assigned.length) return false;
  const draftHashes = new Set(draft.map((m) => m.edidHash).filter(Boolean));
  if (draftHashes.size !== draft.length) {
    // Draft contains monitors without edidHash (demo / legacy). Fall back
    // to id-set comparison; if those also disagree, treat as stale.
    const draftIds = new Set(draft.map((m) => m.id));
    const assignedIds = new Set(assigned.map((m) => m.id));
    if (draftIds.size !== assignedIds.size) return false;
    for (const id of draftIds) if (!assignedIds.has(id)) return false;
    return true;
  }
  for (const m of assigned) {
    if (!m.edidHash || !draftHashes.has(m.edidHash)) return false;
  }
  return true;
}

export function useDisplayDraft(args: UseDisplayDraftArgs): UseDisplayDraftResult {
  const { siteId, machineId, assigned, mode } = args;
  const [draft, setDraft] = useState<MonitorInfo[] | null>(null);
  // Track the previous mode as a state value (not a ref) so the transition
  // detection is a pure derivation during render. Using a ref here would
  // require writing to it during render, which React flags as unsafe.
  const [prevMode, setPrevMode] = useState<'view' | 'edit'>(mode);

  // Keep assigned in a ref so callback identities stay stable and the mode-
  // transition derivation below can read the latest without re-running.
  const assignedRef = useRef<AssignedLayout | null | undefined>(assigned);
  useEffect(() => {
    assignedRef.current = assigned;
  }, [assigned]);

  // Mode-transition seed: when mode flips view -> edit, hydrate the draft
  // from sessionStorage or clone from assigned. When mode flips edit -> view,
  // drop the in-memory draft (sessionStorage is preserved so the caller can
  // decide via clearDraft whether to commit or discard). React's "setState
  // during render" pattern short-circuits the current render — no cascading
  // render, no extra effect that would trigger a cascading-setState lint.
  //
  // Both seed paths run through `normalizePrimaryToOrigin` so any pre-existing
  // non-canonical data (legacy captures made before the capture-time guard
  // existed) self-heals the first time the user opens the editor.
  //
  // A sessionStorage-restored draft only wins when its edidHash set still
  // matches the current assigned layout. Otherwise the draft is stale —
  // another admin saved a different layout, or a monitor was swapped —
  // and restoring it would give the operator a form representing a
  // topology that no longer exists. Stale drafts are dropped from storage
  // and the seed falls back to a fresh clone of assigned.
  if (mode !== prevMode) {
    setPrevMode(mode);
    if (mode === 'edit') {
      const key = storageKey(siteId, machineId);
      const restored = readFromSession(key);
      if (restored && draftMatchesAssigned(restored, assigned?.monitors)) {
        setDraft(normalizePrimaryToOrigin(restored));
      } else {
        if (restored) deleteFromSession(key);
        const source = assigned?.monitors;
        setDraft(source ? normalizePrimaryToOrigin(deepClone(source)) : null);
      }
    } else {
      setDraft(null);
    }
  }

  const assignedMonitors = assigned?.monitors;
  const isDirty = useMemo(() => {
    if (!draft) return false;
    // The draft is always normalized (seeded through normalizePrimaryToOrigin
    // and maintained by updateMonitor / shiftSecondariesBy). The baseline
    // must be normalized on the same basis, otherwise a legacy assigned
    // layout with the primary at e.g. (0, −130) makes every freshly-opened
    // editor report dirty even before the operator types anything.
    const baseline = normalizePrimaryToOrigin(assignedMonitors ?? []);
    return JSON.stringify(draft) !== JSON.stringify(baseline);
  }, [draft, assignedMonitors]);

  useEffect(() => {
    if (mode !== 'edit') return;
    if (!draft) return;
    if (!isDirty) return;
    writeToSession(storageKey(siteId, machineId), draft);
  }, [mode, draft, isDirty, siteId, machineId]);

  const updateMonitor = useCallback(
    (id: string, partial: Partial<MonitorInfo>): void => {
      setDraft((prev) => {
        if (!prev) return prev;
        const target = prev.find((m) => m.id === id);
        if (!target) return prev;
        // Windows pins the primary monitor at (0, 0). Dropping position
        // updates on the primary keeps the draft canonical — moving the
        // primary rect would produce a preview the OS would translate away
        // on recall. The primary-drag canvas gesture goes through
        // `shiftSecondariesBy` instead so the operator still has a way to
        // visually reposition the primary.
        //
        // The key must be *omitted* from the partial (not set to undefined):
        // spreading `{ position: undefined }` into `merged` overwrites the
        // monitor's real position with undefined, which then crashes
        // `normalizePrimaryToOrigin` when it reaches for `.x`.
        let scrubbedPartial: Partial<MonitorInfo>;
        if (target.primary && partial.position) {
          scrubbedPartial = { ...partial };
          delete scrubbedPartial.position;
        } else {
          scrubbedPartial = partial;
        }
        let changed = false;
        let next = prev.map((m) => {
          if (m.id !== id) return m;
          changed = true;
          const merged: MonitorInfo = { ...m, ...scrubbedPartial };
          if (scrubbedPartial.position) {
            merged.position = { ...m.position, ...scrubbedPartial.position };
          }
          if (scrubbedPartial.resolution) {
            merged.resolution = { ...m.resolution, ...scrubbedPartial.resolution };
          }
          return merged;
        });
        if (!changed) return prev;
        // Single-primary invariant: setting primary=true on one clears it on
        // every other. Zero-primary states are disallowed by only firing on
        // true; toggles off aren't supported by the primary picker in the UI.
        if (scrubbedPartial.primary === true) {
          next = next.map((m) =>
            m.id === id ? m : { ...m, primary: false },
          );
        }
        // Primary-origin normalization: after any change, translate all
        // monitors so the primary lands at (0, 0). Handles the primary-change
        // case where the new primary had a non-zero position.
        return normalizePrimaryToOrigin(next);
      });
    },
    [],
  );

  const shiftSecondariesBy = useCallback((dx: number, dy: number): void => {
    if (dx === 0 && dy === 0) return;
    setDraft((prev) => {
      if (!prev) return prev;
      return prev.map((m) =>
        m.primary
          ? m
          : { ...m, position: { x: m.position.x + dx, y: m.position.y + dy } },
      );
    });
  }, []);

  const resetToAssigned = useCallback((): void => {
    const source = assignedRef.current?.monitors;
    setDraft(source ? normalizePrimaryToOrigin(deepClone(source)) : null);
  }, []);

  const resetToLive = useCallback((liveMonitors: MonitorInfo[]): void => {
    setDraft(normalizePrimaryToOrigin(deepClone(liveMonitors)));
  }, []);

  const clearDraft = useCallback((): void => {
    setDraft(null);
    deleteFromSession(storageKey(siteId, machineId));
  }, [siteId, machineId]);

  return {
    draft,
    isDirty,
    updateMonitor,
    shiftSecondariesBy,
    resetToAssigned,
    resetToLive,
    clearDraft,
  };
}
