import type { SVGProps } from 'react';

/**
 * hoot's owl. Hand-drawn — no mainstream line-icon set ships an owl that matches a 2px-stroke UI
 * language. Follows lucide's conventions (24×24 grid, currentColor 2px round strokes, no fill) so
 * it composes with lucide siblings. Precedent: `components/landing/OwletteEye.tsx`.
 *
 * Geometry is tuned for the 16–20px nav glyph, its most common size in-app:
 *  - Ring eyes, not dots — the holes are what survive downscaling. Solid dots plus a tufted head
 *    read as a cat at every size.
 *  - Plain circle head, so at 16px only four strokes cross the middle with real gaps. Ear tufts
 *    are notches cut into that circle (same centre, same radius); pointed corner ears read as a cat.
 *  - The beak is load-bearing — without it two rings under a brow read as spectacles.
 */
export function HootIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={24}
      height={24}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M5.39 6.05 4.5 3.5l3.32.64a8.9 8.9 0 0 1 8.36 0l3.32-.64-.89 2.55a8.9 8.9 0 1 1-13.22 0Z" />
      <circle cx="8.2" cy="11.5" r="2.3" />
      <circle cx="15.8" cy="11.5" r="2.3" />
      <path d="m12 15.9 1.2 2h-2.4z" />
    </svg>
  );
}
