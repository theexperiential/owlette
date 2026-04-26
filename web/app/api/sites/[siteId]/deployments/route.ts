/**
 * GET  /api/sites/{siteId}/deployments
 *      → cursor-paginated list of installer-deployments for a site,
 *        newest first. Requires `site=<id>:read`.
 *
 * POST /api/sites/{siteId}/deployments
 *      → create a deployment + fan out `install_software` commands to
 *        each target machine. Requires `site=<id>:write` and an
 *        `Idempotency-Key` header. Enforces a per-site max-targets quota
 *        (default 100, override via `sites/{siteId}.deployQuota`); over
 *        quota returns 413 `over_quota`.
 *
 * api-sprint wave 1 — track 1A (installer-deploys-api). Public
 * counterpart of `/api/admin/deployments` (which keeps backing the
 * dashboard); shape changes follow the AIP-158 cursor-pagination + RFC
 * 7807 problem+json conventions used across the roost public api.
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
import { getAdminDb } from '@/lib/firebase-admin';
import { timestampToIso } from '@/lib/firestoreTime.server';
import {
  applyAuthDeprecations,
  readAndParseJsonBody,
  requireSiteAuthAndScope,
} from '../../../_shared';
import { withIdempotency } from '@/lib/idempotency';
import { emitMutation } from '@/lib/auditLogClient';

interface RouteParams {
  params: Promise<{ siteId: string }>;
}

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const DEFAULT_MAX_TARGETS = 100;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/i;

/* --------------------------------------------------------------------- */
/*  GET — list deployments                                               */
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
    const deploymentsCol = db
      .collection('sites')
      .doc(siteId)
      .collection('deployments');

    let query = deploymentsCol.orderBy('createdAt', 'desc').limit(pageSize + 1);
    if (pageToken) {
      const cursorSnap = await deploymentsCol.doc(pageToken).get();
      if (cursorSnap.exists) query = query.startAfter(cursorSnap);
    }

    const snap = await query.get();
    const docs = snap.docs.slice(0, pageSize);
    const nextPageToken = snap.docs.length > pageSize ? snap.docs[pageSize].id : '';

    const items = docs.map((d) => serializeDeployment(d.id, d.data() ?? {}));

    return applyAuthDeprecations(
      NextResponse.json({ items, next_page_token: nextPageToken }),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/deployments:GET');
  }
}

/* --------------------------------------------------------------------- */
/*  POST — create deployment                                             */
/* --------------------------------------------------------------------- */

interface CreateDeploymentBody {
  name?: unknown;
  installer_url?: unknown;
  installer_name?: unknown;
  silent_flags?: unknown;
  verify_path?: unknown;
  machines?: unknown;
  sha256_checksum?: unknown;
  parallel_install?: unknown;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { siteId } = await params;

    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const body = (parsed.body ?? {}) as CreateDeploymentBody;

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
        // ── body validation ─────────────────────────────────────────────
        if (typeof body.name !== 'string' || body.name.trim().length === 0) {
          return problemValidation('field `name` is required and must be a non-empty string', {
            'body.name': ['required non-empty string'],
          });
        }
        if (typeof body.installer_name !== 'string' || body.installer_name.trim().length === 0) {
          return problemValidation('field `installer_name` is required and must be a non-empty string', {
            'body.installer_name': ['required non-empty string'],
          });
        }
        if (typeof body.installer_url !== 'string' || body.installer_url.trim().length === 0) {
          return problemValidation('field `installer_url` is required and must be a non-empty string', {
            'body.installer_url': ['required non-empty string'],
          });
        }
        if (typeof body.silent_flags !== 'string') {
          return problemValidation('field `silent_flags` is required and must be a string', {
            'body.silent_flags': ['required string'],
          });
        }
        try {
          const parsedUrl = new URL(body.installer_url);
          if (parsedUrl.protocol !== 'https:') {
            return problemValidation('installer_url must use HTTPS protocol', {
              'body.installer_url': ['must be https://'],
            });
          }
        } catch {
          return problemValidation('installer_url must be a valid URL', {
            'body.installer_url': ['invalid url'],
          });
        }

        let verifyPath: string | undefined;
        if (body.verify_path !== undefined && body.verify_path !== null) {
          if (typeof body.verify_path !== 'string') {
            return problemValidation('verify_path must be a string when provided', {
              'body.verify_path': ['must be a string'],
            });
          }
          verifyPath = body.verify_path;
        }

        let sha256: string | undefined;
        if (body.sha256_checksum !== undefined && body.sha256_checksum !== null) {
          if (typeof body.sha256_checksum !== 'string' || !SHA256_HEX_RE.test(body.sha256_checksum)) {
            return problemValidation(
              'sha256_checksum must be a 64-character hex SHA-256 hash',
              { 'body.sha256_checksum': ['must be 64-char hex'] },
            );
          }
          sha256 = body.sha256_checksum;
        }

        const parallelInstall = body.parallel_install === true;

        if (
          !Array.isArray(body.machines) ||
          body.machines.some((m) => typeof m !== 'string' || m.length === 0)
        ) {
          return problemValidation('field `machines` must be a non-empty array of machineId strings', {
            'body.machines': ['must be string[]'],
          });
        }
        const machines = [...new Set(body.machines as string[])];
        if (machines.length === 0) {
          return problemValidation('machines must not be empty', {
            'body.machines': ['must be non-empty'],
          });
        }

        // ── per-site max-targets quota ─────────────────────────────────
        const db = getAdminDb();
        const siteSnap = await db.collection('sites').doc(siteId).get();
        const siteData = siteSnap.exists ? (siteSnap.data() ?? {}) : {};
        const quotaRaw = siteData.deployQuota;
        const maxTargets =
          typeof quotaRaw === 'number' && Number.isFinite(quotaRaw) && quotaRaw > 0
            ? Math.floor(quotaRaw)
            : DEFAULT_MAX_TARGETS;

        if (machines.length > maxTargets) {
          return problem({
            type: ProblemType.PayloadTooLarge,
            title: 'over quota',
            status: 413,
            detail: `requested ${machines.length} target machines but max-targets-per-deploy on this site is ${maxTargets}`,
            code: 'over_quota',
            quota: { max_targets: maxTargets, requested: machines.length },
          });
        }

        // ── write deployment doc + fan out commands ────────────────────
        const deploymentId = `deploy-${Date.now()}`;
        const deploymentRef = db
          .collection('sites')
          .doc(siteId)
          .collection('deployments')
          .doc(deploymentId);

        const targets = machines.map((machineId) => ({
          machineId,
          status: 'pending' as const,
        }));

        const deploymentData: Record<string, unknown> = {
          name: body.name.trim(),
          installer_name: body.installer_name.trim(),
          installer_url: body.installer_url,
          silent_flags: body.silent_flags,
          targets,
          createdAt: FieldValue.serverTimestamp(),
          status: 'pending',
          createdBy: auth.userId,
        };
        if (sha256) deploymentData.sha256_checksum = sha256;
        if (verifyPath) deploymentData.verify_path = verifyPath;
        if (parallelInstall) deploymentData.parallel_install = true;

        await deploymentRef.set(deploymentData);

        // Fan out install_software commands to each target machine.
        await Promise.all(
          machines.map(async (machineId) => {
            const sanitizedDeploymentId = deploymentId.replace(/-/g, '_');
            const sanitizedMachineId = machineId.replace(/-/g, '_');
            const commandId = `install_${sanitizedDeploymentId}_${sanitizedMachineId}_${Date.now()}`;

            const pendingRef = db
              .collection('sites')
              .doc(siteId)
              .collection('machines')
              .doc(machineId)
              .collection('commands')
              .doc('pending');

            const commandData: Record<string, unknown> = {
              type: 'install_software',
              installer_url: body.installer_url,
              installer_name: (body.installer_name as string).trim(),
              silent_flags: body.silent_flags,
              deployment_id: deploymentId,
              timestamp: FieldValue.serverTimestamp(),
              status: 'pending',
            };
            if (sha256) commandData.sha256_checksum = sha256;
            if (verifyPath) commandData.verify_path = verifyPath;
            if (parallelInstall) commandData.parallel_install = true;

            await pendingRef.set({ [commandId]: commandData }, { merge: true });
          }),
        );

        await deploymentRef.update({ status: 'in_progress' });

        emitMutation({
          kind: 'deployment_mutated',
          siteId,
          actor: auth.auth.keyContext
            ? `apiKey:${auth.auth.keyContext.keyId}`
            : `user:${auth.userId}`,
          targetId: deploymentId,
          attributes: {
            endpoint: `/api/sites/${siteId}/deployments`,
            method: 'POST',
            verb: 'create',
            target_count: machines.length,
            installer_name: (body.installer_name as string).trim(),
          },
        });

        return applyAuthDeprecations(
          NextResponse.json(
            {
              deploymentId,
              siteId,
              status: 'in_progress',
              targets,
            },
            { status: 201 },
          ),
          auth.scopeCheck,
        );
      },
    );
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/deployments:POST');
  }
}

/* --------------------------------------------------------------------- */
/*  helpers                                                              */
/* --------------------------------------------------------------------- */

function serializeDeployment(id: string, data: Record<string, unknown>) {
  return {
    id,
    name: typeof data.name === 'string' ? data.name : 'Unnamed Deployment',
    installer_name: typeof data.installer_name === 'string' ? data.installer_name : '',
    installer_url: typeof data.installer_url === 'string' ? data.installer_url : '',
    silent_flags: typeof data.silent_flags === 'string' ? data.silent_flags : '',
    verify_path: typeof data.verify_path === 'string' ? data.verify_path : null,
    sha256_checksum: typeof data.sha256_checksum === 'string' ? data.sha256_checksum : null,
    parallel_install: data.parallel_install === true,
    targets: Array.isArray(data.targets) ? data.targets : [],
    status: typeof data.status === 'string' ? data.status : 'pending',
    createdAt: timestampToIso(data.createdAt),
    completedAt: timestampToIso(data.completedAt),
    updatedAt: timestampToIso(data.updatedAt),
  };
}
