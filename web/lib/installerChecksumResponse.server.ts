/**
 * Shared HTTP mapping for `InstallerChecksumError`, used by both checksum
 * route shims (site-scoped deployments + platform system-presets). Lives
 * outside the route files because Next.js route modules may only export
 * HTTP method handlers and route-segment config.
 */

import { NextResponse } from 'next/server';
import { problem, problemValidation, ProblemType } from '@/lib/apiErrors';
import type { InstallerChecksumError } from '@/lib/actions/computeInstallerChecksum.server';

export function installerChecksumErrorToResponse(err: InstallerChecksumError): NextResponse {
  switch (err.code) {
    case 'invalid_url':
      return problemValidation(err.message, { 'body.installer_url': [err.message] });
    case 'too_large':
      return problem({
        type: ProblemType.PayloadTooLarge,
        title: 'installer too large',
        status: 413,
        detail: err.message,
        code: 'too_large',
      });
    default:
      // fetch_failed / too_many_redirects / timeout / cancelled — the remote
      // host (or the client hanging up) is the failing party, not this API.
      return problem({
        type: ProblemType.ValidationFailed,
        title: 'checksum computation failed',
        status: 422,
        detail: err.message,
        code: err.code,
      });
  }
}
