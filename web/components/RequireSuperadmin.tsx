'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from '@/lib/toast';

/**
 * Gate for superadmin-only routes: non-superadmins are bounced to /dashboard
 * with an error toast. Wrap the page or layout in it.
 */
export default function RequireSuperadmin({ children }: { children: React.ReactNode }) {
  const { user, loading, isSuperadmin } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;

    // The proxy should already have redirected; double-check for safety.
    if (!user) {
      router.push('/login');
      return;
    }

    if (!isSuperadmin) {
      toast.error('access denied', {
        description: 'you do not have permission to access this page.',
      });
      router.push('/dashboard');
    }
  }, [user, loading, isSuperadmin, router]);

  if (loading || !user || !isSuperadmin) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <div className="text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-accent-cyan border-r-transparent"></div>
          <p className="mt-4 text-muted-foreground">verifying permissions...</p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
