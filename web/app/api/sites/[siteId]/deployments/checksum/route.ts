/**
 * POST /api/sites/{siteId}/deployments/checksum
 *   body:   { installer_url: string }
 *   output: { sha256_checksum: string, size_bytes: number }
 *
 * Streams the installer from `installer_url` server-side and returns its
 * SHA-256, so the deploy dialog can pin a checksum without the user hashing
 * files by hand. Agents refuse `install_software` commands without
 * `sha256_checksum`, so this runs before every dashboard deployment.
 *
 * Internal dashboard utility — not part of the public API surface. The URL
 * goes through the full SSRF guard with per-redirect-hop re-validation (see
 * `computeInstallerChecksum.server.ts`). The outbound fetch is tied to the
 * request signal, so closing the dialog cancels the server-side download.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { problemFromError } from '@/lib/apiErrors';
import { authorizedSiteHandler } from '@/lib/authorizedHandler.server';
import { installerChecksumErrorToResponse } from '@/lib/installerChecksumResponse.server';
import {
  applyAuthDeprecations,
  readAndParseJsonBody,
  requireSiteAuthAndScope,
} from '../../../../_shared';
import {
  computeInstallerChecksum,
  InstallerChecksumError,
} from '@/lib/actions/computeInstallerChecksum.server';

type RouteParams = { siteId: string };

export const runtime = 'nodejs';
// Large installers (TouchDesigner ~1 GB) take a while to stream on the
// Vercel failover origin; Railway (primary) has no function deadline.
export const maxDuration = 300;

export const POST = authorizedSiteHandler<RouteParams>({
  capability: 'DEPLOYMENT_MANAGE',
  siteIdParam: 'path',
  targetKind: 'deployment',
})(async (request: NextRequest, _ctx, routeContext) => {
  try {
    const { siteId } = await routeContext.params;

    const auth = await requireSiteAuthAndScope(request, siteId, 'write');
    if (!auth.ok) return auth.response;

    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const body = (parsed.body ?? {}) as { installer_url?: unknown };

    try {
      const result = await computeInstallerChecksum(body.installer_url, {
        signal: request.signal,
      });
      return applyAuthDeprecations(NextResponse.json(result), auth.scopeCheck);
    } catch (err) {
      if (err instanceof InstallerChecksumError) {
        return installerChecksumErrorToResponse(err);
      }
      throw err;
    }
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/deployments/checksum:POST');
  }
});
