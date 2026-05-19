/** @jest-environment node */

import { NextRequest } from 'next/server';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

const mockRequireSession = jest.fn();
jest.mock('@/lib/apiAuth.server', () => ({
  requireSession: (...args: unknown[]) => mockRequireSession(...args),
}));

const mockVerifyUserSiteAccess = jest.fn();
const mockResolveLlmConfig = jest.fn();
jest.mock('@/lib/cortex-utils.server', () => ({
  verifyUserSiteAccess: (...args: unknown[]) => mockVerifyUserSiteAccess(...args),
  resolveLlmConfig: (...args: unknown[]) => mockResolveLlmConfig(...args),
}));

jest.mock('@/lib/llm', () => ({
  createCheapModel: jest.fn(() => ({ model: 'cheap' })),
}));

jest.mock('ai', () => ({
  generateText: jest.fn(async () => ({ text: 'Generated title\nGeneral' })),
}));

const mockChatGet = jest.fn();
const mockDb = {
  collection: jest.fn((name: string) => {
    if (name !== 'chats') throw new Error(`unexpected collection ${name}`);
    return {
      doc: jest.fn(() => ({ get: mockChatGet })),
    };
  }),
};

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => mockDb,
}));

import { GET as escalationGET } from '@/app/api/cortex/escalation/route';
import { POST as categorizePOST } from '@/app/api/cortex/categorize/route';

function req(url: string, init: RequestInit = {}) {
  return new NextRequest(url, init);
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.CRON_SECRET;
  mockRequireSession.mockResolvedValue('user-1');
  mockVerifyUserSiteAccess.mockResolvedValue({
    role: 'admin',
    isSuperadmin: false,
    isSiteAdmin: true,
    isSiteOwner: true,
  });
  mockResolveLlmConfig.mockResolvedValue({ provider: 'test' });
});

describe('/api/cortex/escalation internal gate', () => {
  it('fails closed when CRON_SECRET is not configured', async () => {
    const res = await escalationGET(req('http://localhost/api/cortex/escalation'));
    expect(res.status).toBe(503);
  });

  it('rejects an incorrect cron bearer token', async () => {
    process.env.CRON_SECRET = 'expected';
    const res = await escalationGET(
      req('http://localhost/api/cortex/escalation', {
        headers: { authorization: 'Bearer wrong' },
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe('/api/cortex/categorize internal access checks', () => {
  it('rejects single-chat categorization when the chat is not on the requested site', async () => {
    mockChatGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({ siteId: 'other-site' }),
    });
    const res = await categorizePOST(
      req('http://localhost/api/cortex/categorize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ siteId: 'site-1', chatId: 'chat-1', message: 'hello' }),
      }),
    );
    expect(res.status).toBe(404);
  });
});
