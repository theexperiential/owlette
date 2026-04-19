'use client';

import { useState } from 'react';
import { getLoadingWord } from '@/lib/loadingWords';

/**
 * Renders a random industry-flavoured loading verb (e.g. "cooking...", "rendering...").
 * Word is picked once per mount so it doesn't flicker on re-renders.
 * suppressHydrationWarning avoids a server/client mismatch from Math.random.
 */
export function LoadingWord() {
  const [word] = useState(getLoadingWord);
  return <span suppressHydrationWarning>{word}...</span>;
}
