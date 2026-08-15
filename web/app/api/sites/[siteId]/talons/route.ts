/**
 * GET  /api/sites/{siteId}/talons — every talon on the site, ordered by name.
 * POST /api/sites/{siteId}/talons — create one.
 *
 * Thin http shim. Every rule that decides whether a talon may exist — input
 * validation, the per-site cap, the `command`-output privilege gate, the SSRF
 * check on webhook outputs, the site-llm-key precondition, `nextRunAt`
 * stamping, secret minting, and the mutation audit — lives in
 * `@/lib/talons/store.server`. Adding a caller here can never sidestep them.
 *
 * Capability: TALON_MANAGE. GET takes read-class api-key scope
 * (`site=<siteId>:read`); POST takes the write-class default.
 *
 * Tier: POST is pro-only, matching `POST /api/webhooks`. GET (and DELETE on
 * the item route) are not, so a downgraded site can still audit and remove
 * what it already has.
 *
 * talons wave 1.2.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { auditActorIdentifier, readAndParseJsonBody } from '@/app/api/_shared';
import { problem, problemFromError, ProblemType } from '@/lib/apiErrors';
import {
  authorizedSiteHandler,
  type SiteHandlerContext,
} from '@/lib/authorizedHandler.server';
import { billingErrorToProblem, requirePro } from '@/lib/billingGate.server';
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
  invalid_webhook_url: 'webhook url rejected',
  site_llm_key_required: 'site llm key required',
  talon_not_found: 'not found',
  pro_required: 'pro plan required',
};

const PROBLEM_TYPE_BY_STATUS: Readonly<Record<number, string>> = {
  400: ProblemType.ValidationFailed,
  // The store's `pro_required` carries the billing gate's own status: 402 when
  // the account is locked out, 403 when the site is core-tier. POST re-checks
  // `requirePro` before the store runs, so this row only matters if that
  // pre-check is ever removed — but a 402 rendered as "validation failed"
  // would be actively wrong, so the table stays total over the statuses the
  // store can raise.
  402: ProblemType.TrialExpired,
  403: ProblemType.Forbidden,
  404: ProblemType.NotFound,
  409: ProblemType.Conflict,
};

/* -------------------------------------------------------------------------- */
/*  shared helpers (imported by the item and runs routes)                     */
/* -------------------------------------------------------------------------- */

/**
 * Trusted store context, derived entirely from what the wrapper already
 * authorized — never from the request body.
 *
 * `via: 'ui'` is hardcoded: these are the dashboard/public-api routes. The
 * cortex tool path builds its own context with `via: 'cortex'` and the
 * originating `chatId`.
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
 * Group the validator's field errors by path for the RFC 7807 `errors`
 * member. One path can carry several messages (e.g. a schedule entry with a
 * bad day list and a bad time), so the values are arrays.
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
 * Render a store rejection as its problem+json response.
 *
 * Validation failures carry both shapes: `errors` for generic RFC 7807
 * clients, and the structured `fieldErrors` list the talon editor renders
 * inline (it needs the per-field `code`, which `errors` cannot express).
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
 * Wire form of a talon. Timestamps become ISO-8601 strings; optional run
 * bookkeeping becomes explicit `null` so clients never have to distinguish
 * "absent" from "never run".
 *
 * The webhook signing secret lives in `talon_secrets` and is deliberately not
 * reachable from here — unlike `webhooks`, whose `signingSecret` any site
 * member can read.
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
  };
}

/* -------------------------------------------------------------------------- */
/*  GET — list talons                                                         */
/* -------------------------------------------------------------------------- */

export const GET = authorizedSiteHandler<RouteParams>({
  capability: 'TALON_MANAGE',
  siteIdParam: 'path',
  targetKind: 'talon',
  apiKeyPermission: 'read',
})(async (_request: NextRequest, ctx: SiteHandlerContext) => {
  try {
    // Unpaginated on purpose: MAX_TALONS_PER_SITE caps the collection at 20,
    // and the editor lists all of them at once.
    const talons = await listTalons(getAdminDb(), ctx.siteId);
    return NextResponse.json({ talons: talons.map(serializeTalon) });
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/talons:GET');
  }
});

/* -------------------------------------------------------------------------- */
/*  POST — create a talon                                                     */
/* -------------------------------------------------------------------------- */

export const POST = authorizedSiteHandler<RouteParams>({
  capability: 'TALON_MANAGE',
  siteIdParam: 'path',
  targetKind: 'talon',
})(async (request: NextRequest, ctx: SiteHandlerContext) => {
  try {
    // Pro-only. The wrapper already ran the lockout half of the billing gate
    // (TALON_MANAGE is in BILLING_LOCKED_CAPABILITIES and this is a mutation);
    // this adds the tier half, and covers session callers too — unlike the
    // api-key-only `{ requirePro: true }` path the public webhooks route takes.
    try {
      await requirePro(ctx.siteId);
    } catch (err) {
      const billingProblem = billingErrorToProblem(err, ctx.siteId);
      if (billingProblem) return billingProblem;
      throw err;
    }

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
