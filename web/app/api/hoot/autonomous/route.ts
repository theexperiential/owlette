/**
 * POST /api/hoot/autonomous
 *
 * Internal endpoint triggered by the agent alert system when a process crashes
 * or fails to start. Runs an autonomous LLM investigation loop using generateText()
 * with tool calling to diagnose and remediate the issue.
 *
 * Auth: hoot internal shared secret (deployed env var CORTEX_INTERNAL_SECRET),
 * NOT a user session.
 * This endpoint is called by the alert route after verifying the agent's identity.
 *
 * Flow:
 * 1. Validate internal secret + request body
 * 2. Check autonomous mode enabled for site
 * 3. Dedup/cooldown check (same machine+process within cooldown window)
 * 4. Concurrency check (max 3 active sessions per site)
 * 5. Create hoot-event record
 * 6. Return accepted response immediately
 * 7. Run LLM investigation in background (fire-and-forget)
 * 8. Save conversation + update event status
 * 9. Escalate if unresolved
 */

import { NextRequest, NextResponse } from 'next/server';
import { generateText, stepCountIs, tool, jsonSchema } from 'ai';
import { Timestamp, FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import { apiError } from '@/lib/apiErrorResponse';
import { createModel, buildAutonomousSystemPrompt } from '@/lib/llm';
import { getToolsByTier, EXISTING_COMMAND_MAPPINGS, type McpToolDefinition } from '@/lib/mcp-tools';
import {
  resolveLlmConfig,
  isMachineOnline,
  isHootEnabled,
  executeServerSideTool,
  SERVER_SIDE_TOOLS,
  type BuildExecutableToolsOptions,
} from '@/lib/hoot-utils.server';
import {
  dispatchToolCallAsSystem,
  dispatchExistingCommandAsSystem,
} from '@/lib/hoot/dispatch.server';
import { escalate } from '@/lib/hoot-escalation.server';
import { emitSecurityBoundaryMetric } from '@/lib/securityBoundaryMetrics.server';
import { hootInternalSecret } from '@/lib/hootInternalSecret';

const MAX_STEPS = 15;
const MAX_CONCURRENT_SESSIONS = 3;
const DEFAULT_COOLDOWN_MINUTES = 15;

interface AutonomousRequest {
  siteId: string;
  machineId: string;
  machineName: string;
  eventType: 'process_crash' | 'process_start_failed';
  processName: string;
  errorMessage: string;
  agentVersion?: string;
  nonce?: string;
}

interface HootSettings {
  autonomousEnabled?: boolean;
  directive?: string;
  maxTier?: number;
  autonomousModel?: string;
  maxEventsPerHour?: number;
  cooldownMinutes?: number;
  escalationEmail?: boolean;
}

function emitHootEventMetric(
  name: 'cortex_events_incoming_total' | 'cortex_events_processed_total',
  params: {
    siteId: string;
    machineId: string;
    eventId?: string;
    status?: string;
    eventType?: string;
    durationMs?: number;
  },
): void {
  emitSecurityBoundaryMetric(name, 1, {
    labels: {
      site: params.siteId,
      status: params.status,
      eventType: params.eventType,
    },
    fields: {
      machineId: params.machineId,
      eventId: params.eventId,
      durationMs: params.durationMs,
    },
  });
}

/**
 * Tools an unattended investigator must never call.
 *
 * Authoring a talon or flipping its enabled state changes standing fleet
 * automation policy, which outlives the incident being investigated — that
 * stays a human decision even when the tier ceiling would otherwise allow it.
 * Read-only talon tools (e.g. `list_talons`) are deliberately NOT excluded.
 * Matched by name so the policy holds regardless of whether the tools are
 * present in the registry.
 */
const AUTONOMOUS_EXCLUDED_TOOLS: ReadonlySet<string> = new Set([
  'create_talon',
  'set_talon_enabled',
]);

/**
 * Build executable tools for autonomous mode (single machine, no streaming).
 *
 * security-boundary-migration wave 3.12 — every agent dispatch flows through
 * `invokeAsSystem` (via `dispatchToolCallAsSystem` /
 * `dispatchExistingCommandAsSystem`) so the cortex_autonomous actor's
 * audit rows + system rate-limit bucket are honored. Those tool
 * implementations live on the agent — only the dispatch layer changed.
 *
 * `SERVER_SIDE_TOOLS` are the exception: they have no handler in
 * agent/src/mcp_tools.py, so they run here on the web server (same system
 * identity, `systemActor: 'cortex_autonomous'`).
 *
 * Separate from the shared buildExecutableTools to avoid the `tool()` import issue
 * with generateText vs streamText — they use the same tool() helper.
 */
function buildAutonomousTools(
  db: FirebaseFirestore.Firestore,
  siteId: string,
  machineId: string,
  chatId: string,
  eventId: string,
  toolDefs: McpToolDefinition[]
) {
  const dispatchCtx = { db, siteId, machineId, chatId, eventId };
  // No chatId/userId: an autonomous run has no session behind it, so
  // server-side mutations are audited as `system:cortex_autonomous`.
  const serverSideOptions: BuildExecutableToolsOptions = { systemActor: 'cortex_autonomous' };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: Record<string, any> = {};

  for (const def of toolDefs) {
    const toolName = def.name;
    if (AUTONOMOUS_EXCLUDED_TOOLS.has(toolName)) continue;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools[toolName] = tool<any, any>({
      description: def.description,
      inputSchema: jsonSchema(def.parameters as Record<string, unknown>),
      execute: async (params) => {
        if (SERVER_SIDE_TOOLS.has(toolName)) {
          return executeServerSideTool(
            db,
            siteId,
            [machineId],
            toolName,
            params as Record<string, unknown>,
            serverSideOptions,
          );
        }
        const existingCmd = EXISTING_COMMAND_MAPPINGS[toolName];
        if (existingCmd) {
          return dispatchExistingCommandAsSystem(
            dispatchCtx,
            existingCmd,
            params as Record<string, unknown>,
          );
        }
        return dispatchToolCallAsSystem(dispatchCtx, toolName, params as Record<string, unknown>);
      },
    });
  }

  return tools;
}

export async function POST(request: NextRequest) {
  try {
    // 1. Validate internal secret
    const secret = request.headers.get('x-cortex-secret');
    const expectedSecret = hootInternalSecret();
    if (!expectedSecret || secret !== expectedSecret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 2. Parse & validate body
    const body = await request.json() as AutonomousRequest;
    const { siteId, machineId, machineName, eventType, processName, errorMessage, agentVersion, nonce } = body;

    if (!siteId || !machineId || !processName || !eventType) {
      return NextResponse.json(
        { error: 'Missing required fields: siteId, machineId, processName, eventType' },
        { status: 400 }
      );
    }

    const db = getAdminDb();

    // 3. Read directive config
    const hootSettingsDoc = await db.doc(`sites/${siteId}/settings/cortex`).get();
    const settings = (hootSettingsDoc.data() ?? {}) as HootSettings;

    if (!settings.autonomousEnabled) {
      return NextResponse.json({ accepted: false, reason: 'autonomous_disabled' });
    }

    // 4. Dedup check — same machine+process within cooldown window
    //    Also dedup by nonce if provided (prevents replay attacks)
    const cooldownMs = (settings.cooldownMinutes ?? DEFAULT_COOLDOWN_MINUTES) * 60 * 1000;
    const cutoffTime = Timestamp.fromMillis(Date.now() - cooldownMs);

    const recentEvents = await db
      .collection(`sites/${siteId}/cortex-events`)
      .where('machineId', '==', machineId)
      .where('processName', '==', processName)
      .where('timestamp', '>', cutoffTime)
      .limit(1)
      .get();

    if (!recentEvents.empty) {
      const existingEvent = recentEvents.docs[0].data();
      console.log(`[hoot/autonomous] Dedup: skipping ${machineId}:${processName} (existing event ${existingEvent.status})`);
      return NextResponse.json({ accepted: false, reason: 'cooldown_active' });
    }

    // Nonce-based dedup: reject exact replay of same request
    if (nonce) {
      const nonceRef = db.doc(`sites/${siteId}/cortex-nonces/${nonce}`);
      const nonceDoc = await nonceRef.get();
      if (nonceDoc.exists) {
        console.log(`[hoot/autonomous] Nonce replay blocked: ${nonce}`);
        return NextResponse.json({ accepted: false, reason: 'duplicate_nonce' });
      }
      // Store nonce with TTL (cleaned up by cooldown window naturally)
      await nonceRef.set({ machineId, processName, timestamp: FieldValue.serverTimestamp() });
    }

    // 5. Concurrency check — max sessions per site
    const lockRef = db.doc(`sites/${siteId}/cortex-state/lock`);
    const canProceed = await db.runTransaction(async (tx) => {
      const lockDoc = await tx.get(lockRef);
      const active = lockDoc.data()?.activeSessions ?? 0;
      if (active >= MAX_CONCURRENT_SESSIONS) return false;
      tx.set(lockRef, {
        activeSessions: active + 1,
        lastUpdated: Timestamp.now(),
      }, { merge: true });
      return true;
    });

    if (!canProceed) {
      console.warn(`[hoot/autonomous] Concurrency limit reached for site ${siteId}`);
      return NextResponse.json({ accepted: false, reason: 'concurrency_limit' });
    }

    // 6. Create event record
    const eventId = `evt_${Date.now()}_${machineId.replace(/[^a-zA-Z0-9-_]/g, '')}`;
    const chatId = `auto_${Date.now()}_${machineId.replace(/[^a-zA-Z0-9-_]/g, '')}`;
    const eventRef = db.doc(`sites/${siteId}/cortex-events/${eventId}`);

    await eventRef.set({
      machineId,
      machineName,
      processName,
      eventType,
      errorMessage: errorMessage || '',
      timestamp: Timestamp.now(),
      chatId,
      status: 'investigating',
      summary: '',
      actions: [],
    });
    emitHootEventMetric('cortex_events_incoming_total', {
      siteId,
      machineId,
      eventId,
      status: 'investigating',
      eventType,
    });

    console.log(`[hoot/autonomous] Accepted: ${eventId} — ${processName} ${eventType} on ${machineName}`);

    // 7. Fire and forget the investigation
    runAutonomousInvestigation(db, {
      siteId, machineId, machineName, eventType, processName,
      errorMessage: errorMessage || '', agentVersion: agentVersion || '',
      eventId, chatId, settings,
    }).catch(err => {
      console.error(`[hoot/autonomous] Investigation failed for ${eventId}:`, err);
    });

    return NextResponse.json({ accepted: true, eventId, chatId });

  } catch (error: unknown) {
    return apiError(error, 'hoot/autonomous');
  }
}

// ─── Background Investigation ─────────────────────────────────────────────────

interface InvestigationParams {
  siteId: string;
  machineId: string;
  machineName: string;
  eventType: string;
  processName: string;
  errorMessage: string;
  agentVersion: string;
  eventId: string;
  chatId: string;
  settings: HootSettings;
}

async function runAutonomousInvestigation(
  db: FirebaseFirestore.Firestore,
  params: InvestigationParams
): Promise<void> {
  const {
    siteId, machineId, machineName, eventType, processName,
    errorMessage, eventId, chatId, settings,
  } = params;

  const eventRef = db.doc(`sites/${siteId}/cortex-events/${eventId}`);
  const lockRef = db.doc(`sites/${siteId}/cortex-state/lock`);
  const startTime = Date.now();

  try {
    // Check machine online
    const online = await isMachineOnline(db, siteId, machineId);
    if (!online) {
      await eventRef.update({
        status: 'escalated',
        summary: 'Machine offline — cannot investigate remotely',
        resolvedAt: Timestamp.now(),
        durationMs: Date.now() - startTime,
      });

      if (settings.escalationEmail !== false) {
        await escalate(
          siteId, eventId, machineName, processName,
          `Machine "${machineName}" is offline. Process "${processName}" ${eventType === 'process_start_failed' ? 'failed to start' : 'crashed'} but hoot cannot reach the machine to investigate.\n\nError: ${errorMessage}`
        );
      }

      console.log(`[hoot/autonomous] ${eventId}: escalated (machine offline)`);
      emitHootEventMetric('cortex_events_processed_total', {
        siteId,
        machineId,
        eventId,
        status: 'escalated',
        eventType,
        durationMs: Date.now() - startTime,
      });
      return;
    }

    // Respect the per-machine Hoot kill switch — skip autonomous investigation
    // but still escalate so operators aren't left in the dark.
    const hootEnabled = await isHootEnabled(db, siteId, machineId);
    if (!hootEnabled) {
      await eventRef.update({
        status: 'escalated',
        summary: 'Hoot disabled on this machine — autonomous investigation skipped',
        resolvedAt: Timestamp.now(),
        durationMs: Date.now() - startTime,
      });

      if (settings.escalationEmail !== false) {
        await escalate(
          siteId, eventId, machineName, processName,
          `hoot is disabled on "${machineName}". Process "${processName}" ${eventType === 'process_start_failed' ? 'failed to start' : 'crashed'} but autonomous investigation was skipped because the kill switch is engaged.\n\nError: ${errorMessage}`
        );
      }

      console.log(`[hoot/autonomous] ${eventId}: escalated (hoot disabled)`);
      emitHootEventMetric('cortex_events_processed_total', {
        siteId,
        machineId,
        eventId,
        status: 'escalated',
        eventType,
        durationMs: Date.now() - startTime,
      });
      return;
    }

    // Resolve LLM config (site-level only)
    const llmConfig = await resolveLlmConfig(db, null, siteId, { autonomous: true });

    // Build tools (tier-capped)
    const maxTier = settings.maxTier ?? 2;
    const toolDefs = getToolsByTier(maxTier as 1 | 2 | 3);
    const tools = buildAutonomousTools(db, siteId, machineId, chatId, eventId, toolDefs);

    // Build event context
    const eventLabel = eventType === 'process_start_failed' ? 'failed to start' : 'crashed';
    const eventContext = [
      `Process "${processName}" ${eventLabel} on machine "${machineName}".`,
      errorMessage ? `Error details: ${errorMessage}` : '',
    ].filter(Boolean).join('\n');

    // Build system prompt with directive
    const systemPrompt = buildAutonomousSystemPrompt(
      machineName,
      settings.directive || '',
      eventContext
    );

    // Run LLM with tools
    const model = createModel(llmConfig);
    const result = await generateText({
      model,
      system: systemPrompt,
      messages: [{ role: 'user', content: eventContext }],
      tools,
      stopWhen: stepCountIs(MAX_STEPS),
    });

    // Extract final text
    const finalText = result.text || '';

    // Determine outcome
    const needsEscalation = finalText.includes('ESCALATION NEEDED');
    const status = needsEscalation ? 'escalated' : 'resolved';

    // Extract summary from structured output
    const summaryMatch = finalText.match(/OUTCOME:\s*(.+)/i);
    const summary = summaryMatch?.[1]?.trim()
      || (needsEscalation ? 'Escalated — hoot could not resolve the issue' : 'Issue investigated and addressed');

    // Collect actions from tool call steps
    const actions = result.steps?.flatMap(step =>
      (step.toolCalls || []).map(tc => ({
        tool: tc.toolName,
        params: 'input' in tc ? (tc.input ?? {}) : {},
        timestamp: Timestamp.now(),
      }))
    ) || [];

    // Update event record
    await eventRef.update({
      status,
      summary,
      actions,
      resolvedAt: Timestamp.now(),
      durationMs: Date.now() - startTime,
    });

    // Save conversation to chats collection
    // Store the full message exchange for review in the Hoot UI
    const chatMessages = result.response?.messages || [];
    await db.doc(`chats/${chatId}`).set({
      source: 'autonomous',
      eventId,
      siteId,
      targetType: 'machine',
      targetMachineId: machineId,
      machineName,
      title: `Auto: ${processName} ${eventLabel}`,
      autonomousSummary: summary,
      // Store serializable message data
      messages: JSON.parse(JSON.stringify(chatMessages)),
      createdAt: Timestamp.fromMillis(startTime),
      updatedAt: Timestamp.now(),
    });

    // Escalate if needed
    if (needsEscalation && settings.escalationEmail !== false) {
      await escalate(siteId, eventId, machineName, processName, finalText);
    }

    console.log(`[hoot/autonomous] ${eventId}: ${status} in ${Date.now() - startTime}ms (${actions.length} tool calls)`);
    emitHootEventMetric('cortex_events_processed_total', {
      siteId,
      machineId,
      eventId,
      status,
      eventType,
      durationMs: Date.now() - startTime,
    });

  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[hoot/autonomous] ${eventId} error:`, err);

    await eventRef.update({
      status: 'failed',
      summary: `Investigation error: ${errMsg}`,
      resolvedAt: Timestamp.now(),
      durationMs: Date.now() - startTime,
    }).catch(() => {});
    emitHootEventMetric('cortex_events_processed_total', {
      siteId,
      machineId,
      eventId,
      status: 'failed',
      eventType,
      durationMs: Date.now() - startTime,
    });

  } finally {
    // Always decrement the active session counter (retry once on failure)
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await db.runTransaction(async (tx) => {
          const lockDoc = await tx.get(lockRef);
          const active = lockDoc.data()?.activeSessions ?? 1;
          tx.set(lockRef, {
            activeSessions: Math.max(0, active - 1),
            lastUpdated: Timestamp.now(),
          }, { merge: true });
        });
        break; // Success
      } catch (err) {
        if (attempt === 0) {
          console.warn(`[hoot/autonomous] Lock release failed for ${eventId}, retrying...`, err);
        } else {
          console.error(`[hoot/autonomous] Lock release failed permanently for ${eventId} — counter may be stale:`, err);
        }
      }
    }
  }
}
