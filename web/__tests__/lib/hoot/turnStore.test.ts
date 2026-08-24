/** @jest-environment node */

/**
 * `web/lib/hoot/turnStore.server.ts` — stream-doc lifecycle for
 * `chats/{chatId}/stream/current`.
 *
 * The firestore admin sdk is an in-memory store keyed by doc path.
 * `FieldValue.serverTimestamp()` sentinels materialize to a fake Timestamp at the
 * mocked `Date.now()` on write, mirroring commit-time resolution, so staleness and
 * throttling run on a controlled clock with no real sleeps.
 */

import { Timestamp } from 'firebase-admin/firestore';

jest.mock('firebase-admin/firestore', () => {
  class FakeTimestamp {
    private readonly _ms: number;
    constructor(ms: number) {
      this._ms = ms;
    }
    toMillis() {
      return this._ms;
    }
    static fromMillis(ms: number) {
      return new FakeTimestamp(ms);
    }
    static now() {
      return new FakeTimestamp(Date.now());
    }
  }
  // Like firebase-admin's FieldPath: literal segments, never split on '.'. This is
  // why recordToolCommand must use it — 'INF-PROJECTION-WALL' stays one segment.
  class FakeFieldPath {
    readonly segments: string[];
    constructor(...segments: string[]) {
      this.segments = segments;
    }
  }
  return {
    __esModule: true,
    FieldValue: {
      serverTimestamp: () => '__SERVER_TS__',
    },
    Timestamp: FakeTimestamp,
    FieldPath: FakeFieldPath,
  };
});

// Re-imported so the fake txn.update can detect it.
import { FieldPath as MockFieldPath } from 'firebase-admin/firestore';
type FieldPathLike = { segments: string[] };
function isFieldPath(value: unknown): value is FieldPathLike {
  return value instanceof (MockFieldPath as unknown as new (...s: string[]) => object);
}

type StoreShape = Record<string, Record<string, unknown>>;
const store: StoreShape = {};

/** When set, the next runTransaction rejects (simulated firestore outage). */
let failNextTransaction = false;

function materialize(value: unknown): unknown {
  return value === '__SERVER_TS__' ? Timestamp.now() : value;
}

/** Set a materialized value at a nested path, cloning as it descends so sibling
 *  keys survive — firestore's no-last-write-wins property. */
function setBySegments(
  target: Record<string, unknown>,
  segments: string[],
  value: unknown,
) {
  let node = target;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    const existing = node[seg];
    node[seg] =
      existing && typeof existing === 'object'
        ? { ...(existing as Record<string, unknown>) }
        : {};
    node = node[seg] as Record<string, unknown>;
  }
  node[segments[segments.length - 1]] = value;
}

/** Object-form update: `{ 'a.b': v }` dotted keys expand like firestore does. */
function applyUpdate(target: Record<string, unknown>, patch: Record<string, unknown>) {
  for (const [key, raw] of Object.entries(patch)) {
    setBySegments(target, key.split('.'), materialize(raw));
  }
}

/** Apply `txn.update(ref, ...args)` in either firestore form: one dotted-key
 *  object patch, or `(fieldPathOrString, value, ...)` pairs (what
 *  `recordToolCommand` uses, with a FieldPath). */
function applyUpdateArgs(target: Record<string, unknown>, args: unknown[]) {
  if (
    args.length === 1 &&
    typeof args[0] === 'object' &&
    args[0] !== null &&
    !isFieldPath(args[0])
  ) {
    applyUpdate(target, args[0] as Record<string, unknown>);
    return;
  }
  for (let i = 0; i + 1 < args.length; i += 2) {
    const path = args[i];
    const segments = isFieldPath(path) ? path.segments : String(path).split('.');
    setBySegments(target, segments, materialize(args[i + 1]));
  }
}

interface FakeRef {
  _path: string;
  collection: (name: string) => { doc: (id: string) => FakeRef };
}

// All module IO is transactional, so refs only need a path + subcollection chain.
function buildCollection(prefix: string) {
  return {
    doc: (id: string): FakeRef => {
      const fullPath = `${prefix}/${id}`;
      return {
        _path: fullPath,
        collection: (sub: string) => buildCollection(`${fullPath}/${sub}`),
      };
    },
  };
}

function freshSnap(path: string) {
  const data = store[path];
  return {
    exists: data !== undefined,
    data: () => (data ? { ...data } : undefined),
  };
}

const fakeDb = {
  collection: (name: string) => buildCollection(name),
  runTransaction: jest.fn(async (fn: (txn: unknown) => Promise<unknown>) => {
    if (failNextTransaction) {
      failNextTransaction = false;
      throw new Error('firestore unavailable');
    }
    const txn = {
      get: async (ref: FakeRef) => freshSnap(ref._path),
      set: (ref: FakeRef, data: Record<string, unknown>) => {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(data)) out[k] = materialize(v);
        store[ref._path] = out;
      },
      update: (ref: FakeRef, ...args: unknown[]) => {
        if (!store[ref._path]) throw new Error(`txn update on missing: ${ref._path}`);
        const next = { ...store[ref._path] };
        applyUpdateArgs(next, args);
        store[ref._path] = next;
      },
    };
    return fn(txn);
  }),
} as unknown as FirebaseFirestore.Firestore;

import type { UIMessage } from 'ai';
import {
  acquireTurnLock,
  writeSnapshot,
  touch,
  recordToolCommand,
  finishTurn,
  generateTurnId,
  TurnActiveError,
  TURN_STALE_MS,
  SNAPSHOT_THROTTLE_MS,
  _resetThrottleForTests,
} from '@/lib/hoot/turnStore.server';

const CHAT_ID = 'chat_1';
const SITE_ID = 'site-A';
const MACHINE_ID = 'machine-1';
const STREAM_PATH = `chats/${CHAT_ID}/stream/current`;

const T0 = 1_700_000_000_000;
let nowMs = T0;

function assistantMessage(text = 'hello'): UIMessage {
  return {
    id: 'msg_assistant_1',
    role: 'assistant',
    parts: [{ type: 'text', text }],
  } as UIMessage;
}

/** Seed a stream doc directly into the store (bypasses acquire). */
function seedStream(overrides: Record<string, unknown> = {}) {
  store[STREAM_PATH] = {
    status: 'running',
    turnId: 'turn_old',
    chatId: CHAT_ID,
    siteId: SITE_ID,
    machineId: MACHINE_ID,
    startedAt: Timestamp.fromMillis(nowMs - 5_000),
    updatedAt: Timestamp.fromMillis(nowMs - 1_000),
    message: null,
    toolCommands: {},
    ...overrides,
  };
}

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  failNextTransaction = false;
  nowMs = T0;
  jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
  _resetThrottleForTests();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('generateTurnId', () => {
  it('produces unique turn_<base64url> ids', () => {
    const a = generateTurnId();
    const b = generateTurnId();
    expect(a).toMatch(/^turn_[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(b);
  });
});

describe('acquireTurnLock', () => {
  it('claims when no stream doc exists', async () => {
    await acquireTurnLock(fakeDb, CHAT_ID, {
      turnId: 'turn_new',
      siteId: SITE_ID,
      machineId: MACHINE_ID,
    });

    const doc = store[STREAM_PATH];
    expect(doc).toMatchObject({
      status: 'running',
      turnId: 'turn_new',
      chatId: CHAT_ID,
      siteId: SITE_ID,
      machineId: MACHINE_ID,
      message: null,
      toolCommands: {},
    });
    expect((doc.startedAt as Timestamp).toMillis()).toBe(nowMs);
    expect((doc.updatedAt as Timestamp).toMillis()).toBe(nowMs);
  });

  it('rejects with TurnActiveError while a fresh turn is running', async () => {
    seedStream();

    const attempt = acquireTurnLock(fakeDb, CHAT_ID, {
      turnId: 'turn_new',
      siteId: SITE_ID,
      machineId: MACHINE_ID,
    });

    await expect(attempt).rejects.toThrow(TurnActiveError);
    await expect(attempt).rejects.toMatchObject({
      name: 'TurnActiveError',
      chatId: CHAT_ID,
      activeTurnId: 'turn_old',
    });
    // The running doc was not clobbered.
    expect(store[STREAM_PATH].turnId).toBe('turn_old');
    expect(store[STREAM_PATH].status).toBe('running');
  });

  it('supersede:true claims over a fresh running turn', async () => {
    seedStream({ toolCommands: { tc_1: { [MACHINE_ID]: { commandId: 'cmd_1' } } } });

    await acquireTurnLock(fakeDb, CHAT_ID, {
      turnId: 'turn_new',
      siteId: SITE_ID,
      machineId: MACHINE_ID,
      supersede: true,
    });

    // Fresh doc for the new turn — old turn state fully replaced.
    expect(store[STREAM_PATH]).toMatchObject({
      status: 'running',
      turnId: 'turn_new',
      message: null,
      toolCommands: {},
    });
  });

  it('takes over a stale running turn without supersede (dead runner)', async () => {
    seedStream({ updatedAt: Timestamp.fromMillis(nowMs - TURN_STALE_MS - 1) });

    await acquireTurnLock(fakeDb, CHAT_ID, {
      turnId: 'turn_new',
      siteId: SITE_ID,
      machineId: MACHINE_ID,
    });

    expect(store[STREAM_PATH].turnId).toBe('turn_new');
    expect(store[STREAM_PATH].status).toBe('running');
  });

  it('claims over a terminal doc even when its updatedAt is fresh', async () => {
    seedStream({ status: 'complete', updatedAt: Timestamp.fromMillis(nowMs) });

    await acquireTurnLock(fakeDb, CHAT_ID, {
      turnId: 'turn_new',
      siteId: SITE_ID,
      machineId: MACHINE_ID,
    });

    expect(store[STREAM_PATH].turnId).toBe('turn_new');
    expect(store[STREAM_PATH].status).toBe('running');
  });

  it('returns the prior doc toolCommands recovery index (and null when no prior doc)', async () => {
    // No prior doc → null.
    const first = await acquireTurnLock(fakeDb, CHAT_ID, {
      turnId: 'turn_a',
      siteId: SITE_ID,
      machineId: MACHINE_ID,
    });
    expect(first).toBeNull();

    // Supersede returns the prior index so the new turn recovers in-flight results.
    await recordToolCommand(fakeDb, CHAT_ID, 'turn_a', 'tc_1', 'cmd_1', MACHINE_ID);
    const prior = await acquireTurnLock(fakeDb, CHAT_ID, {
      turnId: 'turn_b',
      siteId: SITE_ID,
      machineId: MACHINE_ID,
      supersede: true,
    });
    expect(prior).toEqual({ tc_1: { [MACHINE_ID]: { commandId: 'cmd_1' } } });
    // The new doc starts with an empty index.
    expect(store[STREAM_PATH].toolCommands).toEqual({});
  });

  it('resets the snapshot throttle so a new turn writes immediately', async () => {
    await acquireTurnLock(fakeDb, CHAT_ID, {
      turnId: 'turn_a',
      siteId: SITE_ID,
      machineId: MACHINE_ID,
    });
    expect(await writeSnapshot(fakeDb, CHAT_ID, 'turn_a', assistantMessage())).toBe(true);

    // Same clock instant: a second turn claims (supersede) and its first
    // snapshot must not be throttled by turn_a's write.
    await acquireTurnLock(fakeDb, CHAT_ID, {
      turnId: 'turn_b',
      siteId: SITE_ID,
      machineId: MACHINE_ID,
      supersede: true,
    });
    expect(await writeSnapshot(fakeDb, CHAT_ID, 'turn_b', assistantMessage('fresh'))).toBe(true);
  });
});

describe('writeSnapshot', () => {
  it('persists the message and bumps updatedAt', async () => {
    seedStream();
    nowMs += 2_000;

    const written = await writeSnapshot(fakeDb, CHAT_ID, 'turn_old', assistantMessage('draft'));

    expect(written).toBe(true);
    const doc = store[STREAM_PATH];
    expect(doc.message).toEqual({
      id: 'msg_assistant_1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'draft' }],
    });
    expect((doc.updatedAt as Timestamp).toMillis()).toBe(nowMs);
  });

  it('JSON-clones the message, stripping nested undefined', async () => {
    seedStream();
    const message = {
      id: 'msg_assistant_1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'hi', providerMetadata: undefined }],
    } as unknown as UIMessage;

    expect(await writeSnapshot(fakeDb, CHAT_ID, 'turn_old', message)).toBe(true);

    const part = (store[STREAM_PATH].message as UIMessage).parts[0];
    expect('providerMetadata' in (part as Record<string, unknown>)).toBe(false);
    expect(part).toEqual({ type: 'text', text: 'hi' });
  });

  it('throttles writes closer than SNAPSHOT_THROTTLE_MS; skips do not reset the window', async () => {
    seedStream();

    expect(await writeSnapshot(fakeDb, CHAT_ID, 'turn_old', assistantMessage('one'))).toBe(true);

    nowMs += 100;
    expect(await writeSnapshot(fakeDb, CHAT_ID, 'turn_old', assistantMessage('two'))).toBe(false);
    expect((store[STREAM_PATH].message as UIMessage).parts).toEqual([
      { type: 'text', text: 'one' },
    ]);

    // 700ms after the last ACCEPTED write — still throttled.
    nowMs = T0 + 700;
    expect(await writeSnapshot(fakeDb, CHAT_ID, 'turn_old', assistantMessage('three'))).toBe(false);

    nowMs = T0 + SNAPSHOT_THROTTLE_MS;
    expect(await writeSnapshot(fakeDb, CHAT_ID, 'turn_old', assistantMessage('four'))).toBe(true);
    expect((store[STREAM_PATH].message as UIMessage).parts).toEqual([
      { type: 'text', text: 'four' },
    ]);
  });

  it('tracks the throttle per chat', async () => {
    seedStream();
    const otherChatId = 'chat_2';
    store[`chats/${otherChatId}/stream/current`] = {
      ...store[STREAM_PATH],
      chatId: otherChatId,
    };

    expect(await writeSnapshot(fakeDb, CHAT_ID, 'turn_old', assistantMessage())).toBe(true);
    // Same instant, different chat — not throttled.
    expect(await writeSnapshot(fakeDb, otherChatId, 'turn_old', assistantMessage())).toBe(true);
  });

  it('no-ops when the turn was superseded (turnId mismatch)', async () => {
    seedStream({ turnId: 'turn_new' });

    const written = await writeSnapshot(fakeDb, CHAT_ID, 'turn_old', assistantMessage('stale'));

    expect(written).toBe(false);
    expect(store[STREAM_PATH].message).toBeNull();
  });

  it('no-ops when the stream doc is missing', async () => {
    await expect(
      writeSnapshot(fakeDb, CHAT_ID, 'turn_old', assistantMessage()),
    ).resolves.toBe(false);
  });

  it('resolves false instead of throwing when firestore fails', async () => {
    seedStream();
    failNextTransaction = true;

    await expect(
      writeSnapshot(fakeDb, CHAT_ID, 'turn_old', assistantMessage()),
    ).resolves.toBe(false);
  });
});

describe('touch', () => {
  it('reports `owned` and bumps updatedAt without touching the message, unthrottled', async () => {
    seedStream({ message: { id: 'm', role: 'assistant', parts: [] } });

    nowMs += 10_000;
    expect(await touch(fakeDb, CHAT_ID, 'turn_old')).toBe('owned');
    expect((store[STREAM_PATH].updatedAt as Timestamp).toMillis()).toBe(nowMs);
    expect(store[STREAM_PATH].message).toEqual({ id: 'm', role: 'assistant', parts: [] });

    // Back-to-back heartbeats are not throttled (poll loops pace themselves).
    expect(await touch(fakeDb, CHAT_ID, 'turn_old')).toBe('owned');
  });

  it('reports `lost` on turnId mismatch (genuine supersede)', async () => {
    seedStream({ turnId: 'turn_new', updatedAt: Timestamp.fromMillis(nowMs - 1_000) });

    expect(await touch(fakeDb, CHAT_ID, 'turn_old')).toBe('lost');
    expect((store[STREAM_PATH].updatedAt as Timestamp).toMillis()).toBe(nowMs - 1_000);
  });

  it('reports `lost` on a terminal doc even when the turnId matches (stop/cancel)', async () => {
    // Terminal doc: a still-running runner must see `lost` and abort itself.
    seedStream({ status: 'cancelled', updatedAt: Timestamp.fromMillis(nowMs - 1_000) });

    expect(await touch(fakeDb, CHAT_ID, 'turn_old')).toBe('lost');
    expect((store[STREAM_PATH].updatedAt as Timestamp).toMillis()).toBe(nowMs - 1_000);
    expect(store[STREAM_PATH].status).toBe('cancelled');
  });

  it('reports `error` (NOT `lost`) when the transaction throws — a transient blip is not genuine loss', async () => {
    // `lost` aborts a superseded turn; `error` (a blip) must not abort a healthy
    // still-owned one.
    seedStream();
    failNextTransaction = true;

    expect(await touch(fakeDb, CHAT_ID, 'turn_old')).toBe('error');
    expect(store[STREAM_PATH]).toMatchObject({ status: 'running', turnId: 'turn_old' });
  });
});

describe('recordToolCommand', () => {
  it('accumulates toolCallId → machineId → {commandId} entries across tool calls', async () => {
    seedStream({ toolCommands: { tc_1: { [MACHINE_ID]: { commandId: 'cmd_1' } } } });

    const recorded = await recordToolCommand(
      fakeDb,
      CHAT_ID,
      'turn_old',
      'tc_2',
      'cmd_2',
      'machine-2',
    );

    expect(recorded).toBe(true);
    expect(store[STREAM_PATH].toolCommands).toEqual({
      tc_1: { [MACHINE_ID]: { commandId: 'cmd_1' } },
      tc_2: { 'machine-2': { commandId: 'cmd_2' } },
    });
    expect((store[STREAM_PATH].updatedAt as Timestamp).toMillis()).toBe(nowMs);
  });

  it('records EVERY machine under one toolCallId (site-wide fan-out — no last-write-wins)', async () => {
    // finding-7 regression: one toolCallId, two machines — the second write must
    // not clobber the first. FieldPath touches only its own leaf.
    seedStream();

    expect(
      await recordToolCommand(fakeDb, CHAT_ID, 'turn_old', 'tc_site', 'cmd_a', 'machine-1'),
    ).toBe(true);
    expect(
      await recordToolCommand(fakeDb, CHAT_ID, 'turn_old', 'tc_site', 'cmd_b', 'machine-2'),
    ).toBe(true);

    expect(store[STREAM_PATH].toolCommands).toEqual({
      tc_site: {
        'machine-1': { commandId: 'cmd_a' },
        'machine-2': { commandId: 'cmd_b' },
      },
    });
  });

  it('persists hyphenated machineIds intact (FieldPath, not a dotted string)', async () => {
    // Hyphens are invalid in firestore's dotted field-path language, so the
    // string form would throw; FieldPath segments pass through literally.
    seedStream();

    expect(
      await recordToolCommand(
        fakeDb,
        CHAT_ID,
        'turn_old',
        'tc_1',
        'cmd_1',
        'INF-PROJECTION-WALL',
      ),
    ).toBe(true);
    expect(store[STREAM_PATH].toolCommands).toEqual({
      tc_1: { 'INF-PROJECTION-WALL': { commandId: 'cmd_1' } },
    });
  });

  it('no-ops on turnId mismatch', async () => {
    seedStream({ turnId: 'turn_new' });

    const recorded = await recordToolCommand(
      fakeDb,
      CHAT_ID,
      'turn_old',
      'tc_1',
      'cmd_1',
      MACHINE_ID,
    );

    expect(recorded).toBe(false);
    expect(store[STREAM_PATH].toolCommands).toEqual({});
  });
});

describe('finishTurn', () => {
  it('marks the turn complete without an error field', async () => {
    seedStream();
    nowMs += 3_000;

    expect(await finishTurn(fakeDb, CHAT_ID, 'turn_old', 'complete')).toBe(true);
    expect(store[STREAM_PATH].status).toBe('complete');
    expect('error' in store[STREAM_PATH]).toBe(false);
    expect((store[STREAM_PATH].updatedAt as Timestamp).toMillis()).toBe(nowMs);
  });

  it('stamps the error message on status error', async () => {
    seedStream();

    expect(
      await finishTurn(fakeDb, CHAT_ID, 'turn_old', 'error', 'model call failed'),
    ).toBe(true);
    expect(store[STREAM_PATH].status).toBe('error');
    expect(store[STREAM_PATH].error).toBe('model call failed');
  });

  it('supports the cancelled transition', async () => {
    seedStream();

    expect(await finishTurn(fakeDb, CHAT_ID, 'turn_old', 'cancelled')).toBe(true);
    expect(store[STREAM_PATH].status).toBe('cancelled');
  });

  it('no-ops when the turn was superseded mid-flight', async () => {
    seedStream();
    await acquireTurnLock(fakeDb, CHAT_ID, {
      turnId: 'turn_new',
      siteId: SITE_ID,
      machineId: MACHINE_ID,
      supersede: true,
    });

    // The superseded runner finishing must not clobber the new running turn.
    expect(await finishTurn(fakeDb, CHAT_ID, 'turn_old', 'complete')).toBe(false);
    expect(store[STREAM_PATH]).toMatchObject({ status: 'running', turnId: 'turn_new' });
  });

  it('no-ops on a second terminal write (terminal → terminal)', async () => {
    seedStream();

    // First finish wins (running → complete).
    expect(await finishTurn(fakeDb, CHAT_ID, 'turn_old', 'complete')).toBe(true);
    // A later stop for the same turn can't flip an already-terminal doc.
    expect(await finishTurn(fakeDb, CHAT_ID, 'turn_old', 'cancelled')).toBe(false);
    expect(store[STREAM_PATH].status).toBe('complete');
  });

  it('resolves false instead of throwing when firestore fails', async () => {
    seedStream();
    failNextTransaction = true;

    await expect(finishTurn(fakeDb, CHAT_ID, 'turn_old', 'complete')).resolves.toBe(false);
    expect(store[STREAM_PATH].status).toBe('running');
  });
});
