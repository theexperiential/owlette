/**
 * POST /api/cli/device-code/authorize
 *
 * CLI device-code handshake — step 2 of 3 (browser side).
 *
 * The user, already signed in to the dashboard, visits
 * /cli/authorize?code=<phrase> and picks a site + scope preset + ttl.
 * That page POSTs here to mint an owk_* api key scoped to their choices,
 * then stores the raw key in the `cli_device_codes/{phrase}` doc so the
 * CLI's /poll call picks it up.
 *
 * Body:
 *   {
 *     code: string (pairing phrase),
 *     name: string,
 *     scopes: ApiKeyScope[],
 *     ttlDays?: number (default 90, max 365),
 *     environment?: 'live'|'test' (default 'live')
 *   }
 *
 * Returns:
 *   { success: true, keyId, keyPrefix }  — session cookie required
 */
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { withRateLimit } from '@/lib/withRateLimit';
import {
  ApiAuthError,
  assertUserHasSiteAccess,
  requireSessionOrIdToken,
} from '@/lib/apiAuth.server';
import { getAdminDb } from '@/lib/firebase-admin';
import {
  type ApiKeyEnvironment,
  type ApiKeyLookup,
  type ApiKeyPermission,
  type ApiKeyRecord,
  type ApiKeyResource,
  type ApiKeyScope,
  DEFAULT_TTL_DAYS,
  MAX_TTL_DAYS,
} from '@/lib/apiKeyTypes';
import { apiError } from '@/lib/apiErrorResponse';

const VALID_RESOURCES: readonly ApiKeyResource[] = ['roost', 'site', 'machine'];
const VALID_PERMISSIONS: readonly ApiKeyPermission[] = [
  'read',
  'write',
  'deploy',
  'rollback',
  'admin',
];
const VALID_ENVIRONMENTS: readonly ApiKeyEnvironment[] = ['live', 'test'];

interface AuthorizeBody {
  code?: unknown;
  name?: unknown;
  scopes?: unknown;
  ttlDays?: unknown;
  environment?: unknown;
}

function validateScopes(raw: unknown): ApiKeyScope[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return 'scopes must be a non-empty array';
  const out: ApiKeyScope[] = [];
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i];
    if (!s || typeof s !== 'object') return `scopes[${i}] must be an object`;
    const scope = s as Record<string, unknown>;
    if (!VALID_RESOURCES.includes(scope.resource as ApiKeyResource)) {
      return `scopes[${i}].resource invalid`;
    }
    if (typeof scope.id !== 'string' || scope.id.length === 0) {
      return `scopes[${i}].id required`;
    }
    if (!Array.isArray(scope.permissions) || scope.permissions.length === 0) {
      return `scopes[${i}].permissions required`;
    }
    const perms = new Set<ApiKeyPermission>();
    for (const p of scope.permissions) {
      if (!VALID_PERMISSIONS.includes(p as ApiKeyPermission)) {
        return `scopes[${i}].permissions contains invalid value`;
      }
      perms.add(p as ApiKeyPermission);
    }
    out.push({
      resource: scope.resource as ApiKeyResource,
      id: scope.id,
      permissions: Array.from(perms),
    });
  }
  return out;
}

export const POST = withRateLimit(
  async (request: NextRequest) => {
    try {
      const userId = await requireSessionOrIdToken(request);

      const body = (await request.json().catch(() => ({}))) as AuthorizeBody;

      const code = typeof body.code === 'string' ? body.code.toLowerCase().trim() : '';
      if (!code) {
        return NextResponse.json({ error: 'code is required' }, { status: 400 });
      }

      const name =
        typeof body.name === 'string' && body.name.trim().length > 0
          ? body.name.trim().slice(0, 100)
          : null;
      if (!name) {
        return NextResponse.json({ error: 'name is required' }, { status: 400 });
      }

      const scopesResult = validateScopes(body.scopes);
      if (typeof scopesResult === 'string') {
        return NextResponse.json({ error: scopesResult }, { status: 400 });
      }
      const scopes = scopesResult;

      const rawTtl = body.ttlDays === undefined ? DEFAULT_TTL_DAYS : body.ttlDays;
      if (
        typeof rawTtl !== 'number' ||
        !Number.isFinite(rawTtl) ||
        !Number.isInteger(rawTtl) ||
        rawTtl < 1 ||
        rawTtl > MAX_TTL_DAYS
      ) {
        return NextResponse.json(
          { error: `ttlDays must be an integer between 1 and ${MAX_TTL_DAYS}` },
          { status: 400 },
        );
      }
      const ttlDays = rawTtl;

      const rawEnv = body.environment ?? 'live';
      if (!VALID_ENVIRONMENTS.includes(rawEnv as ApiKeyEnvironment)) {
        return NextResponse.json(
          { error: `environment must be one of ${VALID_ENVIRONMENTS.join(', ')}` },
          { status: 400 },
        );
      }
      const environment = rawEnv as ApiKeyEnvironment;

      // Defense-in-depth: validate site-scoped ids against the caller's access.
      for (const scope of scopes) {
        if (scope.resource === 'site' && scope.id !== '*') {
          await assertUserHasSiteAccess(userId, scope.id);
        }
      }

      const db = getAdminDb();
      const codeRef = db.collection('cli_device_codes').doc(code);
      const codeSnap = await codeRef.get();
      if (!codeSnap.exists) {
        return NextResponse.json(
          { error: 'invalid or expired pairing phrase' },
          { status: 404 },
        );
      }
      const codeData = codeSnap.data() ?? {};
      const expiresAtMs = codeData.expiresAt?.toMillis?.() ?? 0;
      if (Date.now() > expiresAtMs) {
        return NextResponse.json({ error: 'pairing phrase expired' }, { status: 410 });
      }
      if (codeData.status !== 'pending') {
        return NextResponse.json(
          { error: 'pairing phrase has already been authorised' },
          { status: 409 },
        );
      }

      // Mint the scoped api key.
      const keyRandom = crypto.randomBytes(32).toString('base64url');
      const rawKey = `owk_${environment}_${keyRandom}`;
      const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
      const keyId = crypto.randomUUID();
      const keyPrefix = rawKey.slice(0, 15);
      const now = Date.now();
      const keyExpiresAt = now + ttlDays * 24 * 60 * 60 * 1000;

      const primarySite = scopes.find((s) => s.resource === 'site' && s.id !== '*')?.id ?? null;

      const batch = db.batch();

      const record: Omit<ApiKeyRecord, 'createdAt'> & {
        createdAt: FirebaseFirestore.FieldValue;
      } = {
        name,
        keyHash,
        keyPrefix,
        environment,
        scopes,
        expiresAt: keyExpiresAt,
        createdAt: FieldValue.serverTimestamp(),
        lastUsedAt: null,
      };
      batch.set(
        db.collection('users').doc(userId).collection('api_keys').doc(keyId),
        record,
      );

      const lookup: ApiKeyLookup = {
        userId,
        keyId,
        environment,
        scopes,
        expiresAt: keyExpiresAt,
      };
      batch.set(db.collection('api_keys').doc(keyHash), lookup);

      // Stash the raw key in the device-code doc for the cli's /poll to
      // read + delete atomically. This is the only time the raw key leaves
      // the mint path unhashed.
      batch.update(codeRef, {
        status: 'authorized',
        authorizedBy: userId,
        authorizedAt: FieldValue.serverTimestamp(),
        keyId,
        name,
        scopes,
        environment,
        keyExpiresAt,
        siteId: primarySite,
        rawKey,
      });

      await batch.commit();

      return NextResponse.json({
        success: true,
        keyId,
        keyPrefix,
      });
    } catch (error: unknown) {
      if (error instanceof ApiAuthError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      return apiError(error, 'cli/device-code/authorize');
    }
  },
  { strategy: 'user', identifier: 'ip' },
);
