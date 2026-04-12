import { NextRequest, NextResponse } from 'next/server';
import { requireAdminOrIdToken, assertUserHasSiteAccess, ApiAuthError } from '@/lib/apiAuth.server';
import { getAdminDb, getAdminStorage } from '@/lib/firebase-admin';
import { apiError } from '@/lib/apiErrorResponse';

/**
 * DELETE /api/admin/screenshots
 *
 * Delete screenshot history for a machine.
 *
 * Query params:
 *   siteId: string
 *   machineId: string
 *   screenshotId?: string  — Delete a single screenshot. If omitted, deletes ALL history.
 */
export async function DELETE(request: NextRequest) {
  try {
    const userId = await requireAdminOrIdToken(request);
    const { searchParams } = request.nextUrl;
    const siteId = searchParams.get('siteId');
    const machineId = searchParams.get('machineId');
    const screenshotId = searchParams.get('screenshotId');

    if (!siteId || !machineId) {
      return NextResponse.json({ error: 'Missing siteId or machineId' }, { status: 400 });
    }

    await assertUserHasSiteAccess(userId, siteId);

    const db = getAdminDb();
    const storage = getAdminStorage();
    const bucketName = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
    const bucket = bucketName ? storage.bucket(bucketName) : null;

    const screenshotsCol = db
      .collection('sites').doc(siteId)
      .collection('machines').doc(machineId)
      .collection('screenshots');

    if (screenshotId) {
      // Delete single screenshot
      const docRef = screenshotsCol.doc(screenshotId);
      const docSnap = await docRef.get();

      if (!docSnap.exists) {
        return NextResponse.json({ error: 'Screenshot not found' }, { status: 404 });
      }

      // Delete Storage file
      const data = docSnap.data();
      if (bucket && data?.url) {
        try {
          const storagePath = data.url.split(`${bucket.name}/`)?.[1]?.split('?')[0];
          if (storagePath) await bucket.file(storagePath).delete();
        } catch {
          // Storage file may already be deleted
        }
      }

      await docRef.delete();
      return NextResponse.json({ success: true, deleted: 1 });
    }

    // Delete ALL history
    const allDocs = await screenshotsCol.get();

    if (allDocs.empty) {
      return NextResponse.json({ success: true, deleted: 0 });
    }

    let deleted = 0;
    for (const docSnap of allDocs.docs) {
      const data = docSnap.data();
      // Delete Storage file
      if (bucket && data?.url) {
        try {
          const storagePath = data.url.split(`${bucket.name}/`)?.[1]?.split('?')[0];
          if (storagePath) await bucket.file(storagePath).delete();
        } catch {
          // Storage file may already be deleted
        }
      }
      await docSnap.ref.delete();
      deleted++;
    }

    // Also clear the lastScreenshot field on the machine doc
    const machineRef = db.collection('sites').doc(siteId).collection('machines').doc(machineId);
    await machineRef.update({ lastScreenshot: null });

    // Delete the latest.jpg from Storage too
    if (bucket) {
      try {
        await bucket.file(`screenshots/${siteId}/${machineId}/latest.jpg`).delete();
      } catch {
        // May not exist
      }
    }

    return NextResponse.json({ success: true, deleted });
  } catch (error: any) {
    if (error instanceof ApiAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return apiError(error, 'admin/screenshots');
  }
}
