/** @jest-environment node */

/**
 * Route-layer tests for POST /api/sites/{siteId}/talons/{talonId}/test (the "run now" button
 * on /talons). The engine (`runTalonManual`) owns cooldown bypass, the in-flight guard, and
 * outputs, and has its own suite; asserted here is only what the http layer owns: TALON_MANAGE
 * against the path siteId, the talon-id bound, the engine arguments, the response envelope,
 * and the TalonStoreError -> problem+json map.
 */

import { NextResponse } from 'next/server';

import { createMockRequest } from './helpers/utils';
import { mockDbFactory } from './helpers/firestore-mock';

const SITE = 'site-a';
const TALON = 'tal000000000000000001';

const mockAuthorize = jest.fn();
const mockRunTalonManual = jest.fn();

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => mockDbFactory(),
  getAdminAuth: () => ({
    verifyIdToken: jest.fn().mockRejectedValue(new Error('n/a')),
  }),
}));

/**
 * Wrapper stand-in: records the registered options on `__options` so capability wiring can be
 * asserted, and defers allow/deny to `mockAuthorize` so a test can 401 before the handler runs.
 * The wrapper's own enforcement is covered by __tests__/lib/authorizedHandler.test.ts.
 */
jest.mock('@/lib/authorizedHandler.server', () => ({
  authorizedSiteHandler:
    (options: Record<string, unknown>) =>
    (handler: (...args: unknown[]) => unknown) => {
      const route = async (
        request: unknown,
        routeContext: { params: Promise<Record<string, string>> },
      ) => {
        const params = await routeContext.params;
        const denial = await mockAuthorize(options, request, params);
        if (denial) return denial;
        return handler(
          request,
          {
            actor: {
              type: 'user',
              userId: 'user-1',
              role: 'admin',
              sites: [params.siteId],
            },
            siteId: params.siteId,
            correlationId: 'corr-test',
            auth: { userId: 'user-1', keyContext: null },
            scopeCheck: { isLegacy: false },
          },
          routeContext,
        );
      };
      route.__options = options;
      return route;
    },
}));

jest.mock('@/lib/talons/engine.server', () => ({
  runTalonManual: (...args: unknown[]) => mockRunTalonManual(...args),
}));

import { TalonStoreError } from '@/lib/talons/store.server';
import { POST as testPOST } from '@/app/api/sites/[siteId]/talons/[talonId]/test/route';

function runSummary(overrides: Record<string, unknown> = {}) {
  return {
    runId: 'run-1',
    status: 'succeeded',
    machineId: 'machine-1',
    outputs: [{ type: 'email', status: 'sent' }],
    ...overrides,
  };
}

function routeParams(talonId = TALON) {
  return { params: Promise.resolve({ siteId: SITE, talonId }) };
}

function request(talonId = TALON) {
  return createMockRequest(
    `http://localhost/api/sites/${SITE}/talons/${talonId}/test`,
    { method: 'POST' },
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthorize.mockResolvedValue(undefined);
  mockRunTalonManual.mockResolvedValue([runSummary()]);
});

describe('POST /api/sites/{siteId}/talons/{talonId}/test', () => {
  it('gates the fire on TALON_MANAGE with write-class scope', () => {
    const options = (testPOST as unknown as { __options: Record<string, unknown> })
      .__options;

    expect(options).toEqual(
      expect.objectContaining({
        capability: 'TALON_MANAGE',
        siteIdParam: 'path',
        targetKind: 'talon',
        targetIdParam: 'talonId',
      }),
    );
    // Absent = the wrapper's write-class default; a read-scoped key must not fire a talon.
    expect(options.apiKeyPermission).toBeUndefined();
  });

  it('returns the wrapper denial without running the talon', async () => {
    mockAuthorize.mockResolvedValue(
      NextResponse.json({ status: 401 }, { status: 401 }),
    );

    const res = await testPOST(request(), routeParams());

    expect(res.status).toBe(401);
    expect(mockRunTalonManual).not.toHaveBeenCalled();
  });

  it('runs the talon for the authorized site and returns its run summaries', async () => {
    const summaries = [
      runSummary(),
      runSummary({
        runId: 'run-2',
        status: 'skipped',
        machineId: 'machine-2',
        outputs: [],
        error: 'another run is already in flight',
      }),
    ];
    mockRunTalonManual.mockResolvedValue(summaries);

    const res = await testPOST(request(), routeParams());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runs: summaries });
    // Site comes from the wrapper context, never the path string; the actor is forwarded so
    // the engine can attribute the manual fire.
    expect(mockRunTalonManual).toHaveBeenCalledWith(
      expect.anything(),
      SITE,
      TALON,
      expect.objectContaining({ type: 'user', userId: 'user-1' }),
    );
  });

  it('404s when the site has no talon with that id', async () => {
    mockRunTalonManual.mockRejectedValue(
      new TalonStoreError(404, 'talon_not_found', `talon \`${TALON}\` was not found.`),
    );

    const res = await testPOST(request(), routeParams());

    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(await res.json()).toMatchObject({
      code: 'talon_not_found',
      title: 'not found',
      status: 404,
      instance: `/api/sites/${SITE}/talons/${TALON}/test`,
    });
  });

  it('400s on a malformed talon id without touching the engine', async () => {
    const res = await testPOST(request('bad/id'), routeParams('bad/id'));

    expect(res.status).toBe(400);
    expect(mockRunTalonManual).not.toHaveBeenCalled();
  });

  it('500s on an unexpected engine failure', async () => {
    mockRunTalonManual.mockRejectedValue(new Error('firestore unavailable'));

    const res = await testPOST(request(), routeParams());

    expect(res.status).toBe(500);
  });
});
