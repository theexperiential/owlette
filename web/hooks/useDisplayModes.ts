'use client';

/**
 * useDisplayModes — per-monitor catalogue of supported display modes.
 *
 * Subscribes to `sites/{siteId}/machines/{machineId}/hardware/displayModes` and
 * exposes the cached catalogue alongside a `requestEnumerate` dispatcher that
 * asks the agent to (re-)build it. The catalogue feeds the resolution +
 * refresh-rate dropdowns in the display editor (Wave A3.4).
 *
 * Auto-trigger behaviour: when the caller passes `triggerForHash` (typically
 * the current live-profile `signatureHash`) and `enabled: true`, the hook
 * fires `enumerateDisplayModes` exactly once per (site, machine, hash) tuple
 * per tab lifetime — so entering the editor with a stale or missing cache
 * kicks a fresh enumeration, and re-entering with an up-to-date cache is a
 * pure read. Callers can also fire manually via `requestEnumerate()`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useDisplayActions } from '@/hooks/useDisplayActions';

export interface DisplayModeEntry {
  /** Pixel width of the mode. */
  w: number;
  /** Pixel height of the mode. */
  h: number;
  /** Refresh rate in hertz. */
  hz: number;
}

export interface DisplayModesEntry {
  /**
   * Supported `{w, h, hz}` triples for this monitor, already filtered and
   * sorted descending by the agent (see agent-side `_enum_modes_for_monitor`).
   */
  modes: DisplayModeEntry[];
  /**
   * Supported DPI scale percentages for this monitor, as integer percents
   * (e.g. [100, 125, 150, 175, 200]). Sourced from the agent's static
   * `_DPI_SCALE_TABLE` — per-monitor valid-scale enumeration is an A3.x
   * follow-up.
   */
  dpiScales: number[];
}

export interface DisplayModesCatalogue {
  /** Catalogue schema version (currently 1). */
  schemaVersion: number;
  /**
   * Topology hash at the time the catalogue was built. Used by the auto-
   * trigger logic to detect staleness — compare against the live display
   * profile's hash.
   */
  signatureHash: string;
  /** Unix seconds at which the catalogue was captured on the agent. */
  capturedAt: number;
  /** Per-monitor modes keyed by the monitor's edidHash. */
  byEdidHash: Record<string, DisplayModesEntry>;
}

export interface UseDisplayModesResult {
  /** Current catalogue, or null if no doc exists yet / still loading. */
  catalogue: DisplayModesCatalogue | null;
  /**
   * True while the subscription is waiting for its first snapshot. Resets
   * when (siteId, machineId) change.
   */
  loading: boolean;
  /** Any error from the Firestore subscription; null while healthy. */
  error: string | null;
  /**
   * Manually dispatch an `enumerate_display_modes` command. Callers rarely
   * need this — the hook's auto-trigger covers the common case — but it's
   * exposed for a "refresh catalogue" affordance in the UI.
   */
  requestEnumerate: () => Promise<string>;
}

export interface UseDisplayModesOptions {
  /**
   * When false, skip the subscription and return an inert result. Useful for
   * components that only need the catalogue in edit mode (e.g. the display
   * layout panel). Defaults to true.
   */
  enabled?: boolean;
  /**
   * When set, auto-fires `enumerateDisplayModes` if the subscribed catalogue's
   * `signatureHash` doesn't match this value — typically the current live
   * profile's hash. Dedup ensures the command never fires more than once per
   * (site, machine, hash) tuple per tab lifetime.
   */
  triggerForHash?: string | null;
}

interface InternalState {
  /**
   * Tag the state with the (site, machine) it belongs to so late snapshots
   * from a previous target can be ignored instead of leaking into the
   * current view. Same pattern as `useDisplayState`.
   */
  siteId: string;
  machineId: string;
  catalogue: DisplayModesCatalogue | null;
  loaded: boolean;
  error: string | null;
}

const INITIAL_STATE: InternalState = {
  siteId: '',
  machineId: '',
  catalogue: null,
  loaded: false,
  error: null,
};

/**
 * Parse a Firestore snapshot into a strongly-typed `DisplayModesCatalogue`.
 * Returns null when the doc doesn't exist or the payload is malformed — we'd
 * rather surface "no catalogue yet" than crash on a partial write.
 */
function parseCatalogue(data: unknown): DisplayModesCatalogue | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const schemaVersion = typeof d.schemaVersion === 'number' ? d.schemaVersion : null;
  const signatureHash = typeof d.signatureHash === 'string' ? d.signatureHash : null;
  const capturedAt = typeof d.capturedAt === 'number' ? d.capturedAt : null;
  const byEdidRaw = d.byEdidHash;
  if (schemaVersion === null || signatureHash === null || capturedAt === null) {
    return null;
  }
  if (!byEdidRaw || typeof byEdidRaw !== 'object') return null;
  const byEdidHash: Record<string, DisplayModesEntry> = {};
  for (const [edid, raw] of Object.entries(byEdidRaw as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const modes: DisplayModeEntry[] = Array.isArray(entry.modes)
      ? entry.modes
          .filter(
            (m): m is DisplayModeEntry =>
              !!m &&
              typeof m === 'object' &&
              typeof (m as DisplayModeEntry).w === 'number' &&
              typeof (m as DisplayModeEntry).h === 'number' &&
              typeof (m as DisplayModeEntry).hz === 'number',
          )
          .map((m) => ({ w: m.w, h: m.h, hz: m.hz }))
      : [];
    const dpiScales: number[] = Array.isArray(entry.dpiScales)
      ? entry.dpiScales.filter((n): n is number => typeof n === 'number')
      : [];
    byEdidHash[edid] = { modes, dpiScales };
  }
  return { schemaVersion, signatureHash, capturedAt, byEdidHash };
}

export function useDisplayModes(
  siteId: string,
  machineId: string,
  options: UseDisplayModesOptions = {},
): UseDisplayModesResult {
  const { enabled = true, triggerForHash } = options;
  const [state, setState] = useState<InternalState>(INITIAL_STATE);
  const actions = useDisplayActions(siteId, machineId);

  // Per-session dedup: record the hash we've dispatched for so re-mounts and
  // snapshot cascades don't fire redundant commands. A ref (not state) so
  // the assignment doesn't itself cause a re-render.
  const triggeredForHashRef = useRef<string | null>(null);
  // Track the last-seen target so we can reset the dedup when the caller
  // swaps to a different machine without unmounting the hook.
  const lastTargetRef = useRef<string>('');

  // Subscribe to the catalogue doc. Teardown on unmount or target change.
  useEffect(() => {
    if (!enabled || !db || !siteId || !machineId) {
      return;
    }

    // Target change: clear the dedup ref so a fresh machine gets a fresh
    // opportunity to trigger. Snapshot arrival will overwrite `loaded`.
    // State-reset for the new target is handled in the render-time derivation
    // below (see the `state.siteId !== siteId` guard) to avoid a setState
    // call outside a React event handler.
    const targetKey = `${siteId}:${machineId}`;
    if (lastTargetRef.current !== targetKey) {
      triggeredForHashRef.current = null;
      lastTargetRef.current = targetKey;
    }

    const ref = doc(
      db,
      'sites',
      siteId,
      'machines',
      machineId,
      'hardware',
      'displayModes',
    );
    const unsubscribe = onSnapshot(
      ref,
      (snap) => {
        const next = snap.exists() ? parseCatalogue(snap.data()) : null;
        // Stamp the snapshot with its target so a later render with a
        // different (siteId, machineId) can discard it via the derivation
        // guard. Unconditionally overwrite prev — stamping takes care of
        // identity across target switches.
        setState({
          siteId,
          machineId,
          catalogue: next,
          loaded: true,
          error: null,
        });
      },
      (err) => {
        console.error('Error subscribing to display modes catalogue:', err);
        setState({
          siteId,
          machineId,
          catalogue: null,
          loaded: true,
          error: err.message,
        });
      },
    );
    return unsubscribe;
  }, [siteId, machineId, enabled]);

  // Auto-trigger: fire the command when we have a triggerForHash that doesn't
  // match the cached catalogue. Gated on `loaded` so a missing doc triggers
  // AFTER the first snapshot confirms "no cache", not speculatively on mount.
  const enumerateDisplayModes = actions.enumerateDisplayModes;
  useEffect(() => {
    if (!enabled) return;
    if (!triggerForHash) return;
    if (!state.loaded) return;
    if (state.siteId !== siteId || state.machineId !== machineId) return;
    if (triggeredForHashRef.current === triggerForHash) return;
    if (state.catalogue?.signatureHash === triggerForHash) {
      // Catalogue already matches — record the dedup and move on without
      // dispatching. Future enters for the same hash become no-ops.
      triggeredForHashRef.current = triggerForHash;
      return;
    }
    triggeredForHashRef.current = triggerForHash;
    enumerateDisplayModes().catch((err) => {
      console.warn('Failed to dispatch enumerate_display_modes:', err);
      // Reset the dedup ref on failure so the next edit-mode entry can retry
      // rather than silently blocking on a transient dispatch error.
      if (triggeredForHashRef.current === triggerForHash) {
        triggeredForHashRef.current = null;
      }
    });
  }, [
    enabled,
    triggerForHash,
    state.loaded,
    state.catalogue?.signatureHash,
    state.siteId,
    state.machineId,
    siteId,
    machineId,
    enumerateDisplayModes,
  ]);

  // Manual trigger passed through to callers — wraps `actions.enumerateDisplayModes`
  // in a stable identity across renders so consumers can list it safely in
  // dependency arrays.
  const requestEnumerate = useCallback(async () => {
    return enumerateDisplayModes();
  }, [enumerateDisplayModes]);

  // Render-time derivation, matching useDisplayState's pattern.
  if (!enabled) {
    return {
      catalogue: null,
      loading: false,
      error: null,
      requestEnumerate,
    };
  }
  if (!db) {
    return {
      catalogue: null,
      loading: false,
      error: 'Firebase not configured',
      requestEnumerate,
    };
  }
  if (!siteId || !machineId) {
    return {
      catalogue: null,
      loading: false,
      error: null,
      requestEnumerate,
    };
  }
  // Target in flight — report loading rather than leaking prior-target data.
  if (state.siteId !== siteId || state.machineId !== machineId) {
    return {
      catalogue: null,
      loading: true,
      error: null,
      requestEnumerate,
    };
  }
  return {
    catalogue: state.catalogue,
    loading: !state.loaded,
    error: state.error,
    requestEnumerate,
  };
}
