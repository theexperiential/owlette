import { NextRequest, NextResponse } from 'next/server';
import { getAdminAuth, getAdminDb, getAdminStorage } from '@/lib/firebase-admin';
import { withRateLimit } from '@/lib/withRateLimit';

/**
 * POST /api/agent/screenshot
 *
 * Agent-authenticated endpoint to upload a screenshot (base64 JPEG).
 * Uploads to Firebase Storage and stores the public URL in Firestore.
 *
 * Request headers:
 * - Authorization: Bearer <agent-firebase-id-token>
 *
 * Request body:
 * - siteId: string
 * - machineId: string
 * - screenshot: string (base64-encoded JPEG)
 * - agentVersion: string
 *
 * Storage path: screenshots/{siteId}/{machineId}/latest.jpg
 * Firestore write:
 *   sites/{siteId}/machines/{machineId} → lastScreenshot: { url, timestamp, sizeKB }
 */
export const POST = withRateLimit(
  async (request: NextRequest) => {
    try {
      // Verify agent Bearer token
      const authHeader = request.headers.get('Authorization') || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

      if (!token) {
        return NextResponse.json({ error: 'Missing Authorization header' }, { status: 401 });
      }

      let decodedToken;
      try {
        const adminAuth = getAdminAuth();
        decodedToken = await adminAuth.verifyIdToken(token);
      } catch {
        return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 });
      }

      // Require agent role
      if (decodedToken.role !== 'agent') {
        return NextResponse.json({ error: 'Forbidden — agent token required' }, { status: 403 });
      }

      // Parse body
      const body = await request.json();
      const { siteId, machineId, screenshot } = body;

      if (!siteId || !machineId || !screenshot) {
        return NextResponse.json(
          { error: 'Missing required fields: siteId, machineId, screenshot' },
          { status: 400 }
        );
      }

      // Verify the token's site_id matches
      if (decodedToken.site_id && decodedToken.site_id !== siteId) {
        return NextResponse.json({ error: 'site_id mismatch' }, { status: 403 });
      }

      // Decode base64 to buffer
      const imageBuffer = Buffer.from(screenshot, 'base64');
      const sizeKB = Math.round(imageBuffer.length / 1024);

      // Reject absurdly large screenshots (> 10MB)
      if (sizeKB > 10240) {
        return NextResponse.json(
          { error: `Screenshot too large: ${sizeKB}KB (max 10MB)` },
          { status: 413 }
        );
      }

      // Upload to Firebase Storage
      const storage = getAdminStorage();
      const bucket = storage.bucket();
      const filePath = `screenshots/${siteId}/${machineId}/latest.jpg`;
      const file = bucket.file(filePath);

      await file.save(imageBuffer, {
        metadata: {
          contentType: 'image/jpeg',
          cacheControl: 'public, max-age=60',
          metadata: {
            machineId,
            siteId,
            capturedAt: String(Date.now()),
          },
        },
      });

      // Make the file publicly readable
      await file.makePublic();

      // Get the public URL
      const url = `https://storage.googleapis.com/${bucket.name}/${filePath}`;
      // Append timestamp as cache-buster so browsers don't serve stale screenshots
      const urlWithCacheBuster = `${url}?t=${Date.now()}`;

      // Write URL reference to Firestore machine document
      const db = getAdminDb();
      const machineRef = db
        .collection('sites')
        .doc(siteId)
        .collection('machines')
        .doc(machineId);

      await machineRef.set(
        {
          lastScreenshot: {
            url: urlWithCacheBuster,
            timestamp: Date.now(),
            sizeKB,
          },
        },
        { merge: true }
      );

      console.log(`[agent/screenshot] Screenshot uploaded for ${machineId} (${sizeKB}KB) → Storage`);

      return NextResponse.json({ success: true, sizeKB, url: urlWithCacheBuster });
    } catch (error: unknown) {
      console.error('[agent/screenshot] Unhandled error:', error);
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
  },
  { strategy: 'agentAlert', identifier: 'ip' }
);
