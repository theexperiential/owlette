/** @jest-environment node */

/**
 * Unit tests for the hoot output — the headless assistant turn a talon fires.
 * Only the three outside collaborators are mocked (author pre-flight, turn
 * store, detached runner); everything this module decides runs for real.
 *
 * `author.server` keeps `requireActual` so the REAL `TalonAuthorError` is in
 * play — this module classifies on `instanceof`, and a stand-in would keep
 * passing after the real class moved. `Date.now` is pinned so the chatId is
 * assertable verbatim.
 */

const mockResolveTalonAuthor = jest.fn();
const mockAssertTalonAuthorLlmKey = jest.fn();
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
jest.mock('@/lib/talons/author.server', () => ({
  ...jest.requireActual('@/lib/talons/author.server'),
  __esModule: true,
  resolveTalonAuthor: (...args: unknown[]) => mockResolveTalonAuthor(...args),
  assertTalonAuthorLlmKey: (...args: unknown[]) => mockAssertTalonAuthorLlmKey(...args),
}));
jest.mock('@/lib/hoot/turnRunner.server', () => ({
  __esModule: true,
  startTurn: (...args: unknown[]) => mockStartTurn(...args),
}));
jest.mock('@/lib/hoot/turnStore.server', () => ({
  __esModule: true,
  acquireTurnLock: (...args: unknown[]) => mockAcquireTurnLock(...args),
  generateTurnId: () => 'turn_fixed',
}));
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import type { Firestore } from 'firebase-admin/firestore';
import type { StartTurnParams } from '@/lib/hoot/turnRunner.server';
import { TalonAuthorError } from '@/lib/talons/author.server';
import {
  READ_ONLY_TIER,
  runHootOutput,
  UNATTENDED_MAX_TIER,
  unattendedToolTier,
  type RunHootOutputArgs,
} from '@/lib/talons/hootOutput.server';
import type { StoredTalon } from '@/lib/talons/store.server';
import type { TalonDoc } from '@/lib/talons/types';

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

function args(overrides: Partial<RunHootOutputArgs> = {}): RunHootOutputArgs {
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

  mockResolveTalonAuthor.mockResolvedValue({
    userId: 'admin-uid',
    access: {
      role: 'admin',
      isSuperadmin: false,
      isSiteAdmin: true,
      isSiteOwner: true,
    },
  });
  mockAssertTalonAuthorLlmKey.mockResolvedValue(undefined);
  mockAcquireTurnLock.mockResolvedValue(null);
  mockCancel.mockResolvedValue(undefined);
  mockStartTurn.mockReturnValue({ cancel: mockCancel });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('fire-time access re-resolution', () => {
  it('re-resolves the creator against the site on every run', async () => {
    await runHootOutput(db, args());

    expect(mockResolveTalonAuthor).toHaveBeenCalledWith(db, SITE, args().talon);
  });

  // Every unrecoverable author problem. Each must fail the run AND carry
  // `disabledReason` — without it a disable is unexplainable after the fact.
  it.each([
    ['creator_not_a_user', 'Talon t1 has no user author'],
    ['creator_deleted', 'Talon t1 author admin-uid can no longer run it: User is deleted'],
    ['creator_access_revoked', 'Talon t1 author admin-uid can no longer run it: no access'],
  ] as const)('disables the talon immediately on %s', async (reason, message) => {
    mockResolveTalonAuthor.mockRejectedValue(new TalonAuthorError(reason, message));

    const result = await runHootOutput(db, args());

    expect(result).toEqual({
      status: 'failed',
      detail: reason,
      error: message,
      disabledReason: reason,
    });
    expect(mockStartTurn).not.toHaveBeenCalled();
    expect(mockAcquireTurnLock).not.toHaveBeenCalled();
    // No chat either: a conversation nobody is allowed to have must not exist.
    expect(fake.docs.size).toBe(0);
  });

  it('disables the talon immediately when the creator has no llm key', async () => {
    mockAssertTalonAuthorLlmKey.mockRejectedValue(
      new TalonAuthorError('creator_missing_llm_key', 'Talon author admin-uid has no usable llm key'),
    );

    const result = await runHootOutput(db, args());

    expect(result).toMatchObject({
      status: 'failed',
      detail: 'creator_missing_llm_key',
      disabledReason: 'creator_missing_llm_key',
    });
    // Pre-flighted before the chat and the lock, so a keyless creator leaves no
    // empty conversation or claimed lock behind on every firing.
    expect(mockAssertTalonAuthorLlmKey).toHaveBeenCalledWith(db, 'admin-uid');
    expect(fake.docs.size).toBe(0);
    expect(mockAcquireTurnLock).not.toHaveBeenCalled();
  });

  it('leaves a transient author-check failure on the failure counter', async () => {
    // A Firestore outage is NOT a TalonAuthorError, and must never disable a
    // talon — the database being unreachable says nothing about the author.
    mockResolveTalonAuthor.mockRejectedValue(new Error('DEADLINE_EXCEEDED'));

    const result = await runHootOutput(db, args());

    expect(result).toEqual({
      status: 'failed',
      detail: 'author_check_failed',
      error: 'DEADLINE_EXCEEDED',
    });
    expect(result).not.toHaveProperty('disabledReason');
    expect(mockStartTurn).not.toHaveBeenCalled();
  });
});

describe('the chat', () => {
  it('creates a fresh chat keyed by timestamp and run id', async () => {
    const result = await runHootOutput(db, args());

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
    await runHootOutput(db, args());

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
    await runHootOutput(db, args({ machineId: undefined, machineName: undefined }));

    expect(chatDoc()).toMatchObject({
      targetType: 'site',
      targetMachineId: null,
      machineName: 'All Machines',
    });
    expect(startTurnParams()).toMatchObject({ machineId: '__site__', machineName: '' });
  });

  it('fails without a lock or a turn when the chat cannot be written', async () => {
    fake.setError = new Error('permission denied');

    const result = await runHootOutput(db, args());

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

    const result = await runHootOutput(db, args());

    expect(result).toEqual({
      status: 'failed',
      detail: 'turn_lock_failed',
      error: 'a turn is already running',
    });
    expect(mockStartTurn).not.toHaveBeenCalled();
  });
});

describe('the turn', () => {
  it('starts headless with the run identifiers, the talon source, and the recovery index', async () => {
    mockAcquireTurnLock.mockResolvedValue({ call_1: { m1: { commandId: 'cmd_1' } } });

    await runHootOutput(db, args());

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
    // The runner returns the HTTP branch of a tee; unread, it buffers the whole
    // turn in memory. The snapshot pump owns the other branch.
    await runHootOutput(db, args());

    expect(mockCancel).toHaveBeenCalledTimes(1);
  });

  it('still reports sent when cancelling the branch rejects', async () => {
    mockCancel.mockRejectedValue(new Error('already errored'));

    await expect(runHootOutput(db, args())).resolves.toEqual({
      status: 'sent',
      chatId: EXPECTED_CHAT_ID,
    });
  });

  it('records a failure rather than throwing when the runner cannot be started', async () => {
    mockStartTurn.mockImplementation(() => {
      throw new Error('stream setup failed');
    });

    const result = await runHootOutput(db, args());

    expect(result).toEqual({
      status: 'failed',
      detail: 'turn_start_failed',
      error: 'stream setup failed',
    });
  });

});

describe('privilege ceiling', () => {
  it('caps a turn at read-only tools by default', async () => {
    mockResolveTalonAuthor.mockResolvedValue({
      userId: 'admin-uid',
      access: {
        role: 'superadmin',
        isSuperadmin: true,
        isSiteAdmin: true,
        isSiteOwner: true,
      },
    });

    await runHootOutput(db, args());

    // The ceiling is explicit, not laundered through a degraded access object —
    // `startTurn` intersects it with what the access earns.
    expect(startTurnParams().maxToolTier).toBe(READ_ONLY_TIER);
    expect(startTurnParams().access).toEqual({
      role: 'superadmin',
      isSuperadmin: true,
      isSiteAdmin: true,
      isSiteOwner: true,
    });
  });

  it('raises the ceiling to tier 2 when the output opted into acting', async () => {
    await runHootOutput(db, args({ allowActions: true }));

    expect(startTurnParams().maxToolTier).toBe(UNATTENDED_MAX_TIER);
  });

  it('never reaches tier 3, whatever the opt-in says', () => {
    // Tier-3 tools (powershell, file writes, deploys, reboots) can require an
    // in-chat approval, and nobody is in this conversation to grant one.
    expect(unattendedToolTier(true)).toBeLessThan(3);
    expect(unattendedToolTier(false)).toBeLessThan(3);
    expect(UNATTENDED_MAX_TIER).toBe(2);
  });
});

describe('the directive message', () => {
  it('opens with the directive and names the talon, trigger, and machine', async () => {
    await runHootOutput(db, args());

    const [message] = startTurnParams().messages;
    expect(message).toMatchObject({ id: `talon_msg_${RUN_ID}`, role: 'user' });

    const text = directiveText();
    expect(text.startsWith('find out why the wall is black')).toBe(true);
    expect(text).toContain('- talon: lobby wall check');
    expect(text).toContain('- trigger: cpu_percent > 90');
    expect(text).toContain('- machine: LOBBY-01 (m1)');
  });

  it('says the scope is the whole site when no machine is named', async () => {
    await runHootOutput(db, args({ machineId: undefined, machineName: undefined }));

    expect(directiveText()).toContain('- scope: every machine in this site');
  });

  it('carries the reason and screenshot from a failed visual check', async () => {
    await runHootOutput(
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
    await runHootOutput(
      db,
      args({
        condition: { type: 'visual_check', verdict: 'pass', reason: 'the loop is playing' },
      }),
    );

    expect(directiveText()).not.toContain('visual check');
  });
});
