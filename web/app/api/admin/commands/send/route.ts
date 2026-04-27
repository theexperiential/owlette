import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { authorizedLegacyBodySiteHandler } from '@/lib/authorizedHandler.server';
import { Capability } from '@/lib/capabilities';
import { getAdminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { apiError } from '@/lib/apiErrorResponse';
import logger from '@/lib/logger';

const COMMAND_POLL_INTERVAL_MS = 1500;
const DEFAULT_TIMEOUT_S = 30;
const MAX_TIMEOUT_S = 120;
const LEGACY_ADMIN_SUNSET = 'Wed, 30 Sep 2026 00:00:00 GMT';

/** Allowed data fields per command type. Fields not in this map are stripped. */
const COMMAND_ALLOWED_FIELDS: Record<string, string[]> = {
  restart_process: ['process_name', 'process_id'],
  kill_process: ['process_name', 'process_id'],
  set_launch_mode: ['process_name', 'process_id', 'launch_mode'],
  update_config: ['config'],
  install_software: [
    'installer_url', 'installer_name', 'silent_flags', 'sha256_checksum',
    'verify_path', 'timeout_seconds', 'deployment_id', 'parallel_install',
  ],
  update_owlette: ['installer_url', 'checksum_sha256', 'version'],
  cancel_installation: ['deployment_id'],
  uninstall_software: ['software_name', 'uninstall_command', 'silent_flags', 'timeout_seconds'],
  cancel_uninstall: [],
  refresh_software_inventory: [],
  distribute_project: [
    'distribution_id', 'project_url', 'project_name', 'destination_path',
    'extract_path', 'sha256_checksum', 'post_install_action', 'verify_files',
  ],
  cancel_distribution: ['distribution_id'],
  mcp_tool_call: ['tool_name', 'tool_params', 'cortex_request_id'],
  capture_screenshot: [],
  reboot_machine: ['delay_seconds'],
  shutdown_machine: ['delay_seconds'],
  cancel_reboot: [],
  dismiss_reboot_pending: [],
  provision_cortex_key: ['api_key'],
  start_live_view: ['interval_ms'],
  stop_live_view: [],
};

/**
 * POST /api/admin/commands/send
 *
 * Send a command to a machine via Firestore command queue.
 *
 * Request body:
 *   siteId: string          — Target site
 *   machineId: string       — Target machine
 *   command: string         — Command type (restart_process, kill_process, reboot_machine, etc.)
 *   data?: object           — Command-specific data (e.g., { process_name: "MyApp.exe" })
 *   wait?: boolean          — If true, poll for completion (default: false)
 *   timeout?: number        — Poll timeout in seconds (default: 30, max: 120)
 *
 * Response:
 *   { success: true, commandId: string }                          — if wait=false
 *   { success: true, commandId: string, result: object }          — if wait=true and completed
 *   { success: true, commandId: string, status: "timeout" }       — if wait=true and timed out
 */
export const POST = withRateLimit(
  authorizedLegacyBodySiteHandler({
    capability: Capability.MACHINE_EXEC_COMMAND,
    targetKind: 'machine',
    deprecated: true,
    canonicalUrl: '/api/sites/{siteId}/machines/{machineId}/commands',
    sunsetDate: LEGACY_ADMIN_SUNSET,
    routeName: 'POST /api/admin/commands/send',
  })(
  async (request: NextRequest) => {
    try {
      const body = await request.json();
      const { siteId, machineId, command, data, wait, timeout } = body;

      if (!siteId || !machineId || !command) {
        return NextResponse.json(
          { error: 'Missing required fields: siteId, machineId, command' },
          { status: 400 }
        );
      }

      const db = getAdminDb();
      const commandId = crypto.randomUUID();

      // Write command to pending
      const pendingRef = db
        .collection('sites')
        .doc(siteId)
        .collection('machines')
        .doc(machineId)
        .collection('commands')
        .doc('pending');

      // Filter command data to only allowed fields (prevent field injection)
      const allowedFields = COMMAND_ALLOWED_FIELDS[command] || [];
      const safeData = Object.fromEntries(
        Object.entries(data || {}).filter(([k]) => allowedFields.includes(k))
      );

      await pendingRef.set(
        {
          [commandId]: {
            type: command,
            ...safeData,
            timestamp: FieldValue.serverTimestamp(),
            status: 'pending',
          },
        },
        { merge: true }
      );

      logger.info(`Command sent: ${command} -> ${machineId}`, { context: 'admin/commands' });

      // If not waiting, return immediately
      if (!wait) {
        return NextResponse.json({ success: true, commandId });
      }

      // Poll for completion
      const timeoutMs = Math.min(timeout || DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S) * 1000;
      const completedRef = db
        .collection('sites')
        .doc(siteId)
        .collection('machines')
        .doc(machineId)
        .collection('commands')
        .doc('completed');

      const startTime = Date.now();

      while (Date.now() - startTime < timeoutMs) {
        await new Promise((resolve) => setTimeout(resolve, COMMAND_POLL_INTERVAL_MS));

        const completedDoc = await completedRef.get();
        if (!completedDoc.exists) continue;

        const cmdResult = completedDoc.data()?.[commandId];
        if (cmdResult) {
          // Clean up completed entry
          const { FieldValue } = await import('firebase-admin/firestore');
          await completedRef.update({ [commandId]: FieldValue.delete() });

          return NextResponse.json({ success: true, commandId, result: cmdResult });
        }
      }

      return NextResponse.json({ success: true, commandId, status: 'timeout' });
    } catch (error: unknown) {
      return apiError(error, 'admin/commands/send');
    }
  }),
  { strategy: 'api', identifier: 'ip' }
);
