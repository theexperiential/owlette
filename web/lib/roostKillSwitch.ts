/**
 * Web-side mirror of `agent/src/roost_kill_switch.py`.
 *
 * Per-site kill switch: `sites/{siteId}.roostEnabled = false` halts new roost
 * work — no signed URLs, no version finalisation — until it flips back.
 *
 * Constants MUST stay in sync with the python side (`test_field_name_is_stable`
 * locks it there).
 *
 * FAIL-OPEN: missing flag OR read error = ENABLED. A firestore blip must never
 * silently disable a customer.
 */

import { problem, ProblemType } from './apiErrors';
import type { NextResponse } from 'next/server';

/** Field name on `sites/{siteId}` doc. Must match ROOST_ENABLED_FIELD in python. */
export const ROOST_ENABLED_FIELD = 'roostEnabled';

/** Pure decision, fail-open, matching the python side. */
export function isEnabledFromDoc(doc: Record<string, unknown> | null | undefined): boolean {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return true;
  const value = doc[ROOST_ENABLED_FIELD];
  if (value === undefined || value === null) return true;
  if (typeof value === 'boolean') return value;
  // Non-boolean: fail open; warning is the log layer's job.
  return true;
}

/** 503 problem+json for an engaged kill switch — clients switch on the type URI. */
export function roostDisabledResponse(siteId: string): NextResponse {
  return problem({
    type: ProblemType.ServiceUnavailable,
    title: 'roost disabled',
    status: 503,
    detail:
      `roost is currently disabled for site ${siteId}. contact your admin ` +
      `or check the site settings.`,
    instance: `/sites/${siteId}`,
  });
}

/**
 * Route gate: null to pass through, or a 503.
 *
 *   const gated = await gateOrProceed(siteId, readSiteDoc);
 *   if (gated) return gated;
 *
 * `readSiteDoc` is injected so this module never reaches into the admin SDK.
 */
export async function gateOrProceed(
  siteId: string,
  readSiteDoc: (siteId: string) => Promise<Record<string, unknown> | null>,
): Promise<NextResponse | null> {
  let doc: Record<string, unknown> | null = null;
  try {
    doc = await readSiteDoc(siteId);
  } catch {
    // Fail open on read error, as the python side does.
    return null;
  }
  if (isEnabledFromDoc(doc)) return null;
  return roostDisabledResponse(siteId);
}
