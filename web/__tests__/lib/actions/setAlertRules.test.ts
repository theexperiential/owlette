/** @jest-environment node */

/**
 * Unit tests for `setAlertRules` action core (security-boundary-migration
 * wave 3.11).
 */

const mockSet = jest.fn().mockResolvedValue(undefined);
const mockAlertsDoc = { set: mockSet };
const mockSettingsCollection = { doc: jest.fn(() => mockAlertsDoc) };
const mockSiteDoc = { collection: jest.fn(() => mockSettingsCollection) };
const mockSitesCollection = { doc: jest.fn(() => mockSiteDoc) };

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: jest.fn((name: string) => {
      if (name !== 'sites') throw new Error(`unexpected collection ${name}`);
      return mockSitesCollection;
    }),
  }),
}));

import type { UserActor } from '@/lib/capabilities';
import {
  AlertRulesValidationError,
  setAlertRules,
  type AlertRuleInput,
} from '@/lib/actions/setAlertRules.server';

const actor: UserActor = {
  type: 'user',
  userId: 'user-superadmin',
  role: 'superadmin',
  sites: [],
};

const validRule: AlertRuleInput = {
  id: 'rule-1',
  name: '  high cpu  ',
  metric: '  cpu_percent  ',
  operator: '>',
  value: 90,
  severity: 'warning',
  channels: ['email', 'webhook'],
  enabled: true,
  cooldownMinutes: 30,
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('setAlertRules', () => {
  it('replaces the rules array with merge semantics', async () => {
    const result = await setAlertRules(
      { actor, siteId: 'site-a' },
      { rules: [validRule] },
    );

    expect(result).toEqual({ siteId: 'site-a', ruleCount: 1 });
    expect(mockSitesCollection.doc).toHaveBeenCalledWith('site-a');
    expect(mockSiteDoc.collection).toHaveBeenCalledWith('settings');
    expect(mockSettingsCollection.doc).toHaveBeenCalledWith('alerts');
    expect(mockSet).toHaveBeenCalledWith(
      {
        rules: [
          {
            ...validRule,
            name: 'high cpu',
            metric: 'cpu_percent',
          },
        ],
      },
      { merge: true },
    );
  });

  it('accepts an empty rules array', async () => {
    const result = await setAlertRules({ actor, siteId: 'site-a' }, { rules: [] });

    expect(result.ruleCount).toBe(0);
    expect(mockSet).toHaveBeenCalledWith({ rules: [] }, { merge: true });
  });

  it('rejects invalid site ids and duplicate rule ids', async () => {
    await expect(
      setAlertRules({ actor, siteId: 'bad site id' }, { rules: [] }),
    ).rejects.toMatchObject({ field: 'siteId' });

    await expect(
      setAlertRules(
        { actor, siteId: 'site-a' },
        { rules: [{ ...validRule }, { ...validRule }] },
      ),
    ).rejects.toMatchObject({ field: 'rules' });
  });

  it.each([
    ['operator', { operator: '!=' }],
    ['severity', { severity: 'urgent' }],
    ['channels', { channels: ['sms'] }],
    ['enabled', { enabled: 'true' }],
    ['cooldownMinutes', { cooldownMinutes: -1 }],
  ])('rejects invalid %s', async (_label, patch) => {
    await expect(
      setAlertRules(
        { actor, siteId: 'site-a' },
        { rules: [{ ...validRule, ...patch } as unknown as AlertRuleInput] },
      ),
    ).rejects.toBeInstanceOf(AlertRulesValidationError);
  });
});
