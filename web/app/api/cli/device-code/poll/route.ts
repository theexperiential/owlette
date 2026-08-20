/**
 * POST /api/cli/device-code/poll — step 3 of the CLI device-code handshake.
 *
 * Body `{ deviceCode }`. Pending → 202; authorised → 200 with the credentials
 * (the firestore doc is deleted in the same transaction); expired → 410.
 *
 *   202 { status: 'pending' }
 *   200 v1     { wrapVersion: 'v1', encryptedCredentials, phrase }
 *   200 legacy { apiKey, keyId, name, scopes, environment, expiresAt, siteId }
 *   410 { error: 'expired' } · 404 { error: 'invalid device code' }
 *
 * v1 callers decrypt locally with
 * `HKDF-SHA256(deviceCode, salt=phrase, info='owlette-device-code-v1')` →
 * AES-256-GCM; canonical impls in lib/deviceCodeCrypto.ts and
 * agent/src/auth_manager.py.
 */
import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { getAdminDb } from '@/lib/firebase-admin';
import { apiError } from '@/lib/apiErrorResponse';
import { DEVICE_CODE_WRAP_VERSION } from '@/lib/deviceCodeCrypto';

export const POST = withRateLimit(
  async (request: NextRequest) => {
    try {
      const body = await request.json().catch(() => ({}));
      const deviceCode = typeof body?.deviceCode === 'string' ? body.deviceCode : '';
      if (!deviceCode) {
        return NextResponse.json(
          { error: 'missing required field: deviceCode' },
          { status: 400 },
        );
      }

      const db = getAdminDb();
      const crypto = await import('crypto');
      const deviceCodeHash = crypto.createHash('sha256').update(deviceCode).digest('hex');

      const snap = await db
        .collection('cli_device_codes')
        .where('deviceCodeHash', '==', deviceCodeHash)
        .limit(1)
        .get();
      if (snap.empty) {
        return NextResponse.json({ error: 'invalid device code' }, { status: 404 });
      }
      const docRef = snap.docs[0].ref;

      const result = await db.runTransaction(async (tx) => {
        const doc = await tx.get(docRef);
        if (!doc.exists) {
          return { error: 'invalid device code', status: 404 } as const;
        }
        const data = doc.data() ?? {};

        const expiresAtMs = data.expiresAt?.toMillis?.() ?? 0;
        if (Date.now() > expiresAtMs) {
          tx.delete(docRef);
          return { error: 'expired', status: 410 } as const;
        }

        if (data.status === 'pending') {
          return { body: { status: 'pending' as const }, status: 202 } as const;
        }

        if (data.status === 'authorized') {
          const isV1 =
            data.wrapVersion === DEVICE_CODE_WRAP_VERSION &&
            typeof data.encryptedCredentials === 'string' &&
            data.encryptedCredentials.length > 0;

          if (isV1) {
            tx.delete(docRef);
            return {
              body: {
                wrapVersion: DEVICE_CODE_WRAP_VERSION,
                encryptedCredentials: data.encryptedCredentials as string,
                phrase: docRef.id,
              },
              status: 200,
            } as const;
          }

          if (typeof data.rawKey === 'string') {
            // Legacy plaintext fallback for pre-deploy docs; new cli builds use
            // the encrypted path.
            tx.delete(docRef);
            return {
              body: {
                apiKey: data.rawKey,
                keyId: data.keyId ?? null,
                name: data.name ?? null,
                scopes: data.scopes ?? null,
                environment: data.environment ?? null,
                expiresAt: data.keyExpiresAt ?? null,
                siteId: data.siteId ?? null,
              },
              status: 200,
            } as const;
          }
        }

        return { error: 'invalid device code state', status: 400 } as const;
      });

      if ('error' in result) {
        return NextResponse.json({ error: result.error }, { status: result.status });
      }
      return NextResponse.json(result.body, { status: result.status });
    } catch (err) {
      return apiError(err, 'cli/device-code/poll');
    }
  },
  { strategy: 'api', identifier: 'ip' },
);
