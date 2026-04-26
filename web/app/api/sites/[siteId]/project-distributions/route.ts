/**
 * GET  /api/sites/{siteId}/project-distributions
 *      → cursor-paginated list of project distributions for a site,
 *        newest first. Requires `site=<id>:read`.
 *
 * POST /api/sites/{siteId}/project-distributions
 *      → create a project distribution + fan out `distribute_project`
 *        commands to each target machine. Requires `site=<id>:write` +
 *        `Idempotency-Key` header. Enforces a per-site max-targets quota
 *        (default 100, override via `sites/{siteId}.distributionQuota`);
 *        over quota returns 413 `over_quota`.
 *
 * Mirror of `/api/sites/{siteId}/deployments` (api-sprint wave 1) for the
 * project-distribution surface (security-boundary-migration wave 3.4).
 * Action core: `web/lib/actions/createDistribution.server.ts`.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  problem,
  problemFromError,
  problemValidation,
  ProblemType,
} from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import { timestampToIso } from '@/lib/firestoreTime.server';
import {
  applyAuthDeprecations,
  readAndParseJsonBody,
  requireSiteAuthAndScope,
} from '../../../_shared';
import { withIdempotency } from '@/lib/idempotency';
import { generateCorrelationId } from '@/lib/auditLog.server';
import {
  createDistribution,
  type CreateDistributionInput,
} from '@/lib/actions/createDistribution.server';

interface RouteParams {
  params: Promise<{ siteId: string }>;
}

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

/* --------------------------------------------------------------------- */
/*  GET — list distributions                                             */
/* --------------------------------------------------------------------- */

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { siteId } = await params;
    const auth = await requireSiteAuthAndScope(request, siteId, 'read');
    if (!auth.ok) return auth.response;

    const pageSizeRaw = Number(
      request.nextUrl.searchParams.get('page_size') ?? DEFAULT_PAGE_SIZE,
    );
    const pageSize = Math.min(
      Math.max(1, Number.isFinite(pageSizeRaw) ? Math.floor(pageSizeRaw) : DEFAULT_PAGE_SIZE),
      MAX_PAGE_SIZE,
    );
    const pageToken = request.nextUrl.searchParams.get('page_token') ?? '';

    const db = getAdminDb();
    const distributionsCol = db
      .collection('sites')
      .doc(siteId)
      .collection('project_distributions');

    let query = distributionsCol.orderBy('createdAt', 'desc').limit(pageSize + 1);
    if (pageToken) {
      const cursorSnap = await distributionsCol.doc(pageToken).get();
      if (cursorSnap.exists) query = query.startAfter(cursorSnap);
    }

    const snap = await query.get();
    const docs = snap.docs.slice(0, pageSize);
    const nextPageToken = snap.docs.length > pageSize ? snap.docs[pageSize].id : '';

    const items = docs.map((d) => serializeDistribution(d.id, d.data() ?? {}));

    return applyAuthDeprecations(
      NextResponse.json({ items, next_page_token: nextPageToken }),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/project-distributions:GET');
  }
}

/* --------------------------------------------------------------------- */
/*  POST — create distribution                                           */
/* --------------------------------------------------------------------- */

interface CreateDistributionBody {
  name?: unknown;
  file_name?: unknown;
  project_url?: unknown;
  extract_path?: unknown;
  verify_files?: unknown;
  machines?: unknown;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { siteId } = await params;

    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const body = (parsed.body ?? {}) as CreateDistributionBody;

    const auth = await requireSiteAuthAndScope(request, siteId, 'write');
    if (!auth.ok) return auth.response;

    return withIdempotency(
      request,
      {
        userId: auth.userId,
        environment: auth.auth.keyContext?.environment ?? 'unknown',
      },
      parsed.raw,
      async () => {
        const correlationId = generateCorrelationId();
        const actorIdentifier = auth.auth.keyContext
          ? `apiKey:${auth.auth.keyContext.keyId}`
          : `user:${auth.userId}`;

        // The action does its own validation; pass the raw body (cast to
        // the Input shape) and let the action surface field-level errors
        // via the discriminated result.
        const input = body as unknown as CreateDistributionInput;
        const result = await createDistribution(input, {
          siteId,
          actorIdentifier,
          correlationId,
        });

        if (!result.ok) {
          if (result.code === 'over_quota') {
            return problem({
              type: ProblemType.PayloadTooLarge,
              title: 'over quota',
              status: 413,
              detail: result.message,
              code: 'over_quota',
              quota: result.details,
            });
          }
          // Every other failure is a 400-class validation problem.
          return problemValidation(result.message, {
            [validationFieldFor(result.code)]: [result.message],
          });
        }

        return applyAuthDeprecations(
          NextResponse.json(
            {
              distributionId: result.distributionId,
              siteId: result.siteId,
              status: result.status,
              targets: result.targets,
            },
            { status: 201 },
          ),
          auth.scopeCheck,
        );
      },
    );
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/project-distributions:POST');
  }
}

/* --------------------------------------------------------------------- */
/*  helpers                                                              */
/* --------------------------------------------------------------------- */

function validationFieldFor(code: string): string {
  switch (code) {
    case 'invalid_name':
      return 'body.name';
    case 'invalid_file_name':
      return 'body.file_name';
    case 'invalid_project_url':
    case 'project_url_not_https':
      return 'body.project_url';
    case 'invalid_extract_path':
      return 'body.extract_path';
    case 'invalid_verify_files':
      return 'body.verify_files';
    case 'invalid_machines':
      return 'body.machines';
    default:
      return 'body';
  }
}

function serializeDistribution(id: string, data: Record<string, unknown>) {
  return {
    id,
    name: typeof data.name === 'string' ? data.name : 'Unnamed Distribution',
    file_name: typeof data.file_name === 'string' ? data.file_name : '',
    project_url: typeof data.project_url === 'string' ? data.project_url : '',
    extract_path: typeof data.extract_path === 'string' ? data.extract_path : null,
    verify_files: Array.isArray(data.verify_files) ? data.verify_files : null,
    targets: Array.isArray(data.targets) ? data.targets : [],
    status: typeof data.status === 'string' ? data.status : 'pending',
    createdAt: timestampToIso(data.createdAt),
    completedAt: timestampToIso(data.completedAt),
    updatedAt: timestampToIso(data.updatedAt),
  };
}
