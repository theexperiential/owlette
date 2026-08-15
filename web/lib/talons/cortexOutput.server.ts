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
 * authoring time. A talon written by an admin who has since left the site, been
 * demoted, or been soft-deleted must not keep executing with the privileges
 * they held the day they wrote it. `verifyUserSiteAccess` throwing is a hard
 * `failed`, never a degraded run.
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
 * `startTurn` derives its tool tier from the `access` it is handed
 * (`resolveCortexMaxTier`), and that mapping is binary — site admin → tier 3,
 * everyone else → tier 1. Tier-3 tools can require an in-chat approval
 * (`getCortexRequireTier3Approval`) and an unattended turn has nobody to grant
 * one, so the call would sit until the turn was declared stale. The resolved
 * access is therefore clamped to non-admin before it reaches the runner, which
 * puts a hoot turn on read-only tools. Talons that need to ACT on a machine use
 * a `command` output, which is separately gated on `MACHINE_EXEC_COMMAND` when
 * the talon is authored.
 *
 * ## llm key
 *
 * `startTurn` resolves its own config internally — `resolveLlmConfig(db,
 * userId, siteId)` — and accepts no override, so a hoot turn uses the
 * CREATOR's personal key when they have one and falls back to the site key
 * otherwise. The store refuses to save a cortex-output talon unless a site key
 * exists (`assertSiteLlmKeyAvailable`, resolved with `autonomous: true`), so
 * the fallback is always present: a creator who later removes their personal
 * key does not silently break the talon.
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
import {
  verifyUserSiteAccess,
  type SiteAccessLevel,
} from '@/lib/cortex-utils.server';
import { startTurn } from '@/lib/cortex/turnRunner.server';
import { acquireTurnLock, generateTurnId } from '@/lib/cortex/turnStore.server';
import logger from '@/lib/logger';
import type { StoredTalon } from './store.server';
import type { TalonRunCondition } from './types';

/** Sentinel `machineId` for site-wide mode (mirrors /api/cortex + the runner). */
const SITE_TARGET_ID = '__site__';

/**
 * `createdBy` prefix the store writes for a non-user author
 * (`authorIdentifier` in `store.server.ts`). Such a talon has no uid whose
 * access could be re-resolved, so it can never drive a hoot turn.
 */
const SYSTEM_AUTHOR_PREFIX = 'system:';

/** Everything a hoot turn needs about the run that is firing it. */
export interface RunCortexOutputArgs {
  siteId: string;
  /** The full talon — `createdBy` is what the fire-time access check resolves. */
  talon: StoredTalon;
  runId: string;
  correlationId: string;
  /** The operator's instruction, verbatim. */
  directive: string;
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
 * the other output executors record.
 */
export type RunCortexOutputResult =
  | { status: 'sent'; chatId: string }
  | { status: 'failed'; detail: string; error?: string };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Clamp resolved access to what an UNATTENDED turn may drive.
 *
 * `resolveCortexMaxTier` reads exactly two flags, so dropping both admin flags
 * is what caps the turn — the same clamp `/api/cortex` applies to api-key
 * callers. Keep `role` / `isSiteOwner` intact: the runner passes `role` through
 * to `buildExecutableTools` for audit attribution, and rewriting it would
 * misreport who the turn is acting as.
 */
export function clampToUnattendedAccess(access: SiteAccessLevel): SiteAccessLevel {
  return { ...access, isSuperadmin: false, isSiteAdmin: false };
}

/**
 * The synthetic user message the turn opens with: the operator's directive,
 * then the facts the assistant would otherwise have to go looking for.
 *
 * The screenshot url is included ONLY on a failed visual check, and only as a
 * url — it is a short-lived signed link (~1h), which is fine for a turn that
 * starts within seconds, and the run doc keeps the durable storage path.
 */
function buildDirectiveMessage(args: RunCortexOutputArgs): UIMessage {
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
export async function runCortexOutput(
  db: Firestore,
  args: RunCortexOutputArgs,
): Promise<RunCortexOutputResult> {
  const { siteId, talon, runId } = args;

  // No uid, no access check — and a hoot turn without an attributable creator
  // is exactly the unbounded-privilege case the re-resolution exists to stop.
  if (!talon.createdBy || talon.createdBy.startsWith(SYSTEM_AUTHOR_PREFIX)) {
    return { status: 'failed', detail: 'no_attributable_creator' };
  }

  let access: SiteAccessLevel;
  try {
    access = await verifyUserSiteAccess(db, talon.createdBy, siteId);
  } catch (error) {
    // Creator deleted, unassigned from the site, or the site is gone. Recording
    // the reason rather than the raw message keeps the run list readable; the
    // message goes in `error` for whoever has to diagnose it.
    return { status: 'failed', detail: 'creator_access_revoked', error: errorText(error) };
  }

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
        userId: talon.createdBy,
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
      userId: talon.createdBy,
      access: clampToUnattendedAccess(access),
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
