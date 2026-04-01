'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Legacy setup page — redirects to /add (new device code pairing flow).
 *
 * Kept as a redirect for backward compatibility with any existing bookmarks
 * or agent installers that reference /setup.
 */
export default function SetupPage() {
  const router = useRouter();

  useEffect(() => {
    // Preserve any query params (e.g., callback_port from old installers)
    const params = typeof window !== 'undefined' ? window.location.search : '';
    router.replace(`/add${params}`);
  }, [router]);

  return null;
}
