/**
 * GET  /api/sites/{siteId}/talons — every talon on the site, ordered by name.
 * POST /api/sites/{siteId}/talons — create one.
 *
 * Thin http shim: every rule deciding whether a talon may exist (validation,
 * per-site cap, `command`-output privilege gate, webhook SSRF check,
 * author-llm-key precondition, `nextRunAt` stamping, secret minting, audit)
 * lives in `@/lib/talons/store.server`, so no caller here can sidestep them.
 *
 * Capability TALON_MANAGE. GET takes read-class api-key scope
 * (`site=<siteId>:read`); POST takes the write-class default.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { auditActorIdentifier, readAndParseJsonBody } from '@/app/api/_shared';
import { problem, problemFromError, ProblemType } from '@/lib/apiErrors';
import {
  authorizedSiteHandler,
  type SiteHandlerContext,
} from '@/lib/authorizedHandler.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { timestampToIso } from '@/lib/firestoreTime.server';
import { checkIdempotency, saveIdempotency } from '@/lib/idempotency';
import {
  createTalon,
  listTalons,
  TalonStoreError,
  type StoredTalon,
  type TalonStoreContext,
  type TalonStoreErrorCode,
} from '@/lib/talons/store.server';
import type { TalonFieldError } from '@/lib/talons/validation';

// The store mints webhook signing secrets with `node:crypto`.
export const runtime = 'nodejs';

type RouteParams = { siteId: string };

/** Problem `title` per store rejection. Lowercase, matching the rest of the api. */
const PROBLEM_TITLE_BY_CODE: Readonly<Record<TalonStoreErrorCode, string>> = {
  invalid_talon: 'validation failed',
  talon_limit_reached: 'talon limit reached',
  command_output_forbidden: 'forbidden',
  hoot_actions_forbidden: 'forbidden',
  invalid_webhook_url: 'webhook url rejected',
  llm_key_required: 'ai key required',
  talon_not_found: 'not found',
  invalid_reassign: 'validation failed',
  successor_invalid: 'invalid successor',
};

const PROBLEM_TYPE_BY_STATUS: Readonly<Record<number, string>> = {
  400: ProblemType.ValidationFailed,
  403: ProblemType.Forbidden,
  404: ProblemType.NotFound,
  409: ProblemType.Conflict,
};

/**
 * Trusted store context, derived from what the wrapper authorized — never from
 * the request body. `via: 'ui'` is hardcoded; the hoot tool path builds its own
 * with `via: 'cortex'` and the originating `chatId`.
 */
export function talonStoreContext(
  request: NextRequest,
  ctx: SiteHandlerContext,
): TalonStoreContext {
  return {
    siteId: ctx.siteId,
    actor: ctx.actor,
    auditActor: auditActorIdentifier(ctx.auth),
    via: 'ui',
    endpoint: request.nextUrl.pathname,
    method: request.method,
  };
}

/**
 * Group validator field errors by path for the RFC 7807 `errors` member. One
 * path can carry several messages, so the values are arrays.
 */
function problemErrorsFrom(fieldErrors: TalonFieldError[]): Record<string, string[]> {
  const grouped: Record<string, string[]> = {};
  for (const fieldError of fieldErrors) {
    const key = `body.${fieldError.field}`;
    (grouped[key] ??= []).push(fieldError.message);
  }
  return grouped;
}

/**
 * Render a store rejection as problem+json. Validation failures carry both
 * shapes: `errors` for generic RFC 7807 clients, and `fieldErrors` for the
 * talon editor, which needs the per-field `code` that `errors` can't express.
 */
export function talonStoreProblem(err: TalonStoreError, instance: string): NextResponse {
  return problem({
    type: PROBLEM_TYPE_BY_STATUS[err.status] ?? ProblemType.ValidationFailed,
    title: PROBLEM_TITLE_BY_CODE[err.code],
    status: err.status,
    detail: err.message,
    instance,
    code: err.code,
    ...(err.fieldErrors
      ? { errors: problemErrorsFrom(err.fieldErrors), fieldErrors: err.fieldErrors }
      : {}),
  });
}

/**
 * Wire form of a talon: timestamps become ISO-8601; optional run bookkeeping
 * becomes explicit `null` so clients need not distinguish absent from never-run.
 *
 * The webhook signing secret lives in `talon_secrets` and is deliberately
 * unreachable here — unlike `webhooks.signingSecret`, which any member reads.
 */
export function serializeTalon(talon: StoredTalon) {
  return {
    id: talon.id,
    schemaVersion: talon.schemaVersion,
    name: talon.name,
    ...(talon.description !== undefined ? { description: talon.description } : {}),
    enabled: talon.enabled,
    trigger: talon.trigger,
    condition: talon.condition,
    outputs: talon.outputs,
    scope: talon.scope,
    cooldownMinutes: talon.cooldownMinutes,
    createdBy: talon.createdBy,
    createdVia: talon.createdVia,
    ...(talon.chatId !== undefined ? { chatId: talon.chatId } : {}),
    createdAt: timestampToIso(talon.createdAt),
    updatedAt: timestampToIso(talon.updatedAt),
    nextRunAt: timestampToIso(talon.nextRunAt),
    lastRunAt: timestampToIso(talon.lastRunAt),
    lastRunStatus: talon.lastRunStatus ?? null,
    lastRunId: talon.lastRunId ?? null,
    consecutiveFailures: talon.consecutiveFailures,
    // Why the SYSTEM switched it off; `null` when enabled or paused by a human.
    disabledReason: talon.disabledReason ?? null,
  };
}


export const GET = authorizedSiteHandler<RouteParams>({
  capability: 'TALON_MANAGE',
  siteIdParam: 'path',
  targetKind: 'talon',
  apiKeyPermission: 'read',
})(async (_request: NextRequest, ctx: SiteHandlerContext) => {
  try {
    // Unpaginated: MAX_TALONS_PER_SITE caps the collection at 20.
    const talons = await listTalons(getAdminDb(), ctx.siteId);
    return NextResponse.json({ talons: talons.map(serializeTalon) });
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/talons:GET');
  }
});


export const POST = authorizedSiteHandler<RouteParams>({
  capability: 'TALON_MANAGE',
  siteIdParam: 'path',
  targetKind: 'talon',
})(async (request: NextRequest, ctx: SiteHandlerContext) => {
  try {
    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;

    const idem = await checkIdempotency(
      request,
      {
        userId: ctx.auth.userId,
        environment: ctx.auth.keyContext?.environment ?? 'unknown',
      },
      parsed.raw,
    );
    if (idem.mode === 'invalid' || idem.mode === 'mismatch' || idem.mode === 'replay') {
      return idem.response;
    }

    const talon = await createTalon(
      getAdminDb(),
      talonStoreContext(request, ctx),
      parsed.body,
    );

    const response = NextResponse.json(serializeTalon(talon), { status: 201 });
    if (idem.mode === 'proceed') await saveIdempotency(idem.token, response);
    return response;
  } catch (err) {
    if (err instanceof TalonStoreError) {
      return talonStoreProblem(err, request.nextUrl.pathname);
    }
    return problemFromError(err, 'sites/[siteId]/talons:POST');
  }
});
