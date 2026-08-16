/**
 * Visual-check condition — "does the wall actually show what it should?"
 * (talons wave 2, task 2.4).
 *
 * Captures a fresh screenshot from the target machine and asks a vision model
 * to judge it against the operator's plain-language expectation. The verdict
 * gates the talon's outputs: `fail` fires them, `pass` short-circuits the run.
 *
 * Two deliberate choices worth keeping:
 *
 *   - **The verdict is structured, never parsed out of prose.** `generateObject`
 *     with a zod schema means a model that rambles produces a schema error we
 *     surface as `verdict_error`, not a regex that silently reads "fail" out of
 *     the sentence "this does not fail to look correct".
 *   - **We persist the storage PATH, not the signed url.** Capture urls expire
 *     in an hour and the bucket lifecycle deletes screenshots at 30 days, so a
 *     url stored on a run doc is a dead link by the time anyone reviews the run.
 *     The url is returned alongside for one purpose only: embedding the image in
 *     the alert email that goes out seconds later.
 *
 * Concurrency note: the agent throttles `capture_screenshot` to one per 5s per
 * machine (`agent/src/owlette_service.py` `COMMAND_RATE_LIMIT_SECONDS`), so two
 * checks must never be issued to one machine concurrently — the second comes
 * back `Error: rate limited`. The engine runs machine-scoped runs in sequence
 * for exactly this reason.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { generateObject } from 'ai';
import { z } from 'zod';
import { ExecuteMachineCommandError } from '@/lib/actions/executeMachineCommand.server';
import { dispatchAndAwait } from '@/lib/jobs/talonRunner.server';
import { createModel } from '@/lib/llm';
import logger from '@/lib/logger';
import {
  TalonAuthorError,
  resolveTalonAuthor,
  resolveTalonAuthorLlmConfig,
} from './author.server';
import type { StoredTalon } from './store.server';
import type { TalonDisabledReason, TalonVisualCheckCondition } from './types';

/**
 * Poll budget for the capture. Wider than the shared 30s command timeout: the
 * agent has to hop into the interactive desktop session, grab the framebuffer,
 * request a signed url, and PUT the bytes to GCS before it writes a result.
 */
export const VISUAL_CHECK_CAPTURE_TIMEOUT_MS = 45_000;

/** The condition fields this evaluator reads — a full `TalonVisualCheckCondition` is assignable. */
export type VisualCheckSpec = Pick<TalonVisualCheckCondition, 'expectation' | 'monitor'>;

export type TalonVisualCheckErrorCode =
  | 'capture_failed'
  | 'machine_offline'
  | 'no_interactive_session'
  | 'verdict_error'
  | 'author_unavailable';

/**
 * A visual check that could not produce a verdict at all — distinct from a
 * `fail` verdict, which IS an answer. The engine maps the two "the machine
 * wasn't in a state to be checked" codes (`machine_offline`,
 * `no_interactive_session`) onto a skipped run and the genuine faults
 * (`capture_failed`, `verdict_error`) onto a failed one.
 *
 * `author_unavailable` is the third kind: not a fault of the machine or the
 * model but of the person whose key backs the check. It always carries a
 * `disabledReason`, and the engine switches the talon off rather than failing
 * it ten more times to reach the same conclusion.
 */
export class TalonVisualCheckError extends Error {
  readonly code: TalonVisualCheckErrorCode;
  /** Set only on `author_unavailable` — the reason to stamp on the talon. */
  readonly disabledReason?: TalonDisabledReason;

  constructor(
    code: TalonVisualCheckErrorCode,
    message: string,
    disabledReason?: TalonDisabledReason,
  ) {
    super(message);
    this.name = 'TalonVisualCheckError';
    this.code = code;
    if (disabledReason) this.disabledReason = disabledReason;
  }
}

export interface VisualCheckResult {
  verdict: 'pass' | 'fail';
  /** Model confidence in its own verdict, 0–1. */
  confidence: number;
  /** One-line justification, shown on the run and in the alert email. */
  reason: string;
  /** GCS object path — the durable reference. */
  screenshotPath?: string;
  /** Signed read url. Expires in ~1h: embed it now, never persist it as a link. */
  screenshotUrl?: string;
}

export const visualCheckVerdictSchema = z.object({
  verdict: z.enum(['pass', 'fail']),
  /**
   * Deliberately unbounded IN THE SCHEMA. `z.number().min(0).max(1)` renders as
   * JSON Schema `minimum`/`maximum`, and Google's structured-output dialect
   * rejects both on a number — "For 'number' type, properties maximum, minimum
   * are not supported" — which failed EVERY visual check on a Gemini key with
   * `verdict_error` before the model was even asked to look at the screenshot.
   *
   * The bound is not lost, just moved: {@link clampConfidence} applies it after
   * the call, where it also covers a model that answers 0-100 or NaN. Schemas
   * that cross a provider boundary have to hold to the smallest dialect any
   * provider accepts; a constraint we can enforce ourselves does not belong in
   * one. Anything added here must be checked against Google's subset.
   */
  confidence: z.number(),
  reason: z.string(),
});

/**
 * The [0,1] bound the schema can no longer carry. A model that returns 87 (a
 * percentage), a negative, or a NaN gets pulled back into range rather than
 * poisoning the run record and the alert email — and an unusable value reads as
 * no confidence rather than total confidence.
 */
function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value > 1 && value <= 100) return Math.min(1, value / 100);
  return Math.min(1, Math.max(0, value));
}

const VISUAL_CHECK_SYSTEM_PROMPT = `You are a strict visual inspector for unattended video-wall, kiosk, and digital-signage installations. You are shown one screenshot of a remote machine's display and one operator expectation describing what that display should look like right now.

Decide whether the screenshot satisfies the expectation.

- Judge only what is visible. Do not assume anything about the machine that the image does not show.
- Treat obvious failure states as failing the expectation even when the operator did not enumerate them: a black or blank screen, the Windows desktop or taskbar where content should be, an error dialog, a crash report, a frozen loading indicator, a stretched or letterboxed image where content should be full-bleed, or a projector/display "no signal" card.
- If the image is too dark, too small, or too ambiguous to tell, return "fail" with LOW confidence and say plainly what you could not determine. A false alarm an operator can dismiss is far cheaper than a dead wall nobody was told about.
- "confidence" is your confidence in the verdict you returned, not the probability that things are fine.
- "reason" is one short sentence an on-call operator can read on a phone. Describe what you actually see.`;

/* -------------------------------------------------------------------------- */
/*  capture                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The `capture_screenshot` success payload as `machine_commands.py` writes it
 * (`_handle_capture_screenshot`, lines 56-130). NOT the `{message, url, base64}`
 * shape the MCP tool route returns — that is a different producer.
 */
interface CaptureResult {
  storage_path?: string;
  url?: string;
  size_kb?: number;
  monitor?: number;
  monitor_count?: number;
}

/** "no interactive session" is the one capture failure that is not our fault. */
function captureErrorCodeFor(message: string): TalonVisualCheckErrorCode {
  return /no interactive/i.test(message) ? 'no_interactive_session' : 'capture_failed';
}

function throwCaptureError(message: string): never {
  throw new TalonVisualCheckError(captureErrorCodeFor(message), message);
}

/**
 * Normalize the agent's terminal completed-entry into the capture payload, or
 * throw the typed error the entry describes.
 */
function readCaptureResult(entry: Record<string, unknown>): CaptureResult {
  if (entry.status === 'failed' || entry.status === 'cancelled') {
    throwCaptureError(
      typeof entry.error === 'string' && entry.error.length > 0
        ? entry.error
        : `screenshot capture ${String(entry.status)}`,
    );
  }

  let result: unknown = entry.result;
  // The agent returns a dict on success and an `Error: ...` string on failure.
  // A JSON-encoded dict is accepted too — some agent versions stringify the
  // result before writing it back.
  if (typeof result === 'string') {
    if (result.startsWith('Error:')) throwCaptureError(result);
    try {
      result = JSON.parse(result);
    } catch {
      throwCaptureError(`screenshot capture returned an unreadable result: ${result}`);
    }
  }

  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    throwCaptureError('screenshot capture returned no result payload');
  }

  return result as CaptureResult;
}

/* -------------------------------------------------------------------------- */
/*  evaluation                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The vision model this check runs on: the author's own, re-resolved every run.
 *
 * There is no shared site key any more (see `resolveLlmConfig`), so a visual
 * check spends the key of whoever wrote the talon — and only while that person
 * still has access to the site. Both halves are the same fire-time question the
 * hoot output asks, answered by the same module, so the two AI paths can never
 * drift apart on who is allowed to run unattended work.
 */
async function resolveAuthorModel(db: Firestore, siteId: string, talon: StoredTalon) {
  try {
    const author = await resolveTalonAuthor(db, siteId, talon);
    return createModel(await resolveTalonAuthorLlmConfig(db, author.userId));
  } catch (error) {
    if (error instanceof TalonAuthorError) {
      throw new TalonVisualCheckError('author_unavailable', error.message, error.reason);
    }
    // Transient — a failed read, a missing site. Stays on the failure counter.
    throw new TalonVisualCheckError(
      'verdict_error',
      `could not resolve who this talon runs as: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Capture the machine's display and judge it against `condition.expectation`.
 *
 * @param talon the talon being evaluated — its `createdBy` is the person whose
 *              key pays for the verdict, re-checked on every run.
 * @throws {TalonVisualCheckError} when no verdict could be produced.
 */
export async function evaluateVisualCheck(
  db: Firestore,
  siteId: string,
  machineId: string,
  talon: StoredTalon,
  condition: VisualCheckSpec,
  correlationId: string,
): Promise<VisualCheckResult> {
  // Resolved BEFORE the capture: a check nobody can pay for should not cost the
  // machine a 45-second screenshot round trip to find that out.
  const model = await resolveAuthorModel(db, siteId, talon);

  const capture = await captureScreenshot(db, siteId, machineId, condition, correlationId);

  const url = capture.url;
  if (typeof url !== 'string' || url.length === 0) {
    throw new TalonVisualCheckError(
      'capture_failed',
      'screenshot capture returned no readable url to evaluate',
    );
  }

  let imageUrl: URL;
  try {
    imageUrl = new URL(url);
  } catch {
    throw new TalonVisualCheckError(
      'capture_failed',
      'screenshot capture returned a malformed url',
    );
  }

  let verdict: z.infer<typeof visualCheckVerdictSchema>;
  try {
    const generated = await generateObject({
      model,
      schema: visualCheckVerdictSchema,
      system: VISUAL_CHECK_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Operator expectation for this display:\n\n${condition.expectation}`,
            },
            { type: 'image', image: imageUrl },
          ],
        },
      ],
    });
    verdict = generated.object;
  } catch (error) {
    throw new TalonVisualCheckError(
      'verdict_error',
      `the vision model did not return a usable verdict: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const confidence = clampConfidence(verdict.confidence);

  logger.info(
    `Talon visual check on ${machineId}: ${verdict.verdict} (${confidence})`,
    { context: 'talons/visualCheck', data: { siteId, machineId, correlationId } },
  );

  return {
    verdict: verdict.verdict,
    confidence,
    reason: verdict.reason,
    ...(capture.storage_path ? { screenshotPath: capture.storage_path } : {}),
    screenshotUrl: url,
  };
}

async function captureScreenshot(
  db: Firestore,
  siteId: string,
  machineId: string,
  condition: VisualCheckSpec,
  correlationId: string,
): Promise<CaptureResult> {
  let outcome;
  try {
    outcome = await dispatchAndAwait(
      db,
      {
        siteId,
        machineId,
        type: 'capture_screenshot',
        // 0 (the default) = all monitors combined, 1 = primary, and so on.
        payload: { monitor: condition.monitor ?? 0 },
        correlationId,
      },
      { timeoutMs: VISUAL_CHECK_CAPTURE_TIMEOUT_MS },
    );
  } catch (error) {
    if (error instanceof ExecuteMachineCommandError && error.status === 409) {
      throw new TalonVisualCheckError('machine_offline', error.detail);
    }
    throw new TalonVisualCheckError(
      'capture_failed',
      `could not queue the screenshot capture: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (outcome.status === 'timeout') {
    throw new TalonVisualCheckError(
      'capture_failed',
      `the machine did not return a screenshot within ${Math.round(
        VISUAL_CHECK_CAPTURE_TIMEOUT_MS / 1000,
      )} seconds`,
    );
  }

  return readCaptureResult(outcome.entry);
}
