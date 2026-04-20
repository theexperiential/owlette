/**
 * POST /api/folders/{folderId}/rollback
 *      input:  { siteId: string, targetManifestId?: string }
 *              (omit targetManifestId to roll back to previousManifestId; specify for arbitrary version)
 *      output: { rolledBackTo: string, previousCurrent: string }
 *      → atomically swap currentManifestId → targetManifestId (or previousManifestId).
 *
 * roost wave 2a.6.
 *
 * STUB: backing transaction not yet wired. implement when wave 1.8 (firestore
 * schema v2) is committed and waves 0.5/0.6 are provisioned.
 */
import type { NextRequest } from 'next/server';
import { problemFromError, problemValidation } from '@/lib/apiErrors';
import {
  parseJsonBody,
  validateResourceId,
  validateSiteIdBody,
  notImplementedYet,
  requireAuthOrProblem,
  requireSiteScope,
} from '../../../_shared';

interface RouteParams {
  params: Promise<{ folderId: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const auth = await requireAuthOrProblem(request);
    if (!auth.ok) return auth.response;

    const { folderId } = await params;
    const folderError = validateResourceId(folderId, 'folderId');
    if (folderError) return folderError;

    const parsed = await parseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body as { siteId?: unknown; targetManifestId?: unknown };

    const site = validateSiteIdBody(body.siteId);
    if (!site.ok) return site.response;

    const scopeError = await requireSiteScope(auth.userId, site.siteId);
    if (scopeError) return scopeError;

    if (body.targetManifestId !== undefined && typeof body.targetManifestId === 'string') {
      const targetError = validateResourceId(body.targetManifestId, 'targetManifestId');
      if (targetError) return targetError;
    } else if (body.targetManifestId !== undefined) {
      return problemValidation('targetManifestId must be a string or omitted', {
        'body.targetManifestId': ['must be a string or omitted'],
      });
    }

    // TODO(wave 2a.6):
    // 1. firestore TRANSACTION:
    //    - read sites/{siteId}/synced_folders/{folderId}
    //    - resolve target: explicit body.targetManifestId, or fall back to previousManifestId
    //    - if target == currentManifestId → 409 Conflict ("already on that version")
    //    - verify target manifest exists in subcollection manifests/{target}
    //    - write: previousManifestId = current, currentManifestId = target
    // 2. audit-log the rollback (who, when, from→to)
    // 3. cf trigger fans out new sync_pull commands to targets
    // 4. honor Idempotency-Key for safe retries
    // 5. respond 200 { rolledBackTo, previousCurrent }
    return notImplementedYet(
      `/api/folders/${folderId}/rollback`,
      'wave 2a.6',
      'firestore CAS transaction; verify target manifest exists; audit log; cf fan-out; Idempotency-Key',
    );
  } catch (err) {
    return problemFromError(err, 'v2/folders/[folderId]/rollback');
  }
}
