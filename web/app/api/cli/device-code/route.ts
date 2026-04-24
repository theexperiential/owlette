/**
 * POST /api/cli/device-code
 *
 * CLI device-code handshake — step 1 of 3.
 *
 * Generates a 3-word pairing phrase + opaque device code. The CLI
 * displays the phrase and points the user at /cli/authorize?code=<phrase>;
 * the user picks a site + scope preset + ttl in their browser (they must
 * be signed in); the CLI polls `/poll` to receive the owk_* key.
 *
 * Response:
 *   {
 *     pairPhrase: string,       // e.g. "silver-compass-drift"
 *     deviceCode: string,       // 64-byte base64url opaque secret
 *     verificationUri: string,  // https://.../cli/authorize
 *     pairingUrl: string,       // verificationUri + ?code=<phrase>
 *     expiresIn: number,        // 600 (10 min)
 *     interval: number,         // 5 (poll seconds)
 *   }
 *
 * Mirrors the agent flow at /api/agent/auth/device-code but returns an
 * api key instead of a firebase custom token. Stored in a separate
 * `cli_device_codes` firestore collection to avoid collisions.
 */
import { NextRequest, NextResponse } from 'next/server';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { withRateLimit } from '@/lib/withRateLimit';
import { getAdminDb } from '@/lib/firebase-admin';
import { generatePairPhrase } from '@/lib/pairPhrases';
import { apiError } from '@/lib/apiErrorResponse';

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

      await db.collection('cli_device_codes').doc(pairPhrase).set({
        deviceCodeHash,
        status: 'pending',
        createdAt: FieldValue.serverTimestamp(),
        expiresAt,
        // Populated by the authorize step:
        authorizedBy: null,
        authorizedAt: null,
        siteId: null,
        keyId: null,
        // Populated ONCE — poll deletes the doc on read, so the secret
        // can't hang around.
        rawKey: null,
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
