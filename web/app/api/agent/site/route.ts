import { NextRequest, NextResponse } from 'next/server';
import { getAdminAuth, getAdminDb } from '@/lib/firebase-admin';
import { withRateLimit } from '@/lib/withRateLimit';
import { apiError } from '@/lib/apiErrorResponse';
import { problemForbidden, problemNotFound, problemUnauthorized } from '@/lib/apiErrors';

/**
 * GET /api/agent/site
 *
 * Resolves the *display name* of the site an agent is paired to, so the
 * desktop app can say "TEC-A4D is connected to TEC" instead of showing the
 * raw site id. Read once per connect by `firebase_client._fetch_site_metadata`
 * and cached agent-side — there is no polling loop here to protect.
 *
 * Request headers:
 * - Authorization: Bearer <agent-firebase-id-token>
 *
 * Response (200):
 * - name: string | null — null when the site exists but has no name set, so
 *   the caller falls back to the site id rather than rendering "null".
 *
 * Errors (RFC 7807 problem+json): 401 missing/invalid bearer, 403 non-agent
 * token or a token with no `site_id` claim, 404 the claimed site is gone.
 *
 * ── why this endpoint exists at all ──────────────────────────────────────
 * Agents cannot read `sites/{siteId}` directly. `firestore.rules` grants an
 * agent access to its machine subtree only (`agentCanAccessMachine`), so the
 * agent's REST read of the site document 403s. Widening that rule would work,
 * and is deliberately NOT the fix — see below.
 *
 * ── why NAME ONLY, and never the whole document ──────────────────────────
 * The site document also carries `timezone`, which the agent reads into
 * `site_timezone` and which — the moment it is non-None — flips schedule
 * evaluation for every process on the machine from machine-local time to
 * site time (`shared_utils.is_within_schedule(..., _cached_site_timezone)`).
 * That is a deliberate, fleet-wide behavior change that has been DEFERRED; it
 * is a decision, not something that should arrive as a side effect of adding
 * a cosmetic label to the footer. So this route projects exactly one field.
 * Adding `timezone` (or returning the raw doc) here silently activates
 * site-timezone scheduling on every paired machine — don't, unless that
 * change is the thing being shipped.
 *
 * ── authorization ────────────────────────────────────────────────────────
 * The site is taken from the token's own `site_id` claim, minted by
 * `/api/agent/auth/device-code/poll` alongside `role: 'agent'` and
 * `machine_id`. It is never accepted from the query string or body, so an
 * agent token can only ever resolve the name of its own site and there is no
 * id to validate or mismatch-check. `machine_id` is not consulted: the name
 * is site-scoped, identical for every machine in the site.
 *
 * No cache headers: the agent caches the answer for the life of a connection.
 */
export const GET = withRateLimit(
  async (request: NextRequest) => {
    try {
      const authHeader = request.headers.get('Authorization') || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

      if (!token) {
        return problemUnauthorized('missing Authorization header');
      }

      let decodedToken;
      try {
        const adminAuth = getAdminAuth();
        decodedToken = await adminAuth.verifyIdToken(token);
      } catch {
        return problemUnauthorized('invalid or expired token');
      }

      if (decodedToken.role !== 'agent') {
        return problemForbidden('agent token required');
      }

      const siteId = typeof decodedToken.site_id === 'string' ? decodedToken.site_id.trim() : '';
      if (!siteId) {
        return problemForbidden('agent token carries no site_id claim');
      }

      const siteDoc = await getAdminDb().collection('sites').doc(siteId).get();
      if (!siteDoc.exists) {
        return problemNotFound('site not found');
      }

      const rawName = siteDoc.data()?.name;
      const name = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : null;

      return NextResponse.json({ name });
    } catch (error: unknown) {
      return apiError(error, 'agent/site');
    }
  },
  { strategy: 'api', identifier: 'ip' }
);
