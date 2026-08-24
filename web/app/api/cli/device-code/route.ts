/**
 * POST /api/cli/device-code — CLI device-code handshake, step 1 of 3.
 *
 * Mints a 3-word pairing phrase + opaque device code. The CLI shows the phrase and points
 * the user at /cli/authorize?code=<phrase>, where a signed-in user picks site, scope
 * preset and ttl; the CLI polls `/poll` for the owk_* key.
 *
 * Response: `{ pairPhrase, deviceCode (64-byte base64url secret), verificationUri,
 * pairingUrl, expiresIn: 600, interval: 5 }`.
 *
 * Mirrors the agent flow at /api/agent/auth/device-code but returns an api key instead of
 * a firebase custom token, in a separate `cli_device_codes` collection to avoid collisions.
 */
import { NextRequest, NextResponse } from 'next/server';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { withRateLimit } from '@/lib/withRateLimit';
import { getAdminDb } from '@/lib/firebase-admin';
import { generatePairPhrase } from '@/lib/pairPhrases';
import { apiError } from '@/lib/apiErrorResponse';
import { DEVICE_CODE_WRAP_VERSION } from '@/lib/deviceCodeCrypto';

export const POST = withRateLimit(
  async (request: NextRequest) => {
    try {
      const db = getAdminDb();

      // Retry on phrase collision (extremely rare in a < 10-minute window).
      let pairPhrase: string | null = null;
      for (let i = 0; i < 5; i++) {
        const candidate = generatePairPhrase();
        const existing = await db.collection('cli_device_codes').doc(candidate).get();
        if (!existing.exists) {
          pairPhrase = candidate;
          break;
        }
      }
      if (!pairPhrase) {
        return NextResponse.json(
          { error: 'could not generate a unique pairing phrase; please retry' },
          { status: 500 },
        );
      }

      const crypto = await import('crypto');
      const deviceCode = crypto.randomBytes(64).toString('base64url');
      const deviceCodeHash = crypto.createHash('sha256').update(deviceCode).digest('hex');

      const host = request.headers.get('host') || 'owlette.app';
      const protocol = host.includes('localhost') ? 'http' : 'https';
      const baseUrl = `${protocol}://${host}`;

      const expiresAt = Timestamp.fromDate(new Date(Date.now() + 10 * 60 * 1000));

      // `deviceCode` is the CLI's polling secret — process memory only, never shown to the
      // dashboard user. It stays on the doc only until authorize encrypts the api key under a
      // key derived from it, then wipes the field.
      await db.collection('cli_device_codes').doc(pairPhrase).set({
        deviceCodeHash,
        deviceCode, // consumed and wiped by authorize
        wrapVersion: DEVICE_CODE_WRAP_VERSION,
        status: 'pending',
        createdAt: FieldValue.serverTimestamp(),
        expiresAt,
        // Populated by the authorize step:
        authorizedBy: null,
        authorizedAt: null,
        siteId: null,
        keyId: null,
        // Encrypted credential bundle (HKDF + AES-256-GCM); the raw api key never lands in clear.
        encryptedCredentials: null,
      });

      return NextResponse.json({
        pairPhrase,
        deviceCode,
        verificationUri: `${baseUrl}/cli/authorize`,
        pairingUrl: `${baseUrl}/cli/authorize?code=${encodeURIComponent(pairPhrase)}`,
        expiresIn: 600,
        interval: 5,
      });
    } catch (err) {
      return apiError(err, 'cli/device-code');
    }
  },
  { strategy: 'tokenExchange', identifier: 'ip' },
);
