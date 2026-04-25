/**
 * GET   /api/roosts/{roostId}/versions/{versionRef}?siteId=...
 *       → Full OCI version (body fetched from R2) + history metadata + stats.
 *
 * PATCH /api/roosts/{roostId}/versions/{versionRef}
 *       body: { siteId, description? }
 *       → Edit a published version's description ONLY. The version's
 *         content (files, chunks) is immutable once published — any other
 *         field in the body is rejected with `version_content_immutable`.
 *
 * `versionRef` is resolved to a concrete versionId in task 1.5. Until the
 * resolver ships, the lookup accepts the stable `vrs_*` / hash form only.
 *
 * roost public api wave 3.2.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { timestampToIso } from '@/lib/firestoreTime.server';
import {
  problem,
  problemFromError,
  problemValidation,
  ProblemType,
} from '@/lib/apiErrors';
import { getVersionBody } from '@/lib/r2Client.server';
import { checkIdempotency, saveIdempotency } from '@/lib/idempotency';
import {
  resolveVersion,
  ResolveVersionError,
} from '@/lib/resolveVersion';
import {
  applyAuthDeprecations,
  readAndParseJsonBody,
  requireRoostAuthAndScope,
  validateSiteIdBody,
} from '../../../../_shared';

const MAX_DESCRIPTION_LENGTH = 500;

/**
 * Map a resolver error to an RFC 7807 response. Called from every route
 * that translates a `{versionRef}` path segment — centralising the
 * mapping keeps error envelopes identical across GET/PATCH/files/diff.
 */
function problemFromResolveError(
  err: ResolveVersionError,
  instance: string,
): NextResponse {
  return problem({
    type: err.status === 404 ? ProblemType.NotFound : ProblemType.ValidationFailed,
    title: err.status === 404 ? 'version not found' : 'versionRef malformed',
    status: err.status,
    detail: err.message,
    instance,
    code: err.code,
  });
}

interface RouteParams {
  params: Promise<{ roostId: string; versionRef: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { roostId, versionRef } = await params;

    const siteIdParam = request.nextUrl.searchParams.get('siteId');
    if (!siteIdParam) {
      return problemValidation('query param `siteId` is required', {
        'query.siteId': ['required'],
      });
    }
    const site = validateSiteIdBody(siteIdParam, 'query.siteId');
    if (!site.ok) return site.response;

    const auth = await requireRoostAuthAndScope(request, site.siteId, roostId, 'read');
    if (!auth.ok) return auth.response;

    // Resolve the ref to a concrete version doc — accepts vrs_* ids,
    // numbers (3 / #3 / v3), and aliases (current/previous/first).
    let resolved;
    try {
      resolved = await resolveVersion({
        roostId,
        siteId: site.siteId,
        ref: versionRef,
      });
    } catch (err) {
      if (err instanceof ResolveVersionError) {
        return problemFromResolveError(
          err,
          `/api/roosts/${roostId}/versions/${versionRef}`,
        );
      }
      throw err;
    }
    const { versionId, doc: versionSnap } = resolved;

    const metadata = versionSnap.data() ?? {};
    const body = await getVersionBody(site.siteId, roostId, versionId);

    if (!body) {
      // metadata doc exists but body is gone — treat as 410 Gone so clients
      // know the pointer is stale vs a transient missing-history error.
      return problem({
        type: ProblemType.NotFound,
        title: 'version body gone',
        status: 410,
        detail: `version ${versionId} metadata exists but the body has been reclaimed`,
        instance: `/api/roosts/${roostId}/versions/${versionRef}`,
      });
    }

    return applyAuthDeprecations(
      NextResponse.json({
        versionId,
        versionNumber:
          typeof metadata.versionNumber === 'number' ? metadata.versionNumber : null,
        description:
          typeof metadata.description === 'string' ? metadata.description : null,
        roostId,
        siteId: site.siteId,
        version: body,
        metadata: {
          versionUrl: metadata.versionUrl ?? null,
          createdAt: timestampToIso(metadata.createdAt),
          createdBy: metadata.createdBy ?? null,
          totalSize: typeof metadata.totalSize === 'number' ? metadata.totalSize : 0,
          totalFiles: typeof metadata.totalFiles === 'number' ? metadata.totalFiles : 0,
          parentVersionId: metadata.parentVersionId ?? null,
        },
      }),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'v2/roosts/[roostId]/versions/[versionRef]:GET');
  }
}

/* --------------------------------------------------------------------- */
/*  PATCH — edit description (only)                                      */
/* --------------------------------------------------------------------- */

interface PatchBody {
  siteId?: unknown;
  description?: unknown;
  [key: string]: unknown;
}

// Fields PATCH is allowed to touch. Anything else in the body triggers
// the `version_content_immutable` rejection below — once a version is
// published its content (files/chunks) is frozen; only metadata like
// description can move.
const PATCHABLE_FIELDS = new Set(['siteId', 'description']);

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { roostId, versionRef } = await params;

    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const body = (parsed.body ?? {}) as PatchBody;

    const site = validateSiteIdBody(body.siteId);
    if (!site.ok) return site.response;

    const auth = await requireRoostAuthAndScope(request, site.siteId, roostId, 'write');
    if (!auth.ok) return auth.response;

    // Reject any body field other than siteId/description up front. Makes
    // the immutability guarantee explicit to the caller — they'd otherwise
    // silently discover it by observing the updated doc is unchanged.
    const offending = Object.keys(body).filter((k) => !PATCHABLE_FIELDS.has(k));
    if (offending.length > 0) {
      return problem({
        type: ProblemType.ValidationFailed,
        title: 'version content is immutable',
        status: 400,
        detail:
          'version content (files, chunks) cannot be changed after publish; only description is editable',
        instance: `/api/roosts/${roostId}/versions/${versionRef}`,
        code: 'version_content_immutable',
        errors: { body: [`cannot patch fields: ${offending.join(', ')}`] },
      });
    }

    // Idempotency replay support — matches the webhook PATCH pattern so
    // a retried PATCH (e.g. same key after a network blip) returns the
    // cached response instead of double-writing the timestamp.
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

    // Description validation mirrors the POST handler in ../route.ts so
    // the two surfaces stay consistent: same cap, same empty-string-as-null
    // normalisation.
    if (body.description === undefined) {
      return problemValidation('description is required', {
        'body.description': ['required when patching a version'],
      });
    }
    let newDescription: string | null = null;
    if (body.description !== null) {
      if (typeof body.description !== 'string') {
        return problemValidation('description must be a string or null', {
          'body.description': ['must be a string or null'],
        });
      }
      if (body.description.length > MAX_DESCRIPTION_LENGTH) {
        return problemValidation(
          `description must be ≤ ${MAX_DESCRIPTION_LENGTH} characters`,
          { 'body.description': [`must be ≤ ${MAX_DESCRIPTION_LENGTH} chars`] },
        );
      }
      const trimmed = body.description.trim();
      newDescription = trimmed.length > 0 ? trimmed : null;
    }

    // Resolve the ref to a concrete version doc — same grammar as GET.
    let resolved;
    try {
      resolved = await resolveVersion({
        roostId,
        siteId: site.siteId,
        ref: versionRef,
      });
    } catch (err) {
      if (err instanceof ResolveVersionError) {
        return problemFromResolveError(
          err,
          `/api/roosts/${roostId}/versions/${versionRef}`,
        );
      }
      throw err;
    }

    await resolved.doc.ref.update({
      description: newDescription,
      updatedAt: FieldValue.serverTimestamp(),
    });

    // Mirror the description onto the roost doc when the edited version is
    // the current pointer — the /roost list reads denormalised
    // `currentVersionDescription` for the row preview, so without this the
    // preview would lag until the next publish.
    const roostRef = resolved.doc.ref.parent.parent;
    if (roostRef) {
      const roostSnap = await roostRef.get();
      const currentId = roostSnap.exists
        ? (roostSnap.data()?.currentVersionId as string | undefined)
        : undefined;
      if (currentId === resolved.doc.id) {
        await roostRef.update({
          currentVersionDescription: newDescription,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
    }

    const refreshed = await resolved.doc.ref.get();
    const data = refreshed.data() ?? {};

    const response = applyAuthDeprecations(
      NextResponse.json({
        versionId: refreshed.id,
        versionNumber:
          typeof data.versionNumber === 'number' ? data.versionNumber : null,
        description: typeof data.description === 'string' ? data.description : null,
        roostId,
        siteId: site.siteId,
        versionUrl: data.versionUrl ?? null,
        createdAt: timestampToIso(data.createdAt),
        updatedAt: timestampToIso(data.updatedAt),
        createdBy: data.createdBy ?? null,
        totalSize: typeof data.totalSize === 'number' ? data.totalSize : 0,
        totalFiles: typeof data.totalFiles === 'number' ? data.totalFiles : 0,
        parentVersionId: data.parentVersionId ?? null,
      }),
      auth.scopeCheck,
    );
    if (idem.mode === 'proceed') await saveIdempotency(idem.token, response);
    return response;
  } catch (err) {
    return problemFromError(err, 'v2/roosts/[roostId]/versions/[versionRef]:PATCH');
  }
}
