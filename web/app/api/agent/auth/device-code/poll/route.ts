import { NextRequest, NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
import { withRateLimit } from '@/lib/withRateLimit';

/**
 * POST /api/agent/auth/device-code/poll
 *
 * Agent polls this endpoint to check if the user has authorized the device code.
 * Returns pending (202), authorized with tokens (200), or expired (410).
 *
 * Request body (one of):
 * - deviceCode: string - The opaque device code from the generation step
 * - pairPhrase: string - The 3-word phrase (for /ADD= silent install flow)
 *
 * Response (202 - pending):
 * - status: 'pending'
 *
 * Response (200 - authorized):
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

    // Resolve the document reference first (outside transaction for query-based lookup)
    let docRef;

    if (pairPhrase) {
      // Direct lookup by phrase (for /ADD= silent install flow)
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
      // Lookup by device code hash (standard interactive flow)
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

    // Use a transaction to atomically check status and mark as consumed,
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
        // Clean up expired document
        transaction.update(docRef, { status: 'expired' });
        return { error: 'expired', status: 410 } as const;
      }

      // Check status
      if (data.status === 'pending') {
        return { body: { status: 'pending' }, status: 202 } as const;
      }

      if (data.status === 'authorized' && data.accessToken && data.refreshToken) {
        // Atomically mark as consumed (single-use) within the transaction
        transaction.update(docRef, { status: 'consumed' });

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
  } catch (error: any) {
    console.error('Error polling device code:', error);
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 }
    );
  }
}, {
  strategy: 'api',
  identifier: 'ip',
});
