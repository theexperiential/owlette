import { NextRequest, NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
import { withRateLimit } from '@/lib/withRateLimit';
import { apiError } from '@/lib/apiErrorResponse';
import { DEVICE_CODE_WRAP_VERSION } from '@/lib/deviceCodeCrypto';

/**
 * POST /api/agent/auth/device-code/poll
 *
 * Agent polls this endpoint to check if the user has authorized the device code.
 * Returns pending (202), authorized with tokens (200), or expired (410).
 *
 * Request body (one of):
 * - deviceCode: string - The opaque device code from the generation step
 *   (interactive pairing flow; preferred — receives encrypted credentials)
 * - pairPhrase: string - The 3-word phrase, accepted ONLY for documents
 *   that were pre-authorised from the dashboard (`/ADD=` silent install).
 *   Interactive-flow docs reject phrase-based polling so the phrase
 *   shown on the installer screen cannot be used to redeem credentials.
 *
 * Response (202 - pending):
 * - status: 'pending'
 *
 * Response (200 - authorized, v1 / interactive):
 * - encryptedCredentials: string (base64 iv||tag||ciphertext)
 * - wrapVersion: 'v1'
 * - phrase: string (HKDF salt; equal to the doc id)
 *
 * Response (200 - authorized, legacy / pre-authorised):
 * - accessToken: string
 * - refreshToken: string
 * - expiresIn: number (3600)
 * - siteId: string
 *
 * Response (410 - expired):
 * - error: 'expired'
 *
 * Response (404 - not found):
 * - error: 'Invalid device code'
 */
export const POST = withRateLimit(async (request: NextRequest) => {
  try {
    const body = await request.json();
    const { deviceCode, pairPhrase } = body;

    if (!deviceCode && !pairPhrase) {
      return NextResponse.json(
        { error: 'Missing required field: deviceCode or pairPhrase' },
        { status: 400 }
      );
    }

    const adminDb = getAdminDb();

    // Resolve the document reference first (outside transaction for query-based lookup).
    //
    // Lookup mode matters for security:
    //   - deviceCode lookup → either flow; v1 docs return encrypted blob,
    //     legacy docs return plaintext.
    //   - pairPhrase lookup → only succeeds for pre-authorised docs.
    //     Interactive-flow docs reject phrase polls inside the
    //     transaction below.
    let docRef;
    const lookupMode: 'deviceCode' | 'pairPhrase' = pairPhrase ? 'pairPhrase' : 'deviceCode';

    if (lookupMode === 'pairPhrase') {
      const normalized = pairPhrase.toLowerCase().trim();
      docRef = adminDb.collection('device_codes').doc(normalized);
      const snapshot = await docRef.get();
      if (!snapshot.exists) {
        return NextResponse.json(
          { error: 'Invalid pairing phrase' },
          { status: 404 }
        );
      }
    } else {
      const crypto = await import('crypto');
      const deviceCodeHash = crypto.createHash('sha256').update(deviceCode).digest('hex');

      const snapshot = await adminDb.collection('device_codes')
        .where('deviceCodeHash', '==', deviceCodeHash)
        .limit(1)
        .get();

      if (snapshot.empty) {
        return NextResponse.json(
          { error: 'Invalid device code' },
          { status: 404 }
        );
      }
      docRef = snapshot.docs[0].ref;
    }

    // Use a transaction to atomically read tokens and delete the document,
    // preventing race conditions where two concurrent poll requests both
    // read 'authorized' and both receive the tokens.
    const result = await adminDb.runTransaction(async (transaction) => {
      const doc = await transaction.get(docRef);

      if (!doc.exists) {
        return { error: 'Invalid device code', status: 404 } as const;
      }

      const data = doc.data()!;

      // Check expiry
      const expiresAt = data.expiresAt?.toMillis?.() || data.expiresAt?.getTime?.() || 0;
      if (Date.now() > expiresAt) {
        // Clean up expired document — no reason to retain it
        transaction.delete(docRef);
        return { error: 'expired', status: 410 } as const;
      }

      // Check status
      if (data.status === 'pending') {
        return { body: { status: 'pending' }, status: 202 } as const;
      }

      if (data.status === 'authorized') {
        const isV1 =
          data.wrapVersion === DEVICE_CODE_WRAP_VERSION &&
          typeof data.encryptedCredentials === 'string' &&
          data.encryptedCredentials.length > 0;

        // Phrase-based polling is only valid for pre-authorised docs.
        // An interactive (v1) doc carrying a wrapped blob requires the
        // caller to present the matching deviceCode — otherwise the
        // phrase alone could be used to fetch the ciphertext and (with
        // a separate firestore read) attempt offline attacks against
        // the AES-GCM tag.
        if (lookupMode === 'pairPhrase' && isV1) {
          return {
            error:
              'this pairing phrase requires the matching device code (interactive pairing only)',
            status: 403,
          } as const;
        }
        // Same defensive check for legacy docs: phrase-based redemption
        // is only allowed when the doc was explicitly pre-authorised.
        if (lookupMode === 'pairPhrase' && !isV1 && data.preauthorized !== true) {
          return {
            error:
              'this pairing phrase requires the matching device code (interactive pairing only)',
            status: 403,
          } as const;
        }

        if (isV1) {
          // Single-use: delete the doc atomically with the read.
          transaction.delete(docRef);
          return {
            body: {
              wrapVersion: DEVICE_CODE_WRAP_VERSION,
              encryptedCredentials: data.encryptedCredentials as string,
              phrase: docRef.id,
            },
            status: 200,
          } as const;
        }

        if (data.accessToken && data.refreshToken) {
          // Legacy / pre-authorised plaintext path.
          transaction.delete(docRef);
          return {
            body: {
              accessToken: data.accessToken,
              refreshToken: data.refreshToken,
              expiresIn: 3600,
              siteId: data.siteId,
            },
            status: 200,
          } as const;
        }
      }

      // Unexpected state
      return { error: 'Invalid device code state', status: 400 } as const;
    });

    if ('error' in result) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status }
      );
    }

    return NextResponse.json(result.body, { status: result.status });
  } catch (error: unknown) {
    return apiError(error, 'agent/auth/device-code/poll');
  }
}, {
  strategy: 'api',
  identifier: 'ip',
});
