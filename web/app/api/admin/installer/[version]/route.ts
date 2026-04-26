/**
 * DELETE /api/admin/installer/{version}
 *
 * Soft-delete an installer version (admin-namespace mirror of the public
 * `DELETE /api/installer/{version}` route from api-sprint wave 1B).
 *
 * Both routes share the same `deleteInstaller` action core; the public
 * route is the public surface (idempotency keys, RFC 7807 shape, scope
 * gating via `requirePlatformAuthAndScope`) and stays intact. This admin
 * variant is gated by `authorizedPlatformHandler({ capability:
 * 'INSTALLER_MANAGE' })` with the new audit + kill-switch pipeline.
 *
 * security-boundary-migration wave 3.11.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  problem,
  problemFromError,
  problemNotFound,
  problemValidation,
  ProblemType,
} from '@/lib/apiErrors';
import { authorizedPlatformHandler } from '@/lib/authorizedHandler.server';
import {
  deleteInstaller,
  InstallerMinVersionsViolatedError,
  InstallerVersionNotFoundError,
  MIN_ACTIVE_VERSIONS,
} from '@/lib/actions/deleteInstaller.server';
import { InstallerValidationError } from '@/lib/actions/uploadInstaller.server';

type RouteParams = {
  version: string;
} & Record<string, string | undefined>;

export const DELETE = authorizedPlatformHandler<RouteParams>({
  capability: 'INSTALLER_MANAGE',
})(async (_request: NextRequest, ctx, routeContext) => {
  try {
    const params = await routeContext!.params;
    const version = params.version;

    try {
      const result = await deleteInstaller({ actor: ctx.actor, version });
      return NextResponse.json({
        version: result.version,
        deletedAt: result.deletedAt,
        alreadyDeleted: result.alreadyDeleted,
      });
    } catch (err) {
      if (err instanceof InstallerValidationError) {
        return problemValidation(err.message, {
          [`path.${err.field}`]: [err.message],
        });
      }
      if (err instanceof InstallerVersionNotFoundError) {
        return problemNotFound(`installer version ${err.version} does not exist`);
      }
      if (err instanceof InstallerMinVersionsViolatedError) {
        return problem({
          type: ProblemType.Conflict,
          title: 'min versions violated',
          status: 409,
          detail: `cannot delete: only ${err.activeCount} active version(s) remain; floor is ${MIN_ACTIVE_VERSIONS}`,
          code: 'min_versions_violated',
          minActiveVersions: err.minActiveVersions,
          currentActiveCount: err.activeCount,
        });
      }
      throw err;
    }
  } catch (err) {
    return problemFromError(err, 'admin/installer/[version]:DELETE');
  }
});
