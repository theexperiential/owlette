'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from '@/lib/toast';

/**
 * Gate for the admin panel: `minRole` is the lowest global role that may see the
 * wrapped subtree ('admin' also admits superadmins). Anyone below it is bounced
 * to /dashboard with an error toast.
 *
 * Role-only by design — which *sites* an admin may act on is scoped per page by
 * `useSites`, and again server-side on every write.
 */
export default function RequireAdminAccess({
  minRole,
  children,
}: {
  minRole: 'admin' | 'superadmin';
  children: React.ReactNode;
}) {
  const { user, loading, role, isSuperadmin } = useAuth();
  const router = useRouter();

  const allowed = minRole === 'admin' ? role === 'admin' || role === 'superadmin' : isSuperadmin;

  useEffect(() => {
    if (loading) return;

    // The proxy should already have redirected; double-check for safety.
    if (!user) {
      router.push('/login');
      return;
    }

    if (!allowed) {
      toast.error('access denied', {
        description: 'you do not have permission to access this page.',
      });
      router.push('/dashboard');
    }
  }, [user, loading, allowed, router]);

  if (loading || !user || !allowed) {
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
