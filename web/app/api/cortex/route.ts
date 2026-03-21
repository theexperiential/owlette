/**
 * Core chat API endpoint.
 *
 * Orchestrates: user message → LLM (with tools) → Firestore command relay → agent → response
 *
 * Uses Vercel AI SDK for streaming. Tool calls are relayed to agents via
 * Firestore commands/pending, with polling on commands/completed.
 */

import { NextRequest, NextResponse } from 'next/server';
import { streamText, stepCountIs, type ModelMessage } from 'ai';
import { requireSession } from '@/lib/apiAuth.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { createModel, buildSystemPrompt } from '@/lib/llm';
import { getToolsByTier } from '@/lib/mcp-tools';
import {
  resolveLlmConfig,
  verifyUserSiteAccess,
  isMachineOnline,
  getOnlineMachines,
  buildExecutableTools,
} from '@/lib/cortex-utils.server';

const SITE_TARGET_ID = '__site__';

// Note: Streaming responses are incompatible with withRateLimit's header injection,
// so we handle rate limiting manually if needed in the future.
export async function POST(request: NextRequest) {
    try {
      const userId = await requireSession(request);
      const body = await request.json();

      const {
        messages,
        siteId,
        machineId,
        machineName,
        chatId,
      } = body as {
        messages: ModelMessage[];
        siteId: string;
        machineId: string;
        machineName: string;
        chatId: string;
      };

      if (!messages || !siteId || !chatId) {
        return NextResponse.json(
          { error: 'messages, siteId, and chatId are required' },
          { status: 400 }
        );
      }

      const db = getAdminDb();
      const isSiteMode = machineId === SITE_TARGET_ID;

      // Verify access
      await verifyUserSiteAccess(db, userId, siteId);

      // Resolve LLM config
      const llmConfig = await resolveLlmConfig(db, userId, siteId);

      let onlineMachines: string[] = [];

      if (isSiteMode) {
        // Site mode: get all online machines
        onlineMachines = await getOnlineMachines(db, siteId);
        if (onlineMachines.length === 0) {
          return NextResponse.json(
            { error: 'No machines are currently online in this site.' },
            { status: 503 }
          );
        }
      } else {
        // Single machine mode: check machine online status
        if (!machineId) {
          return NextResponse.json(
            { error: 'machineId is required for single-machine mode' },
            { status: 400 }
          );
        }
        const online = await isMachineOnline(db, siteId, machineId);
        if (!online) {
          return NextResponse.json(
            { error: `Machine "${machineName || machineId}" appears to be offline. Tool calls will not be delivered.` },
            { status: 503 }
          );
        }
      }

      // Build tools — Tier 1 + 2 for MVP (Tier 3 will be added with confirmation flow)
      const toolDefs = getToolsByTier(2);
      const executableTools = buildExecutableTools(
        db, siteId, machineId, chatId, toolDefs,
        isSiteMode, onlineMachines
      );

      // Create model
      const model = createModel(llmConfig);

      // Stream response
      const result = streamText({
        model,
        system: isSiteMode
          ? buildSystemPrompt('', true)
          : buildSystemPrompt(machineName || machineId),
        messages,
        tools: executableTools,
        stopWhen: stepCountIs(10), // Allow up to 10 tool call rounds
      });

      return result.toUIMessageStreamResponse();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Internal server error';
      console.error('Cortex API error:', error);
      return NextResponse.json({ error: message }, { status: 500 });
    }
}
