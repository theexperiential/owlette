import { NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';

/**
 * GET /download
 *
 * Public permalink that redirects to the latest installer download URL.
 * No authentication required — the download URL itself is a signed Firebase
 * Storage URL with its own expiry.
 */
export async function GET() {
  try {
    const db = getAdminDb();
    const latestDoc = await db.collection('installer_metadata').doc('latest').get();
    const latestData = latestDoc.data();
    const version =
      typeof latestData?.version === 'string' && latestData.version.length > 0
        ? latestData.version
        : null;

    if (!latestDoc.exists || !version) {
      return NextResponse.redirect(new URL('/login', process.env.NEXT_PUBLIC_BASE_URL || 'https://owlette.app'));
    }

    const versionDoc = await db
      .collection('installer_metadata')
      .doc('data')
      .collection('versions')
      .doc(version)
      .get();
    const versionData = versionDoc.data();
    const downloadUrl =
      typeof versionData?.download_url === 'string'
        ? versionData.download_url
        : latestData?.download_url;

    if (!versionDoc.exists || typeof versionData?.deletedAt === 'number' || !downloadUrl) {
      return NextResponse.redirect(new URL('/login', process.env.NEXT_PUBLIC_BASE_URL || 'https://owlette.app'));
    }

    return NextResponse.redirect(downloadUrl);
  } catch (error) {
    console.error('[download] Failed to fetch latest installer:', error);
    return NextResponse.redirect(new URL('/login', process.env.NEXT_PUBLIC_BASE_URL || 'https://owlette.app'));
  }
}
