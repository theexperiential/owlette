/**
 * web-side mirror of `agent/src/roost_kill_switch.py` (wave 5.4).
 *
 * Per-site v2 kill switch. An admin sets `sites/{siteId}.roostEnabled = false`
 * in firestore to halt all new roost work for that site — the API routes
 * refuse to issue signed URLs or finalise versions until it flips back.
 *
 * Constants MUST stay in sync with the python side; a `test_field_name_is_stable`
 * test locks it in on the agent, and this file is load-bearing for the gate
 * logic on every roost route.
 *
 * **fail-open semantics**: missing flag OR read error = ENABLED. A transient
 * firestore blip should never silently disable a customer.
 */

import { problem, ProblemType } from './apiErrors';
import type { NextResponse } from 'next/server';

/** Field name on `sites/{siteId}` doc. Must match ROOST_ENABLED_FIELD in python. */
export const ROOST_ENABLED_FIELD = 'roostEnabled';

/**
 * Pure decision: given a site doc shape (or null), is roost enabled?
 * Fail-open rules match the python side.
 */
export function isEnabledFromDoc(doc: Record<string, unknown> | null | undefined): boolean {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return true;
  const value = doc[ROOST_ENABLED_FIELD];
  if (value === undefined || value === null) return true;
  if (typeof value === 'boolean') return value;
  // non-boolean value — fail-open + leave the warning to the log layer.
  return true;
}

/**
 * Build a standardised `problem+json` response for callers to return when
 * the kill switch is engaged. 503 because "service is temporarily
 * unavailable for this site" matches the HTTP semantics; `ProblemType.ServiceUnavailable`
 * carries the stable URI clients switch on.
 */
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
 * Gate helper for API routes. Reads the site doc via `readSiteDoc`, decides
 * enabled/disabled, and returns either null (pass through) or a 503 response.
 *
 *   const gated = await gateOrProceed(siteId, readSiteDoc);
 *   if (gated) return gated;
 *
 * The caller supplies `readSiteDoc` so server-side callers can use whatever
 * firestore-admin wrapper they already have without this module reaching
 * into admin SDK directly.
 */
export async function gateOrProceed(
  siteId: string,
  readSiteDoc: (siteId: string) => Promise<Record<string, unknown> | null>,
): Promise<NextResponse | null> {
  let doc: Record<string, unknown> | null = null;
  try {
    doc = await readSiteDoc(siteId);
  } catch {
    // fail-open on read error — same contract as the python side.
    return null;
  }
  if (isEnabledFromDoc(doc)) return null;
  return roostDisabledResponse(siteId);
}
