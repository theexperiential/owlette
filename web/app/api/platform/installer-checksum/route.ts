/**
 * POST /api/platform/installer-checksum — { installer_url } ->
 * { sha256_checksum, size_bytes }.
 *
 * Platform twin of POST /api/sites/{siteId}/deployments/checksum for the admin
 * system-preset dialog, which has no site context. Same SSRF guard and streaming
 * hash, gated on SYSTEM_PRESET_MANAGE. Internal, not public API.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { problemFromError } from '@/lib/apiErrors';
import { authorizedPlatformHandler } from '@/lib/authorizedHandler.server';
import { installerChecksumErrorToResponse } from '@/lib/installerChecksumResponse.server';
import { parseJsonBody } from '@/app/api/_shared';
import {
  computeInstallerChecksum,
  InstallerChecksumError,
} from '@/lib/actions/computeInstallerChecksum.server';

export const runtime = 'nodejs';
// ~1 GB installers need the headroom on the Vercel failover origin; Railway has no deadline
export const maxDuration = 300;

export const POST = authorizedPlatformHandler({
  capability: 'SYSTEM_PRESET_MANAGE',
  targetKind: 'preset',
})(async (request: NextRequest) => {
  try {
    const parsed = await parseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const body = (parsed.body ?? {}) as { installer_url?: unknown };

    try {
      const result = await computeInstallerChecksum(body.installer_url, {
        signal: request.signal,
      });
      return NextResponse.json(result);
    } catch (err) {
      if (err instanceof InstallerChecksumError) {
        return installerChecksumErrorToResponse(err);
      }
      throw err;
    }
  } catch (err) {
    return problemFromError(err, 'platform/installer-checksum:POST');
  }
});
