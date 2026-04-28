/** @jest-environment node */

import { NextRequest } from 'next/server';
import { createMockRequest } from './helpers/utils';

let mockAuthorizedOptions: unknown[];
let mockRouteAuthContext: {
  userId: string;
  keyContext: { keyId: string; environment: 'live' | 'test' } | null;
};
const mockSetDisplayLayout = jest.fn();
const mockClearDisplayLayout = jest.fn();

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock('@/lib/withRateLimit', () => ({
  withRateLimit: <H,>(handler: H): H => handler,
}));

jest.mock('@/lib/idempotency', () => ({
  withIdempotency: async (
    request: Request,
    _ctx: unknown,
    _rawBody: string,
    handler: () => Promise<Response>,
    options?: { requireKey?: boolean },
  ) => {
    if (options?.requireKey && !request.headers.get('Idempotency-Key')) {
      const { NextResponse } = jest.requireActual('next/server');
      return NextResponse.json(
        {
          type: 'https://owlette.app/problems/validation-failed',
          title: 'idempotency key required',
          status: 400,
          code: 'idempotency_key_required',
          detail: 'Idempotency-Key is required for this mutation',
        },
        { status: 400, headers: { 'content-type': 'application/problem+json' } },
      );
    }
    return handler();
  },
}));

jest.mock('@/lib/authorizedHandler.server', () => ({
  authorizedSiteHandler: (options: unknown) => {
    mockAuthorizedOptions ??= [];
    mockAuthorizedOptions.push(options);
    return (handler: (...args: unknown[]) => unknown) =>
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
            auth: mockRouteAuthContext,
            scopeCheck: { isLegacy: false },
          },
          routeContext,
        );
      };
  },
}));

jest.mock('@/lib/actions/setDisplayLayout.server', () => ({
  setDisplayLayout: (...args: unknown[]) => mockSetDisplayLayout(...args),
}));

jest.mock('@/lib/actions/clearDisplayLayout.server', () => ({
  clearDisplayLayout: (...args: unknown[]) => mockClearDisplayLayout(...args),
}));

jest.mock('@/lib/actions/createProcess.server', () => {
  class ActionInputError extends Error {
    status: number;
    code: string;

    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }

  return { ActionInputError };
});

import {
  DELETE,
  PUT,
} from '@/app/api/sites/[siteId]/machines/[machineId]/display-layout/route';

const SITE = 'site-alpha';
const MACHINE = 'mach-1';

function routeContext() {
  return { params: Promise.resolve({ siteId: SITE, machineId: MACHINE }) };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRouteAuthContext = { userId: 'admin-uid', keyContext: null };
  mockSetDisplayLayout.mockResolvedValue({ machineId: MACHINE, op: 'capture' });
  mockClearDisplayLayout.mockResolvedValue({ machineId: MACHINE });
});

describe('/api/sites/{siteId}/machines/{machineId}/display-layout', () => {
  it('is wrapped as a machine config write surface', () => {
    expect(mockAuthorizedOptions).toContainEqual(
      expect.objectContaining({
        capability: 'MACHINE_CONFIG_WRITE',
        targetKind: 'machine',
        targetIdParam: 'machineId',
        apiKeyScope: { resource: 'machine', idParam: 'machineId', permission: 'write' },
      }),
    );
  });

  it('PUT capture forwards the assigned layout input', async () => {
    const monitors = [{ id: 'primary', primary: true, position: { x: 0, y: 0 } }];
    const res = await PUT(
      createMockRequest(
        `http://localhost/api/sites/${SITE}/machines/${MACHINE}/display-layout`,
        {
          method: 'PUT',
          headers: { 'Idempotency-Key': 'idem-capture-layout' },
          body: { op: 'capture', monitors, capturedBy: 'alice@acme.com' },
        },
      ),
      routeContext(),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      data: { machineId: MACHINE, op: 'capture' },
    });
    expect(mockSetDisplayLayout).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: SITE, auditActor: 'user:admin-uid' }),
      {
        machineId: MACHINE,
        op: 'capture',
        monitors,
        capturedBy: 'alice@acme.com',
      },
    );
  });

  it('PUT requires Idempotency-Key before mutating layout state', async () => {
    const res = await PUT(
      createMockRequest(
        `http://localhost/api/sites/${SITE}/machines/${MACHINE}/display-layout`,
        {
          method: 'PUT',
          body: { op: 'set_remote_apply', enabled: true },
        },
      ),
      routeContext(),
    );

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('idempotency_key_required');
    expect(mockSetDisplayLayout).not.toHaveBeenCalled();
  });

  it('PUT set_remote_apply requires a boolean enabled value', async () => {
    const res = await PUT(
      createMockRequest(
        `http://localhost/api/sites/${SITE}/machines/${MACHINE}/display-layout`,
        {
          method: 'PUT',
          headers: { 'Idempotency-Key': 'idem-remote-missing' },
          body: { op: 'set_remote_apply' },
        },
      ),
      routeContext(),
    );

    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(res.headers.get('x-request-id')).toBeTruthy();
    const body = await res.json();
    expect(body.code).toBe('invalid_enabled');
    expect(body.requestId).toBeTruthy();
    expect(body.docsUrl).toContain('#invalid_enabled');
    expect(mockSetDisplayLayout).not.toHaveBeenCalled();
  });

  it('PUT set_remote_apply forwards API-key audit identity', async () => {
    mockRouteAuthContext = {
      userId: 'admin-uid',
      keyContext: { keyId: 'key-live-1', environment: 'live' },
    };
    mockSetDisplayLayout.mockResolvedValue({ machineId: MACHINE, op: 'set_remote_apply' });

    const res = await PUT(
      createMockRequest(
        `http://localhost/api/sites/${SITE}/machines/${MACHINE}/display-layout`,
        {
          method: 'PUT',
          headers: { 'Idempotency-Key': 'idem-remote-enable' },
          body: { op: 'set_remote_apply', enabled: true },
        },
      ),
      routeContext(),
    );

    expect(res.status).toBe(200);
    expect(mockSetDisplayLayout).toHaveBeenCalledWith(
      expect.objectContaining({ auditActor: 'apiKey:key-live-1' }),
      { machineId: MACHINE, op: 'set_remote_apply', enabled: true },
    );
  });

  it('PUT rejects non-object JSON bodies', async () => {
    const res = await PUT(
      new NextRequest(
        `http://localhost/api/sites/${SITE}/machines/${MACHINE}/display-layout`,
        {
          method: 'PUT',
          headers: {
            'content-type': 'application/json',
            'Idempotency-Key': 'idem-invalid-body',
          },
          body: 'null',
        },
      ),
      routeContext(),
    );

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_body');
    expect(mockSetDisplayLayout).not.toHaveBeenCalled();
  });

  it('DELETE clears the assigned layout', async () => {
    const res = await DELETE(
      createMockRequest(
        `http://localhost/api/sites/${SITE}/machines/${MACHINE}/display-layout`,
        { method: 'DELETE', headers: { 'Idempotency-Key': 'idem-clear-layout' } },
      ),
      routeContext(),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { machineId: MACHINE } });
    expect(mockClearDisplayLayout).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: SITE, auditActor: 'user:admin-uid' }),
      { machineId: MACHINE },
    );
  });
});
