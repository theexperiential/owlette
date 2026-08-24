'use client';

/**
 * Local draft state for editing a machine's display layout: an editable clone of
 * `assigned.monitors`, persisted to sessionStorage so a mid-edit reload doesn't lose work.
 * Seeded only on entering edit mode — changes to `assigned` while editing never clobber edits.
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
   * Translate every non-primary monitor by (dx, dy), primary stays pinned at (0, 0) — lets the
   * canvas offer primary-drag by shifting the world instead. Deltas must be INCREMENTAL
   * (frame-over-frame); each call compounds on the already-shifted state.
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
    // Drafts are best-effort.
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
 * Whether a sessionStorage-restored draft still applies: if another admin saved a different layout
 * or a monitor was swapped, the draft describes a topology that no longer exists. Keyed on edidHash
 * because monitor.id can change on reconnect even for an identical physical panel.
 */
function draftMatchesAssigned(
  draft: MonitorInfo[],
  assigned: MonitorInfo[] | undefined,
): boolean {
  if (!assigned) return false;
  if (draft.length !== assigned.length) return false;
  const draftHashes = new Set(draft.map((m) => m.edidHash).filter(Boolean));
  if (draftHashes.size !== draft.length) {
    // Monitors without edidHash (demo/legacy): fall back to id-set comparison.
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
  // State, not a ref: transition detection is a pure render derivation, and writing a ref during
  // render is unsafe.
  const [prevMode, setPrevMode] = useState<'view' | 'edit'>(mode);

  // Ref keeps callback identities stable while the derivation below reads the latest value.
  const assignedRef = useRef<AssignedLayout | null | undefined>(assigned);
  useEffect(() => {
    assignedRef.current = assigned;
  }, [assigned]);

  // Mode-transition seed. view→edit hydrates from sessionStorage or clones `assigned`; edit→view
  // drops the in-memory draft but keeps sessionStorage, so the caller decides via clearDraft.
  // setState-during-render short-circuits this render — no cascade, no extra effect.
  //
  // Both seed paths go through `normalizePrimaryToOrigin` so legacy non-canonical captures
  // self-heal the first time the editor opens. A restored draft only wins when its edidHash set
  // still matches `assigned`; stale drafts are deleted and the seed falls back to a fresh clone.
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
    // The draft is always normalized, so the baseline must be too — otherwise a legacy layout with
    // the primary at e.g. (0, −130) reports dirty before the operator types anything.
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
        // Windows pins the primary at (0, 0), so primary position updates are dropped — a moved
        // primary rect previews something the OS translates away on restore. The canvas drag goes
        // through `shiftSecondariesBy` instead.
        //
        // The key must be OMITTED, not set to undefined: spreading `{ position: undefined }`
        // nulls the real position and crashes `normalizePrimaryToOrigin` on `.x`.
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
        // Single-primary invariant. Only fires on true, so no zero-primary state is reachable —
        // the UI's primary picker has no toggle-off.
        if (scrubbedPartial.primary === true) {
          next = next.map((m) =>
            m.id === id ? m : { ...m, primary: false },
          );
        }
        // Re-pin the primary to (0, 0); covers a new primary that had a non-zero position.
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
