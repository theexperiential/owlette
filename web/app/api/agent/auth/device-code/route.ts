import { NextRequest, NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { withRateLimit } from '@/lib/withRateLimit';
import { generatePairPhrase } from '@/lib/pairPhrases';
import { apiError } from '@/lib/apiErrorResponse';
import { DEVICE_CODE_WRAP_VERSION } from '@/lib/deviceCodeCrypto';
import { getSessionFromRequest } from '@/lib/sessionManager.server';
import logger from '@/lib/logger';

/**
 * POST /api/agent/auth/device-code
 *
 * Generate a pairing phrase and device code for agent registration.
 * The agent displays the phrase and polls for authorization.
 *
 * Request body:
 * - machineId: string - Machine hostname (optional for pre-authorized codes)
 * - version: string - Agent version (optional for pre-authorized codes)
 *
 * Response (200):
 * - pairPhrase: string - 3-word human-readable phrase (e.g., "silver-compass-drift")
 * - deviceCode: string - Opaque code for polling (64 bytes, base64url)
 * - verificationUri: string - URL to visit for authorization
 * - pairingUrl: string - Full URL with phrase pre-filled (for browser auto-open)
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

    // Detect the dashboard "Generate Code" pre-authorise path: an
    // authenticated session means the request originated from a
    // logged-in browser tab (where the deviceCode will be discarded
    // immediately after authorize). Anonymous requests come from the
    // agent installer, which keeps the deviceCode in process memory
    // and can therefore receive an encrypted credential blob.
    let isDashboardOrigin = false;
    try {
      const session = await getSessionFromRequest(request);
      if (session.userId && session.expiresAt && Date.now() < session.expiresAt) {
        isDashboardOrigin = true;
      }
    } catch {
      // No session = anonymous installer call. Treat as interactive.
      isDashboardOrigin = false;
    }

    // Determine base URL from request
    const host = request.headers.get('host') || 'owlette.app';
    const protocol = host.includes('localhost') ? 'http' : 'https';
    const baseUrl = `${protocol}://${host}`;

    const expiresAt = Timestamp.fromDate(new Date(Date.now() + 10 * 60 * 1000)); // 10 minutes

    // Store device code in Firestore.
    //
    // Note on `deviceCode` plaintext storage: this is the polling secret
    // (held in the agent's process memory and never shown to the user),
    // not a credential. We persist it briefly so the authorize endpoint
    // can derive the HKDF key without the dashboard user ever holding
    // it. The authorize transaction wipes this field the moment it
    // encrypts the credentials, closing the window.
    //
    // For pre-authorised silent-install codes (Generate Code from the
    // dashboard), the deviceCode is discarded by the browser before
    // authorize runs, so authorize falls through to the legacy plaintext
    // path. Poll-by-phrase is permitted only for that flow.
    // For pre-authorised (dashboard "Generate Code") codes the
    // deviceCode is intentionally NOT persisted: the browser never
    // sends it back, and the agent installer that consumes the phrase
    // via /ADD=phrase has no way to obtain it. Authorize will see the
    // missing deviceCode and fall through to the plaintext path; the
    // /poll endpoint allows phrase-based redemption only for these
    // documents.
    const docPayload: Record<string, unknown> = {
      deviceCodeHash,
      wrapVersion: DEVICE_CODE_WRAP_VERSION,
      machineId: machineId || null,
      version: version || null,
      status: 'pending', // pending → authorized → (deleted on poll or expiry)
      createdAt: FieldValue.serverTimestamp(),
      expiresAt,
      // Populated by authorize:
      siteId: null,
      authorizedBy: null,
      authorizedAt: null,
      // Encrypted credential bundle (HKDF-AES-256-GCM, see
      // lib/deviceCodeCrypto.ts). Populated by authorize for the
      // interactive flow; left null for pre-authorised codes.
      encryptedCredentials: null,
      // Legacy plaintext credential fields, retained only for the
      // pre-authorised silent-install flow where no client holds the
      // HKDF key. New interactive flows leave these null.
      accessToken: null,
      refreshToken: null,
    };

    if (isDashboardOrigin) {
      docPayload.preauthorizedIntent = true;
    } else {
      // Interactive flow only: keep the deviceCode briefly so the
      // authorize transaction can derive the HKDF key. Wiped from the
      // doc the moment authorize encrypts the credential bundle.
      docPayload.deviceCode = deviceCode;
    }

    await adminDb.collection('device_codes').doc(pairPhrase).set(docPayload);

    logger.info(`Device code created: phrase=${pairPhrase}, machine=${machineId || 'pre-auth'}`);

    return NextResponse.json({
      pairPhrase,
      deviceCode,
      verificationUri: `${baseUrl}/add`,
      pairingUrl: `${baseUrl}/add?code=${encodeURIComponent(pairPhrase)}`,
      expiresIn: 600, // 10 minutes
      interval: 5, // poll every 5 seconds
    });
  } catch (error: unknown) {
    return apiError(error, 'agent/auth/device-code');
  }
}, {
  strategy: 'tokenExchange',
  identifier: 'ip',
});
