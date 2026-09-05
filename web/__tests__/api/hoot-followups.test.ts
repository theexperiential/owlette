/** @jest-environment node */

/**
 * Http-shape coverage for DELETE /api/hoot/followups/{followupId} (hoot-async-turns 4.3).
 *
 * Authz matrix: unauthenticated → 401; missing follow-up → 404 before any write;
 * api-key without chat=<siteId>:write → 403 scope_insufficient; no site access → 403.
 *
 * Outcome mapping straight off `cancelFollowup` (the real store runs here — only the
 * Firestore handle is faked): cancelled → 200, not_found → 404 (the doc vanished
 * between the scope pre-read and the transaction), forbidden → 403, not_scheduled → 409.
 */

import { NextRequest } from 'next/server';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock('firebase-admin/firestore', () => ({
  __esModule: true,
  FieldValue: { serverTimestamp: () => '__SERVER_TS__' },
  // `@/lib/firestoreTime.server` does `value instanceof Timestamp`.
  Timestamp: class Timestamp {},
}));

jest.mock('@/lib/withRateLimit', () => {
  // `capturedOptions` is a plain property (not mock state), so the import-time
  // wrapper call survives jest.clearAllMocks() in beforeEach.
  const withRateLimit = Object.assign(
    jest.fn((handler: unknown) => handler),
    { capturedOptions: undefined as unknown },
  );
  withRateLimit.mockImplementation((handler: unknown, options?: unknown) => {
    withRateLimit.capturedOptions = options;
    return handler;
  });
  return {
    __esModule: true,
    withRateLimit,
    getUserIdFromSession: jest.fn(async () => null),
  };
});

const mockResolveAuth = jest.fn();
jest.mock('@/lib/apiAuth.server', () => {
  const actual = jest.requireActual('@/lib/apiAuth.server');
  return {
    ...actual,
    resolveAuth: (...a: unknown[]) => mockResolveAuth(...a),
  };
});

// Full replacement — only the verifyUserSiteAccess contract is used.
const mockVerifyAccess = jest.fn();
jest.mock('@/lib/hoot-utils.server', () => ({
  verifyUserSiteAccess: (...a: unknown[]) => mockVerifyAccess(...a),
}));

jest.mock('@/lib/auditLogClient', () => ({
  emitMutation: jest.fn(),
}));

// fake firestore — the follow-up collection only

const SITE = 'site-a';
const CHAT = 'chat-1';
const FOLLOWUP = 'fu-1';

/** Follow-up docs by id; the pre-read and the transaction both go through this map. */
let followups: Map<string, Record<string, unknown>>;
/** Deletes the doc the instant a transaction opens — the pre-read/claim race. */
let vanishOnTransaction = false;

function scheduledDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chatId: CHAT,
    siteId: SITE,
    machineId: 'lobby-01',
    userId: 'user-1',
    note: 'check whether the render finished',
    runAt: new Date(Date.now() + 10 * 60_000),
    status: 'scheduled',
    createdAt: '__SERVER_TS__',
    ...overrides,
  };
}

function buildFakeDb() {
  const transaction = {
    get: async (ref: { id: string }) => ({
      exists: followups.has(ref.id),
      data: () => followups.get(ref.id),
    }),
    update: (ref: { id: string }, patch: Record<string, unknown>) => {
      followups.set(ref.id, { ...(followups.get(ref.id) ?? {}), ...patch });
    },
  };

  return {
    collection: (name: string) => {
      if (name !== 'cortex-followups') throw new Error(`unexpected collection: ${name}`);
      return {
        doc: (id: string) => ({
          id,
          get: async () => ({
            exists: followups.has(id),
            data: () => followups.get(id),
          }),
        }),
      };
    },
    runTransaction: async (callback: (tx: typeof transaction) => Promise<unknown>) => {
      if (vanishOnTransaction) followups.delete(FOLLOWUP);
      return callback(transaction);
    },
  };
}

let fakeDb: ReturnType<typeof buildFakeDb>;

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => fakeDb,
  getAdminAuth: () => ({
    verifyIdToken: jest.fn().mockRejectedValue(new Error('n/a')),
  }),
}));

import { DELETE } from '@/app/api/hoot/followups/[followupId]/route';
import { ApiAuthError, type ResolvedAuth } from '@/lib/apiAuth.server';
import { withRateLimit } from '@/lib/withRateLimit';
import { emitMutation } from '@/lib/auditLogClient';

// fixtures

function authedSession(): ResolvedAuth {
  return { userId: 'user-1', keyContext: null };
}

function authedKey(scopes: Array<Record<string, unknown>> | null): ResolvedAuth {
  return {
    userId: 'user-1',
    keyContext: {
      keyId: 'key-test',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      scopes: scopes as any,
      environment: 'live',
      expiresAt: Date.now() + 60_000,
      isLegacy: false,
    },
  };
}

function deleteRequest(): NextRequest {
  return new NextRequest(`http://localhost/api/hoot/followups/${FOLLOWUP}`, {
    method: 'DELETE',
  });
}

function context(followupId: string = FOLLOWUP) {
  return { params: Promise.resolve({ followupId }) };
}

beforeEach(() => {
  jest.clearAllMocks();
  followups = new Map([[FOLLOWUP, scheduledDoc()]]);
  vanishOnTransaction = false;
  fakeDb = buildFakeDb();
  mockResolveAuth.mockResolvedValue(authedSession());
  mockVerifyAccess.mockResolvedValue({
    role: 'member',
    isSuperadmin: false,
    isSiteAdmin: false,
    isSiteOwner: false,
  });
});

// authz matrix

describe('DELETE /api/hoot/followups/{followupId} — authz', () => {
  it('401 when unauthenticated', async () => {
    mockResolveAuth.mockRejectedValue(new ApiAuthError(401, 'Unauthorized: No valid session'));
    const res = await DELETE(deleteRequest(), context());
    expect(res.status).toBe(401);
    expect(followups.get(FOLLOWUP)?.status).toBe('scheduled');
  });

  it('400 when the path param is empty', async () => {
    const res = await DELETE(deleteRequest(), context(''));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('followupId is required');
  });

  it('404 when the follow-up does not exist', async () => {
    followups.clear();
    const res = await DELETE(deleteRequest(), context());
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('follow-up not found');
    expect(mockVerifyAccess).not.toHaveBeenCalled();
  });

  it('403 scope_insufficient for an api-key caller without chat write scope', async () => {
    mockResolveAuth.mockResolvedValue(
      authedKey([{ resource: 'machine', id: '*', permissions: ['write'] }]),
    );
    const res = await DELETE(deleteRequest(), context());
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('scope_insufficient');
    expect(followups.get(FOLLOWUP)?.status).toBe('scheduled');
  });

  it('200 for an api-key caller holding chat write on the site', async () => {
    mockResolveAuth.mockResolvedValue(
      authedKey([{ resource: 'chat', id: SITE, permissions: ['write'] }]),
    );
    const res = await DELETE(deleteRequest(), context());
    expect(res.status).toBe(200);
    expect(followups.get(FOLLOWUP)?.status).toBe('cancelled');
  });

  it('403 when the caller has no access to the follow-up\'s site', async () => {
    mockVerifyAccess.mockRejectedValue(new Error('You do not have access to this site'));
    const res = await DELETE(deleteRequest(), context());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('you do not have access to this site');
    expect(followups.get(FOLLOWUP)?.status).toBe('scheduled');
  });
});

// outcome mapping

describe('DELETE /api/hoot/followups/{followupId} — outcomes', () => {
  it('200 cancelled: flips the doc out of scheduled', async () => {
    const res = await DELETE(deleteRequest(), context());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cancelled: true });
    expect(followups.get(FOLLOWUP)?.status).toBe('cancelled');
    expect(mockVerifyAccess).toHaveBeenCalledWith(fakeDb, 'user-1', SITE);
  });

  it('404 when the doc vanishes between the scope pre-read and the transaction', async () => {
    vanishOnTransaction = true;
    const res = await DELETE(deleteRequest(), context());
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('follow-up not found');
  });

  it('403 when the follow-up belongs to another user (site access alone is not enough)', async () => {
    followups.set(FOLLOWUP, scheduledDoc({ userId: 'someone-else' }));
    const res = await DELETE(deleteRequest(), context());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('you do not own this follow-up');
    expect(followups.get(FOLLOWUP)?.status).toBe('scheduled');
  });

  it('409 when the sweep already claimed it', async () => {
    followups.set(FOLLOWUP, scheduledDoc({ status: 'fired' }));
    const res = await DELETE(deleteRequest(), context());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('follow-up is no longer scheduled');
    expect(followups.get(FOLLOWUP)?.status).toBe('fired');
  });

  it('409 on a second cancel of the same follow-up (idempotent from the ui\'s view)', async () => {
    expect((await DELETE(deleteRequest(), context())).status).toBe(200);
    expect((await DELETE(deleteRequest(), context())).status).toBe(409);
  });
});

// audit

describe('DELETE /api/hoot/followups/{followupId} — audit', () => {
  it('emits one chat_mutated row on the cancel, without the note text', async () => {
    await DELETE(deleteRequest(), context());

    expect(emitMutation).toHaveBeenCalledTimes(1);
    expect(emitMutation).toHaveBeenCalledWith({
      kind: 'chat_mutated',
      siteId: SITE,
      actor: 'user:user-1',
      targetId: FOLLOWUP,
      attributes: {
        verb: 'cancel_followup',
        endpoint: `/api/hoot/followups/${FOLLOWUP}`,
        method: 'DELETE',
        siteId: SITE,
        chatId: CHAT,
      },
    });
    const [{ attributes }] = (emitMutation as jest.Mock).mock.calls[0];
    expect(JSON.stringify(attributes)).not.toContain('render finished');
  });

  it('attributes an api-key caller to its key', async () => {
    mockResolveAuth.mockResolvedValue(
      authedKey([{ resource: 'chat', id: '*', permissions: ['write'] }]),
    );
    await DELETE(deleteRequest(), context());
    expect(emitMutation).toHaveBeenCalledWith(
      expect.objectContaining({ actor: 'apiKey:key-test' }),
    );
  });

  it('emits nothing when the cancel changed no state', async () => {
    followups.set(FOLLOWUP, scheduledDoc({ status: 'fired' }));
    expect((await DELETE(deleteRequest(), context())).status).toBe(409);

    followups.set(FOLLOWUP, scheduledDoc({ userId: 'someone-else' }));
    expect((await DELETE(deleteRequest(), context())).status).toBe(403);

    followups.clear();
    expect((await DELETE(deleteRequest(), context())).status).toBe(404);

    expect(emitMutation).not.toHaveBeenCalled();
  });
});

// rate-limit wrapper

describe('DELETE /api/hoot/followups/{followupId} — rate limiting', () => {
  it('exports DELETE wrapped in withRateLimit with the user strategy', () => {
    // Wrapper options were captured at module import (before clearAllMocks).
    const { capturedOptions } = withRateLimit as unknown as {
      capturedOptions: Record<string, unknown> | undefined;
    };
    expect(capturedOptions).toMatchObject({
      strategy: 'user',
      identifier: 'user',
      getUserId: expect.any(Function),
    });
  });
});
