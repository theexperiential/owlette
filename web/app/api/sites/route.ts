/**
 * GET  /api/sites
 * POST /api/sites
 *
 * List and create sites. Scoped API keys only see sites covered by explicit
 * `site` scopes; wildcard / legacy keys and session auth keep the underlying
 * user's account view.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { timestampToIso } from '@/lib/firestoreTime.server';
import {
  problem,
  problemFromError,
  problemForbidden,
  problemNotFound,
  problemValidation,
  problemUnauthorized,
  ProblemType,
} from '@/lib/apiErrors';
import {
  ApiAuthError,
  applyAuthDeprecations,
  resolveAuth,
  type ResolvedAuth,
} from '@/lib/apiAuth.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { withIdempotency } from '@/lib/idempotency';
import { authorizedPlatformHandler, type PlatformHandlerContext } from '@/lib/authorizedHandler.server';
import { Capability } from '@/lib/capabilities';
import { createSite } from '@/lib/actions/createSite.server';
import {
  applyAuthDeprecations as applyScopedAuthDeprecations,
  readAndParseJsonBody,
} from '../_shared';

interface CreateSiteBody {
  siteId?: unknown;
  name?: unknown;
  timezone?: unknown;
}

function auditActor(ctx: PlatformHandlerContext): string {
  return ctx.auth.keyContext
    ? `apiKey:${ctx.auth.keyContext.keyId}`
    : `user:${ctx.actor.userId}`;
}

export async function GET(request: NextRequest) {
  try {
    let auth: ResolvedAuth;
    try {
      auth = await resolveAuth(request);
    } catch (err) {
      if (err instanceof ApiAuthError) {
        if (err.code === 'token_expired') {
          return problem({
            type: ProblemType.TokenExpired,
            title: 'token expired',
            status: 401,
            detail: err.message,
            code: 'token_expired',
            ...(err.details ?? {}),
          });
        }
        if (err.status === 403) return problemForbidden();
        if (err.status === 404) return problemNotFound();
        return problemUnauthorized();
      }
      throw err;
    }

    const db = getAdminDb();
    const userDoc = await db.collection('users').doc(auth.userId).get();
    const userData = userDoc.exists ? userDoc.data() : null;
    const isSuperadmin = userData?.role === 'superadmin';
    const assignedSites: string[] = Array.isArray(userData?.sites) ? userData!.sites : [];

    // Determine the candidate site set the user can access.
    let candidates: Set<string> | 'all';
    if (isSuperadmin) {
      candidates = 'all';
    } else {
      // Also include sites the user owns directly.
      const ownedSnap = await db.collection('sites').where('owner', '==', auth.userId).get();
      const ownedIds = ownedSnap.docs.map((d) => d.id);
      candidates = new Set([...assignedSites, ...ownedIds]);
    }

    // Intersect with API-key scope when scoped to specific site ids.
    const scopeAllowed = scopeAllowedSites(auth.keyContext);

    let siteDocs: FirebaseFirestore.QueryDocumentSnapshot[];
    if (candidates === 'all') {
      const snap = await db.collection('sites').get();
      siteDocs = scopeAllowed
        ? snap.docs.filter((d) => scopeAllowed.has(d.id))
        : snap.docs;
    } else {
      const filtered = [...candidates].filter((id) =>
        scopeAllowed ? scopeAllowed.has(id) : true,
      );
      if (filtered.length === 0) {
        return applyAuthDeprecations(
          NextResponse.json({ sites: [] }),
          { isLegacy: auth.keyContext?.isLegacy === true },
        );
      }
      // Firestore 'in' queries cap at 30 — chunk.
      siteDocs = [];
      for (let i = 0; i < filtered.length; i += 30) {
        const chunk = filtered.slice(i, i + 30);
        const snap = await db.collection('sites').where('__name__', 'in', chunk).get();
        siteDocs.push(...snap.docs);
      }
    }

    const sites = siteDocs.map((d) => summariseSite(d));
    sites.sort((a, b) => a.name.localeCompare(b.name));

    return applyAuthDeprecations(
      NextResponse.json({ sites }),
      { isLegacy: auth.keyContext?.isLegacy === true },
    );
  } catch (err) {
    return problemFromError(err, 'v2/sites:GET');
  }
}

export const POST = authorizedPlatformHandler({
  capability: Capability.SITE_MEMBER_MANAGE,
  targetKind: 'site',
  apiKeyScope: { resource: 'site', permission: 'admin' },
})(async (request: NextRequest, ctx: PlatformHandlerContext) => {
  try {
    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;

    return await withIdempotency(
      request,
      {
        userId: ctx.actor.userId,
        environment: ctx.auth.keyContext?.environment ?? 'unknown',
      },
      parsed.raw,
      async () => {
        const body = parsed.body as CreateSiteBody;
        const result = await createSite(
          {
            auditActor: auditActor(ctx),
            endpoint: '/api/sites',
            method: 'POST',
          },
          {
            siteId: typeof body.siteId === 'string' ? body.siteId : '',
            name: typeof body.name === 'string' ? body.name : '',
            ownerUid: ctx.actor.userId,
            timezone: typeof body.timezone === 'string' ? body.timezone : undefined,
          },
        );

        if (result.kind === 'invalid_site_id') {
          return problemValidation(result.reason, {
            'body.siteId': [result.reason],
          });
        }
        if (result.kind === 'invalid_name') {
          return problemValidation(result.reason, {
            'body.name': [result.reason],
          });
        }
        if (result.kind === 'already_exists') {
          return problem({
            type: ProblemType.Conflict,
            title: 'site already exists',
            status: 409,
            detail: `site ${String(body.siteId)} already exists`,
            instance: '/api/sites',
            code: 'site_already_exists',
          });
        }

        return applyScopedAuthDeprecations(
          NextResponse.json(
            {
              siteId: result.siteId,
              name: result.name,
              timezone: result.timezone,
              owner: result.owner,
              tier: result.tier,
              createdAt: result.createdAt,
            },
            { status: 201 },
          ),
          ctx.scopeCheck,
        );
      },
    );
  } catch (err) {
    return problemFromError(err, 'v2/sites:POST');
  }
});

/**
 * Null = unrestricted (session, legacy key, or site wildcard); Set = restricted
 * to explicit site ids. Scoped API keys with no site scopes get an empty set.
 */
function scopeAllowedSites(keyContext: ResolvedAuth['keyContext']): Set<string> | null {
  if (!keyContext || keyContext.isLegacy || !keyContext.scopes) return null;
  const ids = new Set<string>();
  for (const s of keyContext.scopes) {
    if (s.resource !== 'site') continue;
    if (s.id === '*') return null; // wildcard beats any restriction
    ids.add(s.id);
  }
  return ids;
}

function summariseSite(d: FirebaseFirestore.QueryDocumentSnapshot): {
  id: string;
  name: string;
  plan: string | null;
  tier: 'core' | 'pro' | null;
  timezone: string | null;
  owner: string | null;
  createdAt: string | null;
} {
  const data = d.data();
  const rawTier = data.tier;
  const tier: 'core' | 'pro' | null =
    rawTier === 'core' || rawTier === 'pro' ? rawTier : null;
  return {
    id: d.id,
    name: typeof data.name === 'string' ? data.name : d.id,
    plan: typeof data.plan === 'string' ? data.plan : null,
    tier,
    timezone: typeof data.timezone === 'string' ? data.timezone : null,
    owner: typeof data.owner === 'string' ? data.owner : null,
    createdAt: timestampToIso(data.createdAt),
  };
}

