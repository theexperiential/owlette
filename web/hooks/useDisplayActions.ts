'use client';

/**
 * useDisplayActions Hook
 *
 * Firestore mutation hook for display layout operations. All display writes
 * from the dashboard flow through this hook (per the "never call Firestore
 * directly from components" rule).
 *
 * Operations:
 *   - captureLayout: persist the current monitor topology as the "assigned"
 *     layout on the machine's config doc. This is what the machine should
 *     look like after a reboot or driver refresh. Surfaced in the UI as
 *     "store".
 *   - applyLayout:   dispatch an `apply_display_topology` command to the
 *     agent to reconfigure the OS to match the given layout. Returns the
 *     command id + a client-generated `applyId` (UUID) that must be sent
 *     back in the matching `ackLayout` call. Surfaced in the UI as "recall".
 *   - ackLayout:     acknowledge an in-flight apply within the revert
 *     deadline. Must carry the same `applyId` returned from `applyLayout`.
 *   - clearLayout:   remove the assigned layout entirely. Destructive.
 *
 * All throw on failure; callers are expected to catch and surface a toast.
 * `applying` is flipped on for any in-flight operation.
 */

import { useState } from 'react';
import { doc, setDoc, serverTimestamp, deleteField } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { normalizePrimaryToOrigin, type MonitorInfo } from '@/hooks/useDisplayState';

interface ApplyDispatchResult {
  commandId: string;
  applyId: string;
}

interface UseDisplayActionsResult {
  captureLayout: (monitors: MonitorInfo[], userEmail: string) => Promise<void>;
  clearLayout: () => Promise<void>;
  applyLayout: (monitors: MonitorInfo[]) => Promise<ApplyDispatchResult>;
  ackLayout: (applyId: string) => Promise<string>;
  applying: boolean;
}

export function useDisplayActions(siteId: string, machineId: string): UseDisplayActionsResult {
  const [applying, setApplying] = useState(false);

  /**
   * Persist `monitors` as the assigned layout on the config doc. Uses a nested
   * merge-write so sibling fields under `displays` (and the rest of the config
   * doc) are preserved.
   *
   * Normalizes the primary to the origin before writing — Windows pins the
   * primary at (0, 0), so any non-canonical coordinates would either be lost
   * on apply or masquerade as drift on the next heartbeat. This is the final
   * boundary that guarantees stored layouts obey the invariant regardless of
   * what the caller passed in.
   */
  const captureLayout = async (monitors: MonitorInfo[], userEmail: string): Promise<void> => {
    if (!db) throw new Error('Firebase not configured');
    if (!siteId || !machineId) throw new Error('Site and machine required');

    setApplying(true);
    try {
      const configRef = doc(db, 'config', siteId, 'machines', machineId);
      await setDoc(
        configRef,
        {
          displays: {
            assigned: {
              monitors: normalizePrimaryToOrigin(monitors),
              capturedAt: serverTimestamp(),
              capturedBy: userEmail,
            },
          },
        },
        { merge: true },
      );
    } finally {
      setApplying(false);
    }
  };

  /**
   * Remove the assigned layout from the config doc. After this fires there is
   * no target layout for the agent to enforce — the machine's display config
   * stays whatever Windows decides on its own (no auto-revert, no drift
   * tracking). Uses `deleteField()` so sibling `displays` keys (e.g.
   * `enabled`, `auto_enforce`) survive untouched.
   */
  const clearLayout = async (): Promise<void> => {
    if (!db) throw new Error('Firebase not configured');
    if (!siteId || !machineId) throw new Error('Site and machine required');

    setApplying(true);
    try {
      const configRef = doc(db, 'config', siteId, 'machines', machineId);
      await setDoc(
        configRef,
        {
          displays: {
            assigned: deleteField(),
          },
        },
        { merge: true },
      );
    } finally {
      setApplying(false);
    }
  };

  /**
   * Internal: dispatch an `apply_display_topology` command with a
   * client-generated `applyId` (UUID). The agent stamps the same id into
   * the sentinel and requires the follow-up ack to carry it; this closes
   * the "stale ack cancels newer apply" race.
   *
   * Normalizes the primary to the origin before dispatch — mirrors the
   * guarantee `captureLayout` makes at the storage boundary. Without this,
   * a recall of a legacy non-canonical assigned layout would push a primary
   * at (0, −130) to the agent, which Windows would silently re-anchor on
   * apply and report back as drift on the next heartbeat.
   */
  const dispatchTopologyCommand = async (
    monitors: MonitorInfo[],
  ): Promise<ApplyDispatchResult> => {
    if (!db) throw new Error('Firebase not configured');
    if (!siteId || !machineId) throw new Error('Site and machine required');

    const applyId = crypto.randomUUID().replace(/-/g, '');
    const commandId = `apply_display_topology_${Date.now()}`;
    const commandRef = doc(db, 'sites', siteId, 'machines', machineId, 'commands', 'pending');
    await setDoc(
      commandRef,
      {
        [commandId]: {
          type: 'apply_display_topology',
          layout: { monitors: normalizePrimaryToOrigin(monitors) },
          applyId,
          timestamp: serverTimestamp(),
          status: 'pending',
        },
      },
      { merge: true },
    );
    return { commandId, applyId };
  };

  const applyLayout = async (monitors: MonitorInfo[]): Promise<ApplyDispatchResult> => {
    setApplying(true);
    try {
      return await dispatchTopologyCommand(monitors);
    } finally {
      setApplying(false);
    }
  };

  /**
   * Acknowledge an in-flight apply. `applyId` must match the id returned
   * from the originating `applyLayout` call — the agent rejects mismatched
   * acks so a stale click on a prior apply can't cancel a newer one's
   * auto-revert watchdog.
   *
   * Must be called within the revert deadline (default 30s) or the agent
   * will have already reverted; a late ack is a no-op.
   */
  const ackLayout = async (applyId: string): Promise<string> => {
    if (!db) throw new Error('Firebase not configured');
    if (!siteId || !machineId) throw new Error('Site and machine required');
    if (!applyId) throw new Error('applyId required');

    const commandId = `ack_display_topology_${Date.now()}`;
    const commandRef = doc(db, 'sites', siteId, 'machines', machineId, 'commands', 'pending');
    await setDoc(
      commandRef,
      {
        [commandId]: {
          type: 'ack_display_topology',
          applyId,
          timestamp: serverTimestamp(),
          status: 'pending',
        },
      },
      { merge: true },
    );
    return commandId;
  };

  return {
    captureLayout,
    clearLayout,
    applyLayout,
    ackLayout,
    applying,
  };
}
