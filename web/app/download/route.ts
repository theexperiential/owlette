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

    if (!latestDoc.exists || !latestDoc.data()?.download_url) {
      return NextResponse.redirect(new URL('/login', process.env.NEXT_PUBLIC_BASE_URL || 'https://owlette.app'));
    }

    return NextResponse.redirect(latestDoc.data()!.download_url);
  } catch (error) {
    console.error('[download] Failed to fetch latest installer:', error);
    return NextResponse.redirect(new URL('/login', process.env.NEXT_PUBLIC_BASE_URL || 'https://owlette.app'));
  }
}
