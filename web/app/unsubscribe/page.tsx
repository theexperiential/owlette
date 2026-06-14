'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import Link from 'next/link';

function UnsubscribeContent() {
  const searchParams = useSearchParams();
  const success = searchParams.get('success') === 'true';

  return (
    <div className="relative flex min-h-screen items-center justify-center p-4">
      {/* Grid background */}
      <div className="absolute inset-0 dot-grid opacity-30" />
      <div className="absolute inset-0 blueprint-grid opacity-15" />
      <div className="relative z-10 w-full max-w-md rounded-lg border border-border bg-card p-8 text-center">
        {success ? (
          <>
            <h1 className="mb-4 text-2xl font-bold text-foreground">unsubscribed</h1>
            <p className="mb-6 text-muted-foreground">
              all alert emails, including offline notifications, have been turned off.
              you can re-enable specific alert categories anytime in account settings.
            </p>
          </>
        ) : (
          <>
            <h1 className="mb-4 text-2xl font-bold text-foreground">unsubscribe</h1>
            <p className="mb-6 text-muted-foreground">
              something went wrong. please try again or update your preferences in account settings.
            </p>
          </>
        )}
        <Link
          href="/dashboard"
          className="text-accent-cyan hover:text-accent-cyan-hover text-sm"
        >
          go to dashboard
        </Link>
      </div>
    </div>
  );
}

export default function UnsubscribePage() {
  return (
    <Suspense fallback={
      <div className="relative flex min-h-screen items-center justify-center">
        <div className="absolute inset-0 dot-grid opacity-30" />
        <div className="absolute inset-0 blueprint-grid opacity-15" />
        <p className="relative z-10 text-muted-foreground">loading...</p>
      </div>
    }>
      <UnsubscribeContent />
    </Suspense>
  );
}
