/** @jest-environment node */

/**
 * Route-layer tests for the talon api:
 *   GET/POST          /api/sites/{siteId}/talons
 *   GET/PATCH/DELETE  /api/sites/{siteId}/talons/{talonId}
 *
 * These routes are thin shims — `@/lib/talons/store.server` owns every rule,
 * and has its own suite — so the store is mocked here and the assertions are
 * about what the http layer is responsible for: the wrapper wiring that
 * enforces TALON_MANAGE, the pro gate on create, idempotency, the PATCH
 * toggle-vs-replace dispatch, and the TalonStoreError -> problem+json map.
 *
 * The billing gate runs for real against the shared firestore mock
 * (`seedBilling`), since "create is pro-only, read and delete are not" is a
 * policy this layer owns.
 *
 * talons wave 1.2.
 */

import { NextResponse } from 'next/server';

import { createMockRequest } from './helpers/utils';
import { mockDbFactory, mocks, seedBilling } from './helpers/firestore-mock';

const SITE = 'site-a';
const TALON = 'tal000000000000000001';

const mockAuthorize = jest.fn();
const mockCheckIdempotency = jest.fn();
const mockSaveIdempotency = jest.fn();
const mockCreateTalon = jest.fn();
const mockListTalons = jest.fn();
const mockGetTalon = jest.fn();
const mockUpdateTalon = jest.fn();
const mockSetTalonEnabled = jest.fn();
const mockDeleteTalon = jest.fn();
const mockReassignTalons = jest.fn();
const mockListTalonsAuthoredBy = jest.fn();

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
 * Wrapper stand-in. It records the options each route registered onto the
 * returned handler (`__options`) so the tests can assert the capability
 * wiring per method, and defers the allow/deny decision to `mockAuthorize`
 * so a test can simulate the wrapper answering 401/403 before the handler
 * ever runs. The wrapper's own enforcement is unit-tested in
 * `__tests__/lib/authorizedHandler.test.ts`.
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

jest.mock('@/lib/idempotency', () => ({
  checkIdempotency: (...args: unknown[]) => mockCheckIdempotency(...args),
  saveIdempotency: (...args: unknown[]) => mockSaveIdempotency(...args),
}));

jest.mock('@/lib/talons/store.server', () => {
  class TalonStoreError extends Error {
    readonly status: number;
    readonly code: string;
    readonly fieldErrors?: unknown[];

    constructor(status: number, code: string, message: string, fieldErrors?: unknown[]) {
      super(message);
      this.name = 'TalonStoreError';
      this.status = status;
      this.code = code;
      if (fieldErrors) this.fieldErrors = fieldErrors;
    }
  }

  return {
    TalonStoreError,
    createTalon: (...args: unknown[]) => mockCreateTalon(...args),
    listTalons: (...args: unknown[]) => mockListTalons(...args),
    getTalon: (...args: unknown[]) => mockGetTalon(...args),
    updateTalon: (...args: unknown[]) => mockUpdateTalon(...args),
    setTalonEnabled: (...args: unknown[]) => mockSetTalonEnabled(...args),
    deleteTalon: (...args: unknown[]) => mockDeleteTalon(...args),
    reassignTalons: (...args: unknown[]) => mockReassignTalons(...args),
    listTalonsAuthoredBy: (...args: unknown[]) => mockListTalonsAuthoredBy(...args),
  };
});

import { TalonStoreError } from '@/lib/talons/store.server';
import { GET as listGET, POST as createPOST } from '@/app/api/sites/[siteId]/talons/route';
import {
  GET as itemGET,
  PATCH as itemPATCH,
  DELETE as itemDELETE,
} from '@/app/api/sites/[siteId]/talons/[talonId]/route';
import { POST as reassignPOST } from '@/app/api/sites/[siteId]/talons/reassign/route';
import { GET as authoredGET } from '@/app/api/sites/[siteId]/talons/authored/route';

/* -------------------------------------------------------------------------- */
/*  fixtures                                                                  */
/* -------------------------------------------------------------------------- */

const CREATED_AT = new Date('2026-08-01T10:00:00.000Z');

function storedTalon(overrides: Record<string, unknown> = {}) {
  return {
    id: TALON,
    schemaVersion: 1,
    name: 'restart td nightly',
    enabled: true,
    trigger: { type: 'schedule', intervalMinutes: 60 },
    condition: { type: 'none' },
    outputs: [{ type: 'email' }],
    scope: { machineIds: null },
    cooldownMinutes: 60,
    createdBy: 'user-1',
    createdVia: 'ui',
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    consecutiveFailures: 0,
    ...overrides,
  };
}

function talonInput(overrides: Record<string, unknown> = {}) {
  return {
    name: 'restart td nightly',
    trigger: { type: 'schedule', intervalMinutes: 60 },
    outputs: [{ type: 'email' }],
    ...overrides,
  };
}

function routeParams(talonId?: string) {
  return {
    params: Promise.resolve(
      talonId ? { siteId: SITE, talonId } : { siteId: SITE },
    ),
  };
}

function optionsOf(route: unknown): Record<string, unknown> {
  return (route as { __options: Record<string, unknown> }).__options;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthorize.mockResolvedValue(undefined);
  mockCheckIdempotency.mockResolvedValue({ mode: 'disabled' });
  mockSaveIdempotency.mockResolvedValue(undefined);
  mockListTalons.mockResolvedValue([]);
  mockCreateTalon.mockResolvedValue(storedTalon());
  mockGetTalon.mockResolvedValue(storedTalon());
  mockUpdateTalon.mockResolvedValue(storedTalon());
  mockSetTalonEnabled.mockResolvedValue(storedTalon({ enabled: false }));
  mockDeleteTalon.mockResolvedValue(undefined);
  mockReassignTalons.mockResolvedValue({
    siteId: SITE,
    toUid: 'successor-uid',
    reassignedTalonIds: [TALON],
    skippedTalonIds: [],
  });
  mockListTalonsAuthoredBy.mockResolvedValue([]);
  // Trialing accounts run at the pro feature level, so create is allowed.
  seedBilling({ siteId: SITE, state: 'trialing' });
});

/* -------------------------------------------------------------------------- */
/*  wrapper wiring                                                            */
/* -------------------------------------------------------------------------- */

describe('talon routes: authorization wiring', () => {
  it('gates every method on TALON_MANAGE against the path siteId', () => {
    for (const route of [listGET, createPOST, itemGET, itemPATCH, itemDELETE]) {
      expect(optionsOf(route)).toEqual(
        expect.objectContaining({
          capability: 'TALON_MANAGE',
          siteIdParam: 'path',
          targetKind: 'talon',
        }),
      );
    }
  });

  it('asks for read-class api-key scope on reads and the write default on mutations', () => {
    expect(optionsOf(listGET).apiKeyPermission).toBe('read');
    expect(optionsOf(itemGET).apiKeyPermission).toBe('read');
    for (const route of [createPOST, itemPATCH, itemDELETE]) {
      expect(optionsOf(route).apiKeyPermission).toBeUndefined();
    }
  });

  it('names the mutated talon as the audit target on the item routes', () => {
    for (const route of [itemGET, itemPATCH, itemDELETE]) {
      expect(optionsOf(route).targetIdParam).toBe('talonId');
    }
    expect(optionsOf(createPOST).targetIdParam).toBeUndefined();
  });

  it('returns the wrapper 401 without touching the store', async () => {
    mockAuthorize.mockResolvedValue(
      NextResponse.json({ status: 401 }, { status: 401 }),
    );

    const res = await listGET(
      createMockRequest(`http://localhost/api/sites/${SITE}/talons`),
      routeParams(),
    );

    expect(res.status).toBe(401);
    expect(mockListTalons).not.toHaveBeenCalled();
  });

  it('returns the wrapper 403 on a mutation without touching the store', async () => {
    mockAuthorize.mockResolvedValue(
      NextResponse.json({ detail: 'capability not granted' }, { status: 403 }),
    );

    const res = await createPOST(
      createMockRequest(`http://localhost/api/sites/${SITE}/talons`, {
        method: 'POST',
        body: talonInput(),
      }),
      routeParams(),
    );

    expect(res.status).toBe(403);
    expect(mockCreateTalon).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/*  GET /api/sites/{siteId}/talons                                            */
/* -------------------------------------------------------------------------- */

describe('GET /api/sites/{siteId}/talons', () => {
  it('serializes the site talons with iso timestamps', async () => {
    mockListTalons.mockResolvedValue([storedTalon()]);

    const res = await listGET(
      createMockRequest(`http://localhost/api/sites/${SITE}/talons`),
      routeParams(),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      talons: Array<Record<string, unknown>>;
    };
    expect(mockListTalons).toHaveBeenCalledWith(expect.anything(), SITE);
    expect(body.talons).toHaveLength(1);
    expect(body.talons[0]).toMatchObject({
      id: TALON,
      name: 'restart td nightly',
      createdAt: CREATED_AT.toISOString(),
      updatedAt: CREATED_AT.toISOString(),
      nextRunAt: null,
      lastRunStatus: null,
      lastRunId: null,
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  POST /api/sites/{siteId}/talons                                           */
/* -------------------------------------------------------------------------- */

describe('POST /api/sites/{siteId}/talons', () => {
  it('creates the talon and returns 201 with the stored document', async () => {
    const res = await createPOST(
      createMockRequest(`http://localhost/api/sites/${SITE}/talons`, {
        method: 'POST',
        body: talonInput(),
      }),
      routeParams(),
    );

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ id: TALON, enabled: true });
    expect(mockCreateTalon).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        siteId: SITE,
        auditActor: 'user:user-1',
        via: 'ui',
        endpoint: `/api/sites/${SITE}/talons`,
        method: 'POST',
        actor: expect.objectContaining({ userId: 'user-1' }),
      }),
      talonInput(),
    );
  });

  it('rejects a core-tier site with 403 tier_insufficient', async () => {
    seedBilling({ siteId: SITE, state: 'active', tier: 'core' });

    const res = await createPOST(
      createMockRequest(`http://localhost/api/sites/${SITE}/talons`, {
        method: 'POST',
        body: talonInput(),
      }),
      routeParams(),
    );

    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe('tier_insufficient');
    expect(mockCreateTalon).not.toHaveBeenCalled();
  });

  it('rejects an expired account with 402 trial_expired', async () => {
    seedBilling({ siteId: SITE, state: 'expired' });

    const res = await createPOST(
      createMockRequest(`http://localhost/api/sites/${SITE}/talons`, {
        method: 'POST',
        body: talonInput(),
      }),
      routeParams(),
    );

    expect(res.status).toBe(402);
    expect(((await res.json()) as { code?: string }).code).toBe('trial_expired');
    expect(mockCreateTalon).not.toHaveBeenCalled();
  });

  it('replays a cached response without re-running the store', async () => {
    mockCheckIdempotency.mockResolvedValue({
      mode: 'replay',
      response: NextResponse.json({ id: TALON }, { status: 201 }),
    });

    const res = await createPOST(
      createMockRequest(`http://localhost/api/sites/${SITE}/talons`, {
        method: 'POST',
        body: talonInput(),
        headers: { 'Idempotency-Key': 'key-1' },
      }),
      routeParams(),
    );

    expect(res.status).toBe(201);
    expect(mockCreateTalon).not.toHaveBeenCalled();
    expect(mockSaveIdempotency).not.toHaveBeenCalled();
  });

  it('caches the 201 when an idempotency key was supplied', async () => {
    mockCheckIdempotency.mockResolvedValue({ mode: 'proceed', token: { key: 'key-1' } });

    const res = await createPOST(
      createMockRequest(`http://localhost/api/sites/${SITE}/talons`, {
        method: 'POST',
        body: talonInput(),
        headers: { 'Idempotency-Key': 'key-1' },
      }),
      routeParams(),
    );

    expect(res.status).toBe(201);
    expect(mockSaveIdempotency).toHaveBeenCalledWith({ key: 'key-1' }, res);
  });

  it('maps a validation rejection to 400 with field errors', async () => {
    mockCreateTalon.mockRejectedValue(
      new TalonStoreError(400, 'invalid_talon', 'give this talon a name (+1 more)', [
        { field: 'name', code: 'missing_field', message: 'give this talon a name' },
        {
          field: 'outputs[0].url',
          code: 'invalid_field',
          message: 'enter a valid https url',
        },
      ]),
    );

    const res = await createPOST(
      createMockRequest(`http://localhost/api/sites/${SITE}/talons`, {
        method: 'POST',
        body: { outputs: [{ type: 'webhook', url: 'nope' }] },
      }),
      routeParams(),
    );

    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    const body = (await res.json()) as {
      code?: string;
      title?: string;
      errors?: Record<string, string[]>;
      fieldErrors?: Array<{ field: string }>;
    };
    expect(body.code).toBe('invalid_talon');
    expect(body.title).toBe('validation failed');
    expect(body.errors).toEqual({
      'body.name': ['give this talon a name'],
      'body.outputs[0].url': ['enter a valid https url'],
    });
    expect(body.fieldErrors).toHaveLength(2);
  });

  it('maps the per-site cap to 409 talon_limit_reached', async () => {
    mockCreateTalon.mockRejectedValue(
      new TalonStoreError(409, 'talon_limit_reached', 'the limit is 20.'),
    );

    const res = await createPOST(
      createMockRequest(`http://localhost/api/sites/${SITE}/talons`, {
        method: 'POST',
        body: talonInput(),
      }),
      routeParams(),
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { code?: string; errors?: unknown };
    expect(body.code).toBe('talon_limit_reached');
    expect(body.errors).toBeUndefined();
  });

  it('maps the command-output privilege gate to 403', async () => {
    mockCreateTalon.mockRejectedValue(
      new TalonStoreError(
        403,
        'command_output_forbidden',
        '`command` outputs may only be authored by a site admin.',
      ),
    );

    const res = await createPOST(
      createMockRequest(`http://localhost/api/sites/${SITE}/talons`, {
        method: 'POST',
        body: talonInput({ outputs: [{ type: 'command', commandType: 'restart_process' }] }),
      }),
      routeParams(),
    );

    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe('command_output_forbidden');
  });
});

/* -------------------------------------------------------------------------- */
/*  GET /api/sites/{siteId}/talons/{talonId}                                  */
/* -------------------------------------------------------------------------- */

describe('GET /api/sites/{siteId}/talons/{talonId}', () => {
  it('returns the talon', async () => {
    const res = await itemGET(
      createMockRequest(`http://localhost/api/sites/${SITE}/talons/${TALON}`),
      routeParams(TALON),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: TALON });
    expect(mockGetTalon).toHaveBeenCalledWith(expect.anything(), SITE, TALON);
  });

  it('404s when the site has no such talon', async () => {
    mockGetTalon.mockResolvedValue(null);

    const res = await itemGET(
      createMockRequest(`http://localhost/api/sites/${SITE}/talons/${TALON}`),
      routeParams(TALON),
    );

    expect(res.status).toBe(404);
  });

  it('400s on a malformed talon id before reading anything', async () => {
    const res = await itemGET(
      createMockRequest(`http://localhost/api/sites/${SITE}/talons/bad%2Fid`),
      routeParams('bad/id'),
    );

    expect(res.status).toBe(400);
    expect(mockGetTalon).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/*  PATCH /api/sites/{siteId}/talons/{talonId}                                */
/* -------------------------------------------------------------------------- */

describe('PATCH /api/sites/{siteId}/talons/{talonId}', () => {
  it('treats an enabled-only body as a toggle', async () => {
    const res = await itemPATCH(
      createMockRequest(`http://localhost/api/sites/${SITE}/talons/${TALON}`, {
        method: 'PATCH',
        body: { enabled: false },
      }),
      routeParams(TALON),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enabled: false });
    expect(mockSetTalonEnabled).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ siteId: SITE, via: 'ui', method: 'PATCH' }),
      TALON,
      false,
    );
    expect(mockUpdateTalon).not.toHaveBeenCalled();
  });

  it('treats any other body as a full update', async () => {
    const body = talonInput({ enabled: true, name: 'renamed' });

    const res = await itemPATCH(
      createMockRequest(`http://localhost/api/sites/${SITE}/talons/${TALON}`, {
        method: 'PATCH',
        body,
      }),
      routeParams(TALON),
    );

    expect(res.status).toBe(200);
    expect(mockUpdateTalon).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ siteId: SITE }),
      TALON,
      body,
    );
    expect(mockSetTalonEnabled).not.toHaveBeenCalled();
  });

  it('does not mistake a non-boolean enabled for a toggle', async () => {
    const res = await itemPATCH(
      createMockRequest(`http://localhost/api/sites/${SITE}/talons/${TALON}`, {
        method: 'PATCH',
        body: { enabled: 'yes' },
      }),
      routeParams(TALON),
    );

    expect(res.status).toBe(200);
    expect(mockSetTalonEnabled).not.toHaveBeenCalled();
    expect(mockUpdateTalon).toHaveBeenCalled();
  });

  it('maps a missing talon to 404 talon_not_found', async () => {
    mockSetTalonEnabled.mockRejectedValue(
      new TalonStoreError(404, 'talon_not_found', 'talon `x` was not found.'),
    );

    const res = await itemPATCH(
      createMockRequest(`http://localhost/api/sites/${SITE}/talons/${TALON}`, {
        method: 'PATCH',
        body: { enabled: true },
      }),
      routeParams(TALON),
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as { code?: string; instance?: string };
    expect(body.code).toBe('talon_not_found');
    expect(body.instance).toBe(`/api/sites/${SITE}/talons/${TALON}`);
  });
});

/* -------------------------------------------------------------------------- */
/*  DELETE /api/sites/{siteId}/talons/{talonId}                               */
/* -------------------------------------------------------------------------- */

describe('DELETE /api/sites/{siteId}/talons/{talonId}', () => {
  it('deletes and answers 204 with no body', async () => {
    const res = await itemDELETE(
      createMockRequest(`http://localhost/api/sites/${SITE}/talons/${TALON}`, {
        method: 'DELETE',
      }),
      routeParams(TALON),
    );

    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(mockDeleteTalon).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ siteId: SITE, method: 'DELETE' }),
      TALON,
    );
  });

  it('answers 404 when the talon is already gone', async () => {
    mockDeleteTalon.mockRejectedValue(
      new TalonStoreError(404, 'talon_not_found', 'talon `x` was not found.'),
    );

    const res = await itemDELETE(
      createMockRequest(`http://localhost/api/sites/${SITE}/talons/${TALON}`, {
        method: 'DELETE',
      }),
      routeParams(TALON),
    );

    expect(res.status).toBe(404);
    expect(((await res.json()) as { code?: string }).code).toBe('talon_not_found');
  });

  it('is not blocked by an expired account — decommissioning stays open', async () => {
    seedBilling({ siteId: SITE, state: 'expired' });

    const res = await itemDELETE(
      createMockRequest(`http://localhost/api/sites/${SITE}/talons/${TALON}`, {
        method: 'DELETE',
      }),
      routeParams(TALON),
    );

    expect(res.status).toBe(204);
    expect(mockDeleteTalon).toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/*  POST /api/sites/{siteId}/talons/reassign                                  */
/* -------------------------------------------------------------------------- */

function reassignRequest(body: Record<string, unknown>) {
  return createMockRequest(`http://localhost/api/sites/${SITE}/talons/reassign`, {
    method: 'POST',
    body,
  });
}

describe('POST /api/sites/{siteId}/talons/reassign', () => {
  it('registers TALON_MANAGE — the same capability that authors a talon', () => {
    expect(optionsOf(reassignPOST)).toMatchObject({
      capability: 'TALON_MANAGE',
      siteIdParam: 'path',
      targetKind: 'talon',
    });
    // No `apiKeyPermission: 'read'` — this is a write.
    expect(optionsOf(reassignPOST).apiKeyPermission).toBeUndefined();
  });

  it('forwards the whole selection in one call', async () => {
    const res = await reassignPOST(
      reassignRequest({ toUid: 'successor-uid', fromUid: 'leaver-uid' }),
      routeParams(),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      toUid: 'successor-uid',
      reassignedTalonIds: [TALON],
      reassignedCount: 1,
    });
    // One store call for the whole departure, not one per talon.
    expect(mockReassignTalons).toHaveBeenCalledTimes(1);
    expect(mockReassignTalons).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ siteId: SITE, via: 'ui', method: 'POST' }),
      'successor-uid',
      { fromUid: 'leaver-uid' },
    );
  });

  it('passes an explicit talon list through untouched', async () => {
    await reassignPOST(
      reassignRequest({ toUid: 'successor-uid', talonIds: [TALON] }),
      routeParams(),
    );

    expect(mockReassignTalons).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'successor-uid',
      { talonIds: [TALON] },
    );
  });

  it('rejects a body with no successor before touching the store', async () => {
    const res = await reassignPOST(reassignRequest({ fromUid: 'leaver-uid' }), routeParams());

    expect(res.status).toBe(400);
    expect(mockReassignTalons).not.toHaveBeenCalled();
  });

  it('rejects a non-array talonIds', async () => {
    const res = await reassignPOST(
      reassignRequest({ toUid: 'successor-uid', talonIds: TALON }),
      routeParams(),
    );

    expect(res.status).toBe(400);
    expect(mockReassignTalons).not.toHaveBeenCalled();
  });

  it('renders a refused successor as problem+json, not a 500', async () => {
    mockReassignTalons.mockRejectedValue(
      new TalonStoreError(400, 'successor_invalid', 'the successor is a deleted account.'),
    );

    const res = await reassignPOST(
      reassignRequest({ toUid: 'ghost-uid', fromUid: 'leaver-uid' }),
      routeParams(),
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.code).toBe('successor_invalid');
    expect(body.title).toBe('invalid successor');
  });

  it('replays an idempotent retry without calling the store twice', async () => {
    mockCheckIdempotency.mockResolvedValue({
      mode: 'replay',
      response: NextResponse.json({ replayed: true }),
    });

    const res = await reassignPOST(
      reassignRequest({ toUid: 'successor-uid', fromUid: 'leaver-uid' }),
      routeParams(),
    );

    expect(await res.json()).toEqual({ replayed: true });
    expect(mockReassignTalons).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/*  GET /api/sites/{siteId}/talons/authored                                   */
/* -------------------------------------------------------------------------- */

describe('GET /api/sites/{siteId}/talons/authored', () => {
  it('takes read-class api-key scope, like listing talons', () => {
    expect(optionsOf(authoredGET)).toMatchObject({
      capability: 'TALON_MANAGE',
      apiKeyPermission: 'read',
    });
  });

  it('returns the count and names of what the departing member wrote', async () => {
    mockListTalonsAuthoredBy.mockResolvedValue([
      { id: 't1', name: 'nightly restart', enabled: true, createdBy: 'leaver-uid' },
      { id: 't2', name: 'morning check', enabled: false, createdBy: 'leaver-uid' },
    ]);

    const res = await authoredGET(
      createMockRequest(
        `http://localhost/api/sites/${SITE}/talons/authored?uid=leaver-uid`,
      ),
      routeParams(),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      siteId: SITE,
      uid: 'leaver-uid',
      count: 2,
      // Names only — the preview must not become a second way to read a talon.
      talons: [
        { id: 't1', name: 'nightly restart', enabled: true },
        { id: 't2', name: 'morning check', enabled: false },
      ],
    });
    expect(mockListTalonsAuthoredBy).toHaveBeenCalledWith(
      expect.anything(),
      SITE,
      'leaver-uid',
    );
  });

  it('rejects a missing uid', async () => {
    const res = await authoredGET(
      createMockRequest(`http://localhost/api/sites/${SITE}/talons/authored`),
      routeParams(),
    );

    expect(res.status).toBe(400);
    expect(mockListTalonsAuthoredBy).not.toHaveBeenCalled();
  });

  it('rejects a uid that would escape the document path', async () => {
    const res = await authoredGET(
      createMockRequest(
        `http://localhost/api/sites/${SITE}/talons/authored?uid=${encodeURIComponent('../escape')}`,
      ),
      routeParams(),
    );

    expect(res.status).toBe(400);
    expect(mockListTalonsAuthoredBy).not.toHaveBeenCalled();
  });
});

/* keep the shared firestore mock honest about what these tests seeded */
afterAll(() => {
  mocks.siteDocs.clear();
  mocks.customerDocs.clear();
});
