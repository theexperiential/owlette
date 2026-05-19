/** @jest-environment node */

import { NextRequest } from 'next/server';

const setAlertRulesMock = jest.fn();

jest.mock('@/lib/authorizedHandler.server', () => ({
  authorizedSiteHandler: () => (handler: (...args: unknown[]) => unknown) =>
    async (request: NextRequest, routeContext: { params: Promise<{ siteId: string }> }) => {
      const params = await routeContext.params;
      return handler(
        request,
        {
          actor: { type: 'user', userId: 'test-admin', role: 'superadmin', sites: [params.siteId] },
          siteId: params.siteId,
          correlationId: 'corr-test',
          auth: { userId: 'test-admin', keyContext: null },
          scopeCheck: { isLegacy: false },
        },
        routeContext,
      );
    },
}));

jest.mock('@/lib/actions/setAlertRules.server', () => ({
  setAlertRules: (...args: unknown[]) => setAlertRulesMock(...args),
  AlertRulesValidationError: class AlertRulesValidationError extends Error {
    field = 'rules';
  },
}));

import { PUT } from '@/app/api/sites/[siteId]/alerts/route';

beforeEach(() => {
  setAlertRulesMock.mockReset();
  setAlertRulesMock.mockResolvedValue({ siteId: 'site-a', ruleCount: 1 });
});

describe('PUT /api/sites/{siteId}/alerts', () => {
  it('uses the path siteId and forwards rules to the action core', async () => {
    const rules = [{ id: 'r1', enabled: true }];
    const res = await PUT(
      new NextRequest('http://localhost/api/sites/site-a/alerts', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules }),
      }),
      { params: Promise.resolve({ siteId: 'site-a' }) },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ siteId: 'site-a', ruleCount: 1 });
    expect(setAlertRulesMock).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: 'site-a' }),
      { rules },
    );
  });
});
