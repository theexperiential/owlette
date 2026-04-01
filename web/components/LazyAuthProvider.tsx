'use client';

import { type ReactNode, useEffect, useState, type ComponentType } from 'react';

/**
 * Lazily loads AuthProvider so Firebase SDK isn't in the initial page bundle.
 * Children render immediately with default auth context (user: null, loading: true).
 * Once the dynamic import resolves, children are wrapped in the real AuthProvider.
 */
export function LazyAuthProvider({ children }: { children: ReactNode }) {
  const [Provider, setProvider] = useState<ComponentType<{ children: ReactNode }> | null>(null);

  useEffect(() => {
    import('@/contexts/AuthContext').then(mod => {
      setProvider(() => mod.AuthProvider);
    });
  }, []);

  if (Provider) return <Provider>{children}</Provider>;
  return <>{children}</>;
}
