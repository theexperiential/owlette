/**
 * POST /api/sites/{siteId}/machines/{machineId}/screenshots/upload-url
 *
 * Agent-internal helper invoked during a `capture_screenshot` command:
 * the agent calls this once it has captured a frame, gets back a 5-minute
 * v4-signed PUT url + the canonical storage path, and uploads the binary
 * directly to Firebase Storage. Decoupling upload from command queueing
 * means we never proxy a multi-MB image through Next.js.
 *
 * The agent then writes the storage path back into its command result
 * doc; the GET status route (`commands/{commandId}`) re-issues a fresh
 * 1-hour signed read URL on every poll so the dashboard can render the
 * latest capture.
 *
 * Auth: `machine=<id>:write` (api-key) OR site membership (session/id-token
 * — used by the agent's bearer-id-token path). The agent uses its own
 * Firebase ID token, which carries the agent's uid + site_id; that
 * resolves through `requireMachineAuthAndScope` exactly like a dashboard
 * caller. Idempotency is intentionally *not* required: this endpoint
 * mints a single-use signed url and is safe to call repeatedly (each call
 * issues a fresh path).
 *
 * api-sprint wave 2 — track 2A (machine-api MVP).
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  problemFromError,
  problemValidation,
} from '@/lib/apiErrors';
import {
  applyAuthDeprecations,
  requireMachineAuthAndScope,
} from '../../../../../../_shared';
import { issueScreenshotUploadUrl } from '@/lib/screenshotStorage.server';

interface RouteParams {
  params: Promise<{ siteId: string; machineId: string }>;
}

const ALLOWED_CONTENT_TYPES = new Set(['image/png', 'image/jpeg']);

interface UploadUrlBody {
  contentType?: unknown;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { siteId, machineId } = await params;

    const auth = await requireMachineAuthAndScope(request, siteId, machineId, 'write');
    if (!auth.ok) return auth.response;

    // Body is optional; only `contentType` is honored. We still try to
    // parse so a malformed payload surfaces a 400 instead of being silently
    // ignored (consistent with the rest of the public surface).
    let body: UploadUrlBody = {};
    const text = await request.text().catch(() => '');
    if (text.length > 0) {
      try {
        body = JSON.parse(text) as UploadUrlBody;
      } catch {
        return problemValidation('request body is not valid json');
      }
    }

    let contentType = 'image/png';
    if (body.contentType !== undefined && body.contentType !== null) {
      if (
        typeof body.contentType !== 'string' ||
        !ALLOWED_CONTENT_TYPES.has(body.contentType)
      ) {
        return problemValidation(
          'contentType must be image/png or image/jpeg when provided',
          {
            'body.contentType': ['must be image/png or image/jpeg'],
          },
        );
      }
      contentType = body.contentType;
    }

    const issued = await issueScreenshotUploadUrl(siteId, machineId, contentType);

    return applyAuthDeprecations(
      NextResponse.json({
        ok: true,
        data: {
          uploadUrl: issued.uploadUrl,
          storagePath: issued.storagePath,
          contentType,
          expiresAt: issued.expiresAt,
        },
      }),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(
      err,
      'sites/[siteId]/machines/[machineId]/screenshots/upload-url:POST',
    );
  }
}
