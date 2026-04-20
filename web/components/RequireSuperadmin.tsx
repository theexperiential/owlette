'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';

/**
 * RequireSuperadmin Component
 *
 * Protects superadmin-only routes by checking if the user has the superadmin role.
 * If not superadmin, redirects to dashboard with an error message.
 *
 * Usage:
 * Wrap superadmin pages/layouts with this component:
 *
 * <RequireSuperadmin>
 *   <YourSuperadminContent />
 * </RequireSuperadmin>
 */
export default function RequireSuperadmin({ children }: { children: React.ReactNode }) {
  const { user, loading, isSuperadmin } = useAuth();
  const router = useRouter();

  useEffect(() => {
    // Wait for auth to finish loading
    if (loading) return;

    // If no user, the middleware will redirect to login
    // But we double-check here for safety
    if (!user) {
      router.push('/login');
      return;
    }

    // If user exists but is not superadmin, redirect to dashboard
    if (!isSuperadmin) {
      toast.error('access denied', {
        description: 'you do not have permission to access this page.',
      });
      router.push('/dashboard');
    }
  }, [user, loading, isSuperadmin, router]);

  // Show nothing while loading or redirecting
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

  // User is superadmin, render the protected content
  return <>{children}</>;
}
