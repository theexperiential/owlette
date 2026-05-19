/**
 * GET /api/version
 *     → The roost api version catalog. Unauthenticated — safe for clients
 *       to probe before they've provisioned a key.
 *
 * roost public api wave 3.9.
 */
import { NextResponse } from 'next/server';

/**
 * Current dated version string. Bump on every breaking shape change, not
 * on additive changes. Coordinate with the `Roost-Version` request-header
 * middleware (task 3.11) so clients can pin exactly.
 */
export const CURRENT_ROOST_VERSION = '2026-04-22';

/** Versions the server currently accepts in `Roost-Version` headers. */
export const SUPPORTED_ROOST_VERSIONS: readonly string[] = [CURRENT_ROOST_VERSION];

export async function GET() {
  return NextResponse.json({
    current: CURRENT_ROOST_VERSION,
    supported: SUPPORTED_ROOST_VERSIONS,
  });
}
