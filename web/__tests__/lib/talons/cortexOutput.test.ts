/** @jest-environment node */

/**
 * Unit tests for the hoot output — the headless assistant turn a talon fires
 * (talons wave 3, task 3.3).
 *
 * The three collaborators that reach outside this module are mocked at their
 * boundary: the site-access check, the turn store (lock + turnId), and the
 * detached turn runner. Everything this module actually decides — whether the
 * creator may still drive a turn, what the chat doc looks like, what the
 * assistant is told, what privileges it gets, and the tee cancel that stops the
 * unread HTTP branch buffering — is exercised for real.
 *
 * `Date.now` is pinned so the generated chatId is assertable verbatim.
 */

const mockVerifyUserSiteAccess = jest.fn();
const mockStartTurn = jest.fn();
const mockAcquireTurnLock = jest.fn();
const mockCancel = jest.fn();

jest.mock('firebase-admin/firestore', () => ({
  __esModule: true,
  FieldValue: { serverTimestamp: () => '__SERVER_TS__' },
  Timestamp: class {},
}));
jest.mock('@/lib/firebase-admin', () => ({
  __esModule: true,
  getAdminDb: jest.fn(),
  getAdminAuth: jest.fn(),
}));
jest.mock('@/lib/cortex-utils.server', () => ({
  __esModule: true,
  verifyUserSiteAccess: (...args: unknown[]) => mockVerifyUserSiteAccess(...args),
}));
jest.mock('@/lib/cortex/turnRunner.server', () => ({
  __esModule: true,
  startTurn: (...args: unknown[]) => mockStartTurn(...args),
}));
jest.mock('@/lib/cortex/turnStore.server', () => ({
  __esModule: true,
  acquireTurnLock: (...args: unknown[]) => mockAcquireTurnLock(...args),
  generateTurnId: () => 'turn_fixed',
}));
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import type { Firestore } from 'firebase-admin/firestore';
import type { StartTurnParams } from '@/lib/cortex/turnRunner.server';
import {
  clampToUnattendedAccess,
  runCortexOutput,
  type RunCortexOutputArgs,
} from '@/lib/talons/cortexOutput.server';
import type { StoredTalon } from '@/lib/talons/store.server';
import type { TalonDoc } from '@/lib/talons/types';

/* ------------------------------------------------------------------------- */
/*  fixtures                                                                  */
/* ------------------------------------------------------------------------- */

const SITE = 'site-a';
const RUN_ID = 'run-1';
/** 2026-08-14T12:00:00Z — pinned so the chatId is deterministic. */
const NOW_MS = Date.parse('2026-08-14T12:00:00Z');
const EXPECTED_CHAT_ID = `talon_${NOW_MS}_${RUN_ID}`;

type DocData = Record<string, unknown>;

/** Just enough Firestore for `chats/{chatId}.set(...)`. */
class FakeFirestore {
  readonly docs = new Map<string, DocData>();
  setError: Error | null = null;

  collection(name: string) {
    return {
      doc: (id: string) => ({
        set: async (data: DocData) => {
          if (this.setError) throw this.setError;
          this.docs.set(`${name}/${id}`, { ...data });
        },
      }),
    };
  }
}

let fake: FakeFirestore;
let db: Firestore;

function talonFixture(overrides: Partial<TalonDoc> = {}): StoredTalon {
  const doc: TalonDoc = {
    schemaVersion: 1,
    name: 'lobby wall check',
    enabled: true,
    trigger: { type: 'threshold', metric: 'cpu_percent', operator: '>', value: 90 },
    condition: { type: 'none' },
    outputs: [{ type: 'cortex', directive: 'find out why the wall is black' }],
    scope: { machineIds: null },
    cooldownMinutes: 60,
    createdBy: 'admin-uid',
    createdVia: 'ui',
    createdAt: new Date(NOW_MS),
    updatedAt: new Date(NOW_MS),
    consecutiveFailures: 0,
    ...overrides,
  };
  return { id: 't1', ...doc };
}

function args(overrides: Partial<RunCortexOutputArgs> = {}): RunCortexOutputArgs {
  return {
    siteId: SITE,
    talon: talonFixture(),
    runId: RUN_ID,
    correlationId: 'corr-1',
    directive: 'find out why the wall is black',
    triggerSummary: 'cpu_percent > 90',
    machineId: 'm1',
    machineName: 'LOBBY-01',
    ...overrides,
  };
}

function chatDoc(): DocData | undefined {
  return fake.docs.get(`chats/${EXPECTED_CHAT_ID}`);
}

function startTurnParams(): StartTurnParams {
  return mockStartTurn.mock.calls[0][1] as StartTurnParams;
}

/** The text of the synthetic user message the turn opens with. */
function directiveText(): string {
  const [message] = startTurnParams().messages;
  const [part] = message.parts as { type: string; text: string }[];
  return part.text;
}

beforeEach(() => {
  fake = new FakeFirestore();
  db = fake as unknown as Firestore;
  jest.spyOn(Date, 'now').mockReturnValue(NOW_MS);

  mockVerifyUserSiteAccess.mockResolvedValue({
    role: 'admin',
    isSuperadmin: false,
    isSiteAdmin: true,
    isSiteOwner: true,
  });
  mockAcquireTurnLock.mockResolvedValue(null);
  mockCancel.mockResolvedValue(undefined);
  mockStartTurn.mockReturnValue({ cancel: mockCancel });
});

afterEach(() => {
  jest.restoreAllMocks();
});

/* ------------------------------------------------------------------------- */
/*  fire-time access re-resolution                                            */
/* ------------------------------------------------------------------------- */

describe('fire-time access re-resolution', () => {
  it('re-resolves the creator against the site on every run', async () => {
    await runCortexOutput(db, args());

    expect(mockVerifyUserSiteAccess).toHaveBeenCalledWith(db, 'admin-uid', SITE);
  });

  it('fails without starting a turn when the creator lost site access', async () => {
    mockVerifyUserSiteAccess.mockRejectedValue(new Error('You do not have access to this site'));

    const result = await runCortexOutput(db, args());

    expect(result).toEqual({
      status: 'failed',
      detail: 'creator_access_revoked',
      error: 'You do not have access to this site',
    });
    expect(mockStartTurn).not.toHaveBeenCalled();
    expect(mockAcquireTurnLock).not.toHaveBeenCalled();
    // No chat either: a conversation nobody is allowed to have must not exist.
    expect(fake.docs.size).toBe(0);
  });

  it('fails when the creator was deleted', async () => {
    mockVerifyUserSiteAccess.mockRejectedValue(new Error('User is deleted or inactive'));

    const result = await runCortexOutput(db, args());

    expect(result).toMatchObject({ status: 'failed', detail: 'creator_access_revoked' });
    expect(mockStartTurn).not.toHaveBeenCalled();
  });

  it('refuses a talon with no attributable creator', async () => {
    const result = await runCortexOutput(
      db,
      args({ talon: talonFixture({ createdBy: 'system:talon_runner' }) }),
    );

    expect(result).toEqual({ status: 'failed', detail: 'no_attributable_creator' });
    // There is no uid to check, so the access lookup is never even attempted.
    expect(mockVerifyUserSiteAccess).not.toHaveBeenCalled();
    expect(mockStartTurn).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------------- */
/*  fresh chat per run                                                        */
/* ------------------------------------------------------------------------- */

describe('the chat', () => {
  it('creates a fresh chat keyed by timestamp and run id', async () => {
    const result = await runCortexOutput(db, args());

    expect(result).toEqual({ status: 'sent', chatId: EXPECTED_CHAT_ID });
    expect(chatDoc()).toEqual({
      source: 'talon',
      siteId: SITE,
      userId: 'admin-uid',
      targetType: 'machine',
      targetMachineId: 'm1',
      machineName: 'LOBBY-01',
      title: 'talon: lobby wall check',
      talonId: 't1',
      runId: RUN_ID,
      correlationId: 'corr-1',
      messages: [],
      createdAt: '__SERVER_TS__',
      updatedAt: '__SERVER_TS__',
    });
  });

  it('creates the chat before claiming the lock, so the runner treats the turn as a continuation', async () => {
    await runCortexOutput(db, args());

    // Doc-exists is the runner's new-conversation signal; with the chat already
    // written, its placeholder title can never overwrite `talon: …`.
    expect(chatDoc()).toBeDefined();
    expect(mockAcquireTurnLock).toHaveBeenCalledWith(db, EXPECTED_CHAT_ID, {
      turnId: 'turn_fixed',
      siteId: SITE,
      machineId: 'm1',
    });
  });

  it('goes site-wide when the run names no machine', async () => {
    await runCortexOutput(db, args({ machineId: undefined, machineName: undefined }));

    expect(chatDoc()).toMatchObject({
      targetType: 'site',
      targetMachineId: null,
      machineName: 'All Machines',
    });
    expect(startTurnParams()).toMatchObject({ machineId: '__site__', machineName: '' });
  });

  it('fails without a lock or a turn when the chat cannot be written', async () => {
    fake.setError = new Error('permission denied');

    const result = await runCortexOutput(db, args());

    expect(result).toEqual({
      status: 'failed',
      detail: 'chat_create_failed',
      error: 'permission denied',
    });
    expect(mockAcquireTurnLock).not.toHaveBeenCalled();
    expect(mockStartTurn).not.toHaveBeenCalled();
  });

  it('fails without a turn when the lock cannot be claimed', async () => {
    mockAcquireTurnLock.mockRejectedValue(new Error('a turn is already running'));

    const result = await runCortexOutput(db, args());

    expect(result).toEqual({
      status: 'failed',
      detail: 'turn_lock_failed',
      error: 'a turn is already running',
    });
    expect(mockStartTurn).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------------- */
/*  the turn                                                                  */
/* ------------------------------------------------------------------------- */

describe('the turn', () => {
  it('starts headless with the run identifiers, the talon source, and the recovery index', async () => {
    mockAcquireTurnLock.mockResolvedValue({ call_1: { m1: { commandId: 'cmd_1' } } });

    await runCortexOutput(db, args());

    expect(startTurnParams()).toMatchObject({
      chatId: EXPECTED_CHAT_ID,
      turnId: 'turn_fixed',
      siteId: SITE,
      machineId: 'm1',
      machineName: 'LOBBY-01',
      userId: 'admin-uid',
      source: 'talon',
      priorToolCommands: { call_1: { m1: { commandId: 'cmd_1' } } },
    });
  });

  it('cancels the unread http tee branch immediately', async () => {
    // The runner returns the HTTP branch of a tee. Nothing reads it here, and
    // an unread branch buffers the whole turn in memory — the snapshot pump
    // owns the other branch and keeps the turn alive.
    await runCortexOutput(db, args());

    expect(mockCancel).toHaveBeenCalledTimes(1);
  });

  it('still reports sent when cancelling the branch rejects', async () => {
    mockCancel.mockRejectedValue(new Error('already errored'));

    await expect(runCortexOutput(db, args())).resolves.toEqual({
      status: 'sent',
      chatId: EXPECTED_CHAT_ID,
    });
  });

  it('records a failure rather than throwing when the runner cannot be started', async () => {
    mockStartTurn.mockImplementation(() => {
      throw new Error('stream setup failed');
    });

    const result = await runCortexOutput(db, args());

    expect(result).toEqual({
      status: 'failed',
      detail: 'turn_start_failed',
      error: 'stream setup failed',
    });
  });

});

/* ------------------------------------------------------------------------- */
/*  privilege clamp                                                           */
/* ------------------------------------------------------------------------- */

describe('privilege clamp', () => {
  it('strips the admin flags a tier-3 tool set would be derived from', async () => {
    mockVerifyUserSiteAccess.mockResolvedValue({
      role: 'superadmin',
      isSuperadmin: true,
      isSiteAdmin: true,
      isSiteOwner: true,
    });

    await runCortexOutput(db, args());

    // `resolveCortexMaxTier` reads ONLY `isSiteAdmin` (superadmin implies it):
    // false on both is what puts an unattended turn below tier 3, where a tool
    // call could otherwise block forever on an approval nobody will grant.
    expect(startTurnParams().access).toEqual({
      role: 'superadmin',
      isSuperadmin: false,
      isSiteAdmin: false,
      isSiteOwner: true,
    });
  });

  it('preserves the role for audit attribution', async () => {
    // The runner forwards `access.role` to buildExecutableTools as `userRole`;
    // rewriting it would misreport who the turn acted as.
    expect(
      clampToUnattendedAccess({
        role: 'admin',
        isSuperadmin: false,
        isSiteAdmin: true,
        isSiteOwner: false,
      }),
    ).toEqual({
      role: 'admin',
      isSuperadmin: false,
      isSiteAdmin: false,
      isSiteOwner: false,
    });
  });
});

/* ------------------------------------------------------------------------- */
/*  the directive message                                                     */
/* ------------------------------------------------------------------------- */

describe('the directive message', () => {
  it('opens with the directive and names the talon, trigger, and machine', async () => {
    await runCortexOutput(db, args());

    const [message] = startTurnParams().messages;
    expect(message).toMatchObject({ id: `talon_msg_${RUN_ID}`, role: 'user' });

    const text = directiveText();
    expect(text.startsWith('find out why the wall is black')).toBe(true);
    expect(text).toContain('- talon: lobby wall check');
    expect(text).toContain('- trigger: cpu_percent > 90');
    expect(text).toContain('- machine: LOBBY-01 (m1)');
  });

  it('says the scope is the whole site when no machine is named', async () => {
    await runCortexOutput(db, args({ machineId: undefined, machineName: undefined }));

    expect(directiveText()).toContain('- scope: every machine in this site');
  });

  it('carries the reason and screenshot from a failed visual check', async () => {
    await runCortexOutput(
      db,
      args({
        condition: {
          type: 'visual_check',
          verdict: 'fail',
          confidence: 0.91,
          reason: 'the wall is showing the windows desktop',
          screenshotPath: 'screenshots/site-a/m1/abc.png',
          screenshotUrl: 'https://storage.example.com/abc.png?sig=1',
        },
      }),
    );

    const text = directiveText();
    expect(text).toContain('- visual check: failed — the wall is showing the windows desktop');
    expect(text).toContain('- screenshot: https://storage.example.com/abc.png?sig=1');
  });

  it('omits the visual check block when the condition passed', async () => {
    // The engine only fires outputs on a failed check, but a `pass` reaching
    // here must never be described to the model as something to react to.
    await runCortexOutput(
      db,
      args({
        condition: { type: 'visual_check', verdict: 'pass', reason: 'the loop is playing' },
      }),
    );

    expect(directiveText()).not.toContain('visual check');
  });
});
