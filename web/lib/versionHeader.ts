/**
 * `Roost-Version` header handling. Clients pin an API shape with
 * `Roost-Version: YYYY-MM-DD`; the catalog in `web/app/api/version/route.ts` is
 * the single source of truth for supported dates.
 *
 *   missing     → pass, log, add `X-Roost-Version-Missing: true`
 *   supported   → pass silently
 *   unsupported → 400 problem+json, code `unsupported_version`
 *
 * Soft-advisory only until a second dated version ships; then "missing" becomes a
 * hard error and clients MUST pin.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  problem,
  ProblemType,
} from '@/lib/apiErrors';
import {
  CURRENT_ROOST_VERSION,
  SUPPORTED_ROOST_VERSIONS,
} from '@/app/api/version/route';

export const ROOST_VERSION_HEADER = 'Roost-Version';
export const ROOST_VERSION_MISSING_HEADER = 'X-Roost-Version-Missing';

export interface VersionCheckOk {
  ok: true;
  /** Caller did not pin a version — response should carry X-Roost-Version-Missing. */
  missing: boolean;
  /** Echoed for the server-resolved effective version (current default). */
  effectiveVersion: string;
}

export interface VersionCheckFail {
  ok: false;
  response: NextResponse;
}

export type VersionCheckResult = VersionCheckOk | VersionCheckFail;

/** Read + validate the `Roost-Version` request header. Never throws. */
export function checkRoostVersion(request: NextRequest): VersionCheckResult {
  const raw = request.headers.get(ROOST_VERSION_HEADER);
  if (!raw || raw.trim().length === 0) {
    // Soft-advisory: pass but signal the caller should pin.
    console.warn(
      `[roost-version] request to ${request.nextUrl.pathname} missing '${ROOST_VERSION_HEADER}' header`,
    );
    return {
      ok: true,
      missing: true,
      effectiveVersion: CURRENT_ROOST_VERSION,
    };
  }
  const version = raw.trim();
  if (!SUPPORTED_ROOST_VERSIONS.includes(version)) {
    return {
      ok: false,
      response: problem({
        type: ProblemType.ValidationFailed,
        title: 'unsupported version',
        status: 400,
        detail: `roost-version '${version}' is not supported; supported: ${SUPPORTED_ROOST_VERSIONS.join(', ')}`,
        code: 'unsupported_version',
        sent: version,
        supported: SUPPORTED_ROOST_VERSIONS,
      }),
    };
  }
  return { ok: true, missing: false, effectiveVersion: version };
}

/** Attach the missing-version advisory header; no-op when the caller pinned. */
export function applyVersionHeaders(
  response: NextResponse,
  check: VersionCheckOk,
): NextResponse {
  if (check.missing) {
    response.headers.set(ROOST_VERSION_MISSING_HEADER, 'true');
  }
  return response;
}
