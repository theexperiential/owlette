'use client';

/**
 * DisplayLayoutPanel Component
 *
 * Expanded panel for inspecting and (for admins) managing a machine's display
 * topology. Mirrors the chrome of MetricsDetailPanel (Card shell, title row,
 * controls row, body, stat-card grid) so the two feel like siblings in the
 * dashboard.
 *
 * Two tabs:
 *  - `live`: what the agent most recently reported (real-time via Firestore
 *    subscription in useDisplayState).
 *  - `assigned`: the admin-authored layout the agent is expected to maintain.
 *    When an assigned layout exists, the live tab overlays the assigned
 *    monitors as dashed "ghost" rectangles so drift is visually obvious.
 *
 * Action buttons (store / restore) are wired via useDisplayActions. Restore
 * is the single primary action — when drift is detected, its border turns
 * amber so the same button reads as "undo drift" in that context.
 *
 * Permission gating: store / restore are write operations and are hidden
 * entirely for non-admins (read-only view).
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { toast } from 'sonner';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { AlertTriangle, Loader2, Monitor, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import {
  useDisplayState,
  computeDisplayDrift,
  totalDriftCount,
  type MonitorInfo,
} from '@/hooks/useDisplayState';
import { useDisplayActions } from '@/hooks/useDisplayActions';
import {
  useAckBanner,
  startAckCountdown,
  clearAckCountdown,
  setAckInFlight,
} from '@/hooks/useAckBanner';
import { useDisplayDraft } from '@/hooks/useDisplayDraft';
import { useDisplayModes } from '@/hooks/useDisplayModes';
import {
  useDisplayEventFeed,
  type DisplayEventEntry,
} from '@/hooks/useDisplayEventFeed';
import { DisplayCanvas } from './DisplayCanvas';
import { DisplayMonitorTable } from './DisplayMonitorTable';
import { DisplayEditorDialog } from './DisplayEditorDialog';
import ConfirmDialog from '@/components/ConfirmDialog';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

interface DisplayLayoutPanelProps {
  machineId: string;
  machineName?: string;
  siteId: string;
  onClose: () => void;
}

type DisplayTab = 'live' | 'assigned' | 'events';

const DISPLAY_EVENT_LABEL: Record<string, string> = {
  display_monitor_removed: 'monitor removed',
  display_apply_failed: 'apply failed',
  display_auto_revert_fired: 'auto-reverted',
  display_sync_lost: 'sync lost',
  display_drift: 'drift',
  display_monitor_swapped: 'monitor swapped',
  display_mosaic_disabled: 'mosaic disabled',
  display_apply_refused_mosaic: 'apply refused (mosaic)',
  display_monitor_added: 'monitor added',
  display_apply_succeeded: 'apply succeeded',
  display_apply_acked: 'apply confirmed',
  display_revert_deferred: 'revert deferred',
  display_auto_restore_fired: 'auto-restored',
  display_auto_restore_skipped_unfixable: 'auto-restore skipped',
  display_auto_restore_circuit_breaker_tripped: 'auto-restore paused',
};

/**
 * Compact relative-time formatter for the events tab. Takes epoch ms and
 * returns "just now" / "Nm ago" / "Nh ago" / "Nd ago" for the last week,
 * or a "MMM D" date for older. The shared `formatRelativeTime` in
 * `lib/timeUtils.ts` takes seconds and never falls back to a date, so we
 * keep this one local.
 */
function formatEventRelativeTime(epochMs: number): string {
  if (!epochMs) return '—';
  const diffMs = Date.now() - epochMs;
  if (diffMs < 60_000) return 'just now';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(epochMs).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

/** Parse the JSON-serialized agent payload, returning {} on any failure. */
function parseEventDetails(details: string): Record<string, unknown> {
  if (!details) return {};
  try {
    const parsed = JSON.parse(details) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Pull the operator-friendly monitor name from a parsed event payload, when
 * the agent attached one. Shapes: `{monitor: {friendlyName}}` for per-monitor
 * events, falls back to `''` so the column renders an em-dash.
 */
function eventMonitorName(payload: Record<string, unknown>): string {
  const monitor = payload.monitor;
  if (monitor && typeof monitor === 'object') {
    const fn = (monitor as { friendlyName?: unknown }).friendlyName;
    if (typeof fn === 'string') return fn;
  }
  return '';
}

/**
 * Per-action details snippet:
 *  - `display_drift`        → `changes.join(', ')`
 *  - `display_apply_failed` → `error`
 *  - everything else        → '' (em-dash placeholder in the cell)
 */
function eventDetailsSnippet(
  action: string,
  payload: Record<string, unknown>,
): string {
  if (action === 'display_drift') {
    const changes = payload.changes;
    if (Array.isArray(changes)) {
      return changes.filter((c): c is string => typeof c === 'string').join(', ');
    }
    return '';
  }
  if (action === 'display_apply_failed') {
    const err = payload.error;
    if (typeof err === 'string') return err;
  }
  return '';
}

/** Severity badge classes — matches the amber-500 / destructive tokens used
 *  elsewhere in this file (restore banner, drift overlay). */
function eventLevelBadgeClass(level: string): string {
  if (level === 'critical') {
    return 'bg-destructive/20 text-destructive border-destructive/30';
  }
  if (level === 'warning') {
    return 'bg-amber-500/20 text-amber-300 border-amber-500/30';
  }
  return 'bg-muted text-muted-foreground border-border';
}

/**
 * Sort monitors left-to-right, top-to-bottom by virtual-desktop position so
 * the stat-card grid below the canvas matches the visual order on screen.
 */
function sortByPosition(monitors: MonitorInfo[]): MonitorInfo[] {
  return [...monitors].sort((a, b) => {
    if (a.position.x !== b.position.x) return a.position.x - b.position.x;
    return a.position.y - b.position.y;
  });
}

/**
 * True if any two monitors occupy overlapping virtual-desktop rects. Windows
 * tolerates overlaps, so this is strictly advisory — shown as a warning, never
 * a block. Rotation swaps effective width/height (portrait panels).
 */
function hasOverlappingMonitors(monitors: MonitorInfo[]): boolean {
  const rect = (m: MonitorInfo) => {
    const rot = m.rotation % 180;
    const w = rot === 0 ? m.resolution.width : m.resolution.height;
    const h = rot === 0 ? m.resolution.height : m.resolution.width;
    return { x: m.position.x, y: m.position.y, w, h };
  };
  for (let i = 0; i < monitors.length; i++) {
    const a = rect(monitors[i]);
    for (let j = i + 1; j < monitors.length; j++) {
      const b = rect(monitors[j]);
      if (
        a.x < b.x + b.w &&
        a.x + a.w > b.x &&
        a.y < b.y + b.h &&
        a.y + a.h > b.y
      ) {
        return true;
      }
    }
  }
  return false;
}

export function DisplayLayoutPanel({
  machineId,
  machineName,
  siteId,
  onClose,
}: DisplayLayoutPanelProps) {
  const { isSiteAdmin, user } = useAuth();
  const canSiteAdmin = isSiteAdmin(siteId);
  const { profile, assigned, autoRestore, remoteApplyEnabled, loading, error } = useDisplayState(siteId, machineId);
  // `applying` drives the disabled-state on every write button so repeat-clicks
  // during in-flight operations are blocked at the UI boundary.
  const actions = useDisplayActions(siteId, machineId);

  const [activeTab, setActiveTab] = useState<DisplayTab>('live');
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [selectedMonitorId, setSelectedMonitorId] = useState<string | undefined>(
    undefined,
  );
  const [captureDialogOpen, setCaptureDialogOpen] = useState(false);
  const [clearDialogOpen, setClearDialogOpen] = useState(false);
  const [applyDialogOpen, setApplyDialogOpen] = useState(false);
  const [enableRemoteApplyDialogOpen, setEnableRemoteApplyDialogOpen] = useState(false);
  const [closeUnsavedDialogOpen, setCloseUnsavedDialogOpen] = useState(false);
  // [A2.6] Id of the monitor currently being edited via DisplayEditorDialog.
  // Double-click a rect in the canvas or a row in the table (in edit mode on
  // the assigned tab) to open. Dialog saves flow through the draft via
  // `updateMonitor`, not directly to Firestore.
  const [editingMonitorId, setEditingMonitorId] = useState<string | null>(null);
  // [A4.2] Start-from-live handoff. The "start from live" button in the
  // empty-assigned state flips this + mode='edit' together; the effect below
  // reads the flag post-commit and replaces useDisplayDraft's default
  // "seed from assigned" (empty here) with a clone of the live topology,
  // then clears it. Also read by the render-phase guard so an edit session
  // mid-seed doesn't get snapped back to view before the draft lands.
  // State (not ref) so render reads are lint-clean.
  const [pendingSeedFromLive, setPendingSeedFromLive] = useState(false);

  // [A4.3] Topology signatureHash at the moment edit mode was entered. Used
  // to detect "hardware changed during edit" — if the live profile's hash
  // diverges from this baseline, the prompt below asks the operator whether
  // to reload the draft from the new live topology or keep editing the
  // potentially-stale draft. Captured during render on view -> edit
  // transition (mirrors `useDisplayDraft`'s prevMode pattern) rather than
  // in a useEffect to avoid a one-render window where the baseline is still
  // `null` and the change would be spuriously reported.
  const [editEntryHash, setEditEntryHash] = useState<string | null>(null);
  const [prevModeForHash, setPrevModeForHash] = useState<'view' | 'edit'>(
    mode,
  );
  if (mode !== prevModeForHash) {
    setPrevModeForHash(mode);
    setEditEntryHash(mode === 'edit' ? profile?.signatureHash ?? null : null);
  } else if (
    mode === 'edit' &&
    editEntryHash === null &&
    profile?.signatureHash
  ) {
    // Profile snapshot arrived after edit-mode entry (panel opened before
    // first Firestore read). Backfill the baseline so the very-first hash
    // doesn't get mis-reported as a change.
    setEditEntryHash(profile.signatureHash);
  }

  // [A3.3 / A3.4] Supported-display-modes catalogue, feeding the resolution +
  // refresh dropdowns in the table. Subscription is gated on edit mode so we
  // don't keep a live listener open on every panel — the dashboard card view
  // opens the panel frequently. `triggerForHash` fires the agent-side
  // enumerate command exactly once per (site, machine, topology-hash) per
  // tab lifetime; the hook dedups internally.
  const { catalogue: displayModes } = useDisplayModes(siteId, machineId, {
    enabled: mode === 'edit',
    triggerForHash: profile?.signatureHash,
  });

  const {
    draft,
    isDirty,
    updateMonitor,
    shiftSecondariesBy,
    resetToLive,
    clearDraft,
  } = useDisplayDraft({
    siteId,
    machineId,
    assigned,
    mode,
  });

  // Drag-to-reposition callback — only the assigned canvas in edit mode wires
  // this in, so a no-op outside edit mode keeps the existing read-only flow.
  const handleMonitorMove = useCallback(
    (id: string, position: { x: number; y: number }) => {
      updateMonitor(id, { position });
    },
    [updateMonitor],
  );

  // Primary-drag callback — translates a drag of the primary rect into an
  // inverse shift of every secondary so the operator sees the primary "move"
  // while the data model keeps primary pinned at (0, 0). Delta arrives as
  // incremental (frame-over-frame) virtual units from the canvas.
  const handleLayoutShift = useCallback(
    (dx: number, dy: number) => {
      shiftSecondariesBy(dx, dy);
    },
    [shiftSecondariesBy],
  );

  // Wave 6.5(f) — per-machine ack banner state lives in a module-level
  // hook so the countdown survives the panel closing and re-opening.
  // `useAckBanner` exposes derived `ackSecondsLeft` (recomputed each tick
  // from an absolute wall-clock deadline) plus the `pendingApplyId` we
  // thread into `actions.ackLayout`. The auto-revert toast on deadline
  // crossing is fired inside the hook so it surfaces even when the panel
  // is unmounted.
  const { ackSecondsLeft, pendingApplyId, ackInFlight } = useAckBanner(
    siteId, machineId,
  );

  // Wave 6.4 capability handshake. Subscribes to the machine doc's
  // `capabilities.displayRemoteApply` field (written by the agent's
  // `_upload_metrics` heartbeat). When absent or below version 1 the
  // restore button disables itself with an "agent too old" tooltip so a
  // pre-Wave-3 agent can't be sent a command it can't dispatch. `null`
  // means "first snapshot hasn't landed" — distinct from `0` ("agent
  // sent it explicitly as not supported"). Both are treated as
  // unsupported by the gate, but holding them apart leaves room for a
  // future "loading" state if ever needed.
  const [capabilityVersion, setCapabilityVersion] = useState<number | null>(null);
  useEffect(() => {
    if (!db || !siteId || !machineId) return;
    const ref = doc(db, 'sites', siteId, 'machines', machineId);
    const unsubscribe = onSnapshot(ref, (snap) => {
      if (!snap.exists()) {
        setCapabilityVersion(null);
        return;
      }
      const raw = snap.data()?.capabilities?.displayRemoteApply;
      setCapabilityVersion(typeof raw === 'number' ? raw : null);
    });
    return () => unsubscribe();
  }, [siteId, machineId]);
  const agentSupportsApply = capabilityVersion !== null && capabilityVersion >= 1;

  // Full drift report, computed from the live+assigned snapshot. Callers
  // pick the key they need: live-id for the live tab's table and canvas,
  // assigned-id for the stored tab. `addedHashes` / `removedHashes` cover
  // the "layout changed" case the per-field maps can't express — a
  // disconnected monitor that used to be in the stored layout still counts
  // as drift even though neither side has a per-field row for it.
  const driftReport = useMemo(
    () =>
      computeDisplayDrift(
        profile?.monitors ?? [],
        assigned?.monitors ?? [],
      ),
    [profile, assigned],
  );

  const driftCount = totalDriftCount(driftReport);
  const hasDrift = driftCount > 0;

  // [RECONSTRUCTED — Wave A1.4] Drift signals are zeroed in edit mode so the
  // user isn't flagged for changes they are deliberately making. Raw hasDrift
  // stays available for non-UI math paths; UI surfaces use the hasDriftVisible
  // / effectiveDriftCount forms.
  const effectiveDriftCount = mode === 'edit' ? 0 : driftCount;
  const hasDriftVisible = mode === 'edit' ? false : hasDrift;

  // Stable Set of drifted monitor ids — passed to the canvas so it can
  // amber-stroke drifted rects. The canvas renders from the live- or
  // assigned-keyed monitor array depending on the active tab, so we pick
  // the matching side of the drift report. Memoized so the Set identity
  // is stable across renders when the underlying drift map hasn't changed.
  const driftedMonitorIds = useMemo(
    () =>
      new Set(
        activeTab === 'live'
          ? driftReport.byLiveId.keys()
          : driftReport.byAssignedId.keys(),
      ),
    [driftReport, activeTab],
  );

  // Stable array references across renders so the sort/drift useMemos below
  // don't thrash on every parent render. Without this, `profile?.monitors ?? []`
  // allocates a fresh array when the profile hasn't arrived yet.
  const liveMonitors = useMemo<MonitorInfo[]>(
    () => profile?.monitors ?? [],
    [profile],
  );
  const assignedMonitors = useMemo<MonitorInfo[]>(
    () => assigned?.monitors ?? [],
    [assigned],
  );

  // [A2.1 / Wave A1.5] In edit mode the draft is the source of truth — the
  // table, canvas, and ghost overlay on the live tab all reflect draft edits
  // in real time. Outside edit mode this collapses back to the persisted value.
  const effectiveAssignedMonitors = useMemo<MonitorInfo[]>(
    () => (mode === 'edit' && draft ? draft : assignedMonitors),
    [mode, draft, assignedMonitors],
  );

  const sortedLive = useMemo(() => sortByPosition(liveMonitors), [liveMonitors]);
  const sortedAssigned = useMemo(
    () => sortByPosition(effectiveAssignedMonitors),
    [effectiveAssignedMonitors],
  );

  // [A4.1] Overlap check runs only while editing — outside edit mode an
  // overlapping saved layout is the operator's deliberate choice and not
  // worth nagging.
  const draftHasOverlap = useMemo(() => {
    if (mode !== 'edit') return false;
    return hasOverlappingMonitors(effectiveAssignedMonitors);
  }, [mode, effectiveAssignedMonitors]);

  // Cards and canvas render from the same slice of data so selection stays
  // in sync AND the index labels match. Previously the canvas took the
  // unsorted array while the table took the position-sorted one, so
  // "monitor #1" on the canvas could be "monitor #2" in the table —
  // subtle, confusing, and easy to miss unless you happened to watch both
  // panes at once.
  const cardsMonitors = activeTab === 'live' ? sortedLive : sortedAssigned;
  const canvasMonitors = cardsMonitors;
  // [Wave A1.5 — RECONSTRUCTED] In edit mode the ghost overlay on the live tab
  // mirrors the current draft (not persisted assigned) so operators see the
  // draft-vs-live comparison live. The drift filter is relaxed in edit mode
  // because the whole point is to surface every pending change.
  const ghostMonitors = useMemo<MonitorInfo[] | undefined>(() => {
    if (activeTab !== 'live' || !assigned) return undefined;
    const source = mode === 'edit' && draft ? draft : assignedMonitors;
    if (mode === 'edit') {
      return source;
    }
    const liveByHash = new Map<string, MonitorInfo>();
    for (const m of liveMonitors) {
      if (m.edidHash) liveByHash.set(m.edidHash, m);
    }
    return source.filter((a) => {
      if (!a.edidHash) return true;
      const live = liveByHash.get(a.edidHash);
      if (!live) return true;
      return driftedMonitorIds.has(live.id);
    });
  }, [activeTab, assigned, assignedMonitors, liveMonitors, driftedMonitorIds, mode, draft]);

  // Single source of truth for the active tab's semantic color. Threaded into
  // the canvas (selection ring), monitor cards (left border + selected ring),
  // and the apply button (drift-state accent) so every visible signal of the
  // current mode reads as one coherent color. The events tab is read-only and
  // doesn't drive any canvas/cards, but a neutral accent keeps the tab pill
  // styling consistent with the active-tab ring above.
  const tabAccentColor =
    activeTab === 'live'
      ? 'var(--primary)'
      : activeTab === 'assigned'
        ? 'var(--chart-4)'
        : 'var(--muted-foreground)';

  // Display-event feed for the events tab. Subscription only opens while the
  // tab is active so the dashboard doesn't hold dozens of 50-event listeners
  // open across panels in the background.
  const {
    events: displayEvents,
    loading: eventsLoading,
    error: eventsError,
  } = useDisplayEventFeed(siteId, machineId, {
    enabled: activeTab === 'events',
  });

  const hasLiveProfile = !!profile && liveMonitors.length > 0;
  const hasAssignedLayout = !!assigned && assignedMonitors.length > 0;

  // [A4.3] Hardware-changed detection: edit mode + baseline captured +
  // current live hash diverges from the baseline. Drives the prompt below.
  // Non-null baseline guard prevents a spurious fire on first profile
  // arrival when edit opened before any snapshot landed.
  const hardwareChangedDuringEdit =
    mode === 'edit' &&
    editEntryHash !== null &&
    !!profile?.signatureHash &&
    profile.signatureHash !== editEntryHash;

  // [A4.4] Stale-edidHash set: edidHashes referenced by the assigned-tab
  // monitors that aren't in the current live topology. Drives the
  // "⚠ not connected" badge on canvas rects. Only computed for the
  // assigned tab; the live tab's monitors are by definition connected.
  // Includes the draft when in edit mode so a live-seeded draft that
  // already references a now-disconnected hash gets flagged immediately.
  const staleEdidHashes = useMemo<Set<string> | undefined>(() => {
    if (activeTab !== 'assigned') return undefined;
    const liveHashes = new Set<string>();
    for (const m of liveMonitors) {
      if (m.edidHash) liveHashes.add(m.edidHash);
    }
    const stale = new Set<string>();
    for (const m of effectiveAssignedMonitors) {
      if (m.edidHash && !liveHashes.has(m.edidHash)) stale.add(m.edidHash);
    }
    return stale;
  }, [activeTab, liveMonitors, effectiveAssignedMonitors]);

  // [RECONSTRUCTED — Wave A1.2 / relaxed A4.2] Defensive render-phase guard.
  // If the admin flag disappears mid-edit, snap back to view. If the assigned
  // layout gets cleared AND we have no draft to fall back on AND we're not
  // in the middle of a start-from-live handoff, snap back as well. The
  // relaxed condition lets the live-seed flow linger in edit mode even
  // before an `assigned` layout exists: the draft itself is the authority,
  // and save writes it as the first-ever assigned.
  //
  // Also discards the sessionStorage draft. If we only flip the mode, the
  // stale draft survives in storage; next time an assigned layout exists
  // and the operator enters edit, useDisplayDraft's own staleness check
  // catches most cases by edidHash — but the admin-flag case can't be
  // detected there, so we handle both reasons the same way here.
  const draftHasMonitors = !!draft && draft.length > 0;
  if (
    mode === 'edit' &&
    (!canSiteAdmin ||
      (!hasAssignedLayout &&
        !draftHasMonitors &&
        !pendingSeedFromLive))
  ) {
    setMode('view');
    clearDraft();
    setPendingSeedFromLive(false);
  }

  // Button disabled-state logic:
  //  - store: needs live data to store (otherwise there's nothing to save)
  //  - restore: needs an assigned layout to push, a capable agent, and the
  //    per-machine `displays.remoteApplyEnabled` write-path switch. The
  //    capability says the agent can handle the command; the config switch
  //    says this machine is allowed to mutate Windows display state.
  // `actions.applying` blocks repeat-clicks during in-flight writes.
  const captureDisabled = !hasLiveProfile || actions.applying;
  const applyDisabled =
    !hasAssignedLayout || actions.applying || !agentSupportsApply || !remoteApplyEnabled;
  const editDisabled = !hasAssignedLayout || !!profile?.mosaicActive;

  // Stable click handler so memoized children (DisplayCanvas, DisplayMonitorCard)
  // can shallow-compare props and skip re-renders when only unrelated parent
  // state changed (e.g. `actions.applying` flipping, tab switches that don't
  // touch this row).
  const handleMonitorClick = useCallback((id: string) => {
    setSelectedMonitorId((prev) => (prev === id ? undefined : id));
  }, []);

  // Drift-detection toast. Fires once per (machineId, signatureHash) tuple when
  // drift first appears mid-session — NOT on initial mount (users who open the
  // panel while drift already exists shouldn't be toasted for pre-existing
  // state; the tab badge already signals it). Dedup is keyed on the agent's
  // signature hash so signature flaps on the same baseline don't re-toast.
  const seenDriftKeysRef = useRef(new Set<string>());
  const isInitialMountRef = useRef(true);

  useEffect(() => {
    // [RECONSTRUCTED — Wave A1.4] Suppress drift toasts during edit mode.
    if (mode === 'edit') return;

    // First commit: record current state but don't toast — user just opened
    // the panel and shouldn't get a toast for pre-existing drift.
    if (isInitialMountRef.current) {
      isInitialMountRef.current = false;
      if (hasDrift && profile?.signatureHash) {
        seenDriftKeysRef.current.add(`${machineId}|${profile.signatureHash}`);
      }
      return;
    }

    if (!hasDrift || !profile?.signatureHash) return;

    const key = `${machineId}|${profile.signatureHash}`;
    if (seenDriftKeysRef.current.has(key)) return;
    seenDriftKeysRef.current.add(key);

    const noun = driftCount === 1 ? 'change' : 'changes';
    toast.info(
      `display drift detected on ${machineName || machineId} — ${driftCount} ${noun}. open stored tab to review.`,
      {
        action: { label: 'review', onClick: () => setActiveTab('assigned') },
      },
    );
  }, [hasDrift, profile?.signatureHash, machineId, machineName, driftCount, setActiveTab, mode]);

  /**
   * Extract a readable error string from unknown throwables. Firestore errors
   * carry `.message`; plain strings pass through; everything else gets
   * `String()`-coerced so we never render `[object Object]` in a toast.
   */
  const formatError = (e: unknown): string => {
    if (e instanceof Error) return e.message;
    if (typeof e === 'string') return e;
    return String(e);
  };

  /**
   * Pick a specific apply-failure toast message based on the agent's error
   * code when the error string carries one. The service handler serializes
   * failures as `"Error: {code}: {message}"` (see owlette_service.py
   * `enumerate_display_modes` / `apply_display_topology` branches) so a
   * simple substring check is all we need here — no JSON parsing, no
   * command-result subscription.
   *
   * Today `applyLayout` only throws for Firestore-write failures; agent
   * apply-result parsing is deferred to a follow-up. The specific-toast
   * hook is wired here so that flow has somewhere to land when it ships.
   */
  const applyErrorToast = (e: unknown): string => {
    const msg = formatError(e);
    if (msg.includes('unsupported_mode')) {
      return (
        "restore failed: one or more monitors can't do the requested " +
        'resolution or refresh rate — pick a supported mode from the ' +
        'dropdowns and try again'
      );
    }
    return `restore failed: ${msg}`;
  };

  // Capture writes the current live arrangement as the assigned layout. We
  // snapshot `liveMonitors` at confirm-time (not at dialog-open-time) so any
  // updates that arrive while the dialog is open are persisted. ConfirmDialog
  // closes itself on confirm; on error we reopen so the user can retry.
  const handleCaptureConfirm = async () => {
    try {
      await actions.captureLayout(liveMonitors, user?.email ?? 'unknown');
      toast.success('layout stored');
    } catch (e) {
      console.error('Failed to store display layout', e);
      toast.error(`store failed: ${formatError(e)}`);
      setCaptureDialogOpen(true);
    }
  };

  const handleClearConfirm = async () => {
    try {
      await actions.clearLayout();
      toast.success('assigned layout cleared');
      clearDraft();
      setMode('view');
    } catch (e) {
      console.error('Failed to clear display layout', e);
      toast.error(`clear failed: ${formatError(e)}`);
      setClearDialogOpen(true);
    }
  };

  // Apply dispatches the assigned layout to the agent. On success we start
  // the 30s ack countdown via `startAckCountdown` — module-level state so
  // the banner survives the panel closing. The operator must click "keep"
  // in the banner or the agent auto-reverts. ConfirmDialog closes itself
  // on confirm; on error we reopen so the user can retry.
  const handleApplyConfirm = async () => {
    try {
      const { applyId } = await actions.applyLayout(assignedMonitors);
      // Wave 6.5(c) — honest copy: the Firestore write succeeded but the
      // agent hasn't even seen the command yet, let alone applied it.
      toast.success('restore dispatched — monitors will change shortly');
      startAckCountdown(siteId, machineId, applyId, Date.now() + 30_000);
    } catch (e) {
      console.error('Failed to restore display layout', e);
      toast.error(applyErrorToast(e));
      setApplyDialogOpen(true);
    }
  };

  // Dispatch ack and clear the countdown banner. The applyId threaded
  // through ensures the agent only acks the apply this banner corresponds
  // to — a stale click on a prior apply is rejected.
  //
  // Banner state is cleared only after the ack write resolves. If we cleared
  // optimistically and the write then failed, the operator would have no
  // countdown to retry against and the agent's auto-revert watchdog would
  // keep running on the far side — the "keep" click would silently turn
  // into a revert.
  //
  // Wave 6.5(b) — `setAckInFlight` flips the keep button's disabled state
  // through the module store so a double-click can't dispatch two acks.
  const handleAckKeep = async () => {
    const applyId = pendingApplyId;
    if (!applyId) return;
    setAckInFlight(siteId, machineId, true);
    try {
      await actions.ackLayout(applyId);
      clearAckCountdown(siteId, machineId);
      // Wave 6.5(c) — honest copy: the agent confirms the keep when it
      // emits `display_apply_acked`; from the dashboard's perspective we
      // only know the ack command was written.
      toast.success('ack sent');
    } catch (e) {
      console.error('Failed to ack display layout', e);
      toast.error(`keep failed: ${formatError(e)} — try again before the countdown ends`);
      setAckInFlight(siteId, machineId, false);
    }
  };

  // Wave 6.3 — apply self-test ("test" button). Dispatches a
  // `test_display_apply` command and subscribes to its completed-doc entry so
  // the result text lands inline next to the button. The button is hidden when
  // remote apply is already enabled (the operator no longer needs to verify
  // the helper IPC) so there's no per-machine timeout to manage if the
  // command never lands — closing the panel just discards the pending state.
  const [testApplyCmdId, setTestApplyCmdId] = useState<string | null>(null);
  const [testApplyResult, setTestApplyResult] = useState<string | null>(null);
  const [testApplyInFlight, setTestApplyInFlight] = useState(false);

  const handleTestApply = async () => {
    setTestApplyResult(null);
    setTestApplyInFlight(true);
    try {
      const cmdId = await actions.testDisplayApply();
      setTestApplyCmdId(cmdId);
    } catch (e) {
      console.error('Failed to dispatch test_display_apply', e);
      toast.error(`test failed: ${formatError(e)}`);
      setTestApplyInFlight(false);
    }
  };

  useEffect(() => {
    if (!testApplyCmdId || !db || !siteId || !machineId) return;
    const ref = doc(
      db, 'sites', siteId, 'machines', machineId, 'commands', 'completed',
    );
    const unsubscribe = onSnapshot(ref, (snap) => {
      if (!snap.exists()) return;
      const data = snap.data();
      const entry = data?.[testApplyCmdId];
      if (!entry || entry.status !== 'completed') return;
      const result = typeof entry.result === 'string' ? entry.result : 'no result';
      setTestApplyResult(result);
      setTestApplyInFlight(false);
      setTestApplyCmdId(null);
    });
    return () => unsubscribe();
  }, [testApplyCmdId, siteId, machineId]);

  // Wave 6.5(a/f) — countdown derivation + auto-revert toast both live
  // inside `useAckBanner`'s shared 250ms tick. No per-panel effect needed
  // here; the hook fires the toast and clears the entry on deadline cross
  // even when the panel is unmounted.

  // [RECONSTRUCTED — Wave A1.2] Close-with-unsaved-changes gate. Wave 6.5(f)
  // dropped the previous "block close while ack countdown active" guard —
  // the banner now lives in a per-machine module store so closing the
  // panel during the countdown is safe (re-opening the panel resurfaces
  // the banner; deadline elapsing fires the toast regardless).
  const handleCloseClick = () => {
    if (mode === 'edit' && isDirty) {
      setCloseUnsavedDialogOpen(true);
      return;
    }
    onClose();
  };

  // [RECONSTRUCTED — Wave A1.2] Discard + close confirmation.
  const handleDiscardAndClose = () => {
    clearDraft();
    setMode('view');
    onClose();
  };

  const handleDiscardEdit = () => {
    clearDraft();
    setMode('view');
    setPendingSeedFromLive(false);
  };

  // [A4.2] Empty-assigned seed-from-live. When the assigned tab is empty and
  // the operator clicks "start from live", skip the store-then-edit dance:
  // set the handoff ref, flip into edit mode, and let the effect below
  // clone live into the draft AFTER useDisplayDraft's mode-transition seed
  // (which would otherwise stomp our call with a null from empty assigned).
  const handleSeedFromLive = () => {
    if (liveMonitors.length === 0) return;
    setPendingSeedFromLive(true);
    setMode('edit');
  };

  // Runs post-commit; the mode transition has landed and useDisplayDraft has
  // already seeded draft=null (because assigned is empty). Overwrite with a
  // clone of the current live topology and clear the handoff flag. Guarded
  // on !draft so a re-entry where the draft already exists doesn't clobber
  // the operator's in-progress edits.
  //
  // Note on `set-state-in-effect`: the setPendingSeedFromLive(false) calls
  // below are intentional — the flag is a one-shot coordination token
  // between the click handler and this post-commit seed. React's rule
  // guards against derivable state + state-update loops, neither of which
  // apply here (the flag's semantics are genuinely imperative: "do this
  // one thing after mode flips, then stop").
  useEffect(() => {
    if (!pendingSeedFromLive) return;
    if (mode !== 'edit') return;
    if (draft && draft.length > 0) {
      // Draft already populated by a prior reset — no-op. The flag stays
      // set until save/discard clears it; re-renders with the same deps
      // won't re-invoke the effect, so there's no loop.
      return;
    }
    if (liveMonitors.length === 0) {
      // Live topology hasn't arrived yet — retry on the next render that
      // brings monitors in. The guard above keeps edit mode alive until
      // the draft fills or the user cancels.
      return;
    }
    resetToLive(liveMonitors);
    // Flag clear is the one-shot completion signal — lint's
    // set-state-in-effect rule warns against derivable-state patterns, but
    // this is a genuine imperative handoff (click handler → effect).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPendingSeedFromLive(false);
  }, [pendingSeedFromLive, mode, draft, liveMonitors, resetToLive]);

  // Save commits the draft as the new assigned layout. Uses the same
  // captureLayout path as store — the only difference is which monitors we
  // persist (draft vs current live). On success, drop the sessionStorage
  // draft + exit edit mode so the panel returns to a clean view state.
  const handleSaveDraft = async () => {
    if (!draft) return;
    try {
      await actions.captureLayout(draft, user?.email ?? 'unknown');
      toast.success('layout saved');
      clearDraft();
      setMode('view');
    } catch (e) {
      console.error('Failed to save draft', e);
      toast.error(`save failed: ${formatError(e)}`);
    }
  };

  const handleAutoRestoreToggle = async (next: boolean) => {
    try {
      await actions.setAutoRestore(next, user?.email ?? 'unknown');
    } catch (e) {
      console.error('Failed to update auto-restore', e);
      toast.error(`auto-restore update failed: ${formatError(e)}`);
    }
  };

  const handleEnableRemoteApply = async () => {
    try {
      await actions.setRemoteApplyEnabled(true);
      toast.success('restore enabled');
    } catch (e) {
      console.error('Failed to enable display restore', e);
      toast.error(`enable failed: ${formatError(e)}`);
    }
  };

  const handleResetBreaker = async () => {
    try {
      await actions.resetAutoRestoreBreaker();
      toast.success('auto-restore re-enabled');
    } catch (e) {
      console.error('Failed to reset auto-restore breaker', e);
      toast.error(`reset failed: ${formatError(e)}`);
    }
  };

  const autoRestoreDisabled =
    !hasAssignedLayout || !!profile?.mosaicActive || !remoteApplyEnabled || actions.applying;
  const autoRestoreDisabledReason = !hasAssignedLayout
    ? 'store a layout before enabling automatic restore'
    : profile?.mosaicActive
      ? "auto-restore can't run while nvidia mosaic is active"
      : !remoteApplyEnabled
        ? 'enable restore before enabling automatic restore'
        : autoRestore.enabled
          ? 'automatically reapplies the stored layout when this machine reports display drift'
          : 'turn on automatic restore so the agent reapplies the stored layout when display drift is detected';
  const breakerTripped = autoRestore.circuitBreaker.tripped;
  const breakerLastError =
    autoRestore.circuitBreaker.lastError || '(no error message)';

  const renderEventsTab = (
    events: DisplayEventEntry[],
    eventsLoadingArg: boolean,
    eventsErrorArg: string | null,
  ) => {
    if (eventsErrorArg) {
      return (
        <div
          className="h-[280px] flex items-center justify-center text-destructive text-sm"
          role="alert"
        >
          failed to load events — {eventsErrorArg}
        </div>
      );
    }
    if (eventsLoadingArg) {
      return (
        <div
          className="h-[280px] flex items-center justify-center"
          role="status"
          aria-live="polite"
          aria-busy="true"
          aria-label="loading events"
        >
          <div className="text-muted-foreground animate-pulse text-sm">
            loading...
          </div>
        </div>
      );
    }
    if (events.length === 0) {
      return (
        <div className="h-[280px] flex items-center justify-center px-6 text-center">
          <p className="text-sm text-muted-foreground max-w-md">
            no display events yet. display changes will appear here.
          </p>
        </div>
      );
    }
    return (
      <div
        className="h-[280px] overflow-y-auto border border-border rounded-lg"
        data-testid="display-events-table"
      >
        <table className="w-full text-xs">
          <thead className="bg-muted/40 text-muted-foreground sticky top-0 z-10">
            <tr>
              <th className="text-left font-normal px-3 py-1.5 w-[80px]">when</th>
              <th className="text-left font-normal px-3 py-1.5 w-[80px]">level</th>
              <th className="text-left font-normal px-3 py-1.5 w-[160px]">event</th>
              <th className="text-left font-normal px-3 py-1.5 w-[180px]">monitor</th>
              <th className="text-left font-normal px-3 py-1.5">details</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => {
              const payload = parseEventDetails(event.details);
              const monitorName = eventMonitorName(payload);
              const snippet = eventDetailsSnippet(event.action, payload);
              const label = DISPLAY_EVENT_LABEL[event.action] ?? event.action;
              return (
                <tr
                  key={event.id}
                  className="border-t border-border/60 hover:bg-accent/30"
                >
                  <td className="px-3 py-1.5 text-muted-foreground whitespace-nowrap">
                    {formatEventRelativeTime(event.timestamp)}
                  </td>
                  <td className="px-3 py-1.5">
                    <span
                      className={cn(
                        'inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide',
                        eventLevelBadgeClass(event.level),
                      )}
                    >
                      {event.level || 'info'}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-foreground whitespace-nowrap">
                    {label}
                  </td>
                  <td className="px-3 py-1.5 text-muted-foreground truncate">
                    {monitorName || '—'}
                  </td>
                  <td className="px-3 py-1.5 text-muted-foreground truncate">
                    {snippet || '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  };

  const renderBody = () => {
    // Events tab is sourced from a separate Firestore subscription and has its
    // own loading / error / empty states — bypass the display-state guards
    // below so a still-loading topology doesn't hide the events table.
    if (activeTab === 'events') {
      return renderEventsTab(displayEvents, eventsLoading, eventsError);
    }

    if (error) {
      return (
        <div
          className="h-[320px] flex items-center justify-center text-destructive text-sm"
          role="alert"
        >
          failed to load display data — {error}
        </div>
      );
    }

    if (loading) {
      return (
        <div
          className="h-[320px] flex items-center justify-center"
          role="status"
          aria-live="polite"
          aria-busy="true"
          aria-label="loading displays"
        >
          <div className="text-muted-foreground animate-pulse text-sm">
            loading...
          </div>
        </div>
      );
    }

    // Empty-state copy is tab-aware: "no live data" vs "no assigned layout"
    // are meaningfully different (the first is an agent-side concern, the
    // second is a deliberate admin action that hasn't happened yet).
    if (activeTab === 'live' && !hasLiveProfile) {
      return (
        <div className="h-[320px] flex items-center justify-center px-6 text-center">
          <p className="text-sm text-muted-foreground max-w-md">
            no display data reported yet. data appears once the agent sends a
            display snapshot.
          </p>
        </div>
      );
    }

    // Empty-assigned surface only when there's genuinely nothing to show.
    // Suppressed in edit mode with a populated draft so a live-seeded edit
    // session renders the canvas against the draft instead of the empty state.
    const emptyAssignedVisible =
      activeTab === 'assigned' &&
      !hasAssignedLayout &&
      !(mode === 'edit' && draftHasMonitors);
    if (emptyAssignedVisible) {
      return (
        <div className="h-[320px] flex flex-col items-center justify-center px-6 text-center gap-3">
          <p className="text-sm text-muted-foreground max-w-md">
            nothing stored yet. store the current live arrangement as-is, or
            start from live to tweak before saving.
          </p>
          {canSiteAdmin && (
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={captureDisabled}
                onClick={() => setCaptureDialogOpen(true)}
                data-testid="display-store-current-button"
                className="h-7 px-2 text-xs"
              >
                {actions.applying ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  'store current'
                )}
              </Button>
              {/* [A4.2] Start-from-live: enter edit mode with the draft
                  pre-seeded from the live topology. Equivalent to capture-
                  then-edit, but the operator gets a chance to tweak before
                  anything hits Firestore. */}
              <Button
                variant="outline"
                size="sm"
                disabled={liveMonitors.length === 0 || actions.applying}
                onClick={handleSeedFromLive}
                data-testid="display-start-from-live-button"
                className="h-7 px-2 text-xs"
              >
                start from live
              </Button>
            </div>
          )}
        </div>
      );
    }

    return (
      <div className="animate-in fade-in duration-100 grid grid-cols-1 md:grid-cols-2 gap-0 bg-card rounded-lg">
        <div className="min-w-0 h-[280px] border border-border rounded-l-lg md:border-r-0 overflow-hidden bg-card">
          <DisplayCanvas
            monitors={canvasMonitors}
            mosaicGrids={activeTab === 'live' ? profile?.mosaicGrids : undefined}
            ghostMonitors={ghostMonitors}
            selectedMonitorId={selectedMonitorId}
            onMonitorClick={handleMonitorClick}
            accentColor={tabAccentColor}
            driftedMonitorIds={
              mode === 'edit'
                ? undefined
                : activeTab === 'live'
                  ? driftedMonitorIds
                  : undefined
            }
            staleEdidHashes={staleEdidHashes}
            editable={mode === 'edit' && activeTab === 'assigned'}
            onMonitorMove={
              mode === 'edit' && activeTab === 'assigned'
                ? handleMonitorMove
                : undefined
            }
            onMonitorDoubleClick={
              mode === 'edit' && activeTab === 'assigned'
                ? setEditingMonitorId
                : undefined
            }
            onLayoutShift={
              mode === 'edit' && activeTab === 'assigned'
                ? handleLayoutShift
                : undefined
            }
            className="h-[280px]"
          />
        </div>

        <DisplayMonitorTable
          monitors={cardsMonitors}
          selectedMonitorId={selectedMonitorId}
          onSelect={handleMonitorClick}
          onRowDoubleClick={
            mode === 'edit' && activeTab === 'assigned'
              ? setEditingMonitorId
              : undefined
          }
          accentColor={tabAccentColor}
          editable={mode === 'edit' && activeTab === 'assigned'}
          onUpdateMonitor={
            mode === 'edit' && activeTab === 'assigned'
              ? updateMonitor
              : undefined
          }
          modesByEdidHash={
            mode === 'edit' && activeTab === 'assigned'
              ? displayModes?.byEdidHash
              : undefined
          }
          driftMap={
            mode === 'edit'
              ? undefined
              : activeTab === 'live'
                ? driftReport.byLiveId
                : driftReport.byAssignedId
          }
        />
      </div>
    );
  };

  // Pill-style tab button — factored out so the live/assigned pair share
  // exactly the same shape. Each tab gets its semantic color (resolved via
  // tabAccentColor above) so user always knows which mode they're in.
  const renderTab = (tab: DisplayTab, label: string, badge?: string) => {
    const isActive = activeTab === tab;
    const ringColor =
      tab === 'live'
        ? 'var(--primary)'
        : tab === 'assigned'
          ? 'var(--chart-4)'
          : 'var(--muted-foreground)';
    return (
      <Button
        key={tab}
        variant="ghost"
        size="sm"
        onClick={() => setActiveTab(tab)}
        title={badge ? `${badge} display change${badge === '1' ? '' : 's'} from stored layout` : undefined}
        aria-label={badge ? `${label}, ${badge} display change${badge === '1' ? '' : 's'} from stored layout` : label}
        style={isActive ? { boxShadow: `inset 0 0 0 1px ${ringColor}` } : undefined}
        className={cn(
          'relative bg-card border border-border text-muted-foreground hover:text-white h-8 px-3 text-xs transition-colors',
          isActive
            ? 'border-transparent text-white hover:bg-card'
            : 'hover:bg-card',
        )}
      >
        <span>{label}</span>
        {badge && (
          <span
            className="absolute -top-0.5 -right-0.5 inline-flex"
            aria-hidden="true"
          >
            <span className="inline-block w-2 h-2 rounded-full bg-amber-500" />
          </span>
        )}
      </Button>
    );
  };

  return (
    <Card
      data-testid="display-layout-panel"
      className="border-border bg-card-sunken py-0 gap-0"
    >
      <CardContent className="p-4">
        {/* Single header row: machine title, tabs, write actions, close.
            Consolidates the previous title + controls rows to save vertical
            space and put every panel control within one visual sweep. */}
        <div className="flex items-center gap-3 flex-wrap">
          <span className="flex items-center gap-2 text-xl font-semibold text-foreground shrink-0">
            <Monitor className="h-5 w-5 text-muted-foreground" />
            {machineName || machineId}
          </span>

          <div className="flex items-center gap-1.5">
            {renderTab('live', 'live')}
            {renderTab(
              'assigned',
              'stored',
              hasDriftVisible ? String(effectiveDriftCount) : undefined,
            )}
            {renderTab('events', 'events')}
            {mode === 'edit' && (
              <span className="text-[10px] text-muted-foreground px-2 py-1 rounded bg-muted/40 border border-border">
                editing stored — drift check paused
              </span>
            )}
          </div>

          {canSiteAdmin && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  tabIndex={autoRestoreDisabled ? 0 : -1}
                  className="flex items-center gap-2"
                >
                  <span className="text-xs text-muted-foreground">
                    auto-restore
                  </span>
                  <Switch
                    checked={autoRestore.enabled}
                    onCheckedChange={handleAutoRestoreToggle}
                    disabled={autoRestoreDisabled}
                    data-testid="display-auto-restore-toggle"
                    aria-label="auto-restore"
                  />
                </span>
              </TooltipTrigger>
              <TooltipContent>{autoRestoreDisabledReason}</TooltipContent>
            </Tooltip>
          )}

          <div className="flex-1" />

          {/* Admin action bar. Four verbs: store / restore / edit / discard.
                - live tab (view): store, restore
                - stored tab (view): restore, edit
                - edit mode: store, discard
              Restore is visible on both view tabs so drift can be fixed from
              wherever the operator noticed it. When auto-restore is enabled,
              its status chip occupies the same slot as the manual restore
              action. */}
          {canSiteAdmin && mode === 'view' && activeTab !== 'events' && (
            <div className="flex items-center gap-1.5">
              {/* Restore setup flow: test -> store -> restore. Test is a
                  pre-enable safety check; once restore is enabled, real
                  restore/auto-restore runs are the meaningful verification. */}
              {!remoteApplyEnabled && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span tabIndex={testApplyInFlight ? 0 : -1}>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={testApplyInFlight}
                        onClick={handleTestApply}
                        data-testid="display-test-apply-button"
                        className="bg-card border border-border text-muted-foreground hover:text-white h-8 px-3 text-xs"
                      >
                        {testApplyInFlight ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          'test'
                        )}
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    run a read-only apply self-test (no display changes) to
                    verify the helper works on this machine before enabling restore
                  </TooltipContent>
                </Tooltip>
              )}
              {activeTab === 'live' && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span tabIndex={captureDisabled ? 0 : -1}>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={captureDisabled}
                        onClick={() => setCaptureDialogOpen(true)}
                        data-testid="display-store-button"
                        className="bg-card border border-border text-muted-foreground hover:text-white h-8 px-3 text-xs"
                      >
                        {actions.applying ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          'store'
                        )}
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    store the current live arrangement as the stored layout
                  </TooltipContent>
                </Tooltip>
              )}
              {activeTab === 'assigned' && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span tabIndex={editDisabled ? 0 : -1}>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={editDisabled}
                        onClick={() => setMode('edit')}
                        data-testid="display-edit-button"
                        className="bg-card border border-border text-muted-foreground hover:text-white h-8 px-3 text-xs"
                      >
                        edit
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    {!hasAssignedLayout
                      ? 'store a layout first'
                      : profile?.mosaicActive
                        ? 'editing unavailable while mosaic is active'
                        : 'edit the stored layout'}
                  </TooltipContent>
                </Tooltip>
              )}
              {activeTab === 'assigned' && hasAssignedLayout && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span tabIndex={actions.applying ? 0 : -1}>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={actions.applying}
                        onClick={() => setClearDialogOpen(true)}
                        data-testid="display-clear-button"
                        className="bg-card border border-border text-muted-foreground hover:text-destructive h-8 px-3 text-xs"
                      >
                        clear
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    remove the stored display layout from this machine
                  </TooltipContent>
                </Tooltip>
              )}
              {autoRestore.enabled ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      data-testid="display-auto-restore-status"
                      className="inline-flex h-8 items-center gap-1.5 rounded border border-border bg-card px-3 text-xs text-muted-foreground"
                    >
                      <span className="bg-green-500 rounded-full h-1.5 w-1.5" />
                      auto
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    auto-restore is enabled; the agent restores the stored
                    layout after it detects display drift
                  </TooltipContent>
                </Tooltip>
              ) : !remoteApplyEnabled ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span tabIndex={actions.applying ? 0 : -1}>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={actions.applying}
                        onClick={() => setEnableRemoteApplyDialogOpen(true)}
                        data-testid="display-enable-remote-apply-button"
                        className="bg-card border border-border text-muted-foreground hover:text-white h-8 px-3 text-xs"
                      >
                        {actions.applying ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          'enable restore'
                        )}
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    allow admins to restore the stored display layout on this machine
                  </TooltipContent>
                </Tooltip>
              ) : (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span tabIndex={applyDisabled ? 0 : -1}>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={applyDisabled}
                        onClick={() => setApplyDialogOpen(true)}
                        data-testid="display-recall-button"
                        style={
                          hasDriftVisible
                            ? { boxShadow: 'inset 0 0 0 1px var(--chart-4)' }
                            : undefined
                        }
                        className={cn(
                          'bg-card border border-border text-muted-foreground hover:text-white h-8 px-3 text-xs',
                          hasDriftVisible && 'border-transparent',
                        )}
                      >
                        {actions.applying ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          'restore'
                        )}
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    {!agentSupportsApply
                      ? 'agent too old'
                      : !remoteApplyEnabled
                        ? 'restore is disabled'
                        : hasDriftVisible
                        ? 'drift detected — restore the stored layout to fix it'
                        : 'restore the stored layout — push it to this machine'}
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
          )}

          {canSiteAdmin && mode === 'edit' && (
            <div className="flex items-center gap-1.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={!isDirty || actions.applying ? 0 : -1}>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!isDirty || actions.applying}
                      onClick={handleSaveDraft}
                      data-testid="display-save-button"
                      className="bg-card border border-border text-muted-foreground hover:text-white h-8 px-3 text-xs"
                    >
                      {actions.applying ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        'store'
                      )}
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {isDirty
                    ? 'store edits as the stored layout'
                    : 'no unsaved changes'}
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={-1}>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleDiscardEdit}
                      data-testid="display-discard-button"
                      className="bg-card border border-border text-muted-foreground hover:text-destructive h-8 px-3 text-xs"
                    >
                      discard
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>discard edits and return to view</TooltipContent>
              </Tooltip>
            </div>
          )}

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleCloseClick}
                className="bg-card border border-border text-muted-foreground hover:text-white h-8 w-8 p-0 shrink-0"
              >
                <X className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>close panel</TooltipContent>
          </Tooltip>
        </div>

        {ackSecondsLeft !== null && (
          <div
            className="mt-3 flex items-center justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
            role="status"
            aria-live="polite"
          >
            <span className="text-amber-200">
              keep this layout? auto-revert in {ackSecondsLeft}s
            </span>
            <Button
              size="sm"
              onClick={handleAckKeep}
              disabled={ackInFlight}
              className="h-7 bg-amber-500 text-black hover:bg-amber-400"
            >
              {ackInFlight ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                'keep'
              )}
            </Button>
          </div>
        )}

        {draftHasOverlap && (
          <div
            className="mt-3 flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-1.5 text-xs text-amber-200"
            role="status"
            aria-live="polite"
          >
            <span>monitors overlap — usually unintentional</span>
          </div>
        )}

        {breakerTripped && canSiteAdmin && (
          <div
            className="mt-3 flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
            role="alert"
            data-testid="display-auto-restore-breaker-banner"
          >
            <div className="flex items-center gap-2 min-w-0">
              <AlertTriangle className="h-4 w-4 text-destructive shrink-0" />
              <span className="text-destructive truncate">
                auto-restore paused — 3 attempts failed. last error:{' '}
                {breakerLastError}.
              </span>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleResetBreaker}
              disabled={actions.applying}
              data-testid="display-auto-restore-reset-button"
              className="h-7 px-2 text-xs shrink-0 bg-transparent border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              reset
            </Button>
          </div>
        )}

        {breakerTripped && !canSiteAdmin && (
          <div
            className="mt-3 flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
            role="status"
            data-testid="display-auto-restore-breaker-readonly"
          >
            <AlertTriangle className="h-4 w-4 text-amber-300 shrink-0" />
            <span className="text-amber-200 truncate">
              auto-restore paused — 3 attempts failed. last error:{' '}
              {breakerLastError}.
            </span>
          </div>
        )}

        <div
          className={cn(
            'grid transition-[grid-template-rows,opacity,margin] duration-300 ease-out',
            testApplyResult !== null
              ? 'mt-3 grid-rows-[1fr] opacity-100'
              : 'mt-0 grid-rows-[0fr] opacity-0',
          )}
        >
          <div className="overflow-hidden">
            {testApplyResult !== null && (
              <div
                key={testApplyResult}
                className="flex items-center justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
                role="status"
                aria-live="polite"
                data-testid="display-test-apply-result"
              >
                <span className="text-amber-200 truncate">
                  {testApplyResult}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setTestApplyResult(null)}
                  className="h-7 w-7 p-0 shrink-0 text-amber-200 hover:bg-amber-500/10 hover:text-amber-100"
                  aria-label="dismiss"
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
            )}
          </div>
        </div>

        <div className="mt-3">{renderBody()}</div>
      </CardContent>

      {/* Store confirmation — replaces the stored layout (including any saved
          edits) with the current live arrangement. */}
      <ConfirmDialog
        open={captureDialogOpen}
        onOpenChange={setCaptureDialogOpen}
        title="store current arrangement?"
        description="this replaces the stored layout (including any saved edits) with the current live arrangement. the agent will keep monitors in this arrangement going forward."
        cancelText="cancel"
        confirmText="store"
        onConfirm={handleCaptureConfirm}
      />

      {/* Restore confirmation — kicks the agent to reconfigure the OS. Title
          includes machineName so bulk-operators don't fire against the wrong
          machine by accident. */}
      <ConfirmDialog
        open={clearDialogOpen}
        onOpenChange={setClearDialogOpen}
        title="clear assigned layout?"
        description="this removes the stored display layout. auto-restore and manual restore will stay unavailable until a layout is stored again."
        cancelText="cancel"
        confirmText="clear"
        variant="destructive"
        onConfirm={handleClearConfirm}
      />

      <ConfirmDialog
        open={applyDialogOpen}
        onOpenChange={setApplyDialogOpen}
        title={`restore this layout to ${machineName || machineId}?`}
        description="monitors will rearrange in a few seconds. owlette will auto-revert if no confirmation arrives within 30 seconds."
        cancelText="cancel"
        confirmText="restore"
        onConfirm={handleApplyConfirm}
      />

      <ConfirmDialog
        open={enableRemoteApplyDialogOpen}
        onOpenChange={setEnableRemoteApplyDialogOpen}
        title={`enable restore on ${machineName || machineId}?`}
        description="this allows owlette admins to remotely restore the stored display layout on this machine. use it only after the display apply test succeeds and you are ready for restore or auto-restore to move monitors."
        cancelText="cancel"
        confirmText="enable restore"
        onConfirm={handleEnableRemoteApply}
      />

      <ConfirmDialog
        open={closeUnsavedDialogOpen}
        onOpenChange={setCloseUnsavedDialogOpen}
        title="discard unsaved edits?"
        description="you have pending draft edits. close will discard them."
        cancelText="keep editing"
        confirmText="discard and close"
        onConfirm={handleDiscardAndClose}
      />

      {/* [A4.3] Hardware-changed prompt. Fires when the live profile's
          signatureHash diverges from the one captured at edit-mode entry —
          a monitor got plugged / unplugged / reconfigured while the
          operator was editing the stored layout. "reload from live" nukes
          the draft and clones the new live topology; "keep editing"
          suppresses the prompt (by advancing the baseline to the current
          hash) so it doesn't re-fire on every render, but leaves the
          draft intact. Escape / overlay close also advance the baseline
          so the operator can explicitly acknowledge and keep going. */}
      <ConfirmDialog
        open={hardwareChangedDuringEdit}
        onOpenChange={(next) => {
          if (!next) {
            // Close of any kind — advance the baseline to suppress
            // re-fire until the next genuine hardware change.
            setEditEntryHash(profile?.signatureHash ?? null);
          }
        }}
        title="hardware changed"
        description="the machine's display configuration changed since you started editing. reload your draft from the new live layout?"
        cancelText="keep editing"
        confirmText="reload from live"
        onConfirm={() => {
          resetToLive(liveMonitors);
          setEditEntryHash(profile?.signatureHash ?? null);
        }}
      />

      {/* [A2.6] Per-monitor editor. Opens from double-click on a canvas rect
          or a table row when the panel is in edit mode on the assigned tab.
          Saves flow through the draft via `updateMonitor`, not Firestore. */}
      <DisplayEditorDialog
        monitor={
          editingMonitorId
            ? cardsMonitors.find((m) => m.id === editingMonitorId) ?? null
            : null
        }
        open={editingMonitorId !== null}
        onClose={() => setEditingMonitorId(null)}
        onSave={(changes) => {
          if (editingMonitorId) updateMonitor(editingMonitorId, changes);
        }}
      />
    </Card>
  );
}
