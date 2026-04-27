import { NextResponse, type NextRequest } from 'next/server';

type Params = Record<string, string | undefined>;
type RouteContext<TParams extends Params = Params> = { params: Promise<TParams> };
type HandlerContext = {
  actor: { type: 'user'; userId: string; role: 'superadmin'; sites: string[] };
  siteId: string;
  correlationId: string;
  auth: { userId: string; keyContext: null };
  scopeCheck: { isLegacy: false };
};

type SiteHandler<TParams extends Params = Params> = (
  request: NextRequest,
  ctx: HandlerContext,
  routeContext: RouteContext<TParams>,
) => Promise<NextResponse> | NextResponse;

type PlatformHandler<TParams extends Params = Params> = (
  request: NextRequest,
  ctx: Omit<HandlerContext, 'siteId'>,
  routeContext?: RouteContext<TParams>,
) => Promise<NextResponse> | NextResponse;

type HandlerOptions = {
  deprecated?: boolean;
  canonicalUrl?: string;
  sunsetDate?: string;
};

function withDeprecationHeaders<T extends NextResponse>(
  response: T,
  options: HandlerOptions,
): T {
  if (!options.deprecated) return response;
  response.headers.set('deprecation', 'true');
  if (options.sunsetDate) response.headers.set('sunset', options.sunsetDate);
  if (options.canonicalUrl) {
    response.headers.append('link', `<${options.canonicalUrl}>; rel="successor-version"`);
  }
  return response;
}

function errorResponse(err: unknown): NextResponse {
  const status = typeof (err as { status?: unknown })?.status === 'number'
    ? (err as { status: number }).status
    : 500;
  const message = err instanceof Error ? err.message : 'Internal Server Error';
  return NextResponse.json({ error: message }, { status });
}

function normalizeUserId(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof (value as { userId?: unknown }).userId === 'string') {
    return (value as { userId: string }).userId;
  }
  return 'test-admin';
}

function makeSiteContext(userId: string, siteId: string): HandlerContext {
  return {
    actor: { type: 'user', userId, role: 'superadmin', sites: siteId ? [siteId] : [] },
    siteId,
    correlationId: 'test-correlation-id',
    auth: { userId, keyContext: null },
    scopeCheck: { isLegacy: false },
  };
}

function routeContextFromPath<TParams extends Params>(
  request: NextRequest,
  routeContext?: RouteContext<TParams>,
): RouteContext<TParams> {
  if (routeContext) return routeContext;
  const segments = request.nextUrl.pathname.split('/').filter(Boolean);
  const params: Params = {};
  const markers: Record<string, string> = {
    deployments: 'deploymentId',
    processes: 'processId',
    webhooks: 'webhookId',
    installer: 'version',
    'system-presets': 'presetId',
  };
  for (const [marker, paramName] of Object.entries(markers)) {
    const idx = segments.indexOf(marker);
    if (idx >= 0 && segments[idx + 1]) params[paramName] = decodeURIComponent(segments[idx + 1]);
  }
  return { params: Promise.resolve(params as TParams) };
}

async function bodySiteId(request: NextRequest, field = 'siteId'): Promise<string> {
  try {
    const raw = await request.clone().text();
    if (!raw) return '';
    const body = JSON.parse(raw) as Record<string, unknown>;
    const value = body[field];
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

function requireOptionalMock(moduleName: string): Record<string, unknown> | null {
  try {
    return jest.requireMock(moduleName) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function authorizeSite(request: NextRequest, siteId: string): Promise<string> {
  const helpers = requireOptionalMock('@/lib/apiHelpers.server');
  const requireAdminWithSiteAccess = helpers?.requireAdminWithSiteAccess;
  if (typeof requireAdminWithSiteAccess === 'function') {
    return normalizeUserId(await requireAdminWithSiteAccess(request, siteId));
  }

  const apiAuth = requireOptionalMock('@/lib/apiAuth.server');
  const requireAdminOrIdToken = apiAuth?.requireAdminOrIdToken;
  const assertUserHasSiteAccess = apiAuth?.assertUserHasSiteAccess;
  if (typeof requireAdminOrIdToken === 'function') {
    const userId = normalizeUserId(await requireAdminOrIdToken(request));
    if (siteId && typeof assertUserHasSiteAccess === 'function') {
      await assertUserHasSiteAccess(userId, siteId);
    }
    return userId;
  }

  return 'test-admin';
}

async function authorizePlatform(request: NextRequest): Promise<string> {
  const apiAuth = requireOptionalMock('@/lib/apiAuth.server');
  const requireAdminOrIdToken = apiAuth?.requireAdminOrIdToken ?? apiAuth?.requireAdmin;
  if (typeof requireAdminOrIdToken === 'function') {
    return normalizeUserId(await requireAdminOrIdToken(request));
  }
  return 'test-admin';
}

export function authorizedSiteHandler<TParams extends Params = Params>(options: HandlerOptions & {
  siteIdParam?: 'path' | 'query';
}) {
  return function wrap(handler: SiteHandler<TParams>) {
    return async function authorizedRoute(
      request: NextRequest,
      routeContext?: RouteContext<TParams>,
    ): Promise<NextResponse> {
      try {
        const context = routeContextFromPath(request, routeContext);
        const params = await context.params;
        const siteId = options.siteIdParam === 'path'
          ? params.siteId ?? ''
          : request.nextUrl.searchParams.get('siteId') ?? '';
        if (!siteId) {
          return NextResponse.json(
            { error: `siteId missing from ${options.siteIdParam ?? 'query'}` },
            { status: 400 },
          );
        }
        const userId = await authorizeSite(request, siteId);
        const response = await handler(request, makeSiteContext(userId, siteId), context);
        return withDeprecationHeaders(response, options);
      } catch (err) {
        return errorResponse(err);
      }
    };
  };
}

export function authorizedLegacyBodySiteHandler<TParams extends Params = Params>(
  options: HandlerOptions & { siteIdField?: string },
) {
  return function wrap(handler: SiteHandler<TParams>) {
    return async function legacyBodySiteRoute(
      request: NextRequest,
      routeContext?: RouteContext<TParams>,
    ): Promise<NextResponse> {
      try {
        const querySiteId = request.nextUrl.searchParams.get('siteId') ?? '';
        const siteId = querySiteId || await bodySiteId(request, options.siteIdField);
        const userId = await authorizeSite(request, siteId);
        const response = await handler(
          request,
          makeSiteContext(userId, siteId),
          routeContextFromPath(request, routeContext),
        );
        return withDeprecationHeaders(response, options);
      } catch (err) {
        return errorResponse(err);
      }
    };
  };
}

export function authorizedPlatformHandler<TParams extends Params = Params>(options: HandlerOptions) {
  return function wrap(handler: PlatformHandler<TParams>) {
    return async function authorizedRoute(
      request: NextRequest,
      routeContext?: RouteContext<TParams>,
    ): Promise<NextResponse> {
      try {
        const userId = await authorizePlatform(request);
        const siteContext = makeSiteContext(userId, '');
        const { siteId: _siteId, ...ctx } = siteContext;
        void _siteId;
        const response = await handler(request, ctx, routeContextFromPath(request, routeContext));
        return withDeprecationHeaders(response, options);
      } catch (err) {
        return errorResponse(err);
      }
    };
  };
}
