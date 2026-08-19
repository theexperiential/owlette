/**
 * POST /api/talons/internal/match
 *
 * Internal ingress for fleet events that never reach a web route.
 * `process_restarted` and every `display_*` event are written by the agent
 * DIRECTLY into `sites/{siteId}/logs`, so the `onTalonLogEventCreated` firestore
 * trigger (`functions/src/talonLogEvents.ts`) is the only observer of them —
 * it filters the log stream down to the talon catalog and forwards the survivors
 * here. The other three dispatchers (`/api/alerts/trigger`, `/api/agent/alert`,
 * `/api/cron/health-check`) already hold a `Firestore` handle and call
 * `tapTalonMatcher` in-process; they have no reason to come through http.
 *
 * Auth: `x-internal-secret` against `CORTEX_INTERNAL_SECRET`, compared in
 * constant time — the same posture as `functions/src/lib/requireInternalSecret`,
 * and deliberately not the `!==` comparison the older `/api/alerts/trigger`
 * still uses.
 *
 * Not public, and not in `openapi.yaml`: it is registered in the
 * `INTERNAL_ROUTES` set of `scripts/validate-openapi.ts` alongside
 * `/api/hoot/autonomous` and `/api/alerts/trigger`.
 *
 * Unlike the in-process taps this one AWAITS the matcher. The host here is not
 * a user-facing request whose latency matters — it is a cloud function with
 * nothing else to do — and detaching the work would mean a long run (a visual
 * check is a 45s capture plus a model call) racing a response that has already
 * been sent. The caller's 10s client timeout firing first is a logged non-event:
 * the run continues on this side, and the function does not retry.
 *
 * talons wave 2, task 2.3.
 */
import { timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { problem, problemFromError, problemValidation, ProblemType } from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import { hootInternalSecret } from '@/lib/hootInternalSecret';
import { matchAndRunTalons } from '@/lib/talons/matcher.server';
import { TALON_EVENT_TYPES, type TalonEventType } from '@/lib/talons/types';

// `timingSafeEqual` is a node builtin, and the run engine this route reaches
// mints webhook signatures with `node:crypto` too.
export const runtime = 'nodejs';

/**
 * Constant-time secret check.
 *
 * The length comparison up front is not a leak worth closing: `timingSafeEqual`
 * throws outright on unequal-length buffers, so the length is already
 * observable, and `CORTEX_INTERNAL_SECRET` is a fixed-length deployment secret
 * rather than something an attacker can grow one byte at a time.
 */
function secretMatches(supplied: string, expected: string): boolean {
  if (supplied.length === 0 || supplied.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  } catch {
    return false;
  }
}

function isCatalogEvent(value: unknown): value is TalonEventType {
  return (
    typeof value === 'string' &&
    TALON_EVENT_TYPES.some((eventType) => eventType === value)
  );
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Parsed body, or the problem response for a malformed one. Inline rather than
 * `@/app/api/_shared`'s `parseJsonBody`: that module pulls the whole api-key /
 * scope / billing auth stack in behind it, and this route authenticates on a
 * deployment secret and nothing else.
 */
async function readBody(
  request: NextRequest,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: NextResponse }> {
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, response: problemValidation('request body must be a json object') };
    }
    return { ok: true, body: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, response: problemValidation('request body is not valid json') };
  }
}

export async function POST(request: NextRequest) {
  try {
    const expected = hootInternalSecret();
    if (!expected) {
      // Misconfiguration, not a rejection: without the secret this route cannot
      // authenticate anyone, and a 401 would send the caller hunting for a
      // credential problem that does not exist.
      return problem({
        type: ProblemType.ServiceUnavailable,
        title: 'not configured',
        status: 503,
        detail: 'the internal talon match endpoint is not configured.',
        instance: request.nextUrl.pathname,
        code: 'not_configured',
      });
    }

    if (!secretMatches(request.headers.get('x-internal-secret') ?? '', expected)) {
      return problem({
        type: ProblemType.Unauthorized,
        title: 'unauthorized',
        status: 401,
        detail: 'a valid internal secret is required.',
        instance: request.nextUrl.pathname,
      });
    }

    const parsed = await readBody(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;

    const siteId = readNonEmptyString(body.siteId);
    if (!siteId) {
      return problemValidation('`siteId` is required.', {
        'body.siteId': ['`siteId` must be a non-empty string.'],
      });
    }

    // Closed catalog, checked here rather than inside the matcher: an event
    // outside it could never match a talon anyway, and rejecting it at the
    // boundary keeps a typo in the caller from reading as "no talons matched".
    const eventType = body.eventType;
    if (!isCatalogEvent(eventType)) {
      return problemValidation('`eventType` is not a known talon event.', {
        'body.eventType': [`\`eventType\` must be one of: ${TALON_EVENT_TYPES.join(', ')}.`],
      });
    }

    const machineId = readNonEmptyString(body.machineId);

    const result = await matchAndRunTalons(getAdminDb(), siteId, {
      kind: 'event',
      eventType,
      ...(machineId ? { machineId } : {}),
    });

    return NextResponse.json({ ok: true, matched: result.matched });
  } catch (err) {
    return problemFromError(err, 'talons/internal/match:POST');
  }
}
