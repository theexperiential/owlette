'use client';

import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';

interface MachineStatusPillProps {
  online: boolean;
  rebooting?: boolean;
  shuttingDown?: boolean;
  rebootScheduledAt?: number;    // Unix seconds — TARGET reboot time (when the OS will actually restart)
  shutdownScheduledAt?: number;  // Unix seconds — TARGET shutdown time
  onCancel?: () => Promise<void>;
  isAdmin?: boolean;
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
  isAdmin,
}: MachineStatusPillProps) {
  // Tick every second so the countdown and isActive check stay live.
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  // The pill is active when EITHER the agent has flipped the boolean flag OR
  // the dashboard/agent has set a future scheduled instant. Treating a future
  // scheduledAt as "active" means the countdown shows up the moment the
  // listener sees the doc — no waiting for the boolean flag to round-trip
  // through Firestore separately.
  const hasUpcomingReboot = !!(rebootScheduledAt && rebootScheduledAt > now);
  const hasUpcomingShutdown = !!(shutdownScheduledAt && shutdownScheduledAt > now);
  const showRebootMode = !!rebooting || hasUpcomingReboot;
  const showShutdownMode = !!shuttingDown || hasUpcomingShutdown;
  const isActive = showRebootMode || showShutdownMode;
  const scheduledAt = showRebootMode ? rebootScheduledAt : showShutdownMode ? shutdownScheduledAt : undefined;
  const actionLabel = showShutdownMode ? 'shutting down' : 'rebooting';

  useEffect(() => {
    if (!isActive) return;
    setNow(Math.floor(Date.now() / 1000));
    const interval = setInterval(() => {
      setNow(Math.floor(Date.now() / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [isActive]);

  // Optimistic cancelling state — clears once parent flips rebooting/shuttingDown back to false
  const [cancelling, setCancelling] = useState(false);
  useEffect(() => {
    if (!isActive) setCancelling(false);
  }, [isActive]);

  // Idle state: original online/offline pill, no interactivity
  if (!isActive) {
    return (
      <Badge className={`text-xs select-none ${online ? 'bg-green-600' : 'bg-red-600'}`}>
        {online ? 'online' : 'offline'}
      </Badge>
    );
  }

  // Active state: red pulsing pill with countdown.
  // scheduledAt is the TARGET reboot/shutdown time in Unix seconds; remaining
  // is simply (target - now). This is what the agent writes for both scheduled
  // reboots (announce phase) and dashboard-initiated reboots (optimistic write).
  const remaining = scheduledAt
    ? Math.max(0, scheduledAt - now)
    : null;

  // Graceful degradation: legacy/missing timestamp → static pulsing pill, no countdown
  if (remaining === null) {
    return (
      <Badge className="text-xs select-none bg-red-600 animate-pulse">
        {actionLabel}…
      </Badge>
    );
  }

  // Cancelling in flight
  if (cancelling) {
    return (
      <Badge className="text-xs select-none bg-red-600 animate-pulse">
        cancelling…
      </Badge>
    );
  }

  const canCancel = isAdmin && !!onCancel && remaining > CANCEL_LOCKOUT_THRESHOLD;

  // Final 5 seconds OR non-admin OR no cancel handler: text-only, no interaction
  if (!canCancel) {
    return (
      <Badge className="text-xs select-none bg-red-600 animate-pulse">
        {actionLabel}…
      </Badge>
    );
  }

  // Clickable countdown with hover swap
  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setCancelling(true);
    try {
      await onCancel!();
    } catch {
      setCancelling(false);
    }
  };

  return (
    <Badge
      asChild
      className="text-xs select-none bg-red-600 hover:bg-red-700 animate-pulse cursor-pointer p-0"
    >
      <button
        type="button"
        onClick={handleClick}
        title="click to cancel"
        className="group relative px-2 py-0.5 tabular-nums"
      >
        <span className="group-hover:invisible">{formatMMSS(remaining)}</span>
        <span className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100">
          cancel
        </span>
      </button>
    </Badge>
  );
}
