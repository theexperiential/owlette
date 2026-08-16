/**
 * The hoot output — an action-triggered headless assistant turn
 * (talons wave 3, task 3.3).
 *
 * A talon output `{ type: 'cortex', directive }` hands its directive to the
 * assistant — "hoot" in user-facing copy; this file, the wire, and every stored
 * field stay `cortex` — and lets it work the problem with real tools. Nobody is
 * in the loop, which drives every decision below.
 *
 * ## fire-time access re-resolution
 *
 * The creator's site access is re-resolved on EVERY run and never trusted from
 * authoring time (`resolveTalonAuthor`). A talon written by an admin who has
 * since left the site, been demoted, or been soft-deleted must not keep
 * executing with the privileges they held the day they wrote it. That is a hard
 * `failed`, never a degraded run — and, because no amount of retrying brings a
 * departed author back, it carries a {@link TalonDisabledReason} the engine
 * uses to switch the talon off on the spot instead of after ten silent
 * failures.
 *
 * ## one fresh chat per run
 *
 * Every run creates `chats/talon_{ms}_{runId}` instead of appending to a
 * standing conversation. The turn store holds exactly ONE lock per chat, so two
 * runs sharing a chat would race for it — the loser either gets rejected or
 * supersedes a live turn mid-thought. A fresh chat also makes the work readable
 * on its own: that chat IS the artifact the run record points at.
 *
 * ## tier ceiling
 *
 * The turn's tool tier is set EXPLICITLY here (`maxToolTier`), never by
 * degrading the access object. `startTurn` intersects the ceiling with the tier
 * the re-resolved access already earns, so the ceiling can only ever lower the
 * tool set — a creator who has been demoted since authoring still drops to
 * tier 1, which is the whole point of re-resolving.
 *
 * Two ceilings, decided by the output's `allowActions` flag:
 *
 *   - default (`allowActions` absent or false) — {@link READ_ONLY_TIER}. Hoot
 *     can look at the machine and report; it cannot touch it. Talons that need
 *     to act use a `command` output.
 *   - opted in (`allowActions: true`) — {@link UNATTENDED_MAX_TIER}: process
 *     control, service management, screenshots. Authoring the flag takes
 *     `MACHINE_EXEC_COMMAND`, the same privilege a `command` output takes
 *     (`store.server.ts`), because it is the same power over the same machine.
 *
 * Tier 3 is unreachable on this path in either case, and
 * {@link unattendedToolTier} caps it rather than trusting the call sites: a
 * tier-3 tool can require an in-chat approval (`getHootRequireTier3Approval`)
 * and an unattended turn has nobody to grant one, so the call would sit there
 * until the turn was declared stale. Nothing about powershell, file writes,
 * deploys, or reboots belongs on a turn nobody is watching.
 *
 * ## llm key
 *
 * `startTurn` resolves its own config internally — `resolveLlmConfig(db,
 * userId)` — and accepts no override, so a hoot turn always runs on the
 * CREATOR's own key. There is no shared site key to fall back to any more, so
 * the key is PRE-FLIGHTED here (`assertTalonAuthorLlmKey`) before a chat doc or
 * a turn lock is created: a creator who removed their key would otherwise leave
 * an empty chat and a claimed lock behind on every firing, and the failure
 * would surface deep inside a detached runner where the talon cannot hear it.
 * The pre-flight deliberately never receives the key itself.
 *
 * ## dispatch, not completion
 *
 * Starting the turn is the deliverable. The runner is detached by design (it
 * outlives the request that started it), so awaiting it here would hold the
 * talon run open for the length of a full LLM tool loop and turn a slow model
 * into a failed talon.
 *
 * IMPORTANT: Server-side only — never import this in client components.
 */
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import type { UIMessage } from 'ai';
import type { ToolTier } from '@/lib/mcp-tools';
import { startTurn } from '@/lib/hoot/turnRunner.server';
import { acquireTurnLock, generateTurnId } from '@/lib/hoot/turnStore.server';
import logger from '@/lib/logger';
import {
  TalonAuthorError,
  assertTalonAuthorLlmKey,
  resolveTalonAuthor,
  type TalonAuthor,
} from './author.server';
import type { StoredTalon } from './store.server';
import type { TalonDisabledReason, TalonRunCondition } from './types';

/** Sentinel `machineId` for site-wide mode (mirrors /api/hoot + the runner). */
const SITE_TARGET_ID = '__site__';

/** Everything a hoot turn needs about the run that is firing it. */
export interface RunHootOutputArgs {
  siteId: string;
  /** The full talon — `createdBy` is what the fire-time access check resolves. */
  talon: StoredTalon;
  runId: string;
  correlationId: string;
  /** The operator's instruction, verbatim. */
  directive: string;
  /**
   * The output's `allowActions` opt-in. `true` raises the ceiling from
   * read-only to tier 2 — see the tier-ceiling note at the top of this file.
   * Defaults to false, which is the behaviour every talon had before the flag
   * existed.
   */
  allowActions?: boolean;
  /** Human-readable, lowercase trigger description, e.g. `cpu_percent > 90`. */
  triggerSummary: string;
  /** Set on a machine-scoped run; absent runs go site-wide. */
  machineId?: string;
  machineName?: string;
  /** The condition outcome, when the talon had one. */
  condition?: TalonRunCondition;
}

/**
 * `sent` carries the chat the turn is running in — the observable artifact.
 * `failed` carries a stable machine-readable reason, matching the vocabulary
 * the other output executors record, plus `disabledReason` on the subset of
 * failures that retrying can never fix.
 */
export type RunHootOutputResult =
  | { status: 'sent'; chatId: string }
  | {
      status: 'failed';
      detail: string;
      error?: string;
      /** Present iff this failure must switch the talon off immediately. */
      disabledReason?: TalonDisabledReason;
    };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Look, don't touch — every read-only tool, and nothing else. */
export const READ_ONLY_TIER: ToolTier = 1;

/**
 * The highest tier ANY unattended turn may reach, whatever it asks for. Tier 3
 * is approval-gated and there is nobody here to approve.
 */
export const UNATTENDED_MAX_TIER: ToolTier = 2;

/**
 * The tool ceiling for an unattended turn. `startTurn` intersects it with the
 * tier the creator's re-resolved access earns, so this is a ceiling, not a
 * grant: a non-admin author's opted-in talon still lands on tier 1.
 */
export function unattendedToolTier(allowActions: boolean): ToolTier {
  const requested = allowActions ? UNATTENDED_MAX_TIER : READ_ONLY_TIER;
  return Math.min(UNATTENDED_MAX_TIER, requested) as ToolTier;
}

/**
 * The synthetic user message the turn opens with: the operator's directive,
 * then the facts the assistant would otherwise have to go looking for.
 *
 * The screenshot url is included ONLY on a failed visual check, and only as a
 * url — it is a short-lived signed link (~1h), which is fine for a turn that
 * starts within seconds, and the run doc keeps the durable storage path.
 */
function buildDirectiveMessage(args: RunHootOutputArgs): UIMessage {
  const lines = [
    args.directive.trim(),
    '',
    'context: a talon fired this. no person is in this conversation, so do not',
    'ask questions — investigate with the tools you have and state what you found.',
    `- talon: ${args.talon.name}`,
    `- trigger: ${args.triggerSummary}`,
  ];

  if (args.machineId) {
    lines.push(`- machine: ${args.machineName || args.machineId} (${args.machineId})`);
  } else {
    lines.push('- scope: every machine in this site');
  }

  const condition = args.condition;
  if (condition && condition.verdict === 'fail') {
    lines.push(
      `- visual check: failed${condition.reason ? ` — ${condition.reason}` : ''}`,
    );
    if (condition.screenshotUrl) {
      lines.push(`- screenshot: ${condition.screenshotUrl}`);
    }
  }

  return {
    id: `talon_msg_${args.runId}`,
    role: 'user',
    parts: [{ type: 'text', text: lines.join('\n') }],
  };
}

/**
 * Fire one hoot turn for a talon run.
 *
 * Never throws — every failure is a recorded `failed` result, because the
 * engine records outputs individually and one bad output must not abort the
 * rest of the run.
 *
 * @returns `sent` once the turn is dispatched (NOT once it completes).
 */
export async function runHootOutput(
  db: Firestore,
  args: RunHootOutputArgs,
): Promise<RunHootOutputResult> {
  const { siteId, talon, runId } = args;

  // Both pre-flights before ANY document is written: a creator who can no
  // longer back this talon must not leave a chat and a turn lock behind on
  // every firing. A `TalonAuthorError` is terminal by construction, so its
  // reason travels up and the engine disables the talon on this run.
  let author: TalonAuthor;
  try {
    author = await resolveTalonAuthor(db, siteId, talon);
    await assertTalonAuthorLlmKey(db, author.userId);
  } catch (error) {
    if (error instanceof TalonAuthorError) {
      // The reason is the readable half; the raw message goes in `error` for
      // whoever has to diagnose it.
      return {
        status: 'failed',
        detail: error.reason,
        error: error.message,
        disabledReason: error.reason,
      };
    }
    // Anything else — a failed read, a missing site — is transient and stays on
    // the consecutive-failure counter.
    return { status: 'failed', detail: 'author_check_failed', error: errorText(error) };
  }

  const access = author.access;
  const isSiteMode = !args.machineId;
  const machineId = args.machineId ?? SITE_TARGET_ID;
  const machineName = args.machineName || args.machineId || '';
  const chatId = `talon_${Date.now()}_${runId}`;

  // Create the chat BEFORE the turn starts. Beyond making the artifact visible
  // immediately, it means the runner sees an existing doc and treats the turn
  // as a continuation — so its placeholder title never overwrites `talon: …`
  // and the LLM categorizer is not run on a machine-authored conversation.
  try {
    await db
      .collection('chats')
      .doc(chatId)
      .set({
        source: 'talon',
        siteId,
        userId: author.userId,
        targetType: isSiteMode ? 'site' : 'machine',
        targetMachineId: isSiteMode ? null : machineId,
        machineName: isSiteMode ? 'All Machines' : machineName,
        title: `talon: ${talon.name}`,
        talonId: talon.id,
        runId,
        correlationId: args.correlationId,
        messages: [],
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
  } catch (error) {
    return { status: 'failed', detail: 'chat_create_failed', error: errorText(error) };
  }

  // A brand-new chat has no prior turn, so this claim cannot collide — but it
  // still goes through the lock, because the lock doc IS what the client
  // watches to render a running turn.
  const turnId = generateTurnId();
  let priorToolCommands;
  try {
    priorToolCommands = await acquireTurnLock(db, chatId, { turnId, siteId, machineId });
  } catch (error) {
    return { status: 'failed', detail: 'turn_lock_failed', error: errorText(error) };
  }

  try {
    const stream = startTurn(db, {
      chatId,
      turnId,
      siteId,
      machineId,
      machineName: isSiteMode ? '' : machineName,
      messages: [buildDirectiveMessage(args)],
      userId: author.userId,
      access,
      maxToolTier: unattendedToolTier(args.allowActions === true),
      priorToolCommands,
      source: 'talon',
    });

    // CRITICAL: `startTurn` returns the HTTP branch of a tee'd stream. There is
    // no HTTP response here, and an unread branch buffers every chunk of the
    // turn in memory without bound. Cancelling it drops that branch only — the
    // snapshot pump owns the other one and keeps the turn running to
    // completion.
    void stream.cancel().catch(() => {});
  } catch (error) {
    // `startTurn` is documented never to throw; this covers a synchronous
    // failure in its stream setup, which would otherwise escape as an
    // `output_threw` with no chat to point at.
    return { status: 'failed', detail: 'turn_start_failed', error: errorText(error) };
  }

  logger.info(`Talon ${talon.id} started hoot turn in chat ${chatId}`, {
    context: 'talons/hoot',
    data: { siteId, runId, machineId, turnId },
  });

  return { status: 'sent', chatId };
}
