'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';

/**
 * RequireAdmin Component
 *
 * Protects admin routes by checking if the user has admin role.
 * If not admin, redirects to dashboard with an error message.
 *
 * Usage:
 * Wrap admin pages/layouts with this component:
 *
 * <RequireAdmin>
 *   <YourAdminContent />
 * </RequireAdmin>
 */
export default function RequireAdmin({ children }: { children: React.ReactNode }) {
  const { user, loading, isAdmin } = useAuth();
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

    // If user exists but is not admin, redirect to dashboard
    if (!isAdmin) {
      toast.error('Access Denied', {
        description: 'You do not have permission to access this page.',
      });
      router.push('/dashboard');
    }
  }, [user, loading, isAdmin, router]);

  // Show nothing while loading or redirecting
  if (loading || !user || !isAdmin) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <div className="text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-accent-cyan border-r-transparent"></div>
          <p className="mt-4 text-muted-foreground">Verifying permissions...</p>
        </div>
      </div>
    );
  }

  // User is admin, render the protected content
  return <>{children}</>;
}
