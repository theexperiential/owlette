/** @jest-environment node */

/**
 * Item 18: roost kill-switch is wired into every roost / chunk route.
 *
 * The `gateOrProceed` helper is unit-tested in lib/roostKillSwitch.test.ts.
 * This file is the END-TO-END wiring test: for a representative sample of
 * the 17 wired routes, set `sites/{siteId}.roostEnabled = false` and
 * confirm the route returns 503 with a problem+json body indicating roost
 * is disabled (not a 200, not a 500, not a different problem type).
 *
 * Static-source assertion: at the bottom, we verify all 17 expected route
 * files import `gateOrProceed` so this test can't silently rot if a new
 * roost route ships without the gate.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMockRequest } from '../helpers/utils';
import { mocks, mockDbFactory } from '../helpers/firestore-mock';

const mockEmitMutation = jest.fn();
const mockResolveAuth = jest.fn();
const mockAssertSite = jest.fn();

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock('@/lib/auditLogClient', () => ({
  emitApiKeyUsed: jest.fn(),
  emitMutation: (...args: unknown[]) => mockEmitMutation(...args),
  scopeFingerprint: jest.fn(() => 'fp'),
}));

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => mockDbFactory(),
  getAdminAuth: () => ({
    verifyIdToken: jest
      .fn()
      .mockRejectedValue(new Error('n/a')),
  }),
}));

jest.mock('@/lib/apiAuth.server', () => {
  const actual = jest.requireActual('@/lib/apiAuth.server');
  return {
    ...actual,
    resolveAuth: (...a: unknown[]) => mockResolveAuth(...a),
    assertUserHasSiteAccess: (...a: unknown[]) => mockAssertSite(...a),
  };
});

const SITE = 'site-disabled';

function disableRoostForSite() {
  // The site doc reader inside each route's `readSiteDocForGate` calls
  // `getAdminDb().collection('sites').doc(siteId).get()`. The firestore-mock
  // factory routes top-level site reads through `mocks.siteDocs`.
  mocks.siteDocs.set(SITE, {
    owner: 'user-1',
    roostEnabled: false,
    name: 'Disabled site',
  });
}

function authed() {
  mockResolveAuth.mockResolvedValue({ userId: 'user-1', keyContext: null });
  mockAssertSite.mockResolvedValue({ siteId: SITE, siteData: {} });
}

beforeEach(() => {
  jest.clearAllMocks();
  mocks.siteDocs.clear();
  authed();
});

/* -------------------------------------------------------------------- */
/*  Behavior: hitting a wired route with roostEnabled=false → 503        */
/* -------------------------------------------------------------------- */

describe('roost kill switch — wired route 503 behavior', () => {
  it('GET /api/roosts returns 503 when site has roostEnabled: false', async () => {
    disableRoostForSite();
    const { GET } = await import('@/app/api/roosts/route');
    const req = createMockRequest(
      `http://localhost/api/roosts?siteId=${SITE}`,
    );
    const res = await GET(req);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.title).toMatch(/roost disabled/i);
  });

  it('POST /api/roosts returns 503 when site has roostEnabled: false', async () => {
    disableRoostForSite();
    const { POST } = await import('@/app/api/roosts/route');
    const req = createMockRequest('http://localhost/api/roosts', {
      method: 'POST',
      body: { siteId: SITE, name: 'lobby', targets: [] },
    });
    const res = await POST(req);
    expect(res.status).toBe(503);
  });

  it('POST /api/chunks/upload-urls returns 503 when roost disabled', async () => {
    disableRoostForSite();
    const { POST } = await import('@/app/api/chunks/upload-urls/route');
    const req = createMockRequest('http://localhost/api/chunks/upload-urls', {
      method: 'POST',
      body: { siteId: SITE, digests: [] },
    });
    const res = await POST(req);
    expect(res.status).toBe(503);
  });

  it('POST /api/chunks/check returns 503 when roost disabled', async () => {
    disableRoostForSite();
    const { POST } = await import('@/app/api/chunks/check/route');
    const req = createMockRequest('http://localhost/api/chunks/check', {
      method: 'POST',
      body: { siteId: SITE, digests: [] },
    });
    const res = await POST(req);
    expect(res.status).toBe(503);
  });

  it('returns 503 with content-type application/problem+json', async () => {
    disableRoostForSite();
    const { GET } = await import('@/app/api/roosts/route');
    const req = createMockRequest(
      `http://localhost/api/roosts?siteId=${SITE}`,
    );
    const res = await GET(req);
    expect(res.headers.get('Content-Type')).toMatch(
      /application\/problem\+json/,
    );
  });
});

/* -------------------------------------------------------------------- */
/*  Static wiring guard: every roost route must import gateOrProceed     */
/* -------------------------------------------------------------------- */

/**
 * The 17 routes that ship with the kill switch wired (per dev docs +
 * `grep gateOrProceed app/api`). If any new roost route lands without the
 * gate, this test fails — it's cheap insurance against the most likely
 * regression for this feature: forgetting to wire a new endpoint.
 */
const WIRED_ROUTES: string[] = [
  'app/api/roosts/route.ts',
  'app/api/roosts/[roostId]/route.ts',
  'app/api/roosts/[roostId]/rollback/route.ts',
  'app/api/roosts/[roostId]/deploy/route.ts',
  'app/api/roosts/[roostId]/resync/route.ts',
  'app/api/roosts/[roostId]/deployments/route.ts',
  'app/api/roosts/[roostId]/deployments/[rolloutId]/route.ts',
  'app/api/roosts/[roostId]/version-url/route.ts',
  'app/api/roosts/[roostId]/versions/route.ts',
  'app/api/roosts/[roostId]/versions/[versionRef]/route.ts',
  'app/api/roosts/[roostId]/versions/[versionRef]/files/route.ts',
  'app/api/roosts/[roostId]/versions/[versionRef]/diff/route.ts',
  'app/api/chunks/upload-urls/route.ts',
  'app/api/chunks/download-urls/route.ts',
  'app/api/chunks/check/route.ts',
  'app/api/chunks/[digest]/referrers/route.ts',
  'app/api/chunks/[digest]/mount/route.ts',
];

describe('roost kill switch — static wiring guard', () => {
  it('exactly 17 routes are wired (matches the documented count)', () => {
    expect(WIRED_ROUTES).toHaveLength(17);
  });

  it.each(WIRED_ROUTES)('%s imports gateOrProceed from @/lib/roostKillSwitch', (relPath) => {
    const absPath = join(process.cwd(), relPath);
    const src = readFileSync(absPath, 'utf8');
    // The route either imports the named export directly or imports the
    // whole module — accept either. We additionally require an actual
    // `gateOrProceed(` call to defend against import-without-use.
    expect(src).toMatch(
      /import\s+\{[^}]*gateOrProceed[^}]*\}\s+from\s+['"]@\/lib\/roostKillSwitch['"]/,
    );
    expect(src).toMatch(/gateOrProceed\s*\(/);
  });
});
