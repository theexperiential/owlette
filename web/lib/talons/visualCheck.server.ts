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
import { resolveLlmConfig } from '@/lib/hoot-utils.server';
import { dispatchAndAwait } from '@/lib/jobs/talonRunner.server';
import { createModel } from '@/lib/llm';
import logger from '@/lib/logger';
import type { TalonVisualCheckCondition } from './types';

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
  | 'verdict_error';

/**
 * A visual check that could not produce a verdict at all — distinct from a
 * `fail` verdict, which IS an answer. The engine maps the two "the machine
 * wasn't in a state to be checked" codes (`machine_offline`,
 * `no_interactive_session`) onto a skipped run and the two genuine faults
 * (`capture_failed`, `verdict_error`) onto a failed one.
 */
export class TalonVisualCheckError extends Error {
  readonly code: TalonVisualCheckErrorCode;

  constructor(code: TalonVisualCheckErrorCode, message: string) {
    super(message);
    this.name = 'TalonVisualCheckError';
    this.code = code;
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

const verdictSchema = z.object({
  verdict: z.enum(['pass', 'fail']),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});

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
 * Capture the machine's display and judge it against `condition.expectation`.
 *
 * @throws {TalonVisualCheckError} when no verdict could be produced.
 */
export async function evaluateVisualCheck(
  db: Firestore,
  siteId: string,
  machineId: string,
  condition: VisualCheckSpec,
  correlationId: string,
): Promise<VisualCheckResult> {
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

  // `autonomous: true` skips the per-user key by design — a talon runs with no
  // human in the loop, so only a site-level key can back it.
  let model;
  try {
    model = createModel(await resolveLlmConfig(db, null, siteId, { autonomous: true }));
  } catch (error) {
    throw new TalonVisualCheckError(
      'verdict_error',
      `this talon needs a usable site llm key to judge the screenshot: ${
        error instanceof Error ? error.message : 'no site-level llm key is configured.'
      }`,
    );
  }

  let verdict: z.infer<typeof verdictSchema>;
  try {
    const generated = await generateObject({
      model,
      schema: verdictSchema,
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

  logger.info(
    `Talon visual check on ${machineId}: ${verdict.verdict} (${verdict.confidence})`,
    { context: 'talons/visualCheck', data: { siteId, machineId, correlationId } },
  );

  return {
    verdict: verdict.verdict,
    confidence: verdict.confidence,
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
