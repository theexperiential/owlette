/**
 * Core chat API endpoint — dual-path architecture.
 *
 * Single-machine mode (local Cortex):
 *   Web writes pendingMessage to Firestore → local Cortex picks up →
 *   Agent SDK runs with local tools → Cortex writes response progressively →
 *   Web streams via SSE (onSnapshot).
 *
 * Site-wide mode (unchanged):
 *   Web runs LLM directly via Vercel AI SDK → relays tools via Firestore commands.
 */

import { NextRequest, NextResponse } from 'next/server';
import { streamText, stepCountIs, type ModelMessage } from 'ai';
import { requireSession } from '@/lib/apiAuth.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { createModel, buildSystemPrompt, type ProcessSummary } from '@/lib/llm';
import { getToolsByTier } from '@/lib/mcp-tools';
import {
  resolveLlmConfig,
  verifyUserSiteAccess,
  isMachineOnline,
  getOnlineMachines,
  buildExecutableTools,
} from '@/lib/cortex-utils.server';

const SITE_TARGET_ID = '__site__';

/**
 * Fetch process configurations from Firestore for system prompt context.
 */
async function fetchProcessSummaries(
  db: FirebaseFirestore.Firestore,
  siteId: string,
  machineId: string,
): Promise<ProcessSummary[]> {
  try {
    const configDoc = await db
      .collection('config')
      .doc(siteId)
      .collection('machines')
      .doc(machineId)
      .get();

    if (!configDoc.exists) return [];

    const data = configDoc.data();
    const processes = data?.processes;
    if (!Array.isArray(processes)) return [];

    return processes.map((p: Record<string, unknown>) => ({
      name: (p.name as string) || 'Unknown',
      launch_mode: (p.launch_mode as string) || (p.autolaunch ? 'always' : 'off'),
      exe_path: (p.exe_path as string) || (p.path as string) || '',
      ...(p.file_path ? { file_path: p.file_path as string } : {}),
      ...(p.cwd ? { cwd: p.cwd as string } : {}),
    }));
  } catch {
    return [];
  }
}

/** Cortex heartbeat is "fresh" if within this many milliseconds. */
const HEARTBEAT_STALE_MS = 30_000;

/** Maximum time to wait for Cortex response before timing out. */
const LOCAL_CORTEX_TIMEOUT_MS = 60_000;

/**
 * Check if local Cortex is running on a machine by checking its heartbeat.
 */
async function isCortexLocal(
  db: FirebaseFirestore.Firestore,
  siteId: string,
  machineId: string,
): Promise<boolean> {
  try {
    const machineDoc = await db
      .collection('sites')
      .doc(siteId)
      .collection('machines')
      .doc(machineId)
      .get();

    if (!machineDoc.exists) return false;

    const data = machineDoc.data();
    const cortexStatus = data?.cortexStatus;
    if (!cortexStatus?.online) return false;

    const lastHeartbeat = cortexStatus.lastHeartbeat;
    if (!lastHeartbeat) return false;

    const heartbeatTime = lastHeartbeat.toDate
      ? lastHeartbeat.toDate().getTime()
      : new Date(lastHeartbeat).getTime();

    return Date.now() - heartbeatTime < HEARTBEAT_STALE_MS;
  } catch {
    return false;
  }
}

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
      messages: ModelMessage[];  // content can be string or Array<TextPart | ImagePart>
      siteId: string;
      machineId: string;
      machineName: string;
      chatId: string;
    };

    if (!messages || !siteId || !chatId) {
      return NextResponse.json(
        { error: 'messages, siteId, and chatId are required' },
        { status: 400 },
      );
    }

    const db = getAdminDb();
    const isSiteMode = machineId === SITE_TARGET_ID;

    // Verify access
    await verifyUserSiteAccess(db, userId, siteId);

    // ─── Site-Wide Mode (unchanged — web-side LLM) ─────────────────────
    if (isSiteMode) {
      return handleSiteWideMode(db, userId, siteId, messages, chatId);
    }

    // ─── Single Machine Mode ───────────────────────────────────────────
    if (!machineId) {
      return NextResponse.json(
        { error: 'machineId is required for single-machine mode' },
        { status: 400 },
      );
    }

    const online = await isMachineOnline(db, siteId, machineId);
    if (!online) {
      return NextResponse.json(
        { error: `Machine "${machineName || machineId}" appears to be offline.` },
        { status: 503 },
      );
    }

    // Check if local Cortex is running
    const cortexLocal = await isCortexLocal(db, siteId, machineId);

    if (cortexLocal) {
      // ─── Local Cortex Path (SSE via Firestore onSnapshot) ──────────
      return handleLocalCortex(db, siteId, machineId, machineName, messages, chatId);
    } else {
      // ─── Fallback: Server-side LLM (existing approach) ────────────
      return handleServerSideLLM(db, userId, siteId, machineId, machineName, messages, chatId);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    console.error('Cortex API error:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}


/**
 * Local Cortex path: write pendingMessage to Firestore, then stream
 * response via Vercel AI SDK protocol as Cortex writes progressively.
 *
 * Uses the AI SDK's text-stream protocol so the client-side useChat hook
 * works without modification:
 *   0:"text delta"\n   — text content
 *   d:{"finishReason":"stop"}\n  — stream finish
 *   3:"error message"\n — error
 */
async function handleLocalCortex(
  db: FirebaseFirestore.Firestore,
  siteId: string,
  machineId: string,
  machineName: string,
  messages: ModelMessage[],
  chatId: string,
): Promise<Response> {
  const activeChatRef = db
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .collection('cortex')
    .doc('active-chat');

  // Extract user message text and images
  const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
  const msgContent = (lastUserMsg as { content?: unknown })?.content;

  let userText = '';
  const images: Array<{ url: string; mediaType: string }> = [];

  if (typeof msgContent === 'string') {
    userText = msgContent;
  } else if (Array.isArray(msgContent)) {
    for (const block of msgContent) {
      if (block.type === 'text') userText += block.text || '';
      if (block.type === 'image' && block.image) {
        images.push({ url: String(block.image), mediaType: block.mediaType || 'image/jpeg' });
      }
    }
  }

  // Serialize messages for Firestore (flatten multimodal to text for history)
  const serializedMessages = messages.map((m) => {
    const c = (m as { content?: unknown }).content;
    if (typeof c === 'string') return { role: m.role, content: c };
    if (Array.isArray(c)) {
      const text = c.filter((b: { type: string }) => b.type === 'text').map((b: { text?: string }) => b.text || '').join('');
      return { role: m.role, content: text };
    }
    return { role: m.role, content: '' };
  });

  // Write pending message for local Cortex to pick up
  await activeChatRef.set(
    {
      pendingMessage: userText,
      chatId,
      machineName: machineName || machineId,
      messages: serializedMessages,
      ...(images.length > 0 ? { images } : {}),
      status: 'pending',
      response: { content: '', complete: false, parts: [] },
      updatedAt: new Date(),
    },
    { merge: false },
  );

  // Stream response as AI SDK protocol
  const encoder = new TextEncoder();
  let lastContent = '';
  let unsubscribe: (() => void) | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      // Timeout
      timeoutId = setTimeout(() => {
        controller.enqueue(encoder.encode(`3:"Cortex response timed out"\n`));
        controller.close();
        unsubscribe?.();
      }, LOCAL_CORTEX_TIMEOUT_MS);

      // Listen for Firestore changes
      unsubscribe = activeChatRef.onSnapshot(
        (snapshot) => {
          const data = snapshot.data();
          if (!data) return;

          const response = data.response;
          if (!response) return;

          const content: string = response.content || '';
          const complete: boolean = response.complete || false;
          const status: string = data.status;

          // Send text delta (new content since last snapshot)
          if (content.length > lastContent.length) {
            const delta = content.slice(lastContent.length);
            // AI SDK protocol: 0:"text"\n
            controller.enqueue(encoder.encode(`0:${JSON.stringify(delta)}\n`));
            lastContent = content;
          }

          // Complete
          if (complete) {
            // AI SDK protocol: d:{"finishReason":"stop"}\n
            controller.enqueue(
              encoder.encode(`d:${JSON.stringify({ finishReason: 'stop' })}\n`),
            );
            if (timeoutId) clearTimeout(timeoutId);
            unsubscribe?.();
            controller.close();
          }

          // Error
          if (status === 'error') {
            controller.enqueue(
              encoder.encode(`3:${JSON.stringify(content || 'Cortex error')}\n`),
            );
            if (timeoutId) clearTimeout(timeoutId);
            unsubscribe?.();
            controller.close();
          }
        },
        (error) => {
          console.error('Cortex onSnapshot error:', error);
          controller.enqueue(
            encoder.encode(`3:${JSON.stringify(error.message || 'Stream error')}\n`),
          );
          controller.close();
          if (timeoutId) clearTimeout(timeoutId);
        },
      );
    },

    cancel() {
      unsubscribe?.();
      if (timeoutId) clearTimeout(timeoutId);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Vercel-AI-Data-Stream': 'v1',
    },
  });
}


/**
 * Server-side LLM path (fallback when local Cortex is not running).
 * Same as the original implementation — Vercel AI SDK + Firestore relay.
 */
async function handleServerSideLLM(
  db: FirebaseFirestore.Firestore,
  userId: string,
  siteId: string,
  machineId: string,
  machineName: string,
  messages: ModelMessage[],
  chatId: string,
): Promise<Response> {
  const [llmConfig, processes] = await Promise.all([
    resolveLlmConfig(db, userId, siteId),
    fetchProcessSummaries(db, siteId, machineId),
  ]);

  const toolDefs = getToolsByTier(3);
  const executableTools = buildExecutableTools(
    db, siteId, machineId, chatId, toolDefs,
    false, [],
  );

  const model = createModel(llmConfig);

  const result = streamText({
    model,
    system: buildSystemPrompt(machineName || machineId, false, processes),
    messages,
    tools: executableTools,
    stopWhen: stepCountIs(10),
  });

  return result.toUIMessageStreamResponse();
}


/**
 * Site-wide mode: LLM runs on web server, tools fan out to all online machines.
 */
async function handleSiteWideMode(
  db: FirebaseFirestore.Firestore,
  userId: string,
  siteId: string,
  messages: ModelMessage[],
  chatId: string,
): Promise<Response> {
  const onlineMachines = await getOnlineMachines(db, siteId);
  if (onlineMachines.length === 0) {
    return NextResponse.json(
      { error: 'No machines are currently online in this site.' },
      { status: 503 },
    );
  }

  const llmConfig = await resolveLlmConfig(db, userId, siteId);

  const toolDefs = getToolsByTier(3);
  const executableTools = buildExecutableTools(
    db, siteId, SITE_TARGET_ID, chatId, toolDefs,
    true, onlineMachines,
  );

  const model = createModel(llmConfig);

  const result = streamText({
    model,
    system: buildSystemPrompt('', true),
    messages,
    tools: executableTools,
    stopWhen: stepCountIs(10),
  });

  return result.toUIMessageStreamResponse();
}
