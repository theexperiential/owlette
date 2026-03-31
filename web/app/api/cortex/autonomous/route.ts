/**
 * POST /api/cortex/autonomous
 *
 * Internal endpoint triggered by the agent alert system when a process crashes
 * or fails to start. Runs an autonomous LLM investigation loop using generateText()
 * with tool calling to diagnose and remediate the issue.
 *
 * Auth: Internal shared secret (CORTEX_INTERNAL_SECRET), NOT user session.
 * This endpoint is called by the alert route after verifying the agent's identity.
 *
 * Flow:
 * 1. Validate internal secret + request body
 * 2. Check autonomous mode enabled for site
 * 3. Dedup/cooldown check (same machine+process within cooldown window)
 * 4. Concurrency check (max 3 active sessions per site)
 * 5. Create cortex-event record
 * 6. Return accepted response immediately
 * 7. Run LLM investigation in background (fire-and-forget)
 * 8. Save conversation + update event status
 * 9. Escalate if unresolved
 */

import { NextRequest, NextResponse } from 'next/server';
import { generateText, stepCountIs, tool, jsonSchema } from 'ai';
import { Timestamp } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import { createModel, buildAutonomousSystemPrompt } from '@/lib/llm';
import { getToolsByTier, EXISTING_COMMAND_MAPPINGS, type McpToolDefinition } from '@/lib/mcp-tools';
import {
  resolveLlmConfig,
  isMachineOnline,
  executeToolOnAgent,
  executeExistingCommand,
} from '@/lib/cortex-utils.server';
import { escalate } from '@/lib/cortex-escalation.server';

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
}

interface CortexSettings {
  autonomousEnabled?: boolean;
  directive?: string;
  maxTier?: number;
  autonomousModel?: string;
  maxEventsPerHour?: number;
  cooldownMinutes?: number;
  escalationEmail?: boolean;
}

/**
 * Build executable tools for autonomous mode (single machine, no streaming).
 * Separate from the shared buildExecutableTools to avoid the `tool()` import issue
 * with generateText vs streamText — they use the same tool() helper.
 */
function buildAutonomousTools(
  db: FirebaseFirestore.Firestore,
  siteId: string,
  machineId: string,
  chatId: string,
  toolDefs: McpToolDefinition[]
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: Record<string, any> = {};

  for (const def of toolDefs) {
    const toolName = def.name;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools[toolName] = tool<any, any>({
      description: def.description,
      inputSchema: jsonSchema(def.parameters as Record<string, unknown>),
      execute: async (params) => {
        const existingCmd = EXISTING_COMMAND_MAPPINGS[toolName];
        if (existingCmd) {
          const processName = (params as Record<string, unknown>).process_name as string;
          return executeExistingCommand(db, siteId, machineId, existingCmd, processName);
        }
        return executeToolOnAgent(db, siteId, machineId, toolName, params as Record<string, unknown>, chatId);
      },
    });
  }

  return tools;
}

export async function POST(request: NextRequest) {
  try {
    // 1. Validate internal secret
    const secret = request.headers.get('x-cortex-secret');
    if (!process.env.CORTEX_INTERNAL_SECRET || secret !== process.env.CORTEX_INTERNAL_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 2. Parse & validate body
    const body = await request.json() as AutonomousRequest;
    const { siteId, machineId, machineName, eventType, processName, errorMessage, agentVersion } = body;

    if (!siteId || !machineId || !processName || !eventType) {
      return NextResponse.json(
        { error: 'Missing required fields: siteId, machineId, processName, eventType' },
        { status: 400 }
      );
    }

    const db = getAdminDb();

    // 3. Read directive config
    const cortexSettingsDoc = await db.doc(`sites/${siteId}/settings/cortex`).get();
    const settings = (cortexSettingsDoc.data() ?? {}) as CortexSettings;

    if (!settings.autonomousEnabled) {
      return NextResponse.json({ accepted: false, reason: 'autonomous_disabled' });
    }

    // 4. Dedup check — same machine+process within cooldown window
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
      console.log(`[cortex/autonomous] Dedup: skipping ${machineId}:${processName} (existing event ${existingEvent.status})`);
      return NextResponse.json({ accepted: false, reason: 'cooldown_active' });
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
      console.warn(`[cortex/autonomous] Concurrency limit reached for site ${siteId}`);
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

    console.log(`[cortex/autonomous] Accepted: ${eventId} — ${processName} ${eventType} on ${machineName}`);

    // 7. Fire and forget the investigation
    runAutonomousInvestigation(db, {
      siteId, machineId, machineName, eventType, processName,
      errorMessage: errorMessage || '', agentVersion: agentVersion || '',
      eventId, chatId, settings,
    }).catch(err => {
      console.error(`[cortex/autonomous] Investigation failed for ${eventId}:`, err);
    });

    return NextResponse.json({ accepted: true, eventId, chatId });

  } catch (error: unknown) {
    console.error('[cortex/autonomous] Unhandled error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
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
  settings: CortexSettings;
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
          `Machine "${machineName}" is offline. Process "${processName}" ${eventType === 'process_start_failed' ? 'failed to start' : 'crashed'} but Cortex cannot reach the machine to investigate.\n\nError: ${errorMessage}`
        );
      }

      console.log(`[cortex/autonomous] ${eventId}: escalated (machine offline)`);
      return;
    }

    // Resolve LLM config (site-level only)
    const llmConfig = await resolveLlmConfig(db, null, siteId, { autonomous: true });

    // Build tools (tier-capped)
    const maxTier = settings.maxTier ?? 2;
    const toolDefs = getToolsByTier(maxTier as 1 | 2 | 3);
    const tools = buildAutonomousTools(db, siteId, machineId, chatId, toolDefs);

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
      || (needsEscalation ? 'Escalated — Cortex could not resolve the issue' : 'Issue investigated and addressed');

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
    // Store the full message exchange for review in the Cortex UI
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

    console.log(`[cortex/autonomous] ${eventId}: ${status} in ${Date.now() - startTime}ms (${actions.length} tool calls)`);

  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[cortex/autonomous] ${eventId} error:`, err);

    await eventRef.update({
      status: 'failed',
      summary: `Investigation error: ${errMsg}`,
      resolvedAt: Timestamp.now(),
      durationMs: Date.now() - startTime,
    }).catch(() => {});

  } finally {
    // Always decrement the active session counter
    await db.runTransaction(async (tx) => {
      const lockDoc = await tx.get(lockRef);
      const active = lockDoc.data()?.activeSessions ?? 1;
      tx.set(lockRef, {
        activeSessions: Math.max(0, active - 1),
        lastUpdated: Timestamp.now(),
      }, { merge: true });
    }).catch(err => {
      console.error(`[cortex/autonomous] Failed to release lock for ${eventId}:`, err);
    });
  }
}
