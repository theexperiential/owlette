/**
 * cortex streaming dispatcher (api-sprint wave 3 — track 3A).
 *
 * Extracted from `/api/cortex/route.ts` so both the legacy cortex endpoint
 * and the new `/api/chat/{conversationId}` send-message endpoint can drive
 * the same dual-path streaming flow without duplication.
 *
 * Three paths, mutually exclusive:
 *   - site mode (`SITE_TARGET_ID` machine): server-side llm + fan-out tools
 *   - single-machine, local cortex available + caller is site-admin:
 *       agent runs the llm locally and streams via firestore onSnapshot
 *   - single-machine, fallback: server-side llm + tool-relay
 *
 * The legacy cortex route remains a thin wrapper around `runCortexStream`
 * — its observable behavior (response shape, headers, error semantics) is
 * unchanged. The chat-noun route adds an `onAssistantText` tap that lets
 * us persist the final assistant message back into the conversation as
 * the stream completes.
 */

import { streamText, stepCountIs, type ModelMessage } from 'ai';
import { FieldValue } from 'firebase-admin/firestore';
import { createModel, buildSystemPrompt, type ProcessSummary } from '@/lib/llm';
import { getToolsByTier } from '@/lib/mcp-tools';
import {
  resolveLlmConfig,
  verifyUserSiteAccess,
  resolveCortexMaxTier,
  isMachineOnline,
  isCortexEnabled,
  getOnlineMachines,
  buildExecutableTools,
  type SiteAccessLevel,
} from '@/lib/cortex-utils.server';

export const SITE_TARGET_ID = '__site__';

const HEARTBEAT_STALE_MS = 30_000;
const LOCAL_CORTEX_TIMEOUT_MS = 60_000;

export interface CortexStreamRequest {
  db: FirebaseFirestore.Firestore;
  userId: string;
  siteId: string;
  /** Set to `SITE_TARGET_ID` for site-wide mode. */
  machineId: string;
  machineName: string;
  messages: ModelMessage[];
  chatId: string;
  /**
   * Optional tap fired with the final accumulated assistant text once the
   * stream completes. Used by the chat-noun route to append the assistant
   * message back into the conversation. Errors thrown by the tap are caught
   * and logged — they never break the stream contract for the client.
   */
  onAssistantText?: (text: string) => Promise<void> | void;
}

export type CortexStreamResult =
  | { ok: true; response: Response }
  | { ok: false; status: number; error: string };

/**
 * Run the cortex stream pipeline. Returns either a streaming `Response` ready
 * to be returned from the route, or a structured error payload the route can
 * shape into its preferred error envelope (problem+json for chat noun, plain
 * `{error}` for the legacy cortex endpoint).
 */
export async function runCortexStream(
  req: CortexStreamRequest,
): Promise<CortexStreamResult> {
  const { db, userId, siteId, machineId, machineName, messages, chatId } = req;

  const isSiteMode = machineId === SITE_TARGET_ID;
  const access = await verifyUserSiteAccess(db, userId, siteId);

  if (isSiteMode) {
    const onlineMachines = await getOnlineMachines(db, siteId);
    if (onlineMachines.length === 0) {
      return {
        ok: false,
        status: 503,
        error: 'no machines are currently online in this site.',
      };
    }
    return {
      ok: true,
      response: handleSiteWideMode(db, userId, siteId, messages, chatId, access, onlineMachines, req.onAssistantText),
    };
  }

  if (!machineId) {
    return { ok: false, status: 400, error: 'machineId is required for single-machine mode' };
  }

  const online = await isMachineOnline(db, siteId, machineId);
  if (!online) {
    return {
      ok: false,
      status: 503,
      error: `machine "${machineName || machineId}" appears to be offline.`,
    };
  }

  const cortexEnabled = await isCortexEnabled(db, siteId, machineId);
  if (!cortexEnabled) {
    return {
      ok: false,
      status: 423,
      error: `cortex is disabled on "${machineName || machineId}". re-enable it from the cortex header to deliver tool calls.`,
    };
  }

  // Non-admins are forced through the server-side LLM path so the tier cap
  // (tier 1, read-only) is actually enforced. The local Cortex path runs
  // tools inside the agent and does not yet honor a per-user tier cap.
  const cortexLocal = access.isSiteAdmin
    ? await isCortexLocal(db, siteId, machineId)
    : false;

  if (cortexLocal) {
    return {
      ok: true,
      response: handleLocalCortex(db, siteId, machineId, machineName, messages, chatId, req.onAssistantText),
    };
  }

  return {
    ok: true,
    response: handleServerSideLLM(db, userId, siteId, machineId, machineName, messages, chatId, access, req.onAssistantText),
  };
}

/* -------------------------------------------------------------------------- */
/*  Internal helpers (lifted verbatim from cortex/route.ts where possible)    */
/* -------------------------------------------------------------------------- */

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

function handleLocalCortex(
  db: FirebaseFirestore.Firestore,
  siteId: string,
  machineId: string,
  machineName: string,
  messages: ModelMessage[],
  chatId: string,
  onAssistantText?: (text: string) => Promise<void> | void,
): Response {
  const activeChatRef = db
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .collection('cortex')
    .doc('active-chat');

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

  const serializedMessages = messages.map((m) => {
    const c = (m as { content?: unknown }).content;
    if (typeof c === 'string') return { role: m.role, content: c };
    if (Array.isArray(c)) {
      const text = c
        .filter((b: { type: string }) => b.type === 'text')
        .map((b: { text?: string }) => b.text || '')
        .join('');
      return { role: m.role, content: text };
    }
    return { role: m.role, content: '' };
  });

  // Fire-and-forget the pending-message write. We don't await so the stream
  // can begin enqueuing immediately; if this fails, the agent simply never
  // picks up the message and we'll surface the timeout error.
  activeChatRef
    .set(
      {
        pendingMessage: userText,
        chatId,
        machineName: machineName || machineId,
        messages: serializedMessages,
        ...(images.length > 0 ? { images } : {}),
        status: 'pending',
        response: { content: '', complete: false, parts: [] },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: false },
    )
    .catch((err) => {
      console.warn('[cortexStream] failed to seed pending message:', err);
    });

  const encoder = new TextEncoder();
  let lastContent = '';
  let unsubscribe: (() => void) | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      timeoutId = setTimeout(() => {
        controller.enqueue(encoder.encode(`3:"cortex response timed out"\n`));
        controller.close();
        unsubscribe?.();
      }, LOCAL_CORTEX_TIMEOUT_MS);

      unsubscribe = activeChatRef.onSnapshot(
        (snapshot) => {
          const data = snapshot.data();
          if (!data) return;

          const response = data.response;
          if (!response) return;

          const content: string = response.content || '';
          const complete: boolean = response.complete || false;
          const status: string = data.status;

          if (content.length > lastContent.length) {
            const delta = content.slice(lastContent.length);
            controller.enqueue(encoder.encode(`0:${JSON.stringify(delta)}\n`));
            lastContent = content;
          }

          if (complete) {
            controller.enqueue(
              encoder.encode(`d:${JSON.stringify({ finishReason: 'stop' })}\n`),
            );
            if (timeoutId) clearTimeout(timeoutId);
            unsubscribe?.();
            controller.close();
            void fireAssistantTap(onAssistantText, lastContent);
          }

          if (status === 'error') {
            controller.enqueue(
              encoder.encode(`3:${JSON.stringify(content || 'cortex error')}\n`),
            );
            if (timeoutId) clearTimeout(timeoutId);
            unsubscribe?.();
            controller.close();
          }
        },
        (error) => {
          console.error('cortex onSnapshot error:', error);
          controller.enqueue(
            encoder.encode(`3:${JSON.stringify(error.message || 'stream error')}\n`),
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

function handleServerSideLLM(
  db: FirebaseFirestore.Firestore,
  userId: string,
  siteId: string,
  machineId: string,
  machineName: string,
  messages: ModelMessage[],
  chatId: string,
  access: SiteAccessLevel,
  onAssistantText?: (text: string) => Promise<void> | void,
): Response {
  return wrapWithAssistantTap(
    runServerSideLLM(db, userId, siteId, machineId, machineName, messages, chatId, access),
    onAssistantText,
  );
}

async function runServerSideLLM(
  db: FirebaseFirestore.Firestore,
  userId: string,
  siteId: string,
  machineId: string,
  machineName: string,
  messages: ModelMessage[],
  chatId: string,
  access: SiteAccessLevel,
): Promise<Response> {
  const [llmConfig, processes] = await Promise.all([
    resolveLlmConfig(db, userId, siteId),
    fetchProcessSummaries(db, siteId, machineId),
  ]);

  const toolDefs = getToolsByTier(resolveCortexMaxTier(access));
  const executableTools = buildExecutableTools(
    db,
    siteId,
    machineId,
    chatId,
    toolDefs,
    false,
    [],
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

function handleSiteWideMode(
  db: FirebaseFirestore.Firestore,
  userId: string,
  siteId: string,
  messages: ModelMessage[],
  chatId: string,
  access: SiteAccessLevel,
  onlineMachines: string[],
  onAssistantText?: (text: string) => Promise<void> | void,
): Response {
  return wrapWithAssistantTap(
    runSiteWideMode(db, userId, siteId, messages, chatId, access, onlineMachines),
    onAssistantText,
  );
}

async function runSiteWideMode(
  db: FirebaseFirestore.Firestore,
  userId: string,
  siteId: string,
  messages: ModelMessage[],
  chatId: string,
  access: SiteAccessLevel,
  onlineMachines: string[],
): Promise<Response> {
  const llmConfig = await resolveLlmConfig(db, userId, siteId);
  const toolDefs = getToolsByTier(resolveCortexMaxTier(access));
  const executableTools = buildExecutableTools(
    db,
    siteId,
    SITE_TARGET_ID,
    chatId,
    toolDefs,
    true,
    onlineMachines,
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

/* -------------------------------------------------------------------------- */
/*  Stream tee helpers                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Tee a streaming Response so we can both forward bytes to the client and
 * accumulate assistant text for an `onAssistantText` tap. When the upstream
 * is itself a Promise (server-side LLM path) we resolve it lazily inside the
 * teed stream so the caller still receives a synchronous Response.
 */
function wrapWithAssistantTap(
  upstreamPromise: Response | Promise<Response>,
  onAssistantText?: (text: string) => Promise<void> | void,
): Response {
  const decoder = new TextDecoder();
  let accumulated = '';

  const stream = new ReadableStream({
    async start(controller) {
      let upstream: Response;
      try {
        upstream = await upstreamPromise;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'cortex error';
        controller.enqueue(new TextEncoder().encode(`3:${JSON.stringify(msg)}\n`));
        controller.close();
        return;
      }

      const reader = upstream.body?.getReader();
      if (!reader) {
        controller.close();
        return;
      }

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            controller.enqueue(value);
            if (onAssistantText) {
              accumulated += extractTextDeltas(decoder.decode(value, { stream: true }));
            }
          }
        }
      } finally {
        controller.close();
        void fireAssistantTap(onAssistantText, accumulated);
      }
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
 * Pull text content out of AI-SDK protocol frames. We only inspect `0:"..."`
 * frames (text deltas) — tool-call / finish frames are passed through to the
 * client unchanged but skipped for accumulation.
 */
function extractTextDeltas(chunk: string): string {
  let out = '';
  for (const line of chunk.split('\n')) {
    if (!line.startsWith('0:')) continue;
    const json = line.slice(2);
    try {
      const parsed = JSON.parse(json);
      if (typeof parsed === 'string') out += parsed;
    } catch {
      // ignore partial frames — the next chunk will resync.
    }
  }
  return out;
}

async function fireAssistantTap(
  onAssistantText: ((text: string) => Promise<void> | void) | undefined,
  text: string,
): Promise<void> {
  if (!onAssistantText || !text) return;
  try {
    await onAssistantText(text);
  } catch (err) {
    console.warn('[cortexStream] onAssistantText tap failed:', err);
  }
}
