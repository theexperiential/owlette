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
 * Action buttons (store / recall) are wired via useDisplayActions. Recall
 * is the single primary action — when drift is detected, its border turns
 * amber so the same button reads as "undo drift" in that context.
 *
 * Permission gating: store / recall are write operations and are hidden
 * entirely for non-admins (read-only view).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Loader2, Monitor, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import {
  useDisplayState,
  computeDisplayDrift,
  type MonitorInfo,
} from '@/hooks/useDisplayState';
import { useDisplayActions } from '@/hooks/useDisplayActions';
import { useDisplayDraft } from '@/hooks/useDisplayDraft';
import { DisplayCanvas } from './DisplayCanvas';
import { DisplayMonitorTable } from './DisplayMonitorTable';
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

type DisplayTab = 'live' | 'assigned';

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
  const { profile, assigned, loading, error } = useDisplayState(siteId, machineId);
  // `applying` drives the disabled-state on every write button so repeat-clicks
  // during in-flight operations are blocked at the UI boundary.
  const actions = useDisplayActions(siteId, machineId);

  const [activeTab, setActiveTab] = useState<DisplayTab>('live');
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [selectedMonitorId, setSelectedMonitorId] = useState<string | undefined>(
    undefined,
  );
  const [captureDialogOpen, setCaptureDialogOpen] = useState(false);
  const [applyDialogOpen, setApplyDialogOpen] = useState(false);
  const [clearDialogOpen, setClearDialogOpen] = useState(false);
  const [closeUnsavedDialogOpen, setCloseUnsavedDialogOpen] = useState(false);

  const { draft, isDirty, updateMonitor, resetToLive, clearDraft } = useDisplayDraft({
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

  // Post-apply ack state. When a dispatch succeeds we store the wall-clock
  // deadline (Date.now() + ack_timeout_ms) and the apply's generation token.
  // The countdown displayed in the banner is derived from the deadline on
  // every tick — so tab throttling / backgrounding / clock drift don't
  // lie about how much time is left. `pendingApplyId` is threaded back
  // into the ack so a stale keep-click on a prior apply can't cancel the
  // current watchdog.
  const [ackDeadlineMs, setAckDeadlineMs] = useState<number | null>(null);
  const [pendingApplyId, setPendingApplyId] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const ackSecondsLeft = useMemo(() => {
    if (ackDeadlineMs === null) return null;
    return Math.max(0, Math.ceil((ackDeadlineMs - nowMs) / 1000));
  }, [ackDeadlineMs, nowMs]);

  // Drift is keyed on live monitor id and computed from the live+assigned
  // snapshot. A missing assigned layout yields an empty map, which the UI
  // renders as "no assigned layout" in the status card.
  const driftMap = useMemo(() => {
    if (!profile || !assigned) return new Map<string, string[]>();
    return computeDisplayDrift(profile.monitors, assigned.monitors);
  }, [profile, assigned]);

  const driftCount = driftMap.size;
  const hasDrift = driftCount > 0;

  // [RECONSTRUCTED — Wave A1.4] Drift signals are zeroed in edit mode so the
  // user isn't flagged for changes they are deliberately making. Raw hasDrift
  // stays available for non-UI math paths; UI surfaces use the hasDriftVisible
  // / effectiveDriftCount forms.
  const effectiveDriftCount = mode === 'edit' ? 0 : driftCount;
  const hasDriftVisible = mode === 'edit' ? false : hasDrift;

  // Stable Set of drifted monitor ids — passed to the canvas so it can
  // amber-stroke drifted rects. Memoized so the Set identity is stable
  // across renders when the underlying drift map hasn't changed.
  const driftedMonitorIds = useMemo(
    () => new Set(driftMap.keys()),
    [driftMap],
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
  // in sync. Ghost overlay is only meaningful on the live tab, and only when
  // there's an assigned layout to compare against.
  const cardsMonitors = activeTab === 'live' ? sortedLive : sortedAssigned;
  const canvasMonitors =
    activeTab === 'live' ? liveMonitors : effectiveAssignedMonitors;
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
  // current mode reads as one coherent color.
  const tabAccentColor =
    activeTab === 'live' ? 'var(--primary)' : 'var(--chart-4)';

  const hasLiveProfile = !!profile && liveMonitors.length > 0;
  const hasAssignedLayout = !!assigned && assignedMonitors.length > 0;

  // [RECONSTRUCTED — Wave A1.2] Defensive render-phase guard: if the admin
  // flag disappears or the assigned layout gets cleared mid-edit, drop back
  // to view. Uses the same pattern as useDisplayDraft's prevMode tracker.
  if (mode === 'edit' && (!canSiteAdmin || !hasAssignedLayout)) {
    setMode('view');
  }

  // Button disabled-state logic:
  //  - store: needs live data to store (otherwise there's nothing to save)
  //  - recall: needs an assigned layout to push
  // `actions.applying` blocks repeat-clicks during in-flight writes.
  const captureDisabled = !hasLiveProfile || actions.applying;
  const applyDisabled = !hasAssignedLayout || actions.applying;
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
      `display drift detected on ${machineName || machineId} — ${driftCount} ${noun}. open assigned tab to review.`,
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

  // Apply dispatches the assigned layout to the agent. On success we start
  // a 30s ack countdown — the operator must click "keep" in the banner or
  // the agent auto-reverts. ConfirmDialog closes itself on confirm; on
  // error we reopen so the user can retry.
  const handleApplyConfirm = async () => {
    try {
      const { applyId } = await actions.applyLayout(assignedMonitors);
      toast.success('recall dispatched — monitors will change shortly');
      setPendingApplyId(applyId);
      setAckDeadlineMs(Date.now() + 30_000);
      setNowMs(Date.now());
    } catch (e) {
      console.error('Failed to recall display layout', e);
      toast.error(`recall failed: ${formatError(e)}`);
      setApplyDialogOpen(true);
    }
  };

  // Dispatch ack and clear the countdown banner. The applyId threaded
  // through ensures the agent only acks the apply this banner corresponds
  // to — a stale click on a prior apply is rejected.
  const handleAckKeep = async () => {
    const applyId = pendingApplyId;
    setAckDeadlineMs(null);
    setPendingApplyId(null);
    if (!applyId) return;
    try {
      await actions.ackLayout(applyId);
      toast.success('layout kept');
    } catch (e) {
      console.error('Failed to ack display layout', e);
      toast.error(`keep failed: ${formatError(e)}`);
    }
  };

  // Drive the countdown from an absolute deadline, not a decrementing state.
  // `setInterval` at 250ms keeps the displayed value accurate when the tab
  // is backgrounded (Chrome/Firefox throttle timers to ≥1s there, so a
  // state-based countdown drifts — using the wall clock corrects on resume).
  // State-mutation for the auto-revert transition happens inside the tick
  // callback, keeping the effect a pure synchronizer.
  useEffect(() => {
    if (ackDeadlineMs === null) return;
    const tick = () => {
      const now = Date.now();
      if (now >= ackDeadlineMs) {
        toast.error('no confirmation sent — agent will auto-revert');
        setAckDeadlineMs(null);
        setPendingApplyId(null);
        return;
      }
      setNowMs(now);
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [ackDeadlineMs]);

  // Clear is destructive (operator loses the saved baseline) so it goes
  // through a confirmation dialog. The agent stops drift-tracking once the
  // assigned layout is gone — Windows is free to do whatever it wants.
  const handleClearConfirm = async () => {
    try {
      await actions.clearLayout();
      toast.success('assigned layout cleared');
    } catch (e) {
      console.error('Failed to clear assigned layout', e);
      toast.error(`clear failed: ${formatError(e)}`);
      setClearDialogOpen(true);
    }
  };

  // [RECONSTRUCTED — Wave A1.2] Close-with-unsaved-changes gate. Ack countdown
  // disables the close button via the existing disabled prop; this handler
  // only fires for the clean case.
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
  };

  const handleResetToLive = () => {
    resetToLive(liveMonitors);
  };

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

  const renderBody = () => {
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

    if (activeTab === 'assigned' && !hasAssignedLayout) {
      return (
        <div className="h-[320px] flex flex-col items-center justify-center px-6 text-center gap-3">
          <p className="text-sm text-muted-foreground max-w-md">
            no assigned layout yet. store the live arrangement to make it the
            one owlette keeps in place.
          </p>
          {canSiteAdmin && (
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
          )}
        </div>
      );
    }

    return (
      <div className="animate-in fade-in duration-100 grid grid-cols-1 md:grid-cols-2 gap-0">
        <div className="min-w-0 h-[280px] border border-border rounded-l-lg md:border-r-0 overflow-hidden">
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
            editable={mode === 'edit' && activeTab === 'assigned'}
            onMonitorMove={
              mode === 'edit' && activeTab === 'assigned'
                ? handleMonitorMove
                : undefined
            }
            className="h-[280px]"
          />
        </div>

        <DisplayMonitorTable
          monitors={cardsMonitors}
          selectedMonitorId={selectedMonitorId}
          onSelect={handleMonitorClick}
          accentColor={tabAccentColor}
          driftMap={
            mode === 'edit'
              ? undefined
              : activeTab === 'live'
                ? driftMap
                : undefined
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
    const ringColor = tab === 'live' ? 'var(--primary)' : 'var(--chart-4)';
    return (
      <Button
        key={tab}
        variant={isActive ? 'default' : 'outline'}
        size="sm"
        onClick={() => setActiveTab(tab)}
        style={isActive ? { boxShadow: `inset 0 0 0 1px ${ringColor}` } : undefined}
        className={cn(
          'h-8 px-3 text-xs transition-colors',
          isActive
            ? 'bg-accent text-foreground border-transparent hover:bg-accent'
            : 'bg-card text-muted-foreground border-border hover:bg-accent/40 hover:text-foreground',
        )}
      >
        <span>{label}</span>
        {badge && (
          <span className="ml-1.5 flex items-center gap-1 text-[10px] text-accent-coral">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent-coral" />
            {badge}
          </span>
        )}
      </Button>
    );
  };

  return (
    <Card
      data-testid="display-layout-panel"
      className="border-border bg-card py-0 gap-0"
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
              hasDriftVisible ? `(${effectiveDriftCount})` : undefined,
            )}
            {mode === 'edit' && (
              <span className="text-[10px] text-muted-foreground px-2 py-1 rounded bg-muted/40 border border-border">
                editing stored — drift check paused
              </span>
            )}
          </div>

          <div className="flex-1" />

          {/* [RECONSTRUCTED — Wave A1.2] Admin action block is mode-aware:
              view-mode shows store/recall/clear/edit; edit-mode shows
              save/discard/reset-to-live. Exact button ordering, tooltips,
              and classes here are best-effort; the subagent reported that
              every button matches the existing store/recall styling
              (bg-card border border-border text-muted-foreground
              hover:text-white h-8 px-3 text-xs). */}
          {canSiteAdmin && mode === 'view' && (
            <div className="flex items-center gap-1.5">
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
                        'capture'
                      )}
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  capture the current live arrangement as the assigned layout
                  (replaces any saved edits)
                </TooltipContent>
              </Tooltip>
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
                        'recall'
                      )}
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {hasDriftVisible
                    ? 'drift detected — recall the assigned layout to fix it'
                    : 'recall the assigned layout — push it to this machine'}
                </TooltipContent>
              </Tooltip>
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
                    delete the assigned layout — agent stops enforcing it
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
                        : 'edit the assigned layout'}
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
                        'save'
                      )}
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {isDirty
                    ? 'save draft as the assigned layout'
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
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={!hasLiveProfile ? 0 : -1}>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!hasLiveProfile}
                      onClick={handleResetToLive}
                      data-testid="display-reset-to-live-button"
                      className="bg-card border border-border text-muted-foreground hover:text-white h-8 px-3 text-xs"
                    >
                      reset to live
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  replace draft with the current live arrangement
                </TooltipContent>
              </Tooltip>
            </div>
          )}

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleCloseClick}
                disabled={ackSecondsLeft !== null}
                className="bg-card border border-border text-muted-foreground hover:text-white h-8 w-8 p-0 shrink-0"
              >
                <X className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {ackSecondsLeft !== null
                ? 'confirm or wait for auto-revert before closing'
                : 'close panel'}
            </TooltipContent>
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
              className="h-7 bg-amber-500 text-black hover:bg-amber-400"
            >
              keep
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

        <div className="mt-3">{renderBody()}</div>
      </CardContent>

      {/* Store confirmation — replaces whatever layout is currently saved. */}
      <ConfirmDialog
        open={captureDialogOpen}
        onOpenChange={setCaptureDialogOpen}
        title="store current arrangement?"
        description="this replaces your saved layout. the agent will keep monitors in this arrangement going forward."
        cancelText="cancel"
        confirmText="store"
        onConfirm={handleCaptureConfirm}
      />

      {/* Recall confirmation — kicks the agent to reconfigure the OS. Title
          includes machineName so bulk-operators don't fire against the wrong
          machine by accident. */}
      <ConfirmDialog
        open={applyDialogOpen}
        onOpenChange={setApplyDialogOpen}
        title={`recall this layout to ${machineName || machineId}?`}
        description="monitors will rearrange in a few seconds. owlette will auto-revert if no confirmation arrives within 30 seconds."
        cancelText="cancel"
        confirmText="recall"
        onConfirm={handleApplyConfirm}
      />

      {/* Clear confirmation — destructive: removes the saved baseline so the
          agent stops drift-tracking and stops auto-restoring after reboot. */}
      <ConfirmDialog
        open={clearDialogOpen}
        onOpenChange={setClearDialogOpen}
        title="clear assigned layout?"
        description="the agent will stop enforcing this layout. your monitors stay where they are right now, but owlette will no longer auto-restore them after reboot or driver changes."
        cancelText="cancel"
        confirmText="clear"
        onConfirm={handleClearConfirm}
      />

      {/* [RECONSTRUCTED — Wave A1.2] Close-with-unsaved-changes confirmation.
          Exact copy is reconstructed from subagent intent ("discard and close"
          / "keep editing") and may differ from the actual shipped text. */}
      <ConfirmDialog
        open={closeUnsavedDialogOpen}
        onOpenChange={setCloseUnsavedDialogOpen}
        title="discard unsaved edits?"
        description="you have pending draft edits. close will discard them."
        cancelText="keep editing"
        confirmText="discard and close"
        onConfirm={handleDiscardAndClose}
      />
    </Card>
  );
}
