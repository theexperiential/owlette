/** @jest-environment node */

/**
 * Unit tests for the talon visual-check condition (talons wave 2, task 2.4).
 *
 * Three collaborators are mocked at their module boundary: the command dispatch
 * layer (the only thing that acts as the `talon_runner` system actor), the
 * author pre-flight, and the model call. Everything between them — the
 * `capture_screenshot` result contract, the failure taxonomy, and the shape of
 * the prompt the model is handed — is exercised for real, because that is where
 * the bugs live.
 *
 * `author.server` keeps its REAL `TalonAuthorError` (`requireActual` spread) so
 * the `instanceof` narrowing that decides fatal-vs-transient is the real one.
 *
 * `@/lib/actions/executeMachineCommand.server` stays UNMOCKED so the 409
 * `ExecuteMachineCommandError` the offline test throws is the same class the
 * evaluator's `instanceof` check sees.
 */

const mockDispatchAndAwait = jest.fn();
const mockResolveTalonAuthor = jest.fn();
const mockResolveTalonAuthorLlmConfig = jest.fn();
const mockCreateModel = jest.fn();
const mockGenerateObject = jest.fn();

jest.mock('firebase-admin/firestore', () => ({
  __esModule: true,
  FieldValue: { delete: () => '__DELETE__', serverTimestamp: () => '__SERVER_TS__' },
  Timestamp: class {},
}));
jest.mock('@/lib/firebase-admin', () => ({
  __esModule: true,
  getAdminDb: jest.fn(),
  getAdminAuth: jest.fn(),
}));
jest.mock('@/lib/jobs/talonRunner.server', () => ({
  __esModule: true,
  dispatchAndAwait: (...args: unknown[]) => mockDispatchAndAwait(...args),
  dispatchTalonCommand: jest.fn(),
  pollTalonCommandResult: jest.fn(),
}));
jest.mock('@/lib/hoot-utils.server', () => ({
  __esModule: true,
  COMMAND_POLL_INTERVAL_MS: 0,
  COMMAND_TIMEOUT_MS: 30000,
}));
jest.mock('@/lib/talons/author.server', () => ({
  ...jest.requireActual('@/lib/talons/author.server'),
  __esModule: true,
  resolveTalonAuthor: (...args: unknown[]) => mockResolveTalonAuthor(...args),
  resolveTalonAuthorLlmConfig: (...args: unknown[]) => mockResolveTalonAuthorLlmConfig(...args),
}));
jest.mock('@/lib/llm', () => ({
  __esModule: true,
  createModel: (...args: unknown[]) => mockCreateModel(...args),
}));
jest.mock('ai', () => ({
  __esModule: true,
  generateObject: (...args: unknown[]) => mockGenerateObject(...args),
}));
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import type { Firestore } from 'firebase-admin/firestore';
import { ExecuteMachineCommandError } from '@/lib/actions/executeMachineCommand.server';
import { TalonAuthorError } from '@/lib/talons/author.server';
import type { StoredTalon } from '@/lib/talons/store.server';
import type { TalonDoc } from '@/lib/talons/types';
import {
  evaluateVisualCheck,
  TalonVisualCheckError,
  VISUAL_CHECK_CAPTURE_TIMEOUT_MS,
  visualCheckVerdictSchema,
  type TalonVisualCheckErrorCode,
} from '@/lib/talons/visualCheck.server';

const SITE = 'site-a';
const MACHINE = 'lobby-01';
const CORRELATION = 'corr-1';
const SIGNED_URL = 'https://storage.googleapis.com/bucket/shot.png?X-Goog-Signature=abc';
const STORAGE_PATH = 'screenshots/site-a/lobby-01/2026-08-14.png';

const db = {} as unknown as Firestore;

/** The talon under evaluation — `createdBy` is whose key pays for the verdict. */
const TALON: StoredTalon = {
  id: 't1',
  ...({
    schemaVersion: 1,
    name: 'lobby wall check',
    enabled: true,
    trigger: { type: 'schedule', intervalMinutes: 60 },
    condition: { type: 'visual_check', expectation: 'the show loop is playing full screen' },
    outputs: [{ type: 'email' }],
    scope: { machineIds: null },
    cooldownMinutes: 60,
    createdBy: 'admin-uid',
    createdVia: 'ui',
    createdAt: new Date(),
    updatedAt: new Date(),
    consecutiveFailures: 0,
  } satisfies TalonDoc),
};

/** The success payload `machine_commands.py` writes back. */
function captureEntry(overrides: Record<string, unknown> = {}) {
  return {
    status: 'completed',
    commandId: 'cmd_1',
    entry: {
      status: 'success',
      result: {
        storage_path: STORAGE_PATH,
        url: SIGNED_URL,
        size_kb: 412,
        monitor: 0,
        monitor_count: 3,
        ...overrides,
      },
    },
  };
}

function condition(monitor?: number) {
  return { expectation: 'the show loop is playing full screen', ...(monitor === undefined ? {} : { monitor }) };
}

async function expectVisualCheckError(
  promise: Promise<unknown>,
  code: TalonVisualCheckErrorCode,
): Promise<TalonVisualCheckError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(TalonVisualCheckError);
  expect((error as TalonVisualCheckError).code).toBe(code);
  return error as TalonVisualCheckError;
}

beforeEach(() => {
  mockDispatchAndAwait.mockReset();
  mockResolveTalonAuthor.mockReset();
  mockResolveTalonAuthorLlmConfig.mockReset();
  mockGenerateObject.mockReset();
  mockCreateModel.mockReturnValue({ modelId: 'fake-model' });
  mockResolveTalonAuthor.mockResolvedValue({
    userId: 'admin-uid',
    access: { role: 'admin', isSuperadmin: false, isSiteAdmin: true, isSiteOwner: false },
  });
  mockResolveTalonAuthorLlmConfig.mockResolvedValue({ provider: 'anthropic', apiKey: 'sk-test' });
});

/* ------------------------------------------------------------------------- */
/*  happy paths                                                               */
/* ------------------------------------------------------------------------- */

describe('evaluateVisualCheck', () => {
  it('returns a pass verdict with the capture references', async () => {
    mockDispatchAndAwait.mockResolvedValue(captureEntry());
    mockGenerateObject.mockResolvedValue({
      object: { verdict: 'pass', confidence: 0.96, reason: 'the show loop fills the screen' },
    });

    await expect(
      evaluateVisualCheck(db, SITE, MACHINE, TALON, condition(), CORRELATION),
    ).resolves.toEqual({
      verdict: 'pass',
      confidence: 0.96,
      reason: 'the show loop fills the screen',
      screenshotPath: STORAGE_PATH,
      screenshotUrl: SIGNED_URL,
    });
  });

  /* --- confidence is bounded by us, not by the schema ----------------------
   *
   * `z.number().min(0).max(1)` renders as JSON Schema minimum/maximum, which
   * Google's structured-output dialect rejects outright — every visual check on
   * a Gemini key died with `verdict_error` before the model saw the screenshot.
   * The bound moved into code, so these pin what the schema no longer says.
   */

  it('declares no numeric bounds on confidence — they break google structured output', () => {
    // Asserted through behaviour rather than by rendering JSON Schema, so this
    // holds across zod versions: a schema that ACCEPTS 87 is a schema that
    // emitted no `minimum`/`maximum` for the provider to reject.
    expect(
      visualCheckVerdictSchema.safeParse({ verdict: 'pass', confidence: 87, reason: 'ok' }).success,
    ).toBe(true);
  });

  it.each([
    // 87 is read as a percentage, not clamped to 1: a model that answers on a
    // 0-100 scale is claiming high-but-not-total confidence, and rounding that
    // UP to certainty is the one direction that misleads an operator. Anything
    // past 100 is nonsense rather than a scale, so it just clamps.
    ['a percentage', 87, 0.87],
    ['nonsense above every scale', 250, 1],
    ['below the range', -0.5, 0],
    ['not a number', Number.NaN, 0],
  ])('clamps confidence returned %s', async (_label, returned, expected) => {
    mockDispatchAndAwait.mockResolvedValue(captureEntry());
    mockGenerateObject.mockResolvedValue({
      object: { verdict: 'pass', confidence: returned, reason: 'ok' },
    });

    await expect(
      evaluateVisualCheck(db, SITE, MACHINE, TALON, condition(), CORRELATION),
    ).resolves.toMatchObject({ confidence: expected });
  });

  it('returns a fail verdict', async () => {
    mockDispatchAndAwait.mockResolvedValue(captureEntry());
    mockGenerateObject.mockResolvedValue({
      object: { verdict: 'fail', confidence: 0.72, reason: 'the windows desktop is visible' },
    });

    const result = await evaluateVisualCheck(db, SITE, MACHINE, TALON, condition(), CORRELATION);
    expect(result.verdict).toBe('fail');
    expect(result.reason).toBe('the windows desktop is visible');
  });

  it('captures monitor 0 by default and honors an explicit monitor', async () => {
    mockDispatchAndAwait.mockResolvedValue(captureEntry());
    mockGenerateObject.mockResolvedValue({
      object: { verdict: 'pass', confidence: 0.9, reason: 'ok' },
    });

    await evaluateVisualCheck(db, SITE, MACHINE, TALON, condition(), CORRELATION);
    expect(mockDispatchAndAwait).toHaveBeenCalledWith(
      db,
      {
        siteId: SITE,
        machineId: MACHINE,
        type: 'capture_screenshot',
        payload: { monitor: 0 },
        correlationId: CORRELATION,
      },
      { timeoutMs: VISUAL_CHECK_CAPTURE_TIMEOUT_MS },
    );

    await evaluateVisualCheck(db, SITE, MACHINE, TALON, condition(2), CORRELATION);
    expect(mockDispatchAndAwait.mock.calls[1][1]).toMatchObject({ payload: { monitor: 2 } });
  });

  it('hands the model the expectation and the screenshot as image content', async () => {
    mockDispatchAndAwait.mockResolvedValue(captureEntry());
    mockGenerateObject.mockResolvedValue({
      object: { verdict: 'pass', confidence: 0.9, reason: 'ok' },
    });

    await evaluateVisualCheck(db, SITE, MACHINE, TALON, condition(), CORRELATION);

    const args = mockGenerateObject.mock.calls[0][0];
    expect(args.system).toContain('video-wall');
    const content = args.messages[0].content;
    expect(content[0]).toEqual({
      type: 'text',
      text: expect.stringContaining('the show loop is playing full screen'),
    });
    expect(content[1].type).toBe('image');
    expect(String(content[1].image)).toBe(SIGNED_URL);
  });

  it('accepts a json-encoded capture result', async () => {
    mockDispatchAndAwait.mockResolvedValue({
      status: 'completed',
      commandId: 'cmd_1',
      entry: {
        status: 'success',
        result: JSON.stringify({ storage_path: STORAGE_PATH, url: SIGNED_URL }),
      },
    });
    mockGenerateObject.mockResolvedValue({
      object: { verdict: 'pass', confidence: 0.9, reason: 'ok' },
    });

    await expect(
      evaluateVisualCheck(db, SITE, MACHINE, TALON, condition(), CORRELATION),
    ).resolves.toMatchObject({ screenshotPath: STORAGE_PATH });
  });
});

/* ------------------------------------------------------------------------- */
/*  capture failures                                                          */
/* ------------------------------------------------------------------------- */

describe('capture failures', () => {
  it('reports a poll timeout as capture_failed', async () => {
    mockDispatchAndAwait.mockResolvedValue({ status: 'timeout', commandId: 'cmd_1' });

    const error = await expectVisualCheckError(
      evaluateVisualCheck(db, SITE, MACHINE, TALON, condition(), CORRELATION),
      'capture_failed',
    );
    expect(error.message).toContain('45 seconds');
    expect(mockGenerateObject).not.toHaveBeenCalled();
  });

  it('reports a 409 from the action core as machine_offline', async () => {
    mockDispatchAndAwait.mockRejectedValue(
      new ExecuteMachineCommandError(
        409,
        'machine_offline',
        `machine ${MACHINE} is currently offline; commands cannot be queued until it reconnects`,
      ),
    );

    const error = await expectVisualCheckError(
      evaluateVisualCheck(db, SITE, MACHINE, TALON, condition(), CORRELATION),
      'machine_offline',
    );
    expect(error.message).toContain('currently offline');
  });

  it('reports a machine with nobody logged in as no_interactive_session', async () => {
    mockDispatchAndAwait.mockResolvedValue({
      status: 'completed',
      commandId: 'cmd_1',
      entry: {
        status: 'failed',
        error: 'Error: capture_screenshot failed: no interactive session available',
      },
    });

    await expectVisualCheckError(
      evaluateVisualCheck(db, SITE, MACHINE, TALON, condition(), CORRELATION),
      'no_interactive_session',
    );
  });

  it('reports any other agent error as capture_failed', async () => {
    mockDispatchAndAwait.mockResolvedValue({
      status: 'completed',
      commandId: 'cmd_1',
      entry: { status: 'failed', error: 'Error: failed to obtain valid auth token' },
    });

    await expectVisualCheckError(
      evaluateVisualCheck(db, SITE, MACHINE, TALON, condition(), CORRELATION),
      'capture_failed',
    );
  });

  it('reports an `Error:` string result as capture_failed', async () => {
    mockDispatchAndAwait.mockResolvedValue({
      status: 'completed',
      commandId: 'cmd_1',
      entry: { status: 'success', result: 'Error: firebase_client unavailable' },
    });

    await expectVisualCheckError(
      evaluateVisualCheck(db, SITE, MACHINE, TALON, condition(), CORRELATION),
      'capture_failed',
    );
  });

  it('reports a cancelled capture as capture_failed', async () => {
    mockDispatchAndAwait.mockResolvedValue({
      status: 'completed',
      commandId: 'cmd_1',
      entry: { status: 'cancelled' },
    });

    await expectVisualCheckError(
      evaluateVisualCheck(db, SITE, MACHINE, TALON, condition(), CORRELATION),
      'capture_failed',
    );
  });

  it('refuses to judge a capture that returned no url', async () => {
    mockDispatchAndAwait.mockResolvedValue({
      status: 'completed',
      commandId: 'cmd_1',
      entry: { status: 'success', result: { storage_path: STORAGE_PATH } },
    });

    await expectVisualCheckError(
      evaluateVisualCheck(db, SITE, MACHINE, TALON, condition(), CORRELATION),
      'capture_failed',
    );
    expect(mockGenerateObject).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------------- */
/*  verdict failures                                                          */
/* ------------------------------------------------------------------------- */

describe('the author pre-flight', () => {
  it("runs on the AUTHOR's key, resolved before the machine is asked for a shot", async () => {
    mockDispatchAndAwait.mockResolvedValue(captureEntry());
    mockGenerateObject.mockResolvedValue({
      object: { verdict: 'pass', confidence: 0.9, reason: 'the loop is playing' },
    });

    await evaluateVisualCheck(db, SITE, MACHINE, TALON, condition(), CORRELATION);

    expect(mockResolveTalonAuthor).toHaveBeenCalledWith(db, SITE, TALON);
    expect(mockResolveTalonAuthorLlmConfig).toHaveBeenCalledWith(db, 'admin-uid');
  });

  it.each([
    'creator_not_a_user',
    'creator_deleted',
    'creator_access_revoked',
  ] as const)('turns the %s refusal into a talon-disabling error', async (reason) => {
    mockResolveTalonAuthor.mockRejectedValue(new TalonAuthorError(reason, 'author is gone'));

    const error = await expectVisualCheckError(
      evaluateVisualCheck(db, SITE, MACHINE, TALON, condition(), CORRELATION),
      'author_unavailable',
    );
    expect(error.disabledReason).toBe(reason);
    // Never even asks the machine: a check nobody can pay for should not cost a
    // 45-second screenshot round trip to discover that.
    expect(mockDispatchAndAwait).not.toHaveBeenCalled();
    expect(mockGenerateObject).not.toHaveBeenCalled();
  });

  it('turns a missing author key into a talon-disabling error', async () => {
    mockResolveTalonAuthorLlmConfig.mockRejectedValue(
      new TalonAuthorError('creator_missing_llm_key', 'no usable llm key'),
    );

    const error = await expectVisualCheckError(
      evaluateVisualCheck(db, SITE, MACHINE, TALON, condition(), CORRELATION),
      'author_unavailable',
    );
    expect(error.disabledReason).toBe('creator_missing_llm_key');
  });

  it('leaves a transient author-resolution failure on the failure counter', async () => {
    mockResolveTalonAuthor.mockRejectedValue(new Error('DEADLINE_EXCEEDED'));

    const error = await expectVisualCheckError(
      evaluateVisualCheck(db, SITE, MACHINE, TALON, condition(), CORRELATION),
      'verdict_error',
    );
    // No reason — a database that was briefly unreachable must not switch a
    // talon off.
    expect(error.disabledReason).toBeUndefined();
  });
});

/* ------------------------------------------------------------------------- */
/*  verdict failures                                                          */
/* ------------------------------------------------------------------------- */

describe('verdict failures', () => {
  it('reports a model that did not produce a schema-valid object as verdict_error', async () => {
    mockDispatchAndAwait.mockResolvedValue(captureEntry());
    mockGenerateObject.mockRejectedValue(new Error('response did not match schema'));

    const error = await expectVisualCheckError(
      evaluateVisualCheck(db, SITE, MACHINE, TALON, condition(), CORRELATION),
      'verdict_error',
    );
    expect(error.message).toContain('did not match schema');
  });
});
