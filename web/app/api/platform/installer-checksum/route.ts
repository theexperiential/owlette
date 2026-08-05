/**
 * POST /api/platform/installer-checksum
 *   body:   { installer_url: string }
 *   output: { sha256_checksum: string, size_bytes: number }
 *
 * Platform-level twin of POST /api/sites/{siteId}/deployments/checksum, used
 * by the admin system-preset dialog (which has no site context). Same SSRF
 * guard and streaming hash; gated on SYSTEM_PRESET_MANAGE.
 *
 * Internal dashboard utility — not part of the public API surface.
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
// Large installers (TouchDesigner ~1 GB) take a while to stream on the
// Vercel failover origin; Railway (primary) has no function deadline.
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
