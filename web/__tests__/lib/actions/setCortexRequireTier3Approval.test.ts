/** @jest-environment node */

import type { Actor } from '@/lib/capabilities';

const mockSet = jest.fn().mockResolvedValue(undefined);
const mockEmitMutation = jest.fn();

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: () => ({ set: mockSet }),
        }),
      }),
    }),
  }),
}));
jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: jest.fn(() => '__SERVER_TS__') },
}));
jest.mock('@/lib/auditLogClient', () => ({
  emitMutation: (...args: unknown[]) => mockEmitMutation(...args),
}));
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { setCortexRequireTier3Approval } from '@/lib/actions/setCortexRequireTier3Approval.server';
import { ActionInputError, type ActionContext } from '@/lib/actions/createProcess.server';

const SITE = 'site-a';
const ACTOR: Actor = { type: 'user', userId: 'uid', role: 'admin', sites: [SITE] };
const CTX: ActionContext = { siteId: SITE, actor: ACTOR, auditActor: 'user:uid' };

beforeEach(() => {
  jest.clearAllMocks();
});

describe('setCortexRequireTier3Approval', () => {
  it('merge-writes requireTier3Approval=true to the site cortex settings doc', async () => {
    const result = await setCortexRequireTier3Approval(CTX, { requireTier3Approval: true });
    expect(mockSet).toHaveBeenCalledTimes(1);
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ requireTier3Approval: true }),
      { merge: true },
    );
    expect(result).toEqual({ siteId: SITE, requireTier3Approval: true });
  });

  it('writes requireTier3Approval=false to disable the gate', async () => {
    await setCortexRequireTier3Approval(CTX, { requireTier3Approval: false });
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ requireTier3Approval: false }),
      { merge: true },
    );
  });

  it('emits an audit with verb=set_cortex_require_tier3_approval', async () => {
    await setCortexRequireTier3Approval(CTX, { requireTier3Approval: false });
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'site_mutated',
        siteId: SITE,
        targetId: SITE,
        attributes: expect.objectContaining({
          verb: 'set_cortex_require_tier3_approval',
          method: 'PATCH',
          requireTier3Approval: false,
        }),
      }),
    );
  });

  it('rejects a non-boolean value and does not write or audit', async () => {
    await expect(
      // @ts-expect-error — testing runtime validation
      setCortexRequireTier3Approval(CTX, { requireTier3Approval: 'yes' }),
    ).rejects.toThrow(ActionInputError);
    expect(mockSet).not.toHaveBeenCalled();
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });
});
