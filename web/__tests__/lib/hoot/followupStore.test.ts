/** @jest-environment node */

/**
 * Unit tests for `web/lib/hoot/followupStore.server.ts`.
 *
 * Pins the three contracts Task 4.2 (tools) and 4.3 (UI) build on: what
 * `scheduleFollowup` writes, that `cancelFollowup` is owner-gated AND loses
 * cleanly to a sweep that already claimed the doc, and the query
 * `listChatFollowups` issues (the shape the composite index is cut for).
 */

import type { Firestore } from 'firebase-admin/firestore';

jest.mock('firebase-admin/firestore', () => ({
  __esModule: true,
  FieldValue: { serverTimestamp: () => '__SERVER_TS__' },
  // `@/lib/firestoreTime.server` does `value instanceof Timestamp`, so the
  // binding must exist even though the fixtures use Dates.
  Timestamp: class Timestamp {},
}));

import {
  FOLLOWUPS_COLLECTION,
  cancelFollowup,
  listChatFollowups,
  scheduleFollowup,
} from '@/lib/hoot/followupStore.server';

/** Follow-up docs by id; transactions read and write through this map. */
const followups = new Map<string, Record<string, unknown>>();

const added = jest.fn();
const where = jest.fn();
const orderBy = jest.fn();
const limit = jest.fn();

let listResult: string[] = [];
let nextId = 1;

function docRef(id: string) {
  return {
    id,
    update: jest.fn(async (patch: Record<string, unknown>) => {
      followups.set(id, { ...(followups.get(id) ?? {}), ...patch });
    }),
  };
}

const query = {
  where: jest.fn((...args: unknown[]) => {
    where(...args);
    return query;
  }),
  orderBy: jest.fn((...args: unknown[]) => {
    orderBy(...args);
    return query;
  }),
  limit: jest.fn((...args: unknown[]) => {
    limit(...args);
    return query;
  }),
  get: jest.fn(async () => ({
    docs: listResult.map((id) => ({ id, data: () => followups.get(id) })),
  })),
};

const transaction = {
  get: jest.fn(async (ref: { id: string }) => ({
    exists: followups.has(ref.id),
    data: () => followups.get(ref.id),
  })),
  update: jest.fn((ref: { id: string }, patch: Record<string, unknown>) => {
    followups.set(ref.id, { ...(followups.get(ref.id) ?? {}), ...patch });
  }),
};

const db = {
  collection: jest.fn((name: string) => {
    if (name !== FOLLOWUPS_COLLECTION) throw new Error(`unexpected collection: ${name}`);
    return {
      ...query,
      doc: jest.fn((id: string) => docRef(id)),
      add: jest.fn(async (data: Record<string, unknown>) => {
        const id = `fu-${nextId++}`;
        added(data);
        followups.set(id, { ...data });
        return docRef(id);
      }),
    };
  }),
  runTransaction: jest.fn(
    async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction),
  ),
} as unknown as Firestore;

function scheduled(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chatId: 'chat-1',
    siteId: 'node-pa',
    machineId: 'lobby-01',
    userId: 'user-1',
    note: 'check whether the render finished',
    runAt: new Date(Date.now() + 10 * 60_000),
    status: 'scheduled',
    createdAt: '__SERVER_TS__',
    ...overrides,
  };
}

beforeEach(() => {
  followups.clear();
  listResult = [];
  nextId = 1;
  jest.clearAllMocks();
});

describe('scheduleFollowup', () => {
  it('writes a scheduled doc and returns its id and instant', async () => {
    const runAt = new Date(Date.now() + 5 * 60_000);

    const result = await scheduleFollowup(db, {
      chatId: 'chat-1',
      siteId: 'node-pa',
      machineId: 'lobby-01',
      userId: 'user-1',
      note: 'check whether the render finished',
      runAt,
    });

    expect(result).toEqual({ id: 'fu-1', runAt });
    expect(added).toHaveBeenCalledWith({
      chatId: 'chat-1',
      siteId: 'node-pa',
      machineId: 'lobby-01',
      userId: 'user-1',
      note: 'check whether the render finished',
      runAt,
      status: 'scheduled',
      createdAt: '__SERVER_TS__',
    });
  });

  it('stores watchCommandId only when one was given', async () => {
    await scheduleFollowup(db, {
      chatId: 'chat-1',
      siteId: 'node-pa',
      machineId: 'lobby-01',
      userId: 'user-1',
      note: 'report when the install lands',
      runAt: new Date(),
      watchCommandId: 'cmd-42',
    });

    // Firestore rejects nested undefined, so the field is absent when unset —
    // the exact-shape assertion above covers that case.
    expect(added).toHaveBeenCalledWith(expect.objectContaining({ watchCommandId: 'cmd-42' }));
  });
});

describe('cancelFollowup', () => {
  it('cancels a scheduled follow-up for its owner', async () => {
    followups.set('fu-1', scheduled());

    const outcome = await cancelFollowup(db, 'fu-1', { userId: 'user-1' });

    expect(outcome).toBe('cancelled');
    expect(followups.get('fu-1')?.status).toBe('cancelled');
  });

  it('refuses another user, leaving the follow-up scheduled', async () => {
    followups.set('fu-1', scheduled());

    const outcome = await cancelFollowup(db, 'fu-1', { userId: 'someone-else' });

    expect(outcome).toBe('forbidden');
    expect(followups.get('fu-1')?.status).toBe('scheduled');
  });

  it('reports a missing follow-up', async () => {
    expect(await cancelFollowup(db, 'fu-gone', { userId: 'user-1' })).toBe('not_found');
  });

  it('loses to a sweep that already claimed the follow-up', async () => {
    // The sweep's flip out of `scheduled` is the claim; cancelling after it
    // would leave a dispatched turn with a cancelled record behind it.
    followups.set('fu-1', scheduled({ status: 'fired' }));

    const outcome = await cancelFollowup(db, 'fu-1', { userId: 'user-1' });

    expect(outcome).toBe('not_scheduled');
    expect(followups.get('fu-1')?.status).toBe('fired');
  });
});

describe('listChatFollowups', () => {
  it('queries one chat\'s scheduled follow-ups, soonest first', async () => {
    followups.set('fu-1', scheduled({ runAt: new Date(1_700_000_000_000) }));
    listResult = ['fu-1'];

    const result = await listChatFollowups(db, 'chat-1');

    expect(where).toHaveBeenCalledWith('chatId', '==', 'chat-1');
    expect(where).toHaveBeenCalledWith('status', '==', 'scheduled');
    expect(orderBy).toHaveBeenCalledWith('runAt', 'asc');
    expect(limit).toHaveBeenCalledWith(50);
    expect(result).toEqual([
      {
        id: 'fu-1',
        chatId: 'chat-1',
        siteId: 'node-pa',
        machineId: 'lobby-01',
        userId: 'user-1',
        note: 'check whether the render finished',
        runAtMs: 1_700_000_000_000,
        status: 'scheduled',
      },
    ]);
  });

  it('honours an explicit status and limit', async () => {
    await listChatFollowups(db, 'chat-1', { status: 'failed', limit: 5 });

    expect(where).toHaveBeenCalledWith('status', '==', 'failed');
    expect(limit).toHaveBeenCalledWith(5);
  });

  it('surfaces watchCommandId and turnError when present', async () => {
    followups.set(
      'fu-1',
      scheduled({ status: 'failed', watchCommandId: 'cmd-42', turnError: 'chat_deleted' }),
    );
    listResult = ['fu-1'];

    const [summary] = await listChatFollowups(db, 'chat-1', { status: 'failed' });

    expect(summary).toMatchObject({ watchCommandId: 'cmd-42', turnError: 'chat_deleted' });
  });
});
