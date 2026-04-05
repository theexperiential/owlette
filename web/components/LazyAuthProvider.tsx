'use client';

import { type ReactNode } from 'react';
import { AuthProvider } from '@/contexts/AuthContext';

/**
 * Wraps children in AuthProvider. Previously lazy-loaded to defer Firebase SDK,
 * but dynamic import caused a tree-structure change (Fragment → Provider) that
 * unmounted/remounted the entire child tree, restarting all CSS animations.
 */
export function LazyAuthProvider({ children }: { children: ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}
