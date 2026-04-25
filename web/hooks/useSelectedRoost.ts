'use client';

import { useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

export interface UseSelectedRoostResult {
  selectedRoostId: string | null;
  setSelectedRoostId: (id: string | null) => void;
}

export function useSelectedRoost(): UseSelectedRoostResult {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const raw = searchParams.get('roost');
  const trimmed = raw?.trim() ?? '';
  const selectedRoostId = trimmed.length > 0 ? trimmed : null;

  const setSelectedRoostId = useCallback((id: string | null): void => {
    const params = new URLSearchParams(searchParams.toString());
    const trimmedId = id?.trim() ?? '';
    if (trimmedId.length === 0) {
      params.delete('roost');
    } else {
      params.set('roost', trimmedId);
    }
    const qs = params.toString();
    const next = qs ? `${pathname}?${qs}` : pathname;
    router.push(next);
  }, [router, pathname, searchParams]);

  return { selectedRoostId, setSelectedRoostId };
}
