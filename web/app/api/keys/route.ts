import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { withRateLimit } from '@/lib/withRateLimit';
import { emitMutation } from '@/lib/auditLogClient';
import {
  ApiAuthError,
  assertUserHasSiteAccess,
  requireSessionOrIdToken,
} from '@/lib/apiAuth.server';
import { getAdminDb } from '@/lib/firebase-admin';
import {
  problem,
  problemForbidden,
  problemFromError,
  problemTokenExpired,
  problemUnauthorized,
  problemValidation,
  ProblemType,
} from '@/lib/apiErrors';
import {
  ALL_RESOURCES,
  type ApiKeyEnvironment,
  type ApiKeyLookup,
  type ApiKeyPermission,
  type ApiKeyRecord,
  type ApiKeyResource,
  type ApiKeyScope,
  DEFAULT_TTL_DAYS,
  MAX_TTL_DAYS,
  SUPERADMIN_ONLY_RESOURCES,
} from '@/lib/apiKeyTypes';

const VALID_RESOURCES: readonly ApiKeyResource[] = ALL_RESOURCES;
const VALID_PERMISSIONS: readonly ApiKeyPermission[] = [
  'read',
  'write',
  'deploy',
  'rollback',
  'admin',
];
const VALID_ENVIRONMENTS: readonly ApiKeyEnvironment[] = ['live', 'test'];
const MAX_NAME_LENGTH = 100;
const MAX_SCOPES = 50;

interface CreateKeyBody {
  name?: unknown;
  scopes?: unknown;
  ttlDays?: unknown;
  environment?: unknown;
}

function validateScopes(raw: unknown): ApiKeyScope[] | string {
  if (!Array.isArray(raw) || raw.length === 0) {
    return 'scopes must be a non-empty array';
  }
  if (raw.length > MAX_SCOPES) {
    return `scopes array too large (max ${MAX_SCOPES})`;
  }
  const scopes: ApiKeyScope[] = [];
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i];
    if (!s || typeof s !== 'object') {
      return `scopes[${i}] must be an object`;
    }
    const scope = s as Record<string, unknown>;
    if (!VALID_RESOURCES.includes(scope.resource as ApiKeyResource)) {
      return `scopes[${i}].resource must be one of ${VALID_RESOURCES.join(', ')}`;
    }
    if (typeof scope.id !== 'string' || scope.id.length === 0 || scope.id.length > 128) {
      return `scopes[${i}].id must be a non-empty string (max 128 chars)`;
    }
    if (!Array.isArray(scope.permissions) || scope.permissions.length === 0) {
      return `scopes[${i}].permissions must be a non-empty array`;
    }
    const perms = new Set<ApiKeyPermission>();
    for (const p of scope.permissions) {
      if (!VALID_PERMISSIONS.includes(p as ApiKeyPermission)) {
        return `scopes[${i}].permissions contains invalid value (must be one of ${VALID_PERMISSIONS.join(', ')})`;
      }
      perms.add(p as ApiKeyPermission);
    }
    scopes.push({
      resource: scope.resource as ApiKeyResource,
      id: scope.id,
      permissions: Array.from(perms),
    });
  }
  return scopes;
}

/**
 * POST /api/keys
 *
 * Create a new scoped API key for the authenticated user.
 *
 * Body:
 *   {
 *     name: string,
 *     scopes: [{resource, id, permissions[]}],
 *     ttlDays?: number (1-365, default 90),
 *     environment?: 'live' | 'test' (default 'live')
 *   }
 *
 * Returns the raw key once — only the SHA-256 hash is stored.
 */
export const POST = withRateLimit(
  async (request: NextRequest) => {
    try {
      const userId = await requireSessionOrIdToken(request);

      let body: CreateKeyBody;
      try {
        body = (await request.json()) as CreateKeyBody;
      } catch {
        return problemValidation('request body must be valid json');
      }

      const name =
        typeof body.name === 'string' && body.name.trim().length > 0
          ? body.name.trim().slice(0, MAX_NAME_LENGTH)
          : null;
      if (!name) {
        return problemValidation('name is required');
      }

      const scopesResult = validateScopes(body.scopes);
      if (typeof scopesResult === 'string') {
        return problemValidation(scopesResult);
      }
      const scopes = scopesResult;

      const superadminScopeWithConcreteId = scopes.find(
        (scope) =>
          SUPERADMIN_ONLY_RESOURCES.includes(scope.resource) &&
          scope.id !== '*',
      );
      if (superadminScopeWithConcreteId) {
        return problemValidation(
          `${superadminScopeWithConcreteId.resource} scopes must use id "*"`,
        );
      }

      const needsSuperadminGrant = scopes.some((scope) =>
        SUPERADMIN_ONLY_RESOURCES.includes(scope.resource),
      );
      if (needsSuperadminGrant) {
        const db = getAdminDb();
        const userDoc = await db.collection('users').doc(userId).get();
        const role = userDoc.exists ? userDoc.data()?.role : null;
        if (role !== 'superadmin') {
          return problemForbidden(
            'superadmin access required to create user or installer scopes',
          );
        }
      }

      const rawTtl = body.ttlDays === undefined ? DEFAULT_TTL_DAYS : body.ttlDays;
      if (typeof rawTtl !== 'number' || !Number.isFinite(rawTtl) || !Number.isInteger(rawTtl)) {
        return problemValidation('ttlDays must be an integer');
      }
      if (rawTtl < 1 || rawTtl > MAX_TTL_DAYS) {
        return problemValidation(`ttlDays must be between 1 and ${MAX_TTL_DAYS}`);
      }
      const ttlDays = rawTtl;

      const rawEnv = body.environment ?? 'live';
      if (!VALID_ENVIRONMENTS.includes(rawEnv as ApiKeyEnvironment)) {
        return problemValidation(
          `environment must be one of ${VALID_ENVIRONMENTS.join(', ')}`
        );
      }
      const environment = rawEnv as ApiKeyEnvironment;

      // Defense-in-depth: validate site-scoped ids against caller's own access.
      // Runtime requireScope() also enforces this; doing it here catches typos
      // and prevents storing unusable scopes.
      for (const scope of scopes) {
        if (scope.resource === 'site' && scope.id !== '*') {
          await assertUserHasSiteAccess(userId, scope.id);
        }
      }

      // owk_live_<43 base64url chars> or owk_test_<43 base64url chars>
      const keyRandom = crypto.randomBytes(32).toString('base64url');
      const rawKey = `owk_${environment}_${keyRandom}`;
      const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
      const keyId = crypto.randomUUID();
      const keyPrefix = rawKey.slice(0, 15);
      const now = Date.now();
      const expiresAt = now + ttlDays * 24 * 60 * 60 * 1000;

      const db = getAdminDb();
      const batch = db.batch();

      const record: Omit<ApiKeyRecord, 'createdAt'> & {
        createdAt: FirebaseFirestore.FieldValue;
      } = {
        name,
        keyHash,
        keyPrefix,
        environment,
        scopes,
        expiresAt,
        createdAt: FieldValue.serverTimestamp(),
        lastUsedAt: null,
      };

      batch.set(
        db.collection('users').doc(userId).collection('api_keys').doc(keyId),
        record
      );

      const lookup: ApiKeyLookup = {
        userId,
        keyId,
        environment,
        scopes,
        expiresAt,
      };
      batch.set(db.collection('api_keys').doc(keyHash), lookup);

      await batch.commit();

      emitMutation({
        kind: 'api_key_mutated',
        siteId: '',
        actor: `user:${userId}`,
        targetId: keyId,
        attributes: {
          verb: 'create',
          endpoint: request.nextUrl.pathname,
          method: request.method,
          environment,
          keyPrefix,
          scopeCount: scopes.length,
          ttlDays,
        },
      });

      return NextResponse.json({
        success: true,
        key: rawKey,
        keyId,
        name,
        environment,
        scopes,
        expiresAt,
        keyPrefix,
      });
    } catch (error: unknown) {
      if (error instanceof ApiAuthError) {
        if (error.code === 'token_expired') {
          const expiredAt =
            typeof error.details?.expiredAt === 'number' ? error.details.expiredAt : undefined;
          return problemTokenExpired(expiredAt);
        }
        if (error.status === 401) {
          return problemUnauthorized(error.message);
        }
        return problem({
          type:
            error.status === 403
              ? ProblemType.Forbidden
              : ProblemType.ValidationFailed,
          title: error.status === 403 ? 'forbidden' : 'validation failed',
          status: error.status,
          detail: error.message,
        });
      }
      return problemFromError(error, 'api/keys:POST');
    }
  },
  { strategy: 'api', identifier: 'ip' }
);

/**
 * GET /api/keys
 *
 * List the authenticated user's own API keys (metadata only — never the
 * raw key or hash).
 */
export const GET = withRateLimit(
  async (request: NextRequest) => {
    try {
      const userId = await requireSessionOrIdToken(request);
      const db = getAdminDb();

      const snap = await db
        .collection('users')
        .doc(userId)
        .collection('api_keys')
        .orderBy('createdAt', 'desc')
        .get();

      const keys = snap.docs.map((doc) => {
        const data = doc.data() as Partial<ApiKeyRecord>;
        return {
          id: doc.id,
          name: data.name ?? null,
          keyPrefix: data.keyPrefix ?? null,
          environment: data.environment ?? null,
          scopes: data.scopes ?? null,
          expiresAt: data.expiresAt ?? null,
          createdAt: data.createdAt ?? null,
          lastUsedAt: data.lastUsedAt ?? null,
          rotatedAt: data.rotatedAt ?? null,
          rotatedFromKeyId: data.rotatedFromKeyId ?? null,
          retiresAt: data.retiresAt ?? null,
          revokedAt: data.revokedAt ?? null,
        };
      });

      return NextResponse.json({ success: true, keys });
    } catch (error: unknown) {
      if (error instanceof ApiAuthError) {
        if (error.code === 'token_expired') {
          const expiredAt =
            typeof error.details?.expiredAt === 'number' ? error.details.expiredAt : undefined;
          return problemTokenExpired(expiredAt);
        }
        if (error.status === 401) {
          return problemUnauthorized(error.message);
        }
        return problem({
          type: ProblemType.Forbidden,
          title: 'forbidden',
          status: error.status,
          detail: error.message,
        });
      }
      return problemFromError(error, 'api/keys:GET');
    }
  },
  { strategy: 'api', identifier: 'ip' }
);
