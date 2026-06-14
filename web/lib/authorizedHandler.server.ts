/**
 * authorized handler wrappers (security-boundary-migration wave 2.1).
 *
 * Two wrappers replace the ad-hoc `requireAdminOrIdToken` + manual
 * `assertUserHasSiteAccess` + manual scope/audit/rate-limit pattern that
 * scattered across legacy api routes:
 *
 *   - `authorizedSiteHandler({ capability, siteIdParam })(handler)`
 *   - `authorizedPlatformHandler({ capability })(handler)`
 *
 * Both run a fixed pipeline before the handler is invoked:
 *
 *   1. resolveAuth — produces a UserActor (api-key or session/id-token)
 *   2. site access (site wrapper only) — assertUserHasSiteAccess
 *   3. read kill-switch state — securityConfig.read()
 *   4. api-key scope check — ALWAYS runs; never bypassed by kill switch.
 *      The confused-deputy bug we're guarding against is exactly the one
 *      where a downgraded key would gain elevated effective rights when
 *      capability enforcement is off; api-key scope is the resilient line.
 *   5. capability check — runs unless `capability_enforcement === false`.
 *      Bypass is logged into the audit row metadata so every privileged
 *      action retains a trail even when the kill switch is active.
 *   6. rate-limit check — runs unless `rate_limit_enforcement === false`.
 *      Bypass is logged the same way.
 *   7. allow audit — written *blocking*. If the audit row cannot be
 *      committed we return 503 and DO NOT call the handler. (Deny and
 *      error audits remain best-effort: those don't grant access.)
 *   8. handler invocation with `{ actor, siteId, correlationId }`
 *   9. handler error -> error audit (best-effort) + re-throw
 *
 * `siteIdParam: 'body'` is intentionally NOT supported — the path/query
 * union is a typescript literal-union so attempts to pass `'body'` or any
 * other source are rejected at compile time. siteId-from-body is the
 * confused-deputy attack surface we're closing.
 */

import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import {
  ApiAuthError,
  resolveAuth,
  requireScope,
  assertUserHasSiteAccess,
  type ResolvedAuth,
  type ScopeCheckResult,
} from '@/lib/apiAuth.server';
import {
  problem,
  problemForbidden,
  problemNotFound,
  problemRateLimited,
  problemScopeInsufficient,
  problemTokenExpired,
  problemUnauthorized,
  ProblemType,
} from '@/lib/apiErrors';
import {
  type Actor,
  type Capability,
  type Role,
  type UserActor,
  hasCapability,
} from '@/lib/capabilities';
import {
  generateCorrelationId,
  writeAuditEntry,
  writeAuditEntryBlocking,
  type AuditEntryInput,
  type AuditTarget,
  type AuditTargetKind,
} from '@/lib/auditLog.server';
import type { ApiKeyPermission, ApiKeyResource } from '@/lib/apiKeyTypes';
import {
  checkRateLimit,
  rateLimitHeaders,
  type RateLimitResult,
} from '@/lib/rateLimit.server';
import { securityConfig } from '@/lib/securityConfig.server';
import { getAdminDb } from '@/lib/firebase-admin';
import logger from '@/lib/logger';
import { emitSecurityBoundaryMetric } from '@/lib/securityBoundaryMetrics.server';

/* -------------------------------------------------------------------------- */
/*  public types                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Source of `siteId` for site-scoped routes. `'body'` is intentionally
 * absent — including it is a build error.
 */
export type SiteIdSource = 'path' | 'query';

export interface SiteHandlerContext {
  actor: UserActor;
  siteId: string;
  correlationId: string;
  auth: ResolvedAuth;
  scopeCheck: ScopeCheckResult;
}

export interface PlatformHandlerContext {
  actor: UserActor;
  correlationId: string;
  auth: ResolvedAuth;
  scopeCheck: ScopeCheckResult;
}

export interface SiteHandlerOptions {
  capability: Capability;
  siteIdParam: SiteIdSource;
  /**
   * Audit `target.kind`. Defaults to `'site'`. Routes that operate on a
   * specific machine / deployment / etc. should pass the matching kind so
   * the audit row groups correctly.
   */
  targetKind?: AuditTargetKind;
  /**
   * Dynamic route param to use as the audit target id. Defaults to the
   * resolved siteId. Machine/process routes should pass their nested resource
   * param so audit rows point at the mutated resource, not just the site.
   */
  targetIdParam?: string;
  /**
   * API-key permission required when an api-key is the calling auth.
   * Sessions and id-tokens bypass scope checks. Defaults to `'write'`,
   * which is the right answer for every mutation-class capability we
   * currently support; routes that need read-class scope should pass
   * `'read'` explicitly.
   */
  apiKeyPermission?: ApiKeyPermission;
  /**
   * API-key scope to enforce. Defaults to `site={siteId}:<permission>`.
   * Nested public routes can preserve their pre-migration contract by
   * checking a route-param-backed resource, for example
   * `machine={machineId}:write`.
   */
  apiKeyScope?: {
    resource: ApiKeyResource;
    idParam?: string;
    id?: string;
    permission?: ApiKeyPermission;
  };
}

export interface PlatformHandlerOptions {
  capability: Capability;
  targetKind?: AuditTargetKind;
  /**
   * API-key scope that callers must hold to invoke this route. Sessions
   * and id-token auth bypass scope (consistent with `requireScope`); only
   * api-key callers are gated. Defaults to `{ resource: 'user', permission: 'admin' }`
   * which any superadmin-grade key will hold.
   */
  apiKeyScope?: { resource: ApiKeyResource; permission: ApiKeyPermission };
}

export type SiteRouteHandler<TParams = Record<string, string | undefined>> = (
  request: NextRequest,
  ctx: SiteHandlerContext,
  routeContext: { params: Promise<TParams> },
) => Promise<NextResponse> | NextResponse;

export type PlatformRouteHandler<TParams = Record<string, string | undefined>> = (
  request: NextRequest,
  ctx: PlatformHandlerContext,
  routeContext?: { params: Promise<TParams> },
) => Promise<NextResponse> | NextResponse;

/* -------------------------------------------------------------------------- */
/*  shared helpers                                                            */
/* -------------------------------------------------------------------------- */

function authToActor(auth: ResolvedAuth, role: Role, sites: string[]): UserActor {
  return {
    type: 'user',
    userId: auth.userId,
    ...(auth.keyContext ? { apiKeyId: auth.keyContext.keyId } : {}),
    role,
    sites,
  };
}

async function loadUserActor(auth: ResolvedAuth): Promise<UserActor> {
  const db = getAdminDb();
  const userDoc = await db.collection('users').doc(auth.userId).get();
  const data = userDoc.exists ? userDoc.data() ?? null : null;
  if (!data || typeof data.deletedAt === 'number') {
    throw new ApiAuthError(403, 'Forbidden: User is deleted or inactive', {
      code: 'user_inactive',
    });
  }
  const rawRole = data?.role;
  const role: Role = rawRole === 'superadmin' || rawRole === 'admin' ? rawRole : 'member';
  const sites = Array.isArray(data?.sites)
    ? (data?.sites as unknown[]).filter((s): s is string => typeof s === 'string')
    : [];
  return authToActor(auth, role, sites);
}

function authErrorToResponse(err: ApiAuthError): NextResponse {
  if (err.code === 'token_expired') {
    const expiredAt = typeof err.details?.expiredAt === 'number' ? err.details.expiredAt : undefined;
    return problemTokenExpired(expiredAt);
  }
  if (err.code === 'scope_insufficient') {
    const d = err.details as { resource?: string; id?: string; permission?: string } | undefined;
    return problemScopeInsufficient(err.message, {
      resource: d?.resource ?? 'unknown',
      id: d?.id ?? 'unknown',
      permission: d?.permission ?? 'unknown',
    });
  }
  if (err.status === 401) return problemUnauthorized(err.message);
  if (err.status === 403) return problemForbidden(err.message);
  if (err.status === 404) return problemNotFound(err.message);
  return problem({
    type: ProblemType.Internal,
    title: 'authorization error',
    status: err.status,
    detail: err.message,
  });
}

function serviceUnavailable(detail: string, instance?: string): NextResponse {
  return problem({
    type: ProblemType.ServiceUnavailable,
    title: 'service unavailable',
    status: 503,
    detail,
    ...(instance ? { instance } : {}),
  });
}

function denyAudit(
  siteId: string,
  entry: AuditEntryInput,
): void {
  // Deny / error audits are best-effort. A failed audit here does not
  // change the response we already decided to send.
  writeAuditEntry(siteId, entry);
}

/**
 * Platform audit writer. Audit rows for platform-scoped routes live at
 * `global/audit_log/{entryId}` rather than under `sites/{siteId}/...`.
 * This is a thin firestore-direct writer because `auditLog.server.ts`
 * currently only knows about the site-scoped path; collapsing the two
 * write surfaces is wave 1.3 follow-up work.
 */
async function writePlatformAuditBlocking(entry: AuditEntryInput): Promise<void> {
  const db = getAdminDb();
  const docRef = db.collection('global').doc('audit_log').collection('entries').doc();
  if (entry.enforcementBypassed) {
    logger.warn('authorization enforcement bypassed (platform)', {
      context: 'authorizedHandler',
      data: {
        correlationId: entry.correlationId,
        capability: entry.capability,
        outcome: entry.outcome,
        target: entry.target,
        metadata: entry.metadata,
      },
    });
    emitSecurityBoundaryMetric('authorization_enforcement_bypass_total', 1, {
      severity: 'warning',
      labels: {
        site: '__platform__',
        capability: entry.capability,
        outcome: entry.outcome,
        role: auditActorRoleLabel(entry.actor),
        bypass: String(entry.metadata?.enforcement_bypassed ?? 'unknown'),
      },
      fields: {
        correlationId: entry.correlationId,
        target: entry.target,
      },
    });
  }
  const payload: Record<string, unknown> = {
    correlationId: entry.correlationId,
    actor: entry.actor,
    capability: entry.capability,
    target: entry.target,
    outcome: entry.outcome,
    timestamp: FieldValue.serverTimestamp(),
  };
  if (entry.metadata !== undefined) payload.metadata = entry.metadata;
  if (entry.denyReason !== undefined) payload.denyReason = entry.denyReason;
  if (entry.errorCode !== undefined) payload.errorCode = entry.errorCode;
  if (entry.enforcementBypassed !== undefined) {
    payload.enforcementBypassed = entry.enforcementBypassed;
  }
  try {
    await docRef.set(payload);
  } catch (err) {
    emitSecurityBoundaryMetric('audit_write_failures_total', 1, {
      severity: 'error',
      labels: {
        site: '__platform__',
        capability: entry.capability,
        outcome: entry.outcome,
        role: auditActorRoleLabel(entry.actor),
      },
      fields: {
        correlationId: entry.correlationId,
        error: err instanceof Error ? err.message : String(err),
      },
    });
    throw err;
  }
  emitSecurityBoundaryMetric('capability_decision_total', 1, {
    labels: {
      outcome: entry.outcome,
      capability: entry.capability,
      role: auditActorRoleLabel(entry.actor),
      site: '__platform__',
    },
    fields: {
      correlationId: entry.correlationId,
      target: entry.target,
      denyReason: entry.denyReason,
      errorCode: entry.errorCode,
      enforcementBypassed: entry.enforcementBypassed,
    },
  });
}

function platformDenyAudit(entry: AuditEntryInput): void {
  void writePlatformAuditBlocking(entry).catch((err) => {
    logger.error('platform audit log write failed (fire-and-forget)', {
      context: 'authorizedHandler',
      data: {
        correlationId: entry.correlationId,
        capability: entry.capability,
        outcome: entry.outcome,
        err: err instanceof Error ? err.message : String(err),
      },
    });
  });
}

// Firestore reserves document ids matching `__.*__`; platform routes still
// need a stable bucket for rate-limit counters, so use a non-reserved id.
const PLATFORM_RATE_LIMIT_SITE_ID = 'platform_global';

function auditActorRoleLabel(actor: AuditEntryInput['actor']): string {
  if (actor.type === 'system') return `system:${actor.name}`;
  return actor.apiKeyId ? `api-key:${actor.role}` : actor.role;
}

function headersForRateLimit(result: RateLimitResult): Record<string, string> {
  return typeof rateLimitHeaders === 'function' ? rateLimitHeaders(result) : {};
}

/* -------------------------------------------------------------------------- */
/*  site-scoped wrapper                                                       */
/* -------------------------------------------------------------------------- */

function extractSiteIdFromRequest(
  request: NextRequest,
  source: SiteIdSource,
  paramsPromise: Promise<Record<string, string | undefined>> | undefined,
): Promise<string | null> {
  if (source === 'query') {
    const v = request.nextUrl.searchParams.get('siteId');
    return Promise.resolve(v && v.length > 0 ? v : null);
  }
  // 'path' — pull from Next.js dynamic route params (always Promise in Next 16).
  if (!paramsPromise) return Promise.resolve(null);
  return paramsPromise.then((params) => {
    const v = params?.siteId;
    return typeof v === 'string' && v.length > 0 ? v : null;
  });
}

async function extractRouteParam(
  paramsPromise: Promise<Record<string, string | undefined>> | undefined,
  paramName: string,
): Promise<string | null> {
  if (!paramsPromise) return null;
  const params = await paramsPromise;
  const value = params?.[paramName];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function extractRouteParamFromPath(request: NextRequest, paramName: string): string | null {
  const segments = request.nextUrl.pathname.split('/').filter(Boolean);
  const markerByParam: Record<string, string> = {
    deploymentId: 'deployments',
    processId: 'processes',
    presetId: 'system-presets',
    version: 'installer',
    webhookId: 'webhooks',
  };
  const marker = markerByParam[paramName];
  if (!marker) return null;
  const idx = segments.indexOf(marker);
  const value = idx >= 0 ? segments[idx + 1] : null;
  return value ? decodeURIComponent(value) : null;
}

/**
 * Site-scoped authorized handler. Use for any route that operates on a
 * single site (and any nested resource under it).
 *
 * `siteIdParam` MUST be `'path'` or `'query'`. Passing `'body'` is a
 * compile error: the type-system rejection is the deliberate guard
 * against the confused-deputy bug where a caller supplies a siteId in
 * the body that doesn't match the URL.
 */
export function authorizedSiteHandler<TParams extends Record<string, string | undefined> = Record<string, string | undefined>>(
  options: SiteHandlerOptions,
) {
  return function wrap(handler: SiteRouteHandler<TParams>) {
    return async function authorizedRoute(
      request: NextRequest,
      routeContext?: { params: Promise<TParams> },
    ): Promise<NextResponse> {
      const correlationId = generateCorrelationId();
      let actor: UserActor | null = null;
      let siteId = '';
      const targetKind: AuditTargetKind = options.targetKind ?? 'site';
      const routeParamsPromise = (routeContext?.params ?? Promise.resolve({} as TParams)) as Promise<Record<string, string | undefined>>;

      // 1. Resolve auth.
      let auth: ResolvedAuth;
      try {
        auth = await resolveAuth(request);
      } catch (err) {
        if (err instanceof ApiAuthError) return authErrorToResponse(err);
        throw err;
      }

      // 2. Resolve siteId from path/query (NEVER body).
      const resolvedSiteId = await extractSiteIdFromRequest(
        request,
        options.siteIdParam,
        routeParamsPromise,
      );
      if (!resolvedSiteId) {
        return problem({
          type: ProblemType.ValidationFailed,
          title: 'validation failed',
          status: 400,
          detail: `siteId missing from ${options.siteIdParam}`,
        });
      }
      siteId = resolvedSiteId;

      const targetId = options.targetIdParam
        ? (await extractRouteParam(routeParamsPromise, options.targetIdParam))
          ?? extractRouteParamFromPath(request, options.targetIdParam)
        : siteId;
      if (!targetId) {
        return problem({
          type: ProblemType.ValidationFailed,
          title: 'validation failed',
          status: 400,
          detail: `${options.targetIdParam ?? 'target id'} missing from path`,
        });
      }

      const apiKeyScopeId = options.apiKeyScope?.id
        ?? (options.apiKeyScope?.idParam
          ? (await extractRouteParam(routeParamsPromise, options.apiKeyScope.idParam))
            ?? extractRouteParamFromPath(request, options.apiKeyScope.idParam)
          : siteId);
      if (!apiKeyScopeId) {
        return problem({
          type: ProblemType.ValidationFailed,
          title: 'validation failed',
          status: 400,
          detail: `${options.apiKeyScope?.idParam ?? 'api key scope id'} missing from path`,
        });
      }

      // 3. Site access check.
      try {
        await assertUserHasSiteAccess(auth.userId, siteId);
      } catch (err) {
        if (err instanceof ApiAuthError) {
          if (err.code === 'user_inactive') {
            return authErrorToResponse(err);
          }
          // Don't leak existence: 403/404 both collapse to "not found or no access".
          if (err.status === 404 || err.status === 403) {
            return problemNotFound('site not found or no access');
          }
          return authErrorToResponse(err);
        }
        throw err;
      }

      // 4. Build user actor (role + sites).
      try {
        actor = await loadUserActor(auth);
      } catch (err) {
        if (err instanceof ApiAuthError) return authErrorToResponse(err);
        logger.error('[authorizedSiteHandler] failed to load user actor', {
          context: 'authorizedHandler',
          data: { err: err instanceof Error ? err.message : String(err) },
        });
        return serviceUnavailable('could not load user record');
      }

      // 5. Read kill-switch config.
      const config = await securityConfig.read();

      // 6. API-key scope check — ALWAYS runs (never bypassed).
      let scopeCheck: ScopeCheckResult;
      try {
        scopeCheck = requireScope(
          auth,
          options.apiKeyScope?.resource ?? 'site',
          apiKeyScopeId,
          options.apiKeyScope?.permission ?? options.apiKeyPermission ?? 'write',
        );
      } catch (err) {
        if (err instanceof ApiAuthError) {
          denyAudit(siteId, {
            correlationId,
            actor,
            capability: options.capability,
            target: { kind: targetKind, id: targetId } as AuditTarget,
            outcome: 'deny',
            denyReason: 'scope_insufficient',
            metadata: { route: request.nextUrl.pathname, method: request.method },
          });
          return authErrorToResponse(err);
        }
        throw err;
      }

      // 7. Capability check — bypassable.
      const enforcementBypassed: 'capability' | 'rate_limit' | undefined = !config.capability_enforcement
        ? 'capability'
        : undefined;
      if (config.capability_enforcement) {
        const ok = hasCapability(actor as Actor, options.capability, siteId);
        if (!ok) {
          denyAudit(siteId, {
            correlationId,
            actor,
            capability: options.capability,
            target: { kind: targetKind, id: targetId } as AuditTarget,
            outcome: 'deny',
            denyReason: 'capability_missing',
            metadata: { route: request.nextUrl.pathname, method: request.method },
          });
          return problemForbidden('capability not granted');
        }
      }

      // 8. Rate-limit check — bypassable.
      let rateLimitBypassed = false;
      let rateLimitResult: RateLimitResult | null = null;
      if (config.rate_limit_enforcement) {
        const rl = await checkRateLimit(actor as Actor, options.capability, siteId);
        rateLimitResult = rl;
        if (!rl.ok) {
          denyAudit(siteId, {
            correlationId,
            actor,
            capability: options.capability,
            target: { kind: targetKind, id: targetId } as AuditTarget,
            outcome: 'deny',
            denyReason: 'rate_limited',
            metadata: {
              route: request.nextUrl.pathname,
              method: request.method,
              retryAfterSec: rl.retryAfterSec,
            },
          });
          return problemRateLimited(
            rl.retryAfterSec,
            undefined,
            headersForRateLimit(rl),
          );
        }
      } else {
        rateLimitBypassed = true;
      }

      // 9. Allow audit — BLOCKING. Failure -> 503, handler not called.
      const bypassMeta: Record<string, unknown> = { route: request.nextUrl.pathname, method: request.method };
      if (enforcementBypassed) bypassMeta.enforcement_bypassed = enforcementBypassed;
      else if (rateLimitBypassed) bypassMeta.enforcement_bypassed = 'rate_limit';

      try {
        await writeAuditEntryBlocking(siteId, {
          correlationId,
          actor,
          capability: options.capability,
          target: { kind: targetKind, id: targetId } as AuditTarget,
          outcome: 'allow',
          metadata: bypassMeta,
          enforcementBypassed: Boolean(enforcementBypassed) || rateLimitBypassed,
        });
      } catch (err) {
        logger.error('[authorizedSiteHandler] allow-audit write failed; refusing handler', {
          context: 'authorizedHandler',
          data: {
            correlationId,
            siteId,
            err: err instanceof Error ? err.message : String(err),
          },
        });
        return serviceUnavailable('audit log unavailable; refusing privileged action');
      }

      // 10. Invoke handler.
      try {
        const ctx: SiteHandlerContext = { actor, siteId, correlationId, auth, scopeCheck };
        const response = await handler(request, ctx, { params: routeParamsPromise as Promise<TParams> });
        if (rateLimitResult) {
          Object.entries(headersForRateLimit(rateLimitResult)).forEach(([key, value]) => {
            response.headers.set(key, value);
          });
        }
        return response;
      } catch (err) {
        // Best-effort error audit; then re-throw so the framework's
        // error response path runs.
        denyAudit(siteId, {
          correlationId,
          actor,
          capability: options.capability,
          target: { kind: targetKind, id: targetId } as AuditTarget,
          outcome: 'error',
          errorCode: err instanceof Error ? err.name : 'handler_error',
          metadata: { route: request.nextUrl.pathname, method: request.method },
        });
        throw err;
      }
    };
  };
}

/* -------------------------------------------------------------------------- */
/*  platform-scoped wrapper                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Platform-scoped authorized handler. Use for routes that mutate
 * platform-level state (installer, global settings, user roles).
 *
 * Audit rows for these routes are written under
 * `global/audit_log/{entryId}` rather than a site path, since there is
 * no governing site.
 *
 * Requires `actor.role === 'superadmin'`. SystemActor is not accepted —
 * system-actor capability checks go through `systemInvoker` (wave 2.3).
 */
export function authorizedPlatformHandler<TParams extends Record<string, string | undefined> = Record<string, string | undefined>>(
  options: PlatformHandlerOptions,
) {
  return function wrap(handler: PlatformRouteHandler<TParams>) {
    return async function authorizedRoute(
      request: NextRequest,
      routeContext?: { params: Promise<TParams> },
    ): Promise<NextResponse> {
      const correlationId = generateCorrelationId();
      const targetKind: AuditTargetKind = options.targetKind ?? 'site';

      let auth: ResolvedAuth;
      try {
        auth = await resolveAuth(request);
      } catch (err) {
        if (err instanceof ApiAuthError) return authErrorToResponse(err);
        throw err;
      }

      let actor: UserActor;
      try {
        actor = await loadUserActor(auth);
      } catch (err) {
        if (err instanceof ApiAuthError) return authErrorToResponse(err);
        logger.error('[authorizedPlatformHandler] failed to load user actor', {
          context: 'authorizedHandler',
          data: { err: err instanceof Error ? err.message : String(err) },
        });
        return serviceUnavailable('could not load user record');
      }

      const apiKeyScope = options.apiKeyScope ?? { resource: 'user' as ApiKeyResource, permission: 'admin' as ApiKeyPermission };

      // Role gate: platform endpoints require superadmin.
      if (actor.role !== 'superadmin') {
        platformDenyAudit({
          correlationId,
          actor,
          capability: options.capability,
          target: { kind: targetKind, id: '__platform__' } as AuditTarget,
          outcome: 'deny',
          denyReason: 'role_insufficient',
          metadata: { route: request.nextUrl.pathname, method: request.method },
        });
        return problemForbidden('superadmin access required');
      }

      const config = await securityConfig.read();

      // API-key scope check — ALWAYS runs (sessions/id-tokens bypass inside requireScope).
      let scopeCheck: ScopeCheckResult;
      try {
        scopeCheck = requireScope(auth, apiKeyScope.resource, '*', apiKeyScope.permission);
      } catch (err) {
        if (err instanceof ApiAuthError) {
          platformDenyAudit({
            correlationId,
            actor,
            capability: options.capability,
            target: { kind: targetKind, id: '__platform__' } as AuditTarget,
            outcome: 'deny',
            denyReason: 'scope_insufficient',
            metadata: { route: request.nextUrl.pathname, method: request.method },
          });
          return authErrorToResponse(err);
        }
        throw err;
      }

      const enforcementBypassed: 'capability' | 'rate_limit' | undefined = !config.capability_enforcement
        ? 'capability'
        : undefined;
      if (config.capability_enforcement) {
        const ok = hasCapability(actor as Actor, options.capability);
        if (!ok) {
          platformDenyAudit({
            correlationId,
            actor,
            capability: options.capability,
            target: { kind: targetKind, id: '__platform__' } as AuditTarget,
            outcome: 'deny',
            denyReason: 'capability_missing',
            metadata: { route: request.nextUrl.pathname, method: request.method },
          });
          return problemForbidden('capability not granted');
        }
      }

      let rateLimitBypassed = false;
      let rateLimitResult: RateLimitResult | null = null;
      if (config.rate_limit_enforcement) {
        // Platform endpoints have no siteId; use a synthetic identifier
        // so the firestore counter still partitions per-capability.
        const rl = await checkRateLimit(
          actor as Actor,
          options.capability,
          PLATFORM_RATE_LIMIT_SITE_ID,
        );
        rateLimitResult = rl;
        if (!rl.ok) {
          platformDenyAudit({
            correlationId,
            actor,
            capability: options.capability,
            target: { kind: targetKind, id: '__platform__' } as AuditTarget,
            outcome: 'deny',
            denyReason: 'rate_limited',
            metadata: {
              route: request.nextUrl.pathname,
              method: request.method,
              retryAfterSec: rl.retryAfterSec,
            },
          });
          return problemRateLimited(
            rl.retryAfterSec,
            undefined,
            headersForRateLimit(rl),
          );
        }
      } else {
        rateLimitBypassed = true;
      }

      const bypassMeta: Record<string, unknown> = { route: request.nextUrl.pathname, method: request.method };
      if (enforcementBypassed) bypassMeta.enforcement_bypassed = enforcementBypassed;
      else if (rateLimitBypassed) bypassMeta.enforcement_bypassed = 'rate_limit';

      try {
        await writePlatformAuditBlocking({
          correlationId,
          actor,
          capability: options.capability,
          target: { kind: targetKind, id: '__platform__' } as AuditTarget,
          outcome: 'allow',
          metadata: bypassMeta,
          enforcementBypassed: Boolean(enforcementBypassed) || rateLimitBypassed,
        });
      } catch (err) {
        logger.error('[authorizedPlatformHandler] allow-audit write failed; refusing handler', {
          context: 'authorizedHandler',
          data: {
            correlationId,
            err: err instanceof Error ? err.message : String(err),
          },
        });
        return serviceUnavailable('audit log unavailable; refusing privileged action');
      }

      try {
        const response = await handler(request, { actor, correlationId, auth, scopeCheck }, routeContext);
        if (rateLimitResult) {
          Object.entries(headersForRateLimit(rateLimitResult)).forEach(([key, value]) => {
            response.headers.set(key, value);
          });
        }
        return response;
      } catch (err) {
        platformDenyAudit({
          correlationId,
          actor,
          capability: options.capability,
          target: { kind: targetKind, id: '__platform__' } as AuditTarget,
          outcome: 'error',
          errorCode: err instanceof Error ? err.name : 'handler_error',
          metadata: { route: request.nextUrl.pathname, method: request.method },
        });
        throw err;
      }
    };
  };
}
