import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { ApiAuthError, requireAdmin, assertUserHasSiteAccess } from '@/lib/apiAuth.server';
import { getAdminDb } from '@/lib/firebase-admin';
import logger from '@/lib/logger';

const COMMAND_POLL_INTERVAL_MS = 1500;
const DEFAULT_TIMEOUT_S = 30;
const MAX_TIMEOUT_S = 120;

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
  async (request: NextRequest) => {
    try {
      const userId = await requireAdmin(request);
      const body = await request.json();
      const { siteId, machineId, command, data, wait, timeout } = body;

      if (!siteId || !machineId || !command) {
        return NextResponse.json(
          { error: 'Missing required fields: siteId, machineId, command' },
          { status: 400 }
        );
      }

      await assertUserHasSiteAccess(userId, siteId);

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

      await pendingRef.set(
        {
          [commandId]: {
            type: command,
            ...data,
            timestamp: Date.now(),
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
    } catch (error: any) {
      if (error instanceof ApiAuthError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      console.error('admin/commands/send:', error);
      return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
    }
  },
  { strategy: 'user', identifier: 'ip' }
);
