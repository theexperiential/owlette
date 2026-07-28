'use client';

import { LoadingWord } from '@/components/LoadingWord';

/**
 * Loading state for the metrics detail chart — a miniature line graph that
 * plots itself on a loop above the usual loading verb. Pure CSS: the
 * `chart-plot-draw` keyframes live in globals.css, and pathLength={100}
 * normalizes the dash math so the path geometry can change without touching
 * the keyframes. aria-hidden because the parent loading container already
 * carries role="status" and the label.
 */
export function ChartLoadingIndicator() {
  return (
    <div className="flex flex-col items-center gap-3 text-muted-foreground">
      <svg width="96" height="32" viewBox="0 0 96 32" fill="none" aria-hidden="true">
        <path
          d="M2 26 L18 14 L34 22 L50 8 L66 18 L82 5 L94 12"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          pathLength={100}
          className="animate-chart-plot-draw"
        />
      </svg>
      <div className="animate-pulse text-sm"><LoadingWord /></div>
    </div>
  );
}
