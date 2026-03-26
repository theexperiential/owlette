import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { ApiAuthError, requireAdminOrIdToken, assertUserHasSiteAccess } from '@/lib/apiAuth.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { getToolByName, EXISTING_COMMAND_MAPPINGS } from '@/lib/mcp-tools';
import logger from '@/lib/logger';

const POLL_INTERVAL_MS = 1500;
const DEFAULT_TIMEOUT_S = 30;
const MAX_TIMEOUT_S = 120;

/**
 * POST /api/admin/tools/execute
 *
 * Execute an MCP tool on a target machine and optionally wait for the result.
 * Validates tool name against the registry before sending.
 *
 * Request body:
 *   siteId: string        — Target site
 *   machineId: string     — Target machine
 *   tool: string          — Tool name (must be registered in mcp-tools.ts)
 *   params?: object       — Tool parameters (validated against schema)
 *   wait?: boolean        — If true, poll for completion (default: true)
 *   timeout?: number      — Poll timeout in seconds (default: 30, max: 120)
 *
 * Response:
 *   { success: true, commandId, tool, tier }                   — if wait=false
 *   { success: true, commandId, tool, tier, result }           — if wait=true and completed
 *   { success: true, commandId, tool, tier, status: "timeout" } — if wait=true and timed out
 */
export const POST = withRateLimit(
  async (request: NextRequest) => {
    try {
      const userId = await requireAdminOrIdToken(request);
      const body = await request.json();
      const {
        siteId,
        machineId,
        tool: toolName,
        params: toolParams = {},
        wait = true,
        timeout,
      } = body;

      // ── Validate required fields ──────────────────────────────────────
      if (!siteId || !machineId || !toolName) {
        return NextResponse.json(
          { error: 'Missing required fields: siteId, machineId, tool' },
          { status: 400 }
        );
      }

      // ── Validate tool exists ──────────────────────────────────────────
      const toolDef = getToolByName(toolName);
      if (!toolDef) {
        return NextResponse.json(
          { error: `Unknown tool: ${toolName}` },
          { status: 400 }
        );
      }

      // ── Validate required params ──────────────────────────────────────
      const requiredParams = toolDef.parameters.required || [];
      for (const param of requiredParams) {
        if (toolParams[param] === undefined || toolParams[param] === null || toolParams[param] === '') {
          return NextResponse.json(
            { error: `Missing required parameter: ${param}` },
            { status: 400 }
          );
        }
      }

      await assertUserHasSiteAccess(userId, siteId);

      const db = getAdminDb();
      const commandId = crypto.randomUUID();

      // ── Route: existing command system or mcp_tool_call ────────────────
      const existingCmd = EXISTING_COMMAND_MAPPINGS[toolName];
      const pendingRef = db
        .collection('sites')
        .doc(siteId)
        .collection('machines')
        .doc(machineId)
        .collection('commands')
        .doc('pending');

      if (existingCmd) {
        // Tier 2 tools use the existing command system
        await pendingRef.set(
          {
            [commandId]: {
              type: existingCmd,
              ...toolParams,
              timestamp: Date.now(),
              status: 'pending',
            },
          },
          { merge: true }
        );
      } else {
        // All other tools use mcp_tool_call
        await pendingRef.set(
          {
            [commandId]: {
              type: 'mcp_tool_call',
              tool_name: toolName,
              tool_params: toolParams,
              timestamp: Date.now(),
              status: 'pending',
              timeout_seconds: Math.min(timeout || DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S),
            },
          },
          { merge: true }
        );
      }

      logger.info(`Tool executed: ${toolName} (tier ${toolDef.tier}) -> ${machineId}`, {
        context: 'admin/tools',
      });

      const base = { success: true, commandId, tool: toolName, tier: toolDef.tier };

      if (!wait) {
        return NextResponse.json(base);
      }

      // ── Poll for result ───────────────────────────────────────────────
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
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

        const completedDoc = await completedRef.get();
        if (!completedDoc.exists) continue;

        const cmdResult = completedDoc.data()?.[commandId];
        if (cmdResult) {
          // Clean up
          const { FieldValue } = await import('firebase-admin/firestore');
          await completedRef.update({ [commandId]: FieldValue.delete() });

          return NextResponse.json({ ...base, result: cmdResult });
        }
      }

      return NextResponse.json({ ...base, status: 'timeout' });
    } catch (error: any) {
      if (error instanceof ApiAuthError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      console.error('admin/tools/execute:', error);
      return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
    }
  },
  { strategy: 'api', identifier: 'ip' }
);
