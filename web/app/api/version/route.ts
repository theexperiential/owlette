/** GET /api/version — the roost api version catalog. Unauthenticated, so clients can probe
 * before provisioning a key. */
import { NextResponse } from 'next/server';

/** Bump on breaking shape changes only, never additive ones, and in step with the
 * `Roost-Version` request-header middleware so clients can pin exactly. */
export const CURRENT_ROOST_VERSION = '2026-04-22';

/** Versions the server currently accepts in `Roost-Version` headers. */
export const SUPPORTED_ROOST_VERSIONS: readonly string[] = [CURRENT_ROOST_VERSION];

export async function GET() {
  return NextResponse.json({
    current: CURRENT_ROOST_VERSION,
    supported: SUPPORTED_ROOST_VERSIONS,
  });
}
