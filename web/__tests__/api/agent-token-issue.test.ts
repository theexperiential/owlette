/** @jest-environment node */

/**
 * Audit coverage for the two agent-registration-code minters (talons wave 5.4):
 * POST /api/agent/generate-installer and POST /api/setup/generate-token.
 *
 * Both write an `agent_tokens/{registrationCode}` doc — the doc id IS the
 * credential — so the `site_mutated` / `agent_token.issue` row targets the site
 * and carries only the expiry, exactly as `agent-tokens/revoke` records a mode
 * and a count rather than the token ids it deleted.
 */

import { NextRequest } from 'next/server';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock('@/lib/withRateLimit', () => ({
  __esModule: true,
  withRateLimit: (handler: unknown) => handler,
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('firebase-admin/firestore', () => ({
  __esModule: true,
  FieldValue: { serverTimestamp: () => '__SERVER_TS__' },
  Timestamp: { fromDate: (d: Date) => ({ toDate: () => d }) },
}));

const mockRequireSession = jest.fn();
const mockAssertUserHasSiteAccess = jest.fn();
jest.mock('@/lib/apiAuth.server', () => {
  const actual = jest.requireActual('@/lib/apiAuth.server');
  return {
    ...actual,
    requireSession: (...a: unknown[]) => mockRequireSession(...a),
    assertUserHasSiteAccess: (...a: unknown[]) => mockAssertUserHasSiteAccess(...a),
  };
});

jest.mock('@/lib/auditLogClient', () => ({
  emitMutation: jest.fn(),
}));

const SITE = 'site-a';

const mockTokenSet = jest.fn();
/** Registration codes the routes minted, in call order — the credential itself. */
let mintedCodes: string[];

const fakeDb = {
  collection: (name: string) => {
    if (name !== 'agent_tokens') throw new Error(`unexpected collection: ${name}`);
    return {
      doc: (id: string) => {
        mintedCodes.push(id);
        return { set: mockTokenSet };
      },
    };
  },
};

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => fakeDb,
  // `setup/generate-token` reads the lazy handle. A getter, not a value: the
  // mock factory is hoisted above `fakeDb`'s initialiser.
  adminDb: {
    get value() {
      return fakeDb;
    },
  },
}));

import { POST as GENERATE_INSTALLER } from '@/app/api/agent/generate-installer/route';
import { POST as GENERATE_TOKEN } from '@/app/api/setup/generate-token/route';
import { emitMutation } from '@/lib/auditLogClient';

function request(path: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

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
  mintedCodes = [];
  mockRequireSession.mockResolvedValue('user-1');
  mockAssertUserHasSiteAccess.mockResolvedValue(undefined);
  mockTokenSet.mockResolvedValue(undefined);
});

describe('POST /api/agent/generate-installer — audit', () => {
  it('emits site_mutated/agent_token.issue with the expiry and no registration code', async () => {
    const res = await GENERATE_INSTALLER(
      request('/api/agent/generate-installer', { siteId: SITE }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.registrationCode).toEqual(expect.any(String));

    const audit = soleAudit();
    expect(audit.kind).toBe('site_mutated');
    expect(audit.siteId).toBe(SITE);
    expect(audit.actor).toBe('user:user-1');
    expect(audit.targetId).toBe(SITE);
    expect(audit.attributes).toEqual({
      verb: 'agent_token.issue',
      endpoint: '/api/agent/generate-installer',
      method: 'POST',
      siteId: SITE,
      expiresAt: body.expiresAt,
    });
    // Negative control: the minted code is in hand, and must not be in the row.
    expect(mintedCodes).toEqual([body.registrationCode]);
    expect(JSON.stringify(audit)).not.toContain(body.registrationCode);
  });

  it('emits nothing when the caller has no access to the site', async () => {
    const { ApiAuthError } = jest.requireActual('@/lib/apiAuth.server');
    mockAssertUserHasSiteAccess.mockRejectedValue(new ApiAuthError(403, 'Forbidden'));

    const res = await GENERATE_INSTALLER(
      request('/api/agent/generate-installer', { siteId: SITE }),
    );
    expect(res.status).toBe(403);
    expect(mockTokenSet).not.toHaveBeenCalled();
    expect(emitMutation).not.toHaveBeenCalled();
  });

  it('emits nothing when siteId is missing', async () => {
    const res = await GENERATE_INSTALLER(request('/api/agent/generate-installer', {}));
    expect(res.status).toBe(400);
    expect(emitMutation).not.toHaveBeenCalled();
  });
});

describe('POST /api/setup/generate-token — audit', () => {
  it('emits the same agent_token.issue row, without the token it returns', async () => {
    const res = await GENERATE_TOKEN(request('/api/setup/generate-token', { siteId: SITE }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toEqual(expect.any(String));

    const audit = soleAudit();
    expect(audit.kind).toBe('site_mutated');
    expect(audit.targetId).toBe(SITE);
    expect(audit.attributes).toMatchObject({
      verb: 'agent_token.issue',
      endpoint: '/api/setup/generate-token',
      method: 'POST',
      siteId: SITE,
      expiresAt: expect.any(String),
    });
    expect(Date.parse(audit.attributes.expiresAt as string)).toBeGreaterThan(Date.now());
    expect(mintedCodes).toEqual([body.token]);
    expect(JSON.stringify(audit)).not.toContain(body.token);
  });

  it('emits nothing when the caller has no access to the site', async () => {
    const { ApiAuthError } = jest.requireActual('@/lib/apiAuth.server');
    mockAssertUserHasSiteAccess.mockRejectedValue(new ApiAuthError(403, 'Forbidden'));

    const res = await GENERATE_TOKEN(request('/api/setup/generate-token', { siteId: SITE }));
    expect(res.status).toBe(403);
    expect(mockTokenSet).not.toHaveBeenCalled();
    expect(emitMutation).not.toHaveBeenCalled();
  });
});
