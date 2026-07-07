/**
 * Cortex turn runner — detached LLM loop (cortex-async-turns wave 2.2).
 *
 * A chat turn (LLM loop + tool execution) no longer lives inside the HTTP
 * request: `startTurn` returns the live UI-message stream immediately, while
 * the turn itself keeps running server-side until the model finishes — even
 * if the HTTP response dies (proxy idle timeout, page reload, network drop).
 *
 * Plumbing per turn:
 *   - `createUIMessageStream` drives `streamText`; the resulting chunk stream
 *     is teed. One branch is returned to the route (best-effort live UX); the
 *     other is pumped through `readUIMessageStream` into throttled
 *     `writeSnapshot` calls on `chats/{chatId}/stream/current`, so a
 *     reattaching client can render the turn from Firestore alone.
 *   - A transient `data-heartbeat` part every ~20s keeps proxies from seeing
 *     an idle connection during long tool waits (transient parts never enter
 *     the message state); the same tick bumps the stream doc's `updatedAt` so
 *     a long model/tool gap isn't declared a dead runner.
 *   - Tool dispatches report `toolCallId → machineId → {commandId}` via
 *     `recordToolCommand` (the recovery index). The ~20s heartbeat alone keeps
 *     the stream doc fresh during long tool waits (well under TURN_STALE_MS of
 *     45s), so no redundant per-poll touch is needed.
 *   - Before the model call, the history is repaired: dangling tool parts
 *     from a prior dead turn get a recovery attempt against
 *     `commands/completed` using the prior stream doc's `toolCommands` index.
 *     The repaired history is persisted to `chats/{chatId}` immediately (a
 *     turnId-guarded write) so the user's just-sent message is durable before
 *     any reattach — even if the model call or a tool later fails.
 *   - A per-turn AbortController is aborted the moment the heartbeat's `touch`
 *     reports the turn no longer owns the stream doc (superseded by a newer
 *     turn, or stopped via /api/cortex/stop). That aborts `streamText` and the
 *     in-flight tool poll loops so a dead turn stops doing invisible work.
 *   - On finish the runner is the persist authority: it marks the turn
 *     terminal and writes the final message array to `chats/{chatId}`
 *     (schema mirrors the client persist in `useCortex.ts`), then triggers
 *     categorization for new conversations.
 *
 * Failure discipline: `startTurn` never throws and every detached chain ends
 * in `finishTurn('error', …)`; internal failures surface as an error chunk on
 * the returned stream (via `createUIMessageStream`'s onError), so the client
 * always sees the turn terminate. turnStore writes are turnId-guarded no-ops
 * once superseded, and the final chat persist is skipped when `finishTurn`
 * reports the turn no longer owns the stream doc.
 *
 * IMPORTANT: Server-side only — never import this in client components.
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
import { getToolsByTier } from '@/lib/mcp-tools';
import {
  buildExecutableTools,
  getCortexRequireTier3Approval,
  getOnlineMachines,
  resolveCortexMaxTier,
  resolveLlmConfig,
  type SiteAccessLevel,
} from '@/lib/cortex-utils.server';
import {
  repairDanglingToolParts,
  STILL_RUNNING_ERROR,
  type LostResultResolution,
} from '@/lib/cortex/repairMessages';
import {
  finishTurn,
  recordToolCommand,
  touch,
  writeSnapshot,
} from '@/lib/cortex/turnStore.server';
import { categorizeNewChat } from '@/lib/cortex/categorizeChat.server';

/** Sentinel machineId for site-wide mode (mirrors /api/cortex). */
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
  /** Prior turn's recovery index: `toolCallId → machineId → { commandId }`. */
  priorToolCommands?: Record<string, Record<string, { commandId: string }>> | null;
  source?: 'user' | 'followup';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Fetch process configurations from Firestore for system prompt context.
 * (Moved from /api/cortex/route.ts — the runner owns the LLM call now.)
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

/** Per-machine recovery outcome (before it is shaped for single vs site mode). */
type MachineOutcome =
  | { kind: 'output'; output: unknown }
  | { kind: 'error'; errorText: string }
  | null;

/**
 * Look one machine's `commands/completed` entry up by commandId and classify it:
 *   - terminal success → `{ output }` (JSON-parsed like executeToolOnAgent)
 *   - `failed` / `cancelled` → `{ errorText }` from the entry
 *   - `running` (agent still executing) → `{ errorText: STILL_RUNNING_ERROR }`
 *   - entry absent (consumed, GC'd, or never dispatched) / read failure → `null`
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

    // Terminal success — parse string results like executeToolOnAgent does.
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
 * Build the repair-time recovery resolver from the PRIOR turn's nested
 * `toolCommands` index (`toolCallId → machineId → { commandId }`).
 *
 * Single-machine turn (`isSiteMode === false`): there is exactly one machine
 * entry — resolve it and return the UNWRAPPED result (`{ output }` /
 * `{ errorText }`) exactly as the live single-machine path produces.
 *
 * Site-wide turn (`isSiteMode === true`): a dangling toolCallId fanned out to N
 * machines. Resolve EVERY machine entry and AGGREGATE into the site-wide shape
 * the live path produces (`buildExecutableTools` → `{ machines: [...] }`):
 * `{ output: { machines: [{ machine, ...perMachineResult }, ...] } }`, where a
 * machine's success spreads its output object, a failed/cancelled/running
 * machine contributes `{ machine, error }`, and an absent entry is skipped. If
 * NO machine entry resolves, return `null` so the repair falls back to the
 * synthesized lost-result error.
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
      // Single-machine: exactly one entry — resolve + unwrap.
      const [machineId, { commandId }] = entries[0];
      const outcome = await resolveMachineEntry(db, siteId, machineId, commandId);
      if (!outcome) return null;
      return outcome.kind === 'output'
        ? { output: outcome.output }
        : { errorText: outcome.errorText };
    }

    // Site-wide: aggregate per-machine results into `{ machines: [...] }`.
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
 * Persist a message array to `chats/{chatId}` — the server-side mirror of the
 * client persist in `useCortex.ts` (JSON-cloned parts; merge write). Used for
 * BOTH the turn-start persist (repaired history, so the user's message is
 * durable up front) and the final persist. `isNewConversation` is decided by
 * whether the chat doc pre-existed at turn start — NOT by message count — so a
 * superseded first turn can't permanently skip the title/createdAt stamp.
 * Title + createdAt are only written for new conversations (placeholder title
 * until the LLM categorizer replaces it; the LLM title is never overwritten).
 */
async function persistChatMessages(
  db: FirebaseFirestore.Firestore,
  params: StartTurnParams,
  messages: UIMessage[],
  isNewConversation: boolean,
): Promise<void> {
  const isSiteMode = params.machineId === SITE_TARGET_ID;
  const title = isNewConversation
    ? firstUserText(messages).slice(0, 100) || 'new conversation'
    : undefined;

  // Serialize for Firestore — the JSON round-trip strips nested `undefined`.
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
 * Start a detached Cortex turn.
 *
 * Returns the HTTP tee branch IMMEDIATELY; all turn work continues detached
 * (the snapshot pump consumes the other branch, so the turn runs to
 * completion even if the returned stream is abandoned). NEVER throws and
 * never rejects the returned stream's consumer with an unhandled error:
 * internal failures → `finishTurn('error', msg)` + an error chunk on the
 * stream.
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

  // First error wins — set by execute failures (via onError) and by
  // streamText's own error chunks (via toUIMessageStream's onError).
  let turnError: string | null = null;
  const noteError = (error: unknown): string => {
    const message = errorText(error);
    if (turnError === null) turnError = message;
    return message;
  };

  // Set once the history repair completes — the repaired history (not the
  // raw client history) is what gets persisted alongside the response.
  let repairedHistory: UIMessage[] | null = null;

  // Whether the chat doc already existed when this turn started. Drives
  // new-conversation semantics (title/createdAt stamp + categorize) — decided
  // by doc existence, NOT message count, so a superseded first turn can't
  // permanently skip the stamp. Captured before the turn-start persist creates
  // the doc.
  let chatExistedAtStart = false;

  // Per-turn abort: fired when the heartbeat's `touch` reports this turn no
  // longer owns the stream doc (superseded or stopped). Aborts streamText and
  // the in-flight tool poll loops so a dead turn stops doing invisible work.
  const abortController = new AbortController();

  // Set by onFinish. If the stream tears down without onFinish (e.g. a chunk
  // the state machine rejects), the pump's completion path below closes the
  // turn as errored so the stream doc can never leak a fresh-looking
  // 'running' state.
  let turnFinished = false;

  const stream = createUIMessageStream<UIMessage>({
    // Approval-resume contract: when the history ends with an assistant
    // message carrying an approved tool call, streamText executes that tool
    // and emits output chunks for the PRIOR turn's toolCallId. The stream's
    // state machine can only attach those to an existing message when it is
    // seeded with the original history — without this it throws
    // "No tool invocation found for tool call ID" and the turn dies
    // (pinned by asyncTurns.integration.test.ts scenario 3).
    originalMessages: params.messages,
    execute: async ({ writer }) => {
      // Heartbeat from the very start: transient part for the HTTP proxy,
      // stream-doc touch so a long silent gap (model thinking, tool wait)
      // is never mistaken for a dead runner (TURN_STALE_MS is 45s). The touch
      // return is the ownership signal.
      heartbeatTimer = setInterval(() => {
        try {
          writer.write({ type: 'data-heartbeat', transient: true, data: Date.now() });
        } catch {
          // Stream already torn down — nothing to heartbeat.
        }
        void touch(db, chatId, turnId).then((ownership) => {
          // Abort ONLY on genuine ownership loss (`lost`): a newer turn owns
          // the doc (supersede) or it was stopped. A transient Firestore
          // failure (`error`) is INDETERMINATE — keep the turn alive; the next
          // heartbeat re-checks. Aborting a healthy turn on a single blip would
          // silently drop the user's in-flight response.
          if (ownership === 'lost') {
            abortController.abort();
            clearHeartbeat();
          }
        });
      }, timing.heartbeatMs);

      // Capture doc existence BEFORE the turn-start persist creates it — this
      // is the new-conversation signal for the whole turn.
      try {
        chatExistedAtStart = (await db.collection('chats').doc(chatId).get()).exists;
      } catch {
        // Best effort — a failed read defaults to "not new" so we never
        // clobber an existing conversation's LLM title with a placeholder.
        chatExistedAtStart = true;
      }

      // ── 1. Repair history with commandId recovery ─────────────────────
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
          `[cortex] repaired ${repairedToolCallIds.length} dangling tool part(s) in chat ${chatId}: ${repairedToolCallIds.join(', ')}`,
        );
      }
      repairedHistory = repairedMessages;

      // ── 1b. Persist the repaired history NOW (turnId-guarded) ─────────
      // Makes the user's just-sent message durable before any reattach, and
      // survives a later model/tool failure. Persist ONLY on confirmed
      // ownership (`owned`): a supersede (`lost`) means the newer turn owns the
      // chat doc, and a transient failure (`error`) can't confirm ownership —
      // in both cases skip rather than risk clobbering another turn's state.
      try {
        if ((await touch(db, chatId, turnId)) === 'owned') {
          await persistChatMessages(db, params, repairedMessages, !chatExistedAtStart);
        }
      } catch (error) {
        // A failed start-persist is recoverable (stream doc + repair) — never
        // let it reject into the stream machinery.
        console.error(`[cortex] turn-start persist failed for chat ${chatId}:`, error);
      }

      // ── 2. Tools ──────────────────────────────────────────────────────
      const isSiteMode = params.machineId === SITE_TARGET_ID;
      const onlineMachines = isSiteMode ? await getOnlineMachines(db, params.siteId) : [];
      if (isSiteMode && onlineMachines.length === 0) {
        throw new Error('No machines are currently online in this site.');
      }

      const [llmConfig, requireTier3Approval, processes] = await Promise.all([
        resolveLlmConfig(db, params.userId, params.siteId),
        getCortexRequireTier3Approval(db, params.siteId),
        isSiteMode
          ? Promise.resolve<ProcessSummary[]>([])
          : fetchProcessSummaries(db, params.siteId, params.machineId),
      ]);

      const toolDefs = getToolsByTier(resolveCortexMaxTier(params.access));
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
            // Abort the poll loops when this turn loses ownership — the ~20s
            // heartbeat keeps the stream doc fresh, so no per-poll touch here.
            abortSignal: abortController.signal,
          },
        },
      );

      // ── 3. LLM call ───────────────────────────────────────────────────
      const result = streamText({
        model: createModel(llmConfig),
        system: isSiteMode
          ? buildSystemPrompt('', true)
          : buildSystemPrompt(params.machineName || params.machineId, false, processes),
        // Convert with the built tools so per-tool toModelOutput hooks (e.g.
        // capture_screenshot → image-url) project prior-turn tool outputs
        // into model content, not just on the turn they were produced.
        messages: await convertToModelMessages(repairedMessages, { tools }),
        tools,
        stopWhen: stepCountIs(10),
        // Superseded/stopped → abort the model loop (mirrors the tool aborts).
        abortSignal: abortController.signal,
      });

      // Model/tool-loop errors surface as error CHUNKS (not rejections) —
      // capture them so onFinish records the turn as errored.
      writer.merge(result.toUIMessageStream({ onError: noteError }));
    },
    // Execute rejections become an error chunk with this text on the stream.
    onError: noteError,
    onFinish: async ({ responseMessage }) => {
      turnFinished = true;
      clearHeartbeat();
      const isNewConversation = !chatExistedAtStart;
      // Replace-or-append: on approval-resume the SDK CONTINUES the history's
      // trailing assistant message (same id) instead of minting a new one —
      // appending would duplicate it. When responseMessage has no parts (e.g.
      // an immediate model error), fall back to the base history alone.
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
          // Errored turn: still mark terminal, and if we still own the doc,
          // persist what we have (base history + any partial response) so a
          // provider error can't erase a brand-new conversation.
          const stillOwned = await finishTurn(db, chatId, turnId, 'error', turnError);
          if (stillOwned) {
            await persistChatMessages(db, params, mergedMessages, isNewConversation);
          }
          return;
        }

        // finishTurn first: its turnId-guarded write is the supersede check.
        // `false` means a newer turn owns the stream doc — its runner (and the
        // commandId recovery index) own persistence now, so writing our final
        // array would clobber the newer conversation state.
        const stillOwned = await finishTurn(db, chatId, turnId, 'complete');
        if (!stillOwned) return;

        await persistChatMessages(db, params, mergedMessages, isNewConversation);

        // Auto-title + categorize new conversations (fire-and-forget).
        const userMessage = firstUserText(mergedMessages);
        if (isNewConversation && userMessage) {
          resolveLlmConfig(db, params.userId, params.siteId)
            .then((cfg) => categorizeNewChat(db, createCheapModel(cfg), chatId, userMessage))
            .catch(() => {
              /* best-effort */
            });
        }
      } catch (error) {
        // Persist failure must not reject into the stream machinery — the
        // turn content survives in the stream doc + repair recovers next send.
        console.error(`[cortex] final persist failed for chat ${chatId}:`, error);
      }
    },
  });

  // Tee: one branch back to the HTTP response, the other into the Firestore
  // snapshot pump. The pump always consumes to completion, which is what
  // keeps the source stream (and onFinish) running after the HTTP branch dies.
  const [httpBranch, snapshotBranch] = stream.tee();

  // Seed the pump with the trailing assistant message (if any) for the same
  // approval-resume reason as `originalMessages` above: output chunks for a
  // prior turn's toolCallId can only be applied to a message that contains
  // that tool part.
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
      console.error(`[cortex] snapshot pump failed for chat ${chatId}:`, error);
      if (turnError === null) turnError = errorText(error);
    })
    .finally(async () => {
      // Last-resort turn closure: if the stream tore down without onFinish
      // (state-machine rejection, pump failure), close the turn as errored —
      // otherwise the stream doc leaks 'running' and, worse, a still-armed
      // heartbeat would keep it looking fresh, defeating stale detection.
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
