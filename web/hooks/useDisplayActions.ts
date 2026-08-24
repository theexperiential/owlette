'use client';

/**
 * Firestore mutation hook for display layout ops — all dashboard display writes
 * go through here (never call Firestore directly from components).
 *
 * UI naming: captureLayout is "store", applyLayout is "restore".
 * `applyLayout` returns a client-generated `applyId` that the matching
 * `ackLayout` must echo back, within the revert deadline.
 *
 * All throw on failure; callers catch and toast. `applying` covers any
 * in-flight operation.
 */

import { useState } from 'react';
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
  /**
   * Agent runs the apply helper in self-test mode (query + SDC_VALIDATE, never
   * SDC_APPLY) so operators can verify helper IPC before enabling
   * `displays.remoteApplyEnabled`. Result lands in the command doc's `result`.
   */
  testDisplayApply: () => Promise<string>;
  /**
   * Agent walks EnumDisplaySettingsExW per monitor and re-uploads the
   * per-edidHash catalogue to `hardware/displayModes`, skipping when the
   * topology signatureHash is unchanged. Result arrives via the
   * `useDisplayModes` subscription, not the command doc.
   */
  enumerateDisplayModes: () => Promise<string>;
  setRemoteApplyEnabled: (enabled: boolean) => Promise<void>;
  setAutoRestore: (enabled: boolean, userEmail: string) => Promise<void>;
  resetAutoRestoreBreaker: () => Promise<void>;
  applying: boolean;
}

export function useDisplayActions(siteId: string, machineId: string): UseDisplayActionsResult {
  const [applying, setApplying] = useState(false);

  /**
   * Persist `monitors` as the assigned layout (nested merge-write, so sibling
   * `displays` fields survive).
   *
   * Normalizes the primary to the origin first: Windows pins the primary at
   * (0,0), so non-canonical coords would be lost on apply or read as drift on
   * the next heartbeat. Final boundary — holds whatever the caller passed.
   */
  const captureLayout = async (monitors: MonitorInfo[], userEmail: string): Promise<void> => {
    if (!siteId || !machineId) throw new Error('Site and machine required');

    setApplying(true);
    try {
      await putDisplayLayout(siteId, machineId, {
        op: 'capture',
        monitors: normalizePrimaryToOrigin(monitors),
        capturedBy: userEmail,
      });
    } finally {
      setApplying(false);
    }
  };

  /**
   * Drop the assigned layout: no target for the agent to enforce, no drift
   * tracking, no auto-revert. Uses `deleteField()` so sibling `displays` keys
   * (`enabled`, `auto_enforce`) survive.
   */
  const clearLayout = async (): Promise<void> => {
    if (!siteId || !machineId) throw new Error('Site and machine required');

    setApplying(true);
    try {
      const response = await fetch(displayLayoutUrl(siteId, machineId), {
        method: 'DELETE',
        headers: {
          'Idempotency-Key': makeIdempotencyKey(`display-layout-clear-${machineId}`),
        },
      });
      if (!response.ok) throw new Error(await readApiError(response, 'Failed to clear display layout'));
    } finally {
      setApplying(false);
    }
  };

  /**
   * Dispatch `apply_display_topology` with a client-generated `applyId`. The
   * agent stamps it into the sentinel and requires the ack to carry it, closing
   * the "stale ack cancels newer apply" race.
   *
   * Normalizes the primary to the origin, mirroring `captureLayout`: restoring a
   * legacy layout with a primary at (0,-130) would get silently re-anchored by
   * Windows and reported as drift on the next heartbeat.
   */
  const dispatchTopologyCommand = async (
    monitors: MonitorInfo[],
  ): Promise<ApplyDispatchResult> => {
    if (!siteId || !machineId) throw new Error('Site and machine required');

    const applyId = crypto.randomUUID().replace(/-/g, '');
    const commandId = await postMachineCommand(siteId, machineId, 'apply_display_topology', {
      layout: { monitors: normalizePrimaryToOrigin(monitors) },
      applyId,
    });
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
   * `applyId` must match the originating `applyLayout` — the agent rejects
   * mismatches so a stale click can't cancel a newer apply's revert watchdog.
   * Must land inside the revert deadline (default 30s); a late ack is a no-op.
   */
  const ackLayout = async (applyId: string): Promise<string> => {
    if (!siteId || !machineId) throw new Error('Site and machine required');
    if (!applyId) throw new Error('applyId required');

    return postMachineCommand(siteId, machineId, 'ack_display_topology', { applyId });
  };

  /**
   * Re-enumerate supported modes for every active monitor. The agent caches by
   * signatureHash, so repeat calls on stable hardware are cheap. `useDisplayModes`
   * dedups per (site, machine, hash) for a tab lifetime.
   */
  const enumerateDisplayModes = async (): Promise<string> => {
    if (!siteId || !machineId) throw new Error('Site and machine required');

    return postMachineCommand(siteId, machineId, 'enumerate_display_modes', {});
  };

  /**
   * Toggle per-machine auto-restore. When enabled the agent compares live
   * topology against the assigned layout every heartbeat and silently re-applies
   * on drift (gated by the circuit breaker — see `resetAutoRestoreBreaker`).
   *
   * Enable stamps `enabledBy` / `enabledAt`; disable deliberately leaves them so
   * the "who last enabled this" record survives toggling. Nested merge-write
   * keeps the agent-managed `circuitBreaker` subtree intact.
   */
  const setAutoRestore = async (enabled: boolean, userEmail: string): Promise<void> => {
    if (!siteId || !machineId) throw new Error('Site and machine required');

    setApplying(true);
    try {
      await putDisplayLayout(siteId, machineId, {
        op: 'set_auto_restore',
        enabled,
        ...(enabled ? { enabledBy: userEmail } : {}),
      });
    } finally {
      setApplying(false);
    }
  };

  const setRemoteApplyEnabled = async (enabled: boolean): Promise<void> => {
    if (!siteId || !machineId) throw new Error('Site and machine required');

    setApplying(true);
    try {
      await putDisplayLayout(siteId, machineId, { op: 'set_remote_apply', enabled });
    } finally {
      setApplying(false);
    }
  };

  /**
   * Returns the command id; subscribe to `commands/completed/{commandId}` for the
   * structured response. Read-only by construction (query + SDC_VALIDATE), so it
   * bypasses the apply kill switch and is safe with `remoteApplyEnabled: false`.
   */
  const testDisplayApply = async (): Promise<string> => {
    if (!siteId || !machineId) throw new Error('Site and machine required');

    return postMachineCommand(siteId, machineId, 'test_display_apply', {});
  };

  /**
   * Clear the auto-restore circuit breaker. The agent trips it after three
   * consecutive apply failures so a permanently broken layout (e.g. a monitor
   * unplugged for good) can't retry forever; this is the operator's "fixed it,
   * try again" button.
   *
   * Writes only `tripped: false` / `failures: 0` — agent-written history fields
   * stay so the dashboard can still show the last failure context. Nested
   * merge-write preserves the rest of the config doc.
   */
  const resetAutoRestoreBreaker = async (): Promise<void> => {
    if (!siteId || !machineId) throw new Error('Site and machine required');

    setApplying(true);
    try {
      await putDisplayLayout(siteId, machineId, { op: 'reset_breaker' });
    } finally {
      setApplying(false);
    }
  };

  return {
    captureLayout,
    clearLayout,
    applyLayout,
    ackLayout,
    testDisplayApply,
    enumerateDisplayModes,
    setRemoteApplyEnabled,
    setAutoRestore,
    resetAutoRestoreBreaker,
    applying,
  };
}

function displayLayoutUrl(siteId: string, machineId: string): string {
  return `/api/sites/${encodeURIComponent(siteId)}/machines/${encodeURIComponent(machineId)}/display-layout`;
}

async function putDisplayLayout(
  siteId: string,
  machineId: string,
  body: Record<string, unknown>,
): Promise<void> {
  const response = await fetch(displayLayoutUrl(siteId, machineId), {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      'Idempotency-Key': makeIdempotencyKey(`display-layout-${body.op ?? 'update'}-${machineId}`),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await readApiError(response, 'Failed to update display layout'));
}

async function postMachineCommand(
  siteId: string,
  machineId: string,
  type: string,
  params: Record<string, unknown>,
): Promise<string> {
  const response = await fetch(`/api/sites/${encodeURIComponent(siteId)}/machines/${encodeURIComponent(machineId)}/commands`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Idempotency-Key': makeIdempotencyKey(`display-command-${type}-${machineId}`),
    },
    body: JSON.stringify({ type, params }),
  });
  if (!response.ok) throw new Error(await readApiError(response, 'Failed to dispatch display command'));
  const body = await response.json();
  return body.data?.commandId ?? body.commandId;
}

function makeIdempotencyKey(prefix: string): string {
  const id = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${id}`;
}

async function readApiError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json();
    return body.detail ?? body.title ?? `${fallback} (${response.status})`;
  } catch {
    return `${fallback} (${response.status})`;
  }
}
