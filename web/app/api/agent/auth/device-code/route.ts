import { NextRequest, NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { withRateLimit } from '@/lib/withRateLimit';
import { generatePairPhrase } from '@/lib/pairPhrases';
import logger from '@/lib/logger';

/**
 * POST /api/agent/auth/device-code
 *
 * Generate a pairing phrase and device code for agent registration.
 * The agent displays the phrase (+ QR code) and polls for authorization.
 *
 * Request body:
 * - machineId: string - Machine hostname (optional for pre-authorized codes)
 * - version: string - Agent version (optional for pre-authorized codes)
 *
 * Response (200):
 * - pairPhrase: string - 3-word human-readable phrase (e.g., "silver-compass-drift")
 * - deviceCode: string - Opaque code for polling (64 bytes, base64url)
 * - verificationUri: string - URL to visit for authorization
 * - qrUrl: string - Full URL with phrase pre-filled (for QR code)
 * - expiresIn: number - Seconds until expiry (600 = 10 minutes)
 * - interval: number - Minimum polling interval in seconds (5)
 */
export const POST = withRateLimit(async (request: NextRequest) => {
  try {
    const body = await request.json();
    const { machineId, version } = body;

    // Generate unique pairing phrase (retry on collision)
    const adminDb = getAdminDb();
    let pairPhrase: string;
    let attempts = 0;

    do {
      pairPhrase = generatePairPhrase();
      const existing = await adminDb.collection('device_codes').doc(pairPhrase).get();
      if (!existing.exists) break;
      attempts++;
    } while (attempts < 5);

    if (attempts >= 5) {
      return NextResponse.json(
        { error: 'Failed to generate unique pairing phrase. Please try again.' },
        { status: 500 }
      );
    }

    // Generate device code (opaque secret for polling — never shown to user)
    const crypto = await import('crypto');
    const deviceCode = crypto.randomBytes(64).toString('base64url');
    const deviceCodeHash = crypto.createHash('sha256').update(deviceCode).digest('hex');

    // Determine base URL from request
    const host = request.headers.get('host') || 'owlette.app';
    const protocol = host.includes('localhost') ? 'http' : 'https';
    const baseUrl = `${protocol}://${host}`;

    const expiresAt = Timestamp.fromDate(new Date(Date.now() + 10 * 60 * 1000)); // 10 minutes

    // Store device code in Firestore
    await adminDb.collection('device_codes').doc(pairPhrase).set({
      deviceCodeHash,
      machineId: machineId || null,
      version: version || null,
      status: 'pending', // pending → authorized → (deleted on poll or expiry)
      createdAt: FieldValue.serverTimestamp(),
      expiresAt,
      // These fields are populated when authorized:
      siteId: null,
      authorizedBy: null,
      authorizedAt: null,
      // These fields store the generated tokens for the poll endpoint to return:
      accessToken: null,
      refreshToken: null,
    });

    logger.info(`Device code created: phrase=${pairPhrase}, machine=${machineId || 'pre-auth'}`);

    return NextResponse.json({
      pairPhrase,
      deviceCode,
      verificationUri: `${baseUrl}/add`,
      qrUrl: `${baseUrl}/add?code=${encodeURIComponent(pairPhrase)}`,
      expiresIn: 600, // 10 minutes
      interval: 5, // poll every 5 seconds
    });
  } catch (error: any) {
    console.error('Error generating device code:', error);
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 }
    );
  }
}, {
  strategy: 'tokenExchange',
  identifier: 'ip',
});
