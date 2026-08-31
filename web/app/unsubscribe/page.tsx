'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import Link from 'next/link';
import { AuthShell, authFooterLinkClass } from '@/components/auth/AuthShell';

function UnsubscribeContent() {
  const searchParams = useSearchParams();
  const success = searchParams.get('success') === 'true';

  return (
    /* brandTitleAs="h1" because public/static.spec.ts queries both states by
       heading role, and the "unsubscribe" name is anchored — so this must be a
       real heading and must be the only one with that accessible name. */
    <AuthShell
      brandTitle={success ? 'unsubscribed' : 'unsubscribe'}
      brandTitleAs="h1"
      /* Deliberately not "something went wrong" — static.spec.ts matches that
         phrase with no .first(), so it may appear exactly once, in the body. */
      brandDescription={
        success ? 'alert emails are off' : "we couldn't update your preferences"
      }
      footer={
        <Link href="/dashboard" className={authFooterLinkClass}>
          go to dashboard
        </Link>
      }
    >
      <p className="text-center text-muted-foreground">
        {success
          ? 'all alert emails, including offline notifications, have been turned off. you can re-enable specific alert categories anytime in account settings.'
          : 'something went wrong. please try again or update your preferences in account settings.'}
      </p>
    </AuthShell>
  );
}

export default function UnsubscribePage() {
  return (
    /* useSearchParams forces this boundary; the fallback is the same shell so
       the card does not change shape when it resolves. */
    <Suspense fallback={<AuthShell brandTitle="unsubscribe" loading />}>
      <UnsubscribeContent />
    </Suspense>
  );
}
