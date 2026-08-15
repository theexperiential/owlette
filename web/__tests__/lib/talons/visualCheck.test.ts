/** @jest-environment node */

/**
 * Unit tests for the talon visual-check condition (talons wave 2, task 2.4).
 *
 * Two collaborators are mocked at their module boundary: the command dispatch
 * layer (the only thing that acts as the `talon_runner` system actor) and the
 * model call. Everything between them — the `capture_screenshot` result
 * contract, the failure taxonomy, and the shape of the prompt the model is
 * handed — is exercised for real, because that is where the bugs live.
 *
 * `@/lib/actions/executeMachineCommand.server` stays UNMOCKED so the 409
 * `ExecuteMachineCommandError` the offline test throws is the same class the
 * evaluator's `instanceof` check sees.
 */

const mockDispatchAndAwait = jest.fn();
const mockResolveLlmConfig = jest.fn();
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
  resolveLlmConfig: (...args: unknown[]) => mockResolveLlmConfig(...args),
  COMMAND_POLL_INTERVAL_MS: 0,
  COMMAND_TIMEOUT_MS: 30000,
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
import {
  evaluateVisualCheck,
  TalonVisualCheckError,
  VISUAL_CHECK_CAPTURE_TIMEOUT_MS,
  type TalonVisualCheckErrorCode,
} from '@/lib/talons/visualCheck.server';

const SITE = 'site-a';
const MACHINE = 'lobby-01';
const CORRELATION = 'corr-1';
const SIGNED_URL = 'https://storage.googleapis.com/bucket/shot.png?X-Goog-Signature=abc';
const STORAGE_PATH = 'screenshots/site-a/lobby-01/2026-08-14.png';

const db = {} as unknown as Firestore;

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
  mockResolveLlmConfig.mockReset();
  mockGenerateObject.mockReset();
  mockCreateModel.mockReturnValue({ modelId: 'fake-model' });
  mockResolveLlmConfig.mockResolvedValue({ provider: 'anthropic', apiKey: 'sk-test' });
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
      evaluateVisualCheck(db, SITE, MACHINE, condition(), CORRELATION),
    ).resolves.toEqual({
      verdict: 'pass',
      confidence: 0.96,
      reason: 'the show loop fills the screen',
      screenshotPath: STORAGE_PATH,
      screenshotUrl: SIGNED_URL,
    });
  });

  it('returns a fail verdict', async () => {
    mockDispatchAndAwait.mockResolvedValue(captureEntry());
    mockGenerateObject.mockResolvedValue({
      object: { verdict: 'fail', confidence: 0.72, reason: 'the windows desktop is visible' },
    });

    const result = await evaluateVisualCheck(db, SITE, MACHINE, condition(), CORRELATION);
    expect(result.verdict).toBe('fail');
    expect(result.reason).toBe('the windows desktop is visible');
  });

  it('captures monitor 0 by default and honors an explicit monitor', async () => {
    mockDispatchAndAwait.mockResolvedValue(captureEntry());
    mockGenerateObject.mockResolvedValue({
      object: { verdict: 'pass', confidence: 0.9, reason: 'ok' },
    });

    await evaluateVisualCheck(db, SITE, MACHINE, condition(), CORRELATION);
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

    await evaluateVisualCheck(db, SITE, MACHINE, condition(2), CORRELATION);
    expect(mockDispatchAndAwait.mock.calls[1][1]).toMatchObject({ payload: { monitor: 2 } });
  });

  it('hands the model the expectation and the screenshot as image content', async () => {
    mockDispatchAndAwait.mockResolvedValue(captureEntry());
    mockGenerateObject.mockResolvedValue({
      object: { verdict: 'pass', confidence: 0.9, reason: 'ok' },
    });

    await evaluateVisualCheck(db, SITE, MACHINE, condition(), CORRELATION);

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
      evaluateVisualCheck(db, SITE, MACHINE, condition(), CORRELATION),
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
      evaluateVisualCheck(db, SITE, MACHINE, condition(), CORRELATION),
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
      evaluateVisualCheck(db, SITE, MACHINE, condition(), CORRELATION),
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
      evaluateVisualCheck(db, SITE, MACHINE, condition(), CORRELATION),
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
      evaluateVisualCheck(db, SITE, MACHINE, condition(), CORRELATION),
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
      evaluateVisualCheck(db, SITE, MACHINE, condition(), CORRELATION),
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
      evaluateVisualCheck(db, SITE, MACHINE, condition(), CORRELATION),
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
      evaluateVisualCheck(db, SITE, MACHINE, condition(), CORRELATION),
      'capture_failed',
    );
    expect(mockResolveLlmConfig).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------------- */
/*  verdict failures                                                          */
/* ------------------------------------------------------------------------- */

describe('verdict failures', () => {
  it('reports a missing site llm key as verdict_error', async () => {
    mockDispatchAndAwait.mockResolvedValue(captureEntry());
    mockResolveLlmConfig.mockRejectedValue(
      new Error('No site-level LLM API key configured. Autonomous hoot requires a site-level key.'),
    );

    const error = await expectVisualCheckError(
      evaluateVisualCheck(db, SITE, MACHINE, condition(), CORRELATION),
      'verdict_error',
    );
    expect(error.message).toContain('site llm key');
    // Autonomous: never fall back to a per-user key — no human is in the loop.
    expect(mockResolveLlmConfig).toHaveBeenCalledWith(db, null, SITE, { autonomous: true });
    expect(mockGenerateObject).not.toHaveBeenCalled();
  });

  it('reports a model that did not produce a schema-valid object as verdict_error', async () => {
    mockDispatchAndAwait.mockResolvedValue(captureEntry());
    mockGenerateObject.mockRejectedValue(new Error('response did not match schema'));

    const error = await expectVisualCheckError(
      evaluateVisualCheck(db, SITE, MACHINE, condition(), CORRELATION),
      'verdict_error',
    );
    expect(error.message).toContain('did not match schema');
  });
});
