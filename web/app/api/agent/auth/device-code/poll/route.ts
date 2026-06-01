import { NextRequest, NextResponse } from 'next/server';
import { getAdminAuth, getAdminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { withRateLimit } from '@/lib/withRateLimit';
import { apiError } from '@/lib/apiErrorResponse';
import { DEVICE_CODE_WRAP_VERSION } from '@/lib/deviceCodeCrypto';
import { normalizePairPhrase } from '@/lib/pairPhrases';

const MINT_CLAIM_LEASE_MS = 60_000;

function sanitizeMachineId(value: unknown): { ok: true; machineId: string | null } | { ok: false } {
  if (value === undefined || value === null) {
    return { ok: true, machineId: null };
  }

  if (typeof value !== 'string') {
    return { ok: false };
  }

  const machineId = value.trim();
  if (
    machineId.length < 1 ||
    machineId.length > 128 ||
    machineId.includes('/') ||
    /[\x00-\x1F]/.test(machineId)
  ) {
    return { ok: false };
  }

  return { ok: true, machineId };
}

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

    // Resolve the document reference first (outside transaction for query-based lookup).
    //
    // Lookup mode matters for security:
    //   - deviceCode lookup → either flow; v1 docs return encrypted blob,
    //     legacy docs return plaintext.
    //   - pairPhrase lookup → only succeeds for pre-authorised docs.
    //     Interactive-flow docs reject phrase polls inside the
    //     transaction below.
    let docRef;
    let adminDb: ReturnType<typeof getAdminDb>;
    const lookupMode: 'deviceCode' | 'pairPhrase' = pairPhrase ? 'pairPhrase' : 'deviceCode';
    let machineId: string | null = null;
    let version = 'unknown';

    if (lookupMode === 'pairPhrase') {
      if (typeof pairPhrase !== 'string') {
        return NextResponse.json(
          { error: 'Invalid pairing phrase format' },
          { status: 400 }
        );
      }

      const normalized = normalizePairPhrase(pairPhrase);
      if (!normalized) {
        return NextResponse.json(
          { error: 'Invalid pairing phrase format' },
          { status: 400 }
        );
      }

      const machineIdResult = sanitizeMachineId(body.machineId);
      if (!machineIdResult.ok) {
        return NextResponse.json(
          { error: 'Invalid machineId' },
          { status: 400 }
        );
      }
      machineId = machineIdResult.machineId;
      version =
        typeof body.version === 'string' && body.version.trim()
          ? body.version.trim()
          : 'unknown';

      adminDb = getAdminDb();
      docRef = adminDb.collection('device_codes').doc(normalized);
      const snapshot = await docRef.get();
      if (!snapshot.exists) {
        return NextResponse.json(
          { error: 'Invalid pairing phrase' },
          { status: 404 }
        );
      }

      const snapshotData = snapshot.data?.();
      if (
        snapshotData?.status === 'authorized' &&
        snapshotData.deferTokenMint === true &&
        !machineId
      ) {
        return NextResponse.json(
          { error: 'machineId required for this pairing phrase' },
          { status: 400 }
        );
      }
    } else {
      adminDb = getAdminDb();
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
        const isLegacyPlaintext =
          Boolean(data.accessToken && data.refreshToken && data.preauthorized === true);

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
        // is only allowed for the deferred-mint path or deploy-window plaintext docs.
        if (
          lookupMode === 'pairPhrase' &&
          !isV1 &&
          data.deferTokenMint !== true &&
          !isLegacyPlaintext
        ) {
          return {
            error:
              'this pairing phrase requires the matching device code (interactive pairing only)',
            status: 403,
          } as const;
        }

        if (lookupMode === 'pairPhrase' && !isV1 && data.deferTokenMint === true) {
          if (!machineId) {
            return { error: 'machineId required for this pairing phrase', status: 400 } as const;
          }
          if (!data.siteId || !data.authorizedBy) {
            return { error: 'Invalid device code state', status: 400 } as const;
          }
          if (data.mintClaimExpiresAt && data.mintClaimExpiresAt > Date.now()) {
            return { body: { status: 'pending' }, status: 202 } as const;
          }

          transaction.update(docRef, {
            mintMachineId: machineId,
            mintVersion: version,
            mintClaimExpiresAt: Date.now() + MINT_CLAIM_LEASE_MS,
          });
          return {
            claim: true,
            siteId: data.siteId as string,
            authorizedBy: data.authorizedBy as string,
            machineId: machineId as string,
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
          // deploy-window compat - remove next release
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

    if ('claim' in result) {
      const claimedMachineId = result.machineId;
      const agentUid = `agent_${result.siteId}_${claimedMachineId}`.replace(/[^a-zA-Z0-9_]/g, '_');
      const claims = {
        role: 'agent',
        site_id: result.siteId,
        machine_id: claimedMachineId,
        version,
      };

      const adminAuth = getAdminAuth();
      const customToken = await adminAuth.createCustomToken(agentUid, claims);

      const firebaseApiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
      if (!firebaseApiKey) {
        throw new Error('Firebase API key not configured');
      }

      const authResponse = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${firebaseApiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: customToken, returnSecureToken: true }),
        }
      );

      if (!authResponse.ok) {
        const errorData = await authResponse.json();
        throw new Error(`Failed to exchange custom token: ${errorData.error?.message || 'Unknown error'}`);
      }

      authResponse.body?.cancel();

      await adminAuth.setCustomUserClaims(agentUid, claims);

      const customTokenWithClaims = await adminAuth.createCustomToken(agentUid, claims);
      const refreshAuthResponse = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${firebaseApiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: customTokenWithClaims, returnSecureToken: true }),
        }
      );

      if (!refreshAuthResponse.ok) {
        const errorData = await refreshAuthResponse.json();
        throw new Error(`Failed to refresh token with claims: ${errorData.error?.message || 'Unknown error'}`);
      }

      const refreshAuthData = await refreshAuthResponse.json();
      const idToken = refreshAuthData.idToken;

      const crypto = await import('crypto');
      const refreshToken = crypto.randomBytes(64).toString('base64url');
      const refreshTokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
      const refreshTokenRef = adminDb.collection('agent_refresh_tokens').doc(refreshTokenHash);

      const done = await adminDb.runTransaction(async (transaction) => {
        const doc = await transaction.get(docRef);
        if (!doc.exists) {
          return false;
        }

        const data = doc.data()!;
        const expiresAt = data.expiresAt?.toMillis?.() || data.expiresAt?.getTime?.() || 0;
        if (Date.now() > expiresAt) {
          transaction.delete(docRef);
          return false;
        }

        if (data.mintMachineId !== claimedMachineId || !(data.mintClaimExpiresAt > Date.now())) {
          return false;
        }

        transaction.delete(docRef);
        transaction.set(refreshTokenRef, {
          siteId: result.siteId,
          machineId: claimedMachineId,
          version,
          createdBy: result.authorizedBy,
          createdAt: FieldValue.serverTimestamp(),
          lastUsed: FieldValue.serverTimestamp(),
          agentUid,
        });
        return true;
      });

      if (!done) {
        return NextResponse.json({ error: 'Invalid pairing phrase' }, { status: 404 });
      }

      return NextResponse.json(
        {
          accessToken: idToken,
          refreshToken,
          expiresIn: 3600,
          siteId: result.siteId,
        },
        { status: 200 }
      );
    }

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
