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
 * Storage paths:
 *   screenshots/{siteId}/{machineId}/latest.jpg (overwritten each time)
 *   screenshots/{siteId}/{machineId}/history/{timestamp}.jpg (history, max 20 kept)
 * Firestore writes:
 *   sites/{siteId}/machines/{machineId} → lastScreenshot: { url, timestamp, sizeKB }
 *   sites/{siteId}/machines/{machineId}/screenshots/{docId} → { url, timestamp, sizeKB }
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
      const bucketName = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
      if (!bucketName) {
        console.error('[agent/screenshot] NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET not configured');
        return NextResponse.json({ error: 'Storage not configured' }, { status: 500 });
      }
      const bucket = storage.bucket(bucketName);
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

      // --- Screenshot history ---
      const captureTimestamp = Date.now();

      // Upload history copy with timestamped path
      const historyPath = `screenshots/${siteId}/${machineId}/history/${captureTimestamp}.jpg`;
      const historyFile = bucket.file(historyPath);
      await historyFile.save(imageBuffer, {
        metadata: {
          contentType: 'image/jpeg',
          cacheControl: 'public, max-age=31536000', // immutable history file
          metadata: { machineId, siteId, capturedAt: String(captureTimestamp) },
        },
      });
      await historyFile.makePublic();
      const historyUrl = `https://storage.googleapis.com/${bucket.name}/${historyPath}`;

      // Write to screenshots subcollection
      const screenshotsCol = machineRef.collection('screenshots');
      await screenshotsCol.add({
        url: historyUrl,
        timestamp: captureTimestamp,
        sizeKB,
      });

      // Auto-prune: keep only the 20 most recent
      const MAX_HISTORY = 20;
      const allDocs = await screenshotsCol.orderBy('timestamp', 'asc').get();
      if (allDocs.size > MAX_HISTORY) {
        const toDelete = allDocs.docs.slice(0, allDocs.size - MAX_HISTORY);
        for (const docSnap of toDelete) {
          const data = docSnap.data();
          // Delete Storage file
          try {
            const oldPath = data.url?.split(`${bucket.name}/`)?.[1];
            if (oldPath) await bucket.file(oldPath).delete();
          } catch {
            // Storage file may already be deleted
          }
          // Delete Firestore doc
          await docSnap.ref.delete();
        }
        console.log(`[agent/screenshot] Pruned ${toDelete.length} old screenshots for ${machineId}`);
      }

      console.log(`[agent/screenshot] Screenshot uploaded for ${machineId} (${sizeKB}KB) → Storage + history`);

      return NextResponse.json({ success: true, sizeKB, url: urlWithCacheBuster });
    } catch (error: unknown) {
      console.error('[agent/screenshot] Unhandled error:', error);
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
  },
  { strategy: 'api', identifier: 'ip' }
);
