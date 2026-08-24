import { NextRequest, NextResponse } from 'next/server';
import { getAdminAuth, getAdminDb } from '@/lib/firebase-admin';
import { withRateLimit } from '@/lib/withRateLimit';
import { apiError } from '@/lib/apiErrorResponse';
import { problemForbidden, problemNotFound, problemUnauthorized } from '@/lib/apiErrors';

/**
 * GET /api/agent/site — display name of the site an agent is paired to, so the
 * desktop app can say "TEC-A4D is connected to TEC". Read once per connect by
 * `firebase_client._fetch_site_metadata` and cached agent-side.
 *
 * Auth: `Authorization: Bearer <agent-firebase-id-token>`. Exists because
 * firestore.rules grants an agent its machine subtree only
 * (`agentCanAccessMachine`), so a direct read of `sites/{siteId}` 403s.
 *
 * 200 `{ name: string | null }` — null when the site has no name, so the caller
 * falls back to the id rather than rendering "null". 401 missing/invalid bearer,
 * 403 non-agent token or no `site_id` claim, 404 site gone.
 *
 * NAME ONLY, never the whole document: the site doc also carries `timezone`,
 * which the agent reads into `site_timezone` and which — once non-None — flips
 * schedule evaluation for every process from machine-local to site time. That
 * fleet-wide change is DEFERRED, so do not add `timezone` or return the raw doc
 * unless that change is what's being shipped.
 *
 * The site comes from the token's own `site_id` claim (minted by
 * /api/agent/auth/device-code/poll), never from query or body, so a token can
 * only resolve its own site. `machine_id` is irrelevant — the name is
 * site-scoped. No cache headers; the agent caches for the connection's life.
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
