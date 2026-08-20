/** @jest-environment node */

/**
 * Route-layer tests for GET /api/sites/{siteId}/talons/{talonId}/runs. Assert the query shape
 * (filter + order, matching the composite index), the page envelope, and the deliberate decision
 * NOT to 404 when the talon is gone.
 */

import { NextResponse } from 'next/server';

import { createMockRequest } from './helpers/utils';
import { docSnapshot, mockDbFactory, mocks, querySnapshot } from './helpers/firestore-mock';

const SITE = 'site-a';
const TALON = 'tal000000000000000001';

const mockAuthorize = jest.fn();

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

import { GET as runsGET } from '@/app/api/sites/[siteId]/talons/[talonId]/runs/route';

const STARTED_AT = new Date('2026-08-01T10:00:00.000Z');

function runDoc(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    data: {
      talonId: TALON,
      talonName: 'restart td nightly',
      triggerType: 'schedule',
      triggerSummary: 'every 60 minutes',
      status: 'succeeded',
      startedAt: STARTED_AT,
      completedAt: new Date(STARTED_AT.getTime() + 1500),
      durationMs: 1500,
      outputs: [{ type: 'email', status: 'sent' }],
      correlationId: 'corr-1',
      ...overrides,
    },
  };
}

function routeParams(talonId = TALON) {
  return { params: Promise.resolve({ siteId: SITE, talonId }) };
}

function request(query = '') {
  return createMockRequest(
    `http://localhost/api/sites/${SITE}/talons/${TALON}/runs${query}`,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthorize.mockResolvedValue(undefined);
  mocks.orderBy.mockReturnThis();
  mocks.limit.mockReturnThis();
  mocks.startAfter.mockReturnThis();
  mocks.where.mockReturnThis();
  mocks.get.mockResolvedValue(docSnapshot('missing', null));
  mocks.collectionGet.mockResolvedValue(querySnapshot([]));
});

describe('GET /api/sites/{siteId}/talons/{talonId}/runs', () => {
  it('reads with read-class scope under TALON_MANAGE', () => {
    expect((runsGET as unknown as { __options: Record<string, unknown> }).__options)
      .toEqual(
        expect.objectContaining({
          capability: 'TALON_MANAGE',
          siteIdParam: 'path',
          targetKind: 'talon',
          targetIdParam: 'talonId',
          apiKeyPermission: 'read',
        }),
      );
  });

  it('queries the talon_runs composite index and serializes the page', async () => {
    mocks.collectionGet.mockResolvedValue(querySnapshot([runDoc('run-1')]));

    const res = await runsGET(request(), routeParams());

    expect(res.status).toBe(200);
    expect(mocks.where).toHaveBeenCalledWith('talonId', '==', TALON);
    expect(mocks.orderBy).toHaveBeenCalledWith('startedAt', 'desc');

    const body = (await res.json()) as {
      runs: Array<Record<string, unknown>>;
      next_page_token: string;
      nextPageToken: string;
    };
    expect(body.next_page_token).toBe('');
    expect(body.nextPageToken).toBe('');
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]).toMatchObject({
      id: 'run-1',
      talonId: TALON,
      status: 'succeeded',
      startedAt: STARTED_AT.toISOString(),
      durationMs: 1500,
      machineId: null,
      chatId: null,
      error: null,
      manual: false,
      condition: null,
    });
  });

  it('returns an empty page rather than 404 when the talon is gone', async () => {
    const res = await runsGET(request(), routeParams());

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ runs: [], next_page_token: '' });
  });

  it('emits a next_page_token when more runs remain', async () => {
    mocks.collectionGet.mockResolvedValue(
      querySnapshot([runDoc('run-1'), runDoc('run-2'), runDoc('run-3')]),
    );

    const res = await runsGET(request('?page_size=2'), routeParams());

    expect(res.status).toBe(200);
    // pageSize + 1 is fetched to detect a next page.
    expect(mocks.limit).toHaveBeenCalledWith(3);
    const body = (await res.json()) as {
      runs: Array<{ id: string }>;
      next_page_token: string;
    };
    expect(body.runs.map((run) => run.id)).toEqual(['run-1', 'run-2']);
    expect(body.next_page_token).toBe('run-2');
  });

  it('starts after the cursor document when a page_token is supplied', async () => {
    mocks.get.mockResolvedValue(docSnapshot('run-9', { talonId: TALON }));

    const res = await runsGET(request('?page_token=run-9'), routeParams());

    expect(res.status).toBe(200);
    expect(mocks.startAfter).toHaveBeenCalled();
  });

  it('400s on an out-of-range page_size', async () => {
    const res = await runsGET(request('?page_size=0'), routeParams());

    expect(res.status).toBe(400);
    expect(mocks.collectionGet).not.toHaveBeenCalled();
  });

  it('400s on a malformed talon id', async () => {
    const res = await runsGET(request(), routeParams('bad/id'));

    expect(res.status).toBe(400);
    expect(mocks.collectionGet).not.toHaveBeenCalled();
  });

  it('returns the wrapper denial without querying', async () => {
    mockAuthorize.mockResolvedValue(
      NextResponse.json({ status: 401 }, { status: 401 }),
    );

    const res = await runsGET(request(), routeParams());

    expect(res.status).toBe(401);
    expect(mocks.collectionGet).not.toHaveBeenCalled();
  });
});
