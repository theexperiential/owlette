import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { FieldValue } from 'firebase-admin/firestore';
import {
  ApiAuthError,
  assertActiveUser,
  requireSessionOrIdToken,
} from '@/lib/apiAuth.server';
import { emitMutation } from '@/lib/auditLogClient';
import { getAdminDb } from '@/lib/firebase-admin';
import {
  problem,
  problemFromError,
  problemTokenExpired,
  problemUnauthorized,
  problemNotFound,
  problemValidation,
  ProblemType,
} from '@/lib/apiErrors';
import {
  type ApiKeyEnvironment,
  type ApiKeyLookup,
  type ApiKeyRecord,
  DEFAULT_TTL_DAYS,
  MAX_TTL_DAYS,
  ROTATION_GRACE_MS,
} from '@/lib/apiKeyTypes';

interface RouteParams {
  params: Promise<{ keyId: string }>;
}

interface RotateBody {
  ttlDays?: unknown;
}

/**
 * POST /api/keys/{keyId}/rotate
 *
 * Issue a new raw key with the same scopes + environment and a fresh
 * `expiresAt`. The old key enters a 24-hour grace window where both keys
 * are valid; after grace, the old key is rejected (via the `retiresAt`
 * check in resolveApiKeyContext).
 *
 * Body (optional):
 *   { ttlDays?: number }  1-365, default 90
 *
 * Response: same shape as POST /api/keys.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
      const userId = await requireSessionOrIdToken(request);
      await assertActiveUser(userId);
      const { keyId } = await params;

      if (!keyId || typeof keyId !== 'string') {
        return problemValidation('keyId is required');
      }

      let body: RotateBody = {};
      try {
        const raw = await request.text();
        if (raw.length > 0) body = JSON.parse(raw) as RotateBody;
      } catch {
        return problemValidation('request body must be valid json');
      }

      const rawTtl = body.ttlDays === undefined ? DEFAULT_TTL_DAYS : body.ttlDays;
      if (
        typeof rawTtl !== 'number' ||
        !Number.isFinite(rawTtl) ||
        !Number.isInteger(rawTtl)
      ) {
        return problemValidation('ttlDays must be an integer');
      }
      if (rawTtl < 1 || rawTtl > MAX_TTL_DAYS) {
        return problemValidation(`ttlDays must be between 1 and ${MAX_TTL_DAYS}`);
      }
      const ttlDays = rawTtl;

      const db = getAdminDb();
      const oldKeyRef = db
        .collection('users')
        .doc(userId)
        .collection('api_keys')
        .doc(keyId);
      const oldKeySnap = await oldKeyRef.get();

      if (!oldKeySnap.exists) {
        return problemNotFound('api key not found');
      }

      const oldKey = oldKeySnap.data() as Partial<ApiKeyRecord> & {
        keyHash?: string;
      };

      if (oldKey.revokedAt) {
        return problem({
          type: ProblemType.Conflict,
          title: 'key revoked',
          status: 409,
          detail: 'this api key has been revoked and cannot be rotated',
        });
      }

      if (oldKey.rotatedAt) {
        return problem({
          type: ProblemType.Conflict,
          title: 'key already rotated',
          status: 409,
          detail:
            'this api key was already rotated; use the successor key issued by the prior rotation',
        });
      }

      if (!oldKey.keyHash) {
        return problemFromError(
          new Error('api key record missing keyHash'),
          'api/keys/rotate',
        );
      }

      // Legacy pre-scoping keys have no scopes/environment. Carry a sensible
      // default forward so the rotated key is a valid modern key: 'live' env,
      // empty scopes[] triggers the legacy bypass path — but users should
      // create a fresh scoped key rather than rotate legacy ones. We preserve
      // whatever scopes exist verbatim.
      const environment: ApiKeyEnvironment =
        (oldKey.environment as ApiKeyEnvironment) ?? 'live';
      const scopes = Array.isArray(oldKey.scopes) ? oldKey.scopes : [];
      const name = typeof oldKey.name === 'string' ? oldKey.name : 'api key';

      const now = Date.now();
      const keyRandom = crypto.randomBytes(32).toString('base64url');
      const rawKey = `owk_${environment}_${keyRandom}`;
      const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
      const newKeyId = crypto.randomUUID();
      const keyPrefix = rawKey.slice(0, 15);
      const expiresAt = now + ttlDays * 24 * 60 * 60 * 1000;
      const retiresAt = now + ROTATION_GRACE_MS;

      const batch = db.batch();

      const newRecord: Omit<ApiKeyRecord, 'createdAt'> & {
        createdAt: FirebaseFirestore.FieldValue;
        rotatedFromKeyId: string;
      } = {
        name,
        keyHash,
        keyPrefix,
        environment,
        scopes,
        expiresAt,
        createdAt: FieldValue.serverTimestamp(),
        lastUsedAt: null,
        rotatedFromKeyId: keyId,
      };

      batch.set(
        db.collection('users').doc(userId).collection('api_keys').doc(newKeyId),
        newRecord,
      );

      const newLookup: ApiKeyLookup = {
        userId,
        keyId: newKeyId,
        environment,
        scopes,
        expiresAt,
      };
      batch.set(db.collection('api_keys').doc(keyHash), newLookup);

      // Old key: stamp rotation fields. Its lookup entry gets retiresAt so
      // the auth resolver can reject requests after the grace window. Until
      // then, both keys work.
      batch.update(oldKeyRef, {
        rotatedAt: now,
        retiresAt,
      });
      batch.update(db.collection('api_keys').doc(oldKey.keyHash), {
        retiresAt,
      });

      await batch.commit();

      emitMutation({
        kind: 'api_key_mutated',
        siteId: '',
        actor: `user:${userId}`,
        targetId: newKeyId,
        attributes: {
          verb: 'rotate',
          endpoint: request.nextUrl.pathname,
          method: request.method,
          environment,
          keyPrefix,
          rotatedFromKeyId: keyId,
          previousKeyRetiresAt: retiresAt,
          scopeCount: scopes.length,
          ttlDays,
        },
      });

      return NextResponse.json({
        success: true,
        key: rawKey,
        keyId: newKeyId,
        name,
        environment,
        scopes,
        expiresAt,
        keyPrefix,
        rotatedFromKeyId: keyId,
        previousKey: {
          keyId,
          retiresAt,
        },
      });
    } catch (error: unknown) {
      if (error instanceof ApiAuthError) {
        if (error.code === 'token_expired') {
          const expiredAt =
            typeof error.details?.expiredAt === 'number' ? error.details.expiredAt : undefined;
          return problemTokenExpired(expiredAt);
        }
        if (error.status === 401) return problemUnauthorized(error.message);
        return problem({
          type: ProblemType.Forbidden,
          title: 'forbidden',
          status: error.status,
          detail: error.message,
        });
      }
      return problemFromError(error, 'api/keys/rotate');
    }
}
