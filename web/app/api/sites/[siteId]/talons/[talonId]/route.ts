/**
 * GET    /api/sites/{siteId}/talons/{talonId} — fetch one talon.
 * PATCH  /api/sites/{siteId}/talons/{talonId} — flip `enabled`, or replace the
 *        caller-owned half of the talon.
 * DELETE /api/sites/{siteId}/talons/{talonId} — delete it and its signing secret.
 *
 * Thin http shim over `@/lib/talons/store.server` — see the sibling
 * `../route.ts` header for why every rule lives there rather than here.
 *
 * Capability: TALON_MANAGE. GET takes read-class api-key scope; the mutations
 * take the write-class default.
 *
 * talons wave 1.2.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { readAndParseJsonBody } from '@/app/api/_shared';
import {
  problemFromError,
  problemNotFound,
  problemValidation,
} from '@/lib/apiErrors';
import {
  authorizedSiteHandler,
  type SiteHandlerContext,
} from '@/lib/authorizedHandler.server';
import { getAdminDb } from '@/lib/firebase-admin';
import {
  deleteTalon,
  getTalon,
  setTalonEnabled,
  TalonStoreError,
  updateTalon,
} from '@/lib/talons/store.server';

import { serializeTalon, talonStoreContext, talonStoreProblem } from '../route';

// The store mints webhook signing secrets with `node:crypto`.
export const runtime = 'nodejs';

/**
 * Firestore auto-ids are 20 alphanumeric chars; the bound is deliberately
 * looser and matches the preset routes. Its real job is rejecting ids that
 * would escape the document path.
 */
const TALON_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

type RouteParams = { siteId: string; talonId: string };
type RouteContext = { params: Promise<RouteParams> };

function invalidTalonId(): NextResponse {
  return problemValidation('invalid talon id', {
    'path.talonId': ['must be 1-128 chars: letters, digits, underscore, hyphen'],
  });
}

/**
 * `{ enabled: boolean }` and nothing else is the toggle; anything else is a
 * full replacement of the caller-owned fields. The exact-shape test matters:
 * a body that also carries `name` must go through `updateTalon`, which
 * revalidates the whole talon, rather than silently dropping the rename.
 */
function isEnabledOnlyPatch(body: unknown): body is { enabled: boolean } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return false;
  const keys = Object.keys(body);
  return keys.length === 1 && typeof (body as { enabled?: unknown }).enabled === 'boolean';
}

/* -------------------------------------------------------------------------- */
/*  GET — fetch one talon                                                     */
/* -------------------------------------------------------------------------- */

export const GET = authorizedSiteHandler<RouteParams>({
  capability: 'TALON_MANAGE',
  siteIdParam: 'path',
  targetKind: 'talon',
  targetIdParam: 'talonId',
  apiKeyPermission: 'read',
})(async (_request: NextRequest, ctx: SiteHandlerContext, routeContext: RouteContext) => {
  try {
    const { talonId } = await routeContext.params;
    if (!TALON_ID_RE.test(talonId)) return invalidTalonId();

    const talon = await getTalon(getAdminDb(), ctx.siteId, talonId);
    if (!talon) return problemNotFound(`talon ${talonId} not found on site ${ctx.siteId}`);

    return NextResponse.json(serializeTalon(talon));
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/talons/[talonId]:GET');
  }
});

/* -------------------------------------------------------------------------- */
/*  PATCH — toggle or replace                                                 */
/* -------------------------------------------------------------------------- */

export const PATCH = authorizedSiteHandler<RouteParams>({
  capability: 'TALON_MANAGE',
  siteIdParam: 'path',
  targetKind: 'talon',
  targetIdParam: 'talonId',
})(async (request: NextRequest, ctx: SiteHandlerContext, routeContext: RouteContext) => {
  try {
    const { talonId } = await routeContext.params;
    if (!TALON_ID_RE.test(talonId)) return invalidTalonId();

    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;

    const db = getAdminDb();
    const storeContext = talonStoreContext(request, ctx);
    const talon = isEnabledOnlyPatch(parsed.body)
      ? await setTalonEnabled(db, storeContext, talonId, parsed.body.enabled)
      : await updateTalon(db, storeContext, talonId, parsed.body);

    return NextResponse.json(serializeTalon(talon));
  } catch (err) {
    if (err instanceof TalonStoreError) {
      return talonStoreProblem(err, request.nextUrl.pathname);
    }
    return problemFromError(err, 'sites/[siteId]/talons/[talonId]:PATCH');
  }
});

/* -------------------------------------------------------------------------- */
/*  DELETE — remove the talon and its signing secret                          */
/* -------------------------------------------------------------------------- */

export const DELETE = authorizedSiteHandler<RouteParams>({
  capability: 'TALON_MANAGE',
  siteIdParam: 'path',
  targetKind: 'talon',
  targetIdParam: 'talonId',
})(async (request: NextRequest, ctx: SiteHandlerContext, routeContext: RouteContext) => {
  try {
    const { talonId } = await routeContext.params;
    if (!TALON_ID_RE.test(talonId)) return invalidTalonId();

    // A repeat delete answers 404 `talon_not_found`, matching the sibling
    // preset and webhook delete routes. Run history in `talon_runs` survives —
    // it is an audit surface and outlives the talon it describes.
    await deleteTalon(getAdminDb(), talonStoreContext(request, ctx), talonId);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    if (err instanceof TalonStoreError) {
      return talonStoreProblem(err, request.nextUrl.pathname);
    }
    return problemFromError(err, 'sites/[siteId]/talons/[talonId]:DELETE');
  }
});
