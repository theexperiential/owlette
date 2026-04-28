/** @jest-environment node */

import { createMockRequest } from './helpers/utils';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock('@/lib/authorizedHandler.server', () => ({
  authorizedSiteHandler: () => (handler: (...args: unknown[]) => unknown) =>
    async (
      request: Request,
      routeContext: { params: Promise<{ siteId: string; machineId: string }> },
    ) => {
      const params = await routeContext.params;
      return handler(
        request,
        {
          actor: { type: 'user', userId: 'admin-uid', role: 'admin', sites: [params.siteId] },
          siteId: params.siteId,
          correlationId: 'corr-test',
          auth: { userId: 'admin-uid', keyContext: null },
          scopeCheck: { isLegacy: false },
        },
        routeContext,
      );
    },
}));

jest.mock('@/lib/auditLogClient', () => ({
  emitMutation: jest.fn(),
}));

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: jest.fn(),
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: jest.fn(() => ({ __op: 'serverTimestamp' })),
  },
}));

const mockTriggerUninstall = jest.fn();
const mockCancelUninstall = jest.fn();

jest.mock('@/lib/actions/triggerUninstall.server', () => {
  class TriggerUninstallError extends Error {
    code = 'validation_failed';
    fieldErrors = {};
  }

  return {
    triggerUninstall: (...args: unknown[]) => mockTriggerUninstall(...args),
    parseTriggerUninstallInput: jest.fn(() => ({ software_name: 'TouchDesigner' })),
    TriggerUninstallError,
  };
});

jest.mock('@/lib/actions/cancelUninstall.server', () => {
  class CancelUninstallError extends Error {
    code = 'validation_failed';
    fieldErrors = {};
  }

  return {
    cancelUninstall: (...args: unknown[]) => mockCancelUninstall(...args),
    parseCancelUninstallInput: jest.fn(() => ({ software_name: 'TouchDesigner' })),
    CancelUninstallError,
  };
});

import {
  DELETE as uninstallDELETE,
  POST as uninstallPOST,
} from '@/app/api/sites/[siteId]/machines/[machineId]/uninstall/route';

const SITE = 'site-alpha';
const MACHINE = 'mach-1';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('/api/sites/{siteId}/machines/{machineId}/uninstall', () => {
  it('POST requires Idempotency-Key before queuing uninstall', async () => {
    const res = await uninstallPOST(
      createMockRequest(`http://localhost/api/sites/${SITE}/machines/${MACHINE}/uninstall`, {
        method: 'POST',
        body: { software_name: 'TouchDesigner' },
      }),
      { params: Promise.resolve({ siteId: SITE, machineId: MACHINE }) },
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.code).toBe('idempotency_key_required');
    expect(mockTriggerUninstall).not.toHaveBeenCalled();
  });

  it('DELETE requires Idempotency-Key before queuing cancel_uninstall', async () => {
    const res = await uninstallDELETE(
      createMockRequest(
        `http://localhost/api/sites/${SITE}/machines/${MACHINE}/uninstall?software_name=TouchDesigner`,
        {
          method: 'DELETE',
        },
      ),
      { params: Promise.resolve({ siteId: SITE, machineId: MACHINE }) },
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.code).toBe('idempotency_key_required');
    expect(mockCancelUninstall).not.toHaveBeenCalled();
  });
});
