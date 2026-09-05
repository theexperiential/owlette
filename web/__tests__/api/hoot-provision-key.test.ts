/** @jest-environment node */

/**
 * Audit coverage for POST /api/hoot/provision-key (talons wave 5.4).
 *
 * The route queues a `provision_cortex_key` machine command carrying a raw LLM
 * api key, then blocks polling for the agent's terminal status. The mutation is
 * the queue write, so the `site_mutated` / `llm_key.provision` row is emitted
 * there — before the poll, and regardless of how the poll ends. The key must
 * never appear in the row.
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

jest.mock('firebase-admin/firestore', () => ({
  __esModule: true,
  FieldValue: {
    serverTimestamp: () => '__SERVER_TS__',
    delete: () => '__DELETE__',
  },
}));

const mockRequireSession = jest.fn();
jest.mock('@/lib/apiAuth.server', () => {
  const actual = jest.requireActual('@/lib/apiAuth.server');
  return {
    ...actual,
    requireSession: (...a: unknown[]) => mockRequireSession(...a),
  };
});

const mockVerifyAccess = jest.fn();
jest.mock('@/lib/hoot-utils.server', () => ({
  verifyUserSiteAccess: (...a: unknown[]) => mockVerifyAccess(...a),
}));

jest.mock('@/lib/auditLogClient', () => ({
  emitMutation: jest.fn(),
}));

const SITE = 'site-a';
const MACHINE = 'lobby-01';
const RAW_KEY = 'sk-ant-super-secret-value';

const mockPendingSet = jest.fn();
const mockPendingUpdate = jest.fn();
const mockCompletedUpdate = jest.fn();
/** What the agent has written back under `commands/completed`, by command id. */
let completedDoc: Record<string, unknown>;

function commandDoc(id: string) {
  if (id === 'pending') {
    return { set: mockPendingSet, update: mockPendingUpdate };
  }
  return {
    get: async () => ({ data: () => completedDoc }),
    update: mockCompletedUpdate,
  };
}

const fakeDb = {
  collection: (name: string) => {
    if (name !== 'sites') throw new Error(`unexpected collection: ${name}`);
    return {
      doc: () => ({
        collection: () => ({
          doc: () => ({
            collection: () => ({ doc: (id: string) => commandDoc(id) }),
          }),
        }),
      }),
    };
  },
};

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => fakeDb,
}));

import { POST } from '@/app/api/hoot/provision-key/route';
import { emitMutation } from '@/lib/auditLogClient';

function request(body: Record<string, unknown> = {}): NextRequest {
  return new NextRequest('http://localhost/api/hoot/provision-key', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      siteId: SITE,
      machineId: MACHINE,
      apiKey: RAW_KEY,
      provider: 'anthropic',
      ...body,
    }),
  });
}

/** The single audit row, with the command id the route minted. */
function soleAudit() {
  expect(emitMutation).toHaveBeenCalledTimes(1);
  return (emitMutation as jest.Mock).mock.calls[0][0] as {
    kind: string;
    siteId: string;
    actor: string;
    targetId: string;
    attributes: Record<string, unknown>;
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireSession.mockResolvedValue('user-1');
  mockVerifyAccess.mockResolvedValue({ role: 'admin' });
  mockPendingSet.mockResolvedValue(undefined);
  mockCompletedUpdate.mockResolvedValue(undefined);
  completedDoc = {};
});

describe('POST /api/hoot/provision-key — audit', () => {
  it('emits one site_mutated/llm_key.provision row naming the machine, never the key', async () => {
    // Agent answers on the first poll so the handler doesn't sit out its
    // 15s timeout.
    mockPendingSet.mockImplementation(async (payload: Record<string, unknown>) => {
      const [commandId] = Object.keys(payload);
      completedDoc = { [commandId]: { status: 'completed' } };
    });

    const res = await POST(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    const audit = soleAudit();
    expect(audit.kind).toBe('site_mutated');
    expect(audit.siteId).toBe(SITE);
    expect(audit.actor).toBe('user:user-1');
    expect(audit.targetId).toBe(MACHINE);
    expect(audit.attributes).toMatchObject({
      verb: 'llm_key.provision',
      endpoint: '/api/hoot/provision-key',
      method: 'POST',
      siteId: SITE,
      machineId: MACHINE,
      provider: 'anthropic',
      commandId: expect.stringMatching(/^provision_cortex_key_\d+$/),
    });
    expect(JSON.stringify(audit)).not.toContain(RAW_KEY);
  });

  it('still records the queued command when the agent reports a failure', async () => {
    // The command WAS written to the machine's queue; a failed install does not
    // un-write it, so the row must stand.
    mockPendingSet.mockImplementation(async (payload: Record<string, unknown>) => {
      const [commandId] = Object.keys(payload);
      completedDoc = { [commandId]: { status: 'failed', error: 'no disk' } };
    });

    const res = await POST(request());
    expect(res.status).toBe(500);
    expect(soleAudit().attributes.verb).toBe('llm_key.provision');
  });

  it('emits nothing when the caller has no access to the site', async () => {
    mockVerifyAccess.mockRejectedValue(new Error('You do not have access to this site'));

    await POST(request());
    expect(mockPendingSet).not.toHaveBeenCalled();
    expect(emitMutation).not.toHaveBeenCalled();
  });

  it('emits nothing when required fields are missing', async () => {
    const res = await POST(request({ apiKey: undefined }));
    expect(res.status).toBe(400);
    expect(emitMutation).not.toHaveBeenCalled();
  });
});
