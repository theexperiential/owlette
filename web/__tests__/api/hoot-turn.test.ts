/** @jest-environment node */

/**
 * Audit coverage for the two turn-lifecycle routes (talons wave 5.4).
 *
 * POST /api/hoot      — starts a turn; audits `chat_mutated` / `send` once the
 *                       per-chat lock write has committed, never before.
 * POST /api/hoot/stop — cancels one; audits `chat_mutated` / `cancel_turn` only
 *                       when `finishTurn` actually wrote the terminal state. The
 *                       route is idempotent and always 200s, so a no-op stop
 *                       must not manufacture a row.
 *
 * Neither emit may carry message content, and neither may change the response.
 */

import { NextRequest } from 'next/server';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock('@/lib/withRateLimit', () => ({
  __esModule: true,
  withRateLimit: (handler: unknown) => handler,
  getUserIdFromSession: jest.fn(async () => null),
}));

const mockResolveAuth = jest.fn();
jest.mock('@/lib/apiAuth.server', () => {
  const actual = jest.requireActual('@/lib/apiAuth.server');
  return {
    ...actual,
    resolveAuth: (...a: unknown[]) => mockResolveAuth(...a),
  };
});

const mockVerifyAccess = jest.fn();
const mockIsMachineOnline = jest.fn();
const mockIsHootEnabled = jest.fn();
const mockGetOnlineMachines = jest.fn();
jest.mock('@/lib/hoot-utils.server', () => ({
  verifyUserSiteAccess: (...a: unknown[]) => mockVerifyAccess(...a),
  isMachineOnline: (...a: unknown[]) => mockIsMachineOnline(...a),
  isHootEnabled: (...a: unknown[]) => mockIsHootEnabled(...a),
  getOnlineMachines: (...a: unknown[]) => mockGetOnlineMachines(...a),
}));

const mockAcquireTurnLock = jest.fn();
const mockFinishTurn = jest.fn();
jest.mock('@/lib/hoot/turnStore.server', () => {
  // Inline: jest hoists the factory, so `instanceof` needs the class defined here.
  class TurnActiveError extends Error {}
  return {
    __esModule: true,
    TurnActiveError,
    generateTurnId: () => 'turn-fixed',
    acquireTurnLock: (...a: unknown[]) => mockAcquireTurnLock(...a),
    finishTurn: (...a: unknown[]) => mockFinishTurn(...a),
  };
});

const mockStartTurn = jest.fn();
jest.mock('@/lib/hoot/turnRunner.server', () => ({
  startTurn: (...a: unknown[]) => mockStartTurn(...a),
}));

jest.mock('ai', () => ({
  __esModule: true,
  createUIMessageStreamResponse: jest.fn(() => new Response('stream', { status: 200 })),
}));

jest.mock('@/lib/auditLogClient', () => ({
  emitMutation: jest.fn(),
}));

const SITE = 'site-a';
const CHAT = 'chat-1';
const MACHINE = 'lobby-01';

/** `chats/{chatId}`; `null` means the doc does not exist yet (first turn). */
let chatDoc: Record<string, unknown> | null;

const fakeDb = {
  collection: (name: string) => {
    if (name !== 'chats') throw new Error(`unexpected collection: ${name}`);
    return {
      doc: (id: string) => ({
        id,
        get: async () => ({ exists: chatDoc !== null, data: () => chatDoc ?? undefined }),
      }),
    };
  },
};

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => fakeDb,
  getAdminAuth: () => ({
    verifyIdToken: jest.fn().mockRejectedValue(new Error('n/a')),
  }),
}));

import { POST as TURN } from '@/app/api/hoot/route';
import { POST as STOP } from '@/app/api/hoot/stop/route';
import { emitMutation } from '@/lib/auditLogClient';
import type { ResolvedAuth } from '@/lib/apiAuth.server';

function authedSession(): ResolvedAuth {
  return { userId: 'user-1', keyContext: null };
}

function authedKey(): ResolvedAuth {
  return {
    userId: 'user-1',
    keyContext: {
      keyId: 'key-test',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      scopes: [{ resource: 'chat', id: '*', permissions: ['write'] }] as any,
      environment: 'live',
      expiresAt: Date.now() + 60_000,
      isLegacy: false,
    },
  };
}

function turnRequest(body: Record<string, unknown> = {}): NextRequest {
  return new NextRequest('http://localhost/api/hoot', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'secret plans' }] }],
      siteId: SITE,
      machineId: MACHINE,
      machineName: 'Lobby',
      chatId: CHAT,
      ...body,
    }),
  });
}

function stopRequest(body: Record<string, unknown> = {}): NextRequest {
  return new NextRequest('http://localhost/api/hoot/stop', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chatId: CHAT, turnId: 'turn-fixed', ...body }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  chatDoc = { userId: 'user-1', siteId: SITE };
  mockResolveAuth.mockResolvedValue(authedSession());
  mockVerifyAccess.mockResolvedValue({
    role: 'admin',
    isSuperadmin: false,
    isSiteAdmin: true,
    isSiteOwner: true,
  });
  mockIsMachineOnline.mockResolvedValue(true);
  mockIsHootEnabled.mockResolvedValue(true);
  mockGetOnlineMachines.mockResolvedValue([MACHINE]);
  mockAcquireTurnLock.mockResolvedValue(undefined);
  mockStartTurn.mockReturnValue({ cancel: jest.fn(async () => {}) });
  mockFinishTurn.mockResolvedValue(true);
});

describe('POST /api/hoot — turn-start audit', () => {
  it('emits one chat_mutated/send row after the lock is held, without message content', async () => {
    const res = await TURN(turnRequest());
    expect(res.status).toBe(200);

    expect(emitMutation).toHaveBeenCalledTimes(1);
    expect(emitMutation).toHaveBeenCalledWith({
      kind: 'chat_mutated',
      siteId: SITE,
      actor: 'user:user-1',
      targetId: CHAT,
      attributes: {
        verb: 'send',
        endpoint: '/api/hoot',
        method: 'POST',
        siteId: SITE,
        machineId: MACHINE,
        turnId: 'turn-fixed',
        supersede: false,
      },
    });
    // What was said is not audit material.
    expect(JSON.stringify((emitMutation as jest.Mock).mock.calls[0][0])).not.toContain(
      'secret plans',
    );
  });

  it('records a supersede claim as such', async () => {
    await TURN(turnRequest({ supersede: true }));
    expect(emitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        attributes: expect.objectContaining({ supersede: true }),
      }),
    );
  });

  it('attributes an api-key caller to its key', async () => {
    mockResolveAuth.mockResolvedValue(authedKey());
    await TURN(turnRequest());
    expect(emitMutation).toHaveBeenCalledWith(
      expect.objectContaining({ actor: 'apiKey:key-test' }),
    );
  });

  it('emits nothing when the lock is already held by a live turn', async () => {
    const { TurnActiveError } = jest.requireMock('@/lib/hoot/turnStore.server') as {
      TurnActiveError: new (m: string) => Error;
    };
    mockAcquireTurnLock.mockRejectedValue(new TurnActiveError('busy'));

    const res = await TURN(turnRequest());
    expect(res.status).toBe(409);
    expect(emitMutation).not.toHaveBeenCalled();
    expect(mockStartTurn).not.toHaveBeenCalled();
  });

  it('emits nothing when the chat belongs to another user', async () => {
    chatDoc = { userId: 'someone-else', siteId: SITE };

    const res = await TURN(turnRequest());
    expect(res.status).toBe(403);
    expect(emitMutation).not.toHaveBeenCalled();
    expect(mockAcquireTurnLock).not.toHaveBeenCalled();
  });

  it('emits nothing when the target machine is offline', async () => {
    mockIsMachineOnline.mockResolvedValue(false);

    const res = await TURN(turnRequest());
    expect(res.status).toBe(503);
    expect(emitMutation).not.toHaveBeenCalled();
  });
});

describe('POST /api/hoot/stop — turn-cancel audit', () => {
  it('emits one chat_mutated/cancel_turn row when the terminal write lands', async () => {
    const res = await STOP(stopRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stopped: true });

    expect(emitMutation).toHaveBeenCalledTimes(1);
    expect(emitMutation).toHaveBeenCalledWith({
      kind: 'chat_mutated',
      siteId: SITE,
      actor: 'user:user-1',
      targetId: CHAT,
      attributes: {
        verb: 'cancel_turn',
        endpoint: '/api/hoot/stop',
        method: 'POST',
        siteId: SITE,
        turnId: 'turn-fixed',
      },
    });
  });

  it('still 200s but emits nothing when the turnId is stale or already terminal', async () => {
    mockFinishTurn.mockResolvedValue(false);

    const res = await STOP(stopRequest({ turnId: 'turn-stale' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stopped: true });
    expect(emitMutation).not.toHaveBeenCalled();
  });

  it('emits nothing when the caller does not own the chat', async () => {
    chatDoc = { userId: 'someone-else', siteId: SITE };

    const res = await STOP(stopRequest());
    expect(res.status).toBe(403);
    expect(emitMutation).not.toHaveBeenCalled();
    expect(mockFinishTurn).not.toHaveBeenCalled();
  });
});
