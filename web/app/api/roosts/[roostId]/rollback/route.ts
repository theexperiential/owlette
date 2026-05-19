/**
 * POST /api/roosts/{roostId}/rollback
 *      input:  { siteId: string, targetVersion?: string | number }
 *      output: { ok, roostId, siteId, currentVersionId, currentVersionNumber, previousVersionId }
 *
 * Flip the roost's `currentVersionId` pointer to a previously-published
 * version. Does NOT mint a new version (rollbacks are a pointer change,
 * not a new publish — versions are immutable once written).
 *
 * `targetVersion` accepts every form supported by the resolver in
 * `web/lib/resolveVersion.ts`:
 *   - alias    'current' | 'previous' | 'first'
 *   - stable id 'vrs_<hex>'
 *   - number    3 / '3' / '#3' / 'v3' / 'V3'
 * Defaults to `'previous'` when omitted, matching the most common UX
 * (one-click "undo last publish").
 *
 * Auth: scope `rollback` on the roost. The scope grammar already
 * distinguishes rollback from write so an operator key can be issued
 * with rollback-only powers (no new pushes). Defined in
 * `web/lib/apiKeyTypes.ts`.
 *
 * Webhook emission: NOT done inline. The fan-out cloud function
 * (`functions/src/distributionFanout.ts:onRoostWritten`) fires on every
 * `currentVersionId` change and handles rollout state. Webhook
 * publication of `version.rolled_back` is the dispatcher's job in a
 * follow-up wave (currently nothing emits it — see TODO below).
 *
 * Audit log: `version_pointer_changed` audit emission is structural
 * infra not yet wired up from any web route. See TODO below — for now
 * the firestore write itself is the durable record.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import {
  problem,
  problemFromError,
  problemValidation,
  ProblemType,
} from '@/lib/apiErrors';
import { emitMutation } from '@/lib/auditLogClient';
import { getAdminDb } from '@/lib/firebase-admin';
import { gateOrProceed } from '@/lib/roostKillSwitch';
import {
  resolveVersion,
  ResolveVersionError,
} from '@/lib/resolveVersion';
import {
  auditActorIdentifier,
  applyAuthDeprecations,
  readAndParseJsonBody,
  requireRoostAuthAndScope,
  validateResourceId,
  validateSiteIdBody,
} from '../../../_shared';
import { checkIdempotency, saveIdempotency } from '@/lib/idempotency';

interface RouteParams {
  params: Promise<{ roostId: string }>;
}

const DEFAULT_TARGET = 'previous';

async function readSiteDocForGate(siteId: string): Promise<Record<string, unknown> | null> {
  const snap = await getAdminDb().collection('sites').doc(siteId).get();
  return snap.exists ? (snap.data() ?? null) : null;
}

/**
 * Map a resolver error to an RFC 7807 response. Mirrors the helper in
 * `versions/[versionRef]/route.ts` so error envelopes stay identical
 * across every endpoint that resolves a versionRef.
 */
function problemFromResolveError(
  err: ResolveVersionError,
  instance: string,
): NextResponse {
  return problem({
    type: err.status === 404 ? ProblemType.NotFound : ProblemType.ValidationFailed,
    title: err.status === 404 ? 'version not found' : 'targetVersion malformed',
    status: err.status,
    detail: err.message,
    instance,
    code: err.code,
  });
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { roostId } = await params;
    const roostError = validateResourceId(roostId, 'roostId');
    if (roostError) return roostError;

    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const body = (parsed.body ?? {}) as {
      siteId?: unknown;
      targetVersion?: unknown;
    };

    const site = validateSiteIdBody(body.siteId);
    if (!site.ok) return site.response;

    // Scope `rollback` per `web/lib/apiKeyTypes.ts` — the operator preset
    // grants this alongside read/write/deploy. A read-only key gets a
    // 403 scope_insufficient.
    const auth = await requireRoostAuthAndScope(
      request,
      site.siteId,
      roostId,
      'rollback',
    );
    if (!auth.ok) return auth.response;

    const gateRes = await gateOrProceed(site.siteId, readSiteDocForGate);
    if (gateRes) return gateRes;

    // Idempotency replay support — matches the PATCH pattern in
    // versions/[versionRef]/route.ts so retries (operator hits the button
    // twice on a flaky network) don't double-flip the pointer or fire two
    // dispatcher waves.
    const idem = await checkIdempotency(
      request,
      {
        userId: auth.userId,
        environment: auth.auth.keyContext?.environment ?? 'unknown',
      },
      parsed.raw,
    );
    if (idem.mode === 'invalid' || idem.mode === 'mismatch' || idem.mode === 'replay') {
      return idem.response;
    }

    // targetVersion is optional. When provided, accept string OR number;
    // anything else (object, array, boolean) is an immediate 400 — we
    // don't want to silently coerce or bury that error in the resolver.
    const rawTarget = body.targetVersion;
    if (
      rawTarget !== undefined &&
      rawTarget !== null &&
      typeof rawTarget !== 'string' &&
      typeof rawTarget !== 'number'
    ) {
      return problemValidation(
        'targetVersion must be a string or number when provided',
        { 'body.targetVersion': ['must be a string or number'] },
      );
    }
    const refInput =
      rawTarget === undefined || rawTarget === null
        ? DEFAULT_TARGET
        : String(rawTarget);

    // Resolve the ref to a concrete version doc — same grammar as
    // GET/PATCH /versions/{versionRef}. Side-effect free; throws
    // ResolveVersionError on bad input or missing target.
    let resolved;
    try {
      resolved = await resolveVersion({
        roostId,
        siteId: site.siteId,
        ref: refInput,
      });
    } catch (err) {
      if (err instanceof ResolveVersionError) {
        return problemFromResolveError(
          err,
          `/api/roosts/${roostId}/rollback`,
        );
      }
      throw err;
    }
    const resolvedData = resolved.doc.data() ?? {};

    // Compare-and-swap inside a transaction: read the roost head, verify
    // the target isn't already current, flip the pointers atomically.
    // The transactional read protects us against a concurrent push that
    // landed between resolveVersion() and the update — firestore retries
    // the callback if the roost doc moved.
    const db = getAdminDb();
    const roostRef = db
      .collection('sites')
      .doc(site.siteId)
      .collection('roosts')
      .doc(roostId);

    const txResult = await db.runTransaction(async (tx) => {
      const roostSnap = await tx.get(roostRef);
      if (!roostSnap.exists) {
        return { kind: 'not_found' as const };
      }
      const existing = roostSnap.data() ?? {};
      if (existing.deletedAt) {
        return { kind: 'not_found' as const };
      }

      const currentId = (existing.currentVersionId as string | undefined) ?? null;
      if (currentId === resolved.versionId) {
        return { kind: 'no_op' as const, currentId };
      }

      // Denormalise the resolved version's summary fields onto the roost
      // doc so the /roost list + dispatcher cloud function can read them
      // without a sub-collection round-trip. Mirrors the field set the
      // POST /versions handler writes on a fresh push.
      tx.update(roostRef, {
        currentVersionId: resolved.versionId,
        currentVersionNumber: resolved.versionNumber,
        currentVersionDescription:
          typeof resolvedData.description === 'string'
            ? resolvedData.description
            : null,
        previousVersionId: currentId,
        versionUrl:
          typeof resolvedData.versionUrl === 'string'
            ? resolvedData.versionUrl
            : null,
        totalFiles:
          typeof resolvedData.totalFiles === 'number' ? resolvedData.totalFiles : 0,
        totalSize:
          typeof resolvedData.totalSize === 'number' ? resolvedData.totalSize : 0,
        updatedAt: FieldValue.serverTimestamp(),
      });

      return {
        kind: 'flipped' as const,
        previousVersionId: currentId,
      };
    });

    if (txResult.kind === 'not_found') {
      return problem({
        type: ProblemType.NotFound,
        title: 'not found',
        status: 404,
        detail: `roost ${roostId} not found on site ${site.siteId}`,
        instance: `/api/roosts/${roostId}/rollback`,
      });
    }
    if (txResult.kind === 'no_op') {
      // Defensive only — the UI hides the rollback action on the row that's
      // already current. A direct API caller still gets a clear 400 rather
      // than a silent success that does nothing.
      return problem({
        type: ProblemType.ValidationFailed,
        title: 'rollback no-op',
        status: 400,
        detail: 'targetVersion is already the current version',
        instance: `/api/roosts/${roostId}/rollback`,
        code: 'rollback_no_op',
      });
    }

    // TODO(roost-webhooks): emit a `version.rolled_back` webhook event.
    // The fan-out cloud function (distributionFanout.ts:onRoostWritten)
    // fires on every currentVersionId change and is responsible for
    // rollout state, but webhook publication is a separate dispatcher
    // not yet wired up — same gap as `version.published`. Track in the
    // wave-2 webhook-emission task.

    const response = applyAuthDeprecations(
      NextResponse.json({
        ok: true,
        roostId,
        siteId: site.siteId,
        currentVersionId: resolved.versionId,
        currentVersionNumber: resolved.versionNumber,
        previousVersionId: txResult.previousVersionId,
      }),
      auth.scopeCheck,
    );
    if (idem.mode === 'proceed') await saveIdempotency(idem.token, response);
    emitMutation({
      kind: 'roost_mutated',
      siteId: site.siteId,
      actor: auditActorIdentifier(auth.auth),
      targetId: resolved.versionId,
      attributes: {
        verb: 'rollback',
        endpoint: request.nextUrl.pathname,
        method: request.method,
        roostId,
        targetVersion: refInput,
        fromVersionId: txResult.previousVersionId,
        toVersionId: resolved.versionId,
        toVersionNumber: resolved.versionNumber,
      },
    });
    return response;
  } catch (err) {
    return problemFromError(err, 'v2/roosts/[roostId]/rollback');
  }
}
