/**
 * Hoot turn runner — detached LLM loop.
 *
 * The turn outlives the HTTP request: `startTurn` returns the live UI-message
 * stream immediately and keeps running server-side even if the response dies
 * (proxy idle timeout, page reload, network drop).
 *
 * - The chunk stream is teed: one branch to the route, the other pumped via
 *   `readUIMessageStream` into throttled `writeSnapshot` calls on
 *   `chats/{chatId}/stream/current`, so a reattaching client can render the
 *   turn from Firestore alone.
 * - A transient `data-heartbeat` every ~20s keeps proxies from seeing an idle
 *   connection and bumps the stream doc's `updatedAt` (TURN_STALE_MS is 45s),
 *   which is why tool poll loops need no per-poll touch.
 * - History is repaired before the model call — dangling tool parts recovered
 *   from `commands/completed` via the prior stream doc's `toolCommands` index
 *   — then persisted immediately (turnId-guarded) so the user's message is
 *   durable before any reattach, even if the model or a tool later fails.
 * - A per-turn AbortController fires when `touch` reports lost ownership
 *   (superseded, or stopped via /api/hoot/stop), killing streamText and the
 *   in-flight tool poll loops.
 * - On finish the runner is the persist authority: marks the turn terminal,
 *   writes the final message array (schema mirrors `useHoot.ts`), triggers
 *   categorization for new conversations.
 *
 * `startTurn` never throws; every detached chain ends in `finishTurn('error')`
 * and surfaces an error chunk, so the client always sees the turn terminate.
 * turnStore writes are turnId-guarded no-ops once superseded.
 *
 * Server-side only — never import this in client components.
 */

import {
  convertToModelMessages,
  createUIMessageStream,
  readUIMessageStream,
  stepCountIs,
  streamText,
  type InferUIMessageChunk,
  type UIMessage,
} from 'ai';
import { FieldValue } from 'firebase-admin/firestore';
import {
  buildSystemPrompt,
  createCheapModel,
  createModel,
  type ProcessSummary,
} from '@/lib/llm';
import { getToolsByTier, type ToolTier } from '@/lib/mcp-tools';
import {
  buildExecutableTools,
  getHootRequireTier3Approval,
  getOnlineMachines,
  resolveHootMaxTier,
  resolveLlmConfig,
  type SiteAccessLevel,
} from '@/lib/hoot-utils.server';
import {
  repairDanglingToolParts,
  STILL_RUNNING_ERROR,
  type LostResultResolution,
} from '@/lib/hoot/repairMessages';
import {
  finishTurn,
  recordToolCommand,
  touch,
  writeSnapshot,
} from '@/lib/hoot/turnStore.server';
import { categorizeNewChat } from '@/lib/hoot/categorizeChat.server';
import { UNTITLED_CHAT_TITLE } from '@/lib/hoot/untitledChat';
import { sanitizeForLog } from '@/lib/logSanitize';

/** Sentinel machineId for site-wide mode (mirrors /api/hoot). */
const SITE_TARGET_ID = '__site__';

/** Transient heartbeat cadence — keeps proxies from seeing an idle stream. */
export const HEARTBEAT_INTERVAL_MS = 20_000;

const timing = {
  heartbeatMs: HEARTBEAT_INTERVAL_MS,
};

/** Test-only: shrink timer cadences so suites don't need 20s real waits. */
export function _setTurnTimingForTests(overrides?: { heartbeatMs?: number }): void {
  timing.heartbeatMs = overrides?.heartbeatMs ?? HEARTBEAT_INTERVAL_MS;
}

export interface StartTurnParams {
  chatId: string;
  turnId: string;
  siteId: string;
  machineId: string;
  machineName: string;
  messages: UIMessage[];
  userId: string;
  access: SiteAccessLevel;
  /**
   * Ceiling on this turn's tool tier, intersected with what `access` earns so
   * it can only LOWER the tool set. Omitted = whatever `access` earns.
   * The talon path sets this instead of degrading `access`, so fire-time
   * access re-resolution still demotes a demoted author to tier 1.
   */
  maxToolTier?: ToolTier;
  /** Prior turn's recovery index: `toolCallId → machineId → { commandId }`. */
  priorToolCommands?: Record<string, Record<string, { commandId: string }>> | null;
  source?: 'user' | 'followup' | 'talon';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Process configs from Firestore, for system-prompt context. */
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

/** Per-machine recovery outcome (before it is shaped for single vs site mode). */
type MachineOutcome =
  | { kind: 'output'; output: unknown }
  | { kind: 'error'; errorText: string }
  | null;

/**
 * Classify one machine's `commands/completed` entry:
 * success → `{ output }` (JSON-parsed like executeToolOnAgent); failed /
 * cancelled → `{ errorText }`; running → STILL_RUNNING_ERROR; entry absent
 * (consumed, GC'd, never dispatched) or read failure → `null`.
 */
async function resolveMachineEntry(
  db: FirebaseFirestore.Firestore,
  siteId: string,
  machineId: string,
  commandId: string,
): Promise<MachineOutcome> {
  try {
    const completedDoc = await db
      .collection('sites')
      .doc(siteId)
      .collection('machines')
      .doc(machineId)
      .collection('commands')
      .doc('completed')
      .get();

    const cmd = completedDoc.exists
      ? ((completedDoc.data() ?? {})[commandId] as Record<string, unknown> | undefined)
      : undefined;
    if (!cmd) return null;

    if (cmd.status === 'running') {
      return { kind: 'error', errorText: STILL_RUNNING_ERROR };
    }
    if (cmd.status === 'failed' || cmd.status === 'cancelled') {
      return {
        kind: 'error',
        errorText:
          (typeof cmd.error === 'string' && cmd.error) ||
          (cmd.status === 'cancelled' ? 'cancelled by user' : 'Tool execution failed'),
      };
    }

    // Parse string results like executeToolOnAgent does.
    const result = cmd.result;
    if (typeof result === 'string') {
      try {
        return { kind: 'output', output: JSON.parse(result) };
      } catch {
        return { kind: 'output', output: { result } };
      }
    }
    return { kind: 'output', output: result };
  } catch {
    // Recovery is best-effort — fall back to the synthesized lost-result error.
    return null;
  }
}

/**
 * Repair-time recovery resolver over the PRIOR turn's `toolCommands` index
 * (`toolCallId → machineId → { commandId }`). Output shape must match what the
 * live path produces: single-machine returns the unwrapped result; site mode
 * aggregates every machine into `{ machines: [{ machine, ...result }] }` (a
 * failure contributes `{ machine, error }`, an absent entry is skipped).
 * `null` when nothing resolves — the repair then synthesizes a lost-result error.
 */
function buildResolveLostResult(
  db: FirebaseFirestore.Firestore,
  siteId: string,
  priorToolCommands: Record<string, Record<string, { commandId: string }>> | null,
  isSiteMode: boolean,
): (toolCallId: string) => Promise<LostResultResolution | null> {
  return async (toolCallId) => {
    const machineEntries = priorToolCommands?.[toolCallId];
    const entries = machineEntries ? Object.entries(machineEntries) : [];
    if (entries.length === 0) return null;

    if (!isSiteMode) {
      const [machineId, { commandId }] = entries[0];
      const outcome = await resolveMachineEntry(db, siteId, machineId, commandId);
      if (!outcome) return null;
      return outcome.kind === 'output'
        ? { output: outcome.output }
        : { errorText: outcome.errorText };
    }

    const machines: Array<Record<string, unknown>> = [];
    for (const [machineId, { commandId }] of entries) {
      const outcome = await resolveMachineEntry(db, siteId, machineId, commandId);
      if (!outcome) continue; // absent — skip this machine
      if (outcome.kind === 'output') {
        const out = outcome.output;
        machines.push(
          typeof out === 'object' && out !== null
            ? { machine: machineId, ...(out as Record<string, unknown>) }
            : { machine: machineId, result: out },
        );
      } else {
        machines.push({ machine: machineId, error: outcome.errorText });
      }
    }
    if (machines.length === 0) return null;
    return { output: { machines } };
  };
}

/** First user-text in a message array (title seed + categorize input). */
function firstUserText(messages: UIMessage[]): string {
  const firstUserMsg = messages.find((m) => m.role === 'user');
  const firstTextPart = firstUserMsg?.parts?.find((p) => p.type === 'text');
  return firstTextPart && 'text' in firstTextPart ? (firstTextPart as { text: string }).text : '';
}

/**
 * Merge-write a message array to `chats/{chatId}` — server mirror of the
 * client persist in `useHoot.ts`. `isNewConversation` comes from chat-doc
 * existence at turn start, NOT message count, so a superseded first turn can't
 * permanently skip the title/createdAt stamp. Title is a placeholder until the
 * LLM categorizer replaces it, and an LLM title is never overwritten.
 */
async function persistChatMessages(
  db: FirebaseFirestore.Firestore,
  params: StartTurnParams,
  messages: UIMessage[],
  isNewConversation: boolean,
): Promise<void> {
  const isSiteMode = params.machineId === SITE_TARGET_ID;
  const title = isNewConversation
    ? firstUserText(messages).slice(0, 100) || UNTITLED_CHAT_TITLE
    : undefined;

  // JSON round-trip strips nested `undefined`, which Firestore rejects.
  const serializedMessages = messages.map((m) => ({
    id: m.id,
    role: m.role,
    parts: m.parts.map((p) => JSON.parse(JSON.stringify(p))),
  }));

  await db
    .collection('chats')
    .doc(params.chatId)
    .set(
      {
        userId: params.userId,
        siteId: params.siteId,
        targetType: isSiteMode ? 'site' : 'machine',
        targetMachineId: isSiteMode ? null : params.machineId,
        machineName: isSiteMode ? 'All Machines' : params.machineName,
        ...(title ? { title } : {}),
        messages: serializedMessages,
        updatedAt: FieldValue.serverTimestamp(),
        ...(isNewConversation ? { createdAt: FieldValue.serverTimestamp() } : {}),
      },
      { merge: true },
    );
}

/**
 * Start a detached Hoot turn. Returns the HTTP tee branch immediately; the
 * snapshot pump consumes the other branch, so the turn completes even if the
 * returned stream is abandoned. Never throws and never rejects the consumer:
 * internal failures → `finishTurn('error', msg)` + an error chunk.
 */
export function startTurn(
  db: FirebaseFirestore.Firestore,
  params: StartTurnParams,
): ReadableStream<InferUIMessageChunk<UIMessage>> {
  const { chatId, turnId } = params;

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  const clearHeartbeat = () => {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  // First error wins — set by execute failures and by streamText error chunks.
  let turnError: string | null = null;
  const noteError = (error: unknown): string => {
    const message = errorText(error);
    if (turnError === null) turnError = message;
    return message;
  };

  // The repaired history (not the raw client history) is what gets persisted.
  let repairedHistory: UIMessage[] | null = null;

  // Drives new-conversation semantics. Captured before the turn-start persist
  // creates the doc.
  let chatExistedAtStart = false;

  // Fired when the heartbeat's `touch` reports lost ownership (superseded or
  // stopped) — kills streamText and the in-flight tool poll loops.
  const abortController = new AbortController();

  // Set by onFinish. If the stream tears down without it (e.g. a chunk the
  // state machine rejects), the pump's finally closes the turn as errored so
  // the stream doc can't leak a fresh-looking 'running' state.
  let turnFinished = false;

  const stream = createUIMessageStream<UIMessage>({
    // Approval-resume: chunks for the PRIOR turn's toolCallId can only attach
    // to a message the state machine already knows, so it must be seeded with
    // the original history — otherwise "No tool invocation found for tool call
    // ID" kills the turn (asyncTurns.integration.test.ts scenario 3).
    originalMessages: params.messages,
    execute: async ({ writer }) => {
      // Transient part keeps the HTTP proxy awake; the touch keeps the stream
      // doc fresh (TURN_STALE_MS 45s) and returns the ownership signal.
      heartbeatTimer = setInterval(() => {
        try {
          writer.write({ type: 'data-heartbeat', transient: true, data: Date.now() });
        } catch {
          // Stream already torn down — nothing to heartbeat.
        }
        void touch(db, chatId, turnId).then((ownership) => {
          // Abort only on genuine loss. A Firestore `error` is indeterminate —
          // aborting on a single blip would drop a healthy in-flight response;
          // the next heartbeat re-checks.
          if (ownership === 'lost') {
            abortController.abort();
            clearHeartbeat();
          }
        });
      }, timing.heartbeatMs);

      // Must precede the turn-start persist, which creates the doc.
      try {
        chatExistedAtStart = (await db.collection('chats').doc(chatId).get()).exists;
      } catch {
        // Fail to "not new" so a read blip can't clobber an existing
        // conversation's LLM title with a placeholder.
        chatExistedAtStart = true;
      }

      const { messages: repairedMessages, repairedToolCallIds } =
        await repairDanglingToolParts(params.messages, {
          resolveLostResult: buildResolveLostResult(
            db,
            params.siteId,
            params.priorToolCommands ?? null,
            params.machineId === SITE_TARGET_ID,
          ),
        });
      if (repairedToolCallIds.length > 0) {
        console.warn(
          `[hoot] repaired ${repairedToolCallIds.length} dangling tool part(s) in chat ${sanitizeForLog(chatId)}: ${sanitizeForLog(repairedToolCallIds.join(', '))}`,
        );
      }
      repairedHistory = repairedMessages;

      // Persist the repaired history now so the user's just-sent message is
      // durable before any reattach. Only on confirmed `owned` — `lost` and
      // `error` both risk clobbering another turn's state.
      try {
        if ((await touch(db, chatId, turnId)) === 'owned') {
          await persistChatMessages(db, params, repairedMessages, !chatExistedAtStart);
        }
      } catch (error) {
        // Recoverable via stream doc + repair; must not reject into the stream.
        console.error(`[hoot] turn-start persist failed for chat ${sanitizeForLog(chatId)}:`, error);
      }

      const isSiteMode = params.machineId === SITE_TARGET_ID;
      const onlineMachines = isSiteMode ? await getOnlineMachines(db, params.siteId) : [];
      if (isSiteMode && onlineMachines.length === 0) {
        throw new Error('No machines are currently online in this site.');
      }

      const [llmConfig, requireTier3Approval, processes] = await Promise.all([
        resolveLlmConfig(db, params.userId),
        getHootRequireTier3Approval(db, params.siteId),
        isSiteMode
          ? Promise.resolve<ProcessSummary[]>([])
          : fetchProcessSummaries(db, params.siteId, params.machineId),
      ]);

      const earnedTier = resolveHootMaxTier(params.access);
      const toolDefs = getToolsByTier(
        params.maxToolTier === undefined
          ? earnedTier
          : (Math.min(params.maxToolTier, earnedTier) as ToolTier),
      );
      const tools = buildExecutableTools(
        db,
        params.siteId,
        params.machineId,
        chatId,
        toolDefs,
        isSiteMode,
        onlineMachines,
        {
          userId: params.userId,
          userRole: params.access.role,
          requireTier3Approval,
          toolCallbacks: {
            onCommandQueued: (toolCallId: string, commandId: string, machineId: string) =>
              recordToolCommand(db, chatId, turnId, toolCallId, commandId, machineId),
            abortSignal: abortController.signal,
          },
        },
      );

      const result = streamText({
        model: createModel(llmConfig),
        system: isSiteMode
          ? buildSystemPrompt('', true)
          : buildSystemPrompt(params.machineName || params.machineId, false, processes),
        // Pass `tools` so per-tool toModelOutput hooks (e.g. capture_screenshot
        // → image-url) also project PRIOR-turn outputs into model content.
        messages: await convertToModelMessages(repairedMessages, { tools }),
        tools,
        stopWhen: stepCountIs(10),
        abortSignal: abortController.signal,
      });

      // Model/tool-loop errors arrive as error CHUNKS, not rejections.
      writer.merge(result.toUIMessageStream({ onError: noteError }));
    },
    onError: noteError,
    onFinish: async ({ responseMessage }) => {
      turnFinished = true;
      clearHeartbeat();
      const isNewConversation = !chatExistedAtStart;
      // Replace-or-append: on approval-resume the SDK continues the trailing
      // assistant message (same id), so appending would duplicate it.
      const baseHistory = repairedHistory ?? params.messages;
      const hasResponseParts =
        Array.isArray(responseMessage?.parts) && responseMessage.parts.length > 0;
      const mergedMessages = !hasResponseParts
        ? baseHistory
        : baseHistory.length > 0 && baseHistory[baseHistory.length - 1].id === responseMessage.id
          ? [...baseHistory.slice(0, -1), responseMessage]
          : [...baseHistory, responseMessage];

      try {
        if (turnError !== null) {
          // Still persist the partial history so a provider error can't erase
          // a brand-new conversation.
          const stillOwned = await finishTurn(db, chatId, turnId, 'error', turnError);
          if (stillOwned) {
            await persistChatMessages(db, params, mergedMessages, isNewConversation);
          }
          return;
        }

        // finishTurn first — its turnId-guarded write is the supersede check.
        // `false` means a newer turn owns persistence; writing our final array
        // would clobber it.
        const stillOwned = await finishTurn(db, chatId, turnId, 'complete');
        if (!stillOwned) return;

        await persistChatMessages(db, params, mergedMessages, isNewConversation);

        const userMessage = firstUserText(mergedMessages);
        if (isNewConversation && userMessage) {
          resolveLlmConfig(db, params.userId)
            .then((cfg) => categorizeNewChat(db, createCheapModel(cfg), chatId, userMessage))
            .catch(() => {
              /* best-effort */
            });
        }
      } catch (error) {
        // Must not reject into the stream machinery; content survives in the
        // stream doc and repair recovers it on the next send.
        console.error(`[hoot] final persist failed for chat ${sanitizeForLog(chatId)}:`, error);
      }
    },
  });

  // One branch to the HTTP response, one to the Firestore snapshot pump. The
  // pump consumes to completion, which keeps the source stream (and onFinish)
  // running after the HTTP branch dies.
  const [httpBranch, snapshotBranch] = stream.tee();

  // Seed the pump for the same approval-resume reason as `originalMessages`.
  const lastMessage = params.messages[params.messages.length - 1];
  const resumeMessage = lastMessage?.role === 'assistant' ? lastMessage : undefined;

  (async () => {
    for await (const message of readUIMessageStream<UIMessage>({
      stream: snapshotBranch,
      message: resumeMessage,
    })) {
      // writeSnapshot self-throttles (≥750ms apart) and never throws.
      await writeSnapshot(db, chatId, turnId, message);
    }
  })()
    .catch(async (error) => {
      console.error(`[hoot] snapshot pump failed for chat ${sanitizeForLog(chatId)}:`, error);
      if (turnError === null) turnError = errorText(error);
    })
    .finally(async () => {
      // Torn down without onFinish (state-machine rejection, pump failure):
      // close as errored, else the doc leaks 'running' and a still-armed
      // heartbeat keeps it looking fresh, defeating stale detection.
      if (turnFinished) return;
      clearHeartbeat();
      await finishTurn(
        db,
        chatId,
        turnId,
        'error',
        turnError ?? 'turn ended without finishing',
      ).catch(() => {
        /* finishTurn never throws by contract; belt and braces. */
      });
    });

  return httpBranch;
}
