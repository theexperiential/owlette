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
 *     back in the matching `ackLayout` call. Surfaced in the UI as "restore".
 *   - ackLayout:     acknowledge an in-flight apply within the revert
 *     deadline. Must carry the same `applyId` returned from `applyLayout`.
 *   - clearLayout:   remove the assigned layout entirely. Destructive.
 *
 * All throw on failure; callers are expected to catch and surface a toast.
 * `applying` is flipped on for any in-flight operation.
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
   * Wave 6.3 — dispatch a `test_display_apply` command. The agent spawns
   * the apply helper in self-test mode (query + SDC_VALIDATE only, never
   * SDC_APPLY) so operators can verify the helper IPC works end-to-end
   * before flipping `displays.remoteApplyEnabled` on. Returns the command
   * id only — the structured result lands in the command doc's `result`
   * field, which the panel reads via the existing command-result hook.
   */
  testDisplayApply: () => Promise<string>;
  /**
   * Dispatch an `enumerate_display_modes` command. The agent walks
   * EnumDisplaySettingsExW per monitor and (re-)uploads the per-edidHash
   * catalogue to `sites/{siteId}/machines/{machineId}/hardware/displayModes`,
   * skipping the upload when the topology's signatureHash matches the
   * last-uploaded one. Fire-and-forget from the caller's perspective — the
   * result flows back via the `useDisplayModes` subscription, not the command
   * doc's return string.
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
   * Remove the assigned layout from the config doc. After this fires there is
   * no target layout for the agent to enforce — the machine's display config
   * stays whatever Windows decides on its own (no auto-revert, no drift
   * tracking). Uses `deleteField()` so sibling `displays` keys (e.g.
   * `enabled`, `auto_enforce`) survive untouched.
   */
  const clearLayout = async (): Promise<void> => {
    if (!siteId || !machineId) throw new Error('Site and machine required');

    setApplying(true);
    try {
      const response = await fetch(displayLayoutUrl(siteId, machineId), { method: 'DELETE' });
      if (!response.ok) throw new Error(await readApiError(response, 'Failed to clear display layout'));
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
   * a restore of a legacy non-canonical assigned layout would push a primary
   * at (0, −130) to the agent, which Windows would silently re-anchor on
   * apply and report back as drift on the next heartbeat.
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
   * Acknowledge an in-flight apply. `applyId` must match the id returned
   * from the originating `applyLayout` call — the agent rejects mismatched
   * acks so a stale click on a prior apply can't cancel a newer one's
   * auto-revert watchdog.
   *
   * Must be called within the revert deadline (default 30s) or the agent
   * will have already reverted; a late ack is a no-op.
   */
  const ackLayout = async (applyId: string): Promise<string> => {
    if (!siteId || !machineId) throw new Error('Site and machine required');
    if (!applyId) throw new Error('applyId required');

    return postMachineCommand(siteId, machineId, 'ack_display_topology', { applyId });
  };

  /**
   * Ask the agent to (re-)enumerate the supported display modes for every
   * active monitor. The agent handles cache-by-signatureHash internally, so
   * repeated calls on stable hardware are cheap no-ops at the Firestore level.
   *
   * Consumer pattern: call this when the operator enters edit mode if the
   * cached `hardware/displayModes` doc is missing or its `signatureHash` is
   * stale compared to the current live profile. `useDisplayModes` wraps this
   * with a per-session dedup so the command never fires more than once per
   * (site, machine, hash) tuple in a given tab lifetime.
   */
  const enumerateDisplayModes = async (): Promise<string> => {
    if (!siteId || !machineId) throw new Error('Site and machine required');

    return postMachineCommand(siteId, machineId, 'enumerate_display_modes', {});
  };

  /**
   * Toggle the per-machine auto-restore feature on or off. When the agent sees
   * `displays.autoRestore.enabled === true` on its config doc it begins
   * comparing the live monitor topology against the assigned layout on every
   * heartbeat and silently re-applies the assigned layout when drift is
   * detected (gated by the circuit breaker — see `resetAutoRestoreBreaker`).
   *
   * On enable we also stamp `enabledBy` (operator email) and `enabledAt`
   * (server timestamp) so the dashboard can surface "auto-restore turned on
   * by alice@acme.com on 2026-04-25". On disable we deliberately leave those
   * fields untouched so the historical "who last enabled this" record
   * survives toggling — the `enabled: false` write alone is enough to stop
   * the agent from acting.
   *
   * Uses a nested merge-write so sibling fields under `displays.autoRestore`
   * (notably the agent-managed `circuitBreaker` subtree) are preserved.
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
   * Wave 6.3 — dispatch a `test_display_apply` command. Returns the command
   * id so the caller can subscribe to `commands/completed/{commandId}` for
   * the structured response. Read-only by construction (the agent runs
   * query + SDC_VALIDATE only) so this bypasses the apply kill switch and
   * is safe to invoke on machines with `displays.remoteApplyEnabled: false`.
   */
  const testDisplayApply = async (): Promise<string> => {
    if (!siteId || !machineId) throw new Error('Site and machine required');

    return postMachineCommand(siteId, machineId, 'test_display_apply', {});
  };

  /**
   * Manually reset the auto-restore circuit breaker. After three consecutive
   * apply failures the agent trips the breaker (`tripped: true`) and stops
   * attempting auto-restore until an operator clears it — this prevents a
   * persistently broken layout (e.g. a monitor that was permanently unplugged)
   * from generating an endless retry loop. This method is the operator's
   * "I've fixed the underlying issue, try again" button.
   *
   * Writes only `tripped: false` and `failures: 0` — the agent-written history
   * fields (`lastSuccessAt`, `lastFailureAt`, `lastError`, `trippedAt`) are
   * left intact so the dashboard can still show the last known failure context
   * even after a reset. No audit trail field is added here; the existing
   * timestamps tell the story.
   *
   * Uses a nested merge-write so sibling fields under
   * `displays.autoRestore.circuitBreaker` and elsewhere in the config doc
   * are preserved.
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
    headers: { 'content-type': 'application/json' },
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
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type, params }),
  });
  if (!response.ok) throw new Error(await readApiError(response, 'Failed to dispatch display command'));
  const body = await response.json();
  return body.data?.commandId ?? body.commandId;
}

async function readApiError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json();
    return body.detail ?? body.title ?? `${fallback} (${response.status})`;
  } catch {
    return `${fallback} (${response.status})`;
  }
}
