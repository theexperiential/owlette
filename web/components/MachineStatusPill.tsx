'use client';

import { useEffect, useState } from 'react';
import { Power, RotateCw, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

interface MachineStatusPillProps {
  online: boolean;
  rebooting?: boolean;
  shuttingDown?: boolean;
  rebootScheduledAt?: number;    // Unix seconds — TARGET restart time (when the OS will actually restart). Field name kept as the agent-written wire contract.
  shutdownScheduledAt?: number;  // Unix seconds — TARGET shutdown time
  onCancel?: () => Promise<void>;
  isSiteAdmin?: boolean;
}

const CANCEL_LOCKOUT_THRESHOLD = 5; // Hide cancel in final 5s — Windows shutdown /a is unreliable

function formatMMSS(seconds: number): string {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = (seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

export function MachineStatusPill({
  online,
  rebooting,
  shuttingDown,
  rebootScheduledAt,
  shutdownScheduledAt,
  onCancel,
  isSiteAdmin,
}: MachineStatusPillProps) {
  // Tick every second so the countdown and isActive check stay live.
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  // The pill is active when EITHER the agent has flipped the boolean flag OR
  // the dashboard/agent has set a future scheduled instant. Treating a future
  // scheduledAt as "active" means the countdown shows up the moment the
  // listener sees the doc — no waiting for the boolean flag to round-trip
  // through Firestore separately.
  const hasUpcomingRestart = !!(rebootScheduledAt && rebootScheduledAt > now);
  const hasUpcomingShutdown = !!(shutdownScheduledAt && shutdownScheduledAt > now);
  const showRestartMode = !!rebooting || hasUpcomingRestart;
  // A shutdown's terminal state is "offline". The agent sets `shuttingDown`
  // before issuing the OS shutdown but can never clear it afterwards (the box
  // is powered off), so the latch stays set in Firestore indefinitely. Treat
  // "latch set but machine offline" as a completed shutdown and fall through to
  // the offline pill rather than pulsing "shutting down…" forever. A still-
  // future scheduled shutdown keeps its countdown regardless of online state.
  // (Restart deliberately stays active across the offline reboot gap — its
  // terminal state is back-online, and the agent clears the flag on next boot.)
  const showShutdownMode = (!!shuttingDown && online) || hasUpcomingShutdown;
  const isActive = showRestartMode || showShutdownMode;
  const scheduledAt = showRestartMode ? rebootScheduledAt : showShutdownMode ? shutdownScheduledAt : undefined;
  const actionLabel = showShutdownMode ? 'shutting down' : 'restarting';
  // Compact icon for the active pill. The status column is a fixed 72px cell
  // (the list view is table-layout:fixed), so we render an icon + countdown that
  // fits rather than the full label — which would overflow into the cpu column.
  // The words are exposed via title/aria-label instead.
  const ActionIcon = showShutdownMode ? Power : RotateCw;

  useEffect(() => {
    if (!isActive) return;
    // No sync setNow before the interval — that tripped
    // react-hooks/set-state-in-effect. `now` starts at the mount value and
    // the first interval tick catches it up within 1s of activation.
    const interval = setInterval(() => {
      setNow(Math.floor(Date.now() / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [isActive]);

  // Optimistic cancelling state — derived so it auto-clears when parent flips
  // rebooting/shuttingDown back to false (no effect needed).
  const [userCancelling, setUserCancelling] = useState(false);
  const cancelling = isActive && userCancelling;

  // Idle state: original online/offline pill, no interactivity
  if (!isActive) {
    return (
      <Badge className={`text-xs select-none ${online ? 'bg-green-600' : 'bg-red-600'}`}>
        {online ? 'online' : 'offline'}
      </Badge>
    );
  }

  // Active state: compact red pulsing icon pill (+ live countdown). scheduledAt is
  // the TARGET restart/shutdown instant in Unix seconds; remaining is (target - now).
  // The agent writes scheduledAt for both scheduled restarts (announce phase) and
  // dashboard-initiated restarts (optimistic write).
  const remaining = scheduledAt
    ? Math.max(0, scheduledAt - now)
    : null;

  // Graceful degradation: legacy/missing timestamp → icon-only pulsing pill, no countdown.
  if (remaining === null) {
    return (
      <Badge
        role="img"
        className="text-xs select-none bg-red-600 animate-pulse px-1.5"
        title={actionLabel}
        aria-label={actionLabel}
      >
        <ActionIcon className="h-3 w-3" aria-hidden="true" />
      </Badge>
    );
  }

  // Cancelling in flight — spinner.
  if (cancelling) {
    return (
      <Badge
        role="img"
        className="text-xs select-none bg-red-600 px-1.5"
        title="cancelling"
        aria-label="cancelling"
      >
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
      </Badge>
    );
  }

  const canCancel = isSiteAdmin && !!onCancel && remaining > CANCEL_LOCKOUT_THRESHOLD;

  // Final 5 seconds OR non-admin OR no cancel handler: icon + countdown, no interaction.
  if (!canCancel) {
    return (
      <Badge
        role="img"
        className="text-xs select-none bg-red-600 animate-pulse px-1 tabular-nums"
        title={actionLabel}
        aria-label={`${actionLabel}, ${formatMMSS(remaining)} remaining`}
      >
        <ActionIcon className="h-3 w-3" aria-hidden="true" />
        {formatMMSS(remaining)}
      </Badge>
    );
  }

  // Clickable icon + countdown with hover swap to "cancel".
  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setUserCancelling(true);
    try {
      await onCancel!();
    } catch {
      setUserCancelling(false);
    }
  };

  return (
    <Badge
      asChild
      className="text-xs select-none bg-red-600 hover:bg-red-700 animate-pulse cursor-pointer p-0 tabular-nums"
    >
      <button
        type="button"
        onClick={handleClick}
        title="click to cancel"
        aria-label={`${actionLabel}, ${formatMMSS(remaining)} remaining — click to cancel`}
        data-testid="machine-status-cancel-pill"
        className="group relative px-1 py-0.5"
      >
        <ActionIcon className="h-3 w-3 group-hover:invisible" aria-hidden="true" />
        <span className="group-hover:invisible">{formatMMSS(remaining)}</span>
        <span className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100">
          cancel
        </span>
      </button>
    </Badge>
  );
}
