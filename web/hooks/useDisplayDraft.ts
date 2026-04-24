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
import type { AssignedLayout, MonitorInfo } from '@/hooks/useDisplayState';

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
  if (mode !== prevMode) {
    setPrevMode(mode);
    if (mode === 'edit') {
      const restored = readFromSession(storageKey(siteId, machineId));
      if (restored) {
        setDraft(restored);
      } else {
        const source = assigned?.monitors;
        setDraft(source ? deepClone(source) : null);
      }
    } else {
      setDraft(null);
    }
  }

  const assignedMonitors = assigned?.monitors;
  const isDirty = useMemo(() => {
    if (!draft) return false;
    const baseline = assignedMonitors ?? [];
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
        let changed = false;
        const next = prev.map((m) => {
          if (m.id !== id) return m;
          changed = true;
          const merged: MonitorInfo = { ...m, ...partial };
          if (partial.position) {
            merged.position = { ...m.position, ...partial.position };
          }
          if (partial.resolution) {
            merged.resolution = { ...m.resolution, ...partial.resolution };
          }
          return merged;
        });
        return changed ? next : prev;
      });
    },
    [],
  );

  const resetToAssigned = useCallback((): void => {
    const source = assignedRef.current?.monitors;
    setDraft(source ? deepClone(source) : null);
  }, []);

  const resetToLive = useCallback((liveMonitors: MonitorInfo[]): void => {
    setDraft(deepClone(liveMonitors));
  }, []);

  const clearDraft = useCallback((): void => {
    setDraft(null);
    deleteFromSession(storageKey(siteId, machineId));
  }, [siteId, machineId]);

  return {
    draft,
    isDirty,
    updateMonitor,
    resetToAssigned,
    resetToLive,
    clearDraft,
  };
}
