/** @jest-environment node */

import { NextRequest } from 'next/server';

let systemPresetDocs: Array<{ id: string; data: Record<string, unknown> }> = [];

jest.mock('@/lib/withRateLimit', () => ({
  withRateLimit: (handler: unknown) => handler,
}));

jest.mock('@/lib/authorizedHandler.server', () => ({
  authorizedPlatformHandler: () => (handler: (...args: unknown[]) => unknown) =>
    (request: NextRequest, routeContext?: unknown) =>
      handler(
        request,
        {
          actor: { type: 'user', userId: 'test-admin', role: 'superadmin', sites: [] },
          correlationId: 'corr-test',
          auth: { userId: 'test-admin', keyContext: null },
          scopeCheck: { isLegacy: false },
        },
        routeContext,
      ),
}));

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (name: string) => {
      if (name !== 'system_presets') throw new Error(`unexpected collection ${name}`);
      return {
        get: async () => ({
          docs: systemPresetDocs.map((doc) => ({
            id: doc.id,
            data: () => doc.data,
          })),
        }),
      };
    },
  }),
}));

jest.mock('@/lib/resendClient.server', () => ({
  FROM_EMAIL: 'noreply@example.com',
  ENV_LABEL: 'test',
  isProduction: false,
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { GET as emailGET } from '@/app/api/platform/email/config/route';
import { GET as tdGET } from '@/app/api/platform/touchdesigner/builds/route';
import { GET as presetsGET } from '@/app/api/platform/system-presets/route';

beforeEach(() => {
  systemPresetDocs = [];
  global.fetch = jest.fn();
});

describe('GET /api/platform/email/config', () => {
  it('returns email provider configuration', async () => {
    const res = await emailGET(new NextRequest('http://localhost/api/platform/email/config'));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      provider: 'Resend',
      fromEmail: 'noreply@example.com',
      environment: 'test',
    });
  });
});

describe('GET /api/platform/touchdesigner/builds', () => {
  it('returns TouchDesigner builds scraped from the archive page', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      text: async () => `
        https://download.derivative.ca/TouchDesigner.2023.12345.exe
        https://download.derivative.ca/TouchDesignerWebInstaller.2023.12345.exe
      `,
    });

    const res = await tdGET(new NextRequest('http://localhost/api/platform/touchdesigner/builds'));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      latest: {
        version: '2023.12345',
        full_installer_url: 'https://download.derivative.ca/TouchDesigner.2023.12345.exe',
        web_installer_url: 'https://download.derivative.ca/TouchDesignerWebInstaller.2023.12345.exe',
      },
    });
  });
});

describe('GET /api/platform/system-presets', () => {
  it('lists global system presets sorted by order then name', async () => {
    systemPresetDocs = [
      { id: 'b', data: { name: 'Beta', software_name: 'Beta', category: 'tools', order: 2 } },
      { id: 'a', data: { name: 'Alpha', software_name: 'Alpha', category: 'tools', order: 1 } },
    ];

    const res = await presetsGET(new NextRequest('http://localhost/api/platform/system-presets'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.items.map((p: { id: string }) => p.id)).toEqual(['a', 'b']);
  });
});
