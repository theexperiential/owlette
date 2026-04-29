/**
 * sync_pull command payload contract.
 *
 * The pure builder + id helper for the command queued onto each
 * machine's `commands/pending` doc. Three call sites must stay aligned:
 *
 *   - `functions/src/distributionFanout.ts` (canary/fleet rollout trigger)
 *   - `web/app/api/roosts/[roostId]/deploy/route.ts`
 *   - `web/app/api/roosts/[roostId]/resync/route.ts`
 *
 * The agent's handler at `agent/src/sync_commands.py:_handle_sync_pull`
 * calls `_require_str(cmd_data, '<field>')` for every key emitted here.
 * A renamed or missing field crashes the agent before any disk work.
 *
 * Pure (no firebase-admin imports) so a contract test can pin field
 * names without spinning up the firestore client.
 */

export function buildSyncPullCommand(
  siteId: string,
  roostId: string,
  versionId: string,
  versionUrl: string,
  extractRoot: string,
  queuedAt: unknown,
): Record<string, unknown> {
  return {
    type: 'sync_pull',
    site_id: siteId,
    roost_id: roostId,
    version_id: versionId,
    version_url: versionUrl,
    extract_root: extractRoot,
    queued_at: queuedAt,
  };
}

export function syncPullCommandId(roostId: string, versionId: string): string {
  return `roost_sync_${roostId}_${versionId}`;
}
