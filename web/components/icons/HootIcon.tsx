import type { SVGProps } from 'react';

/**
 * hoot's owl.
 *
 * Hand-drawn because no mainstream line-icon set ships one — lucide,
 * heroicons, phosphor, tabler, and font awesome's free set are all owl-less,
 * and the packs that do have owls (emoji sets, game-icon packs) don't match
 * a 2px-stroke UI language. Drawn to lucide's conventions (24×24 grid,
 * currentColor 2px round strokes, no fill) so it composes with lucide
 * siblings anywhere an icon component is expected. Custom-icon precedent:
 * `components/landing/OwletteEye.tsx`.
 *
 * ## Why this shape
 *
 * Rendered and compared at 14/16/20/24/32/48px on both surfaces before
 * landing, because the icon's most common size in-app is the 16–20px nav
 * glyph, and a first pass that looked fine at 48px was mush at 16px.
 * Three findings drove the geometry:
 *
 *  - **Ring eyes, not dots.** The eye *holes* are what survive downscaling;
 *    they carry the owl read on their own. Solid dots plus a tufted head
 *    render as a cat at every size.
 *  - **A plain circle head.** Nothing else competes with the eyes for the
 *    narrow width, so at 16px there are only four strokes across the middle
 *    with real gaps between them. Ear tufts are *notches* cut into that one
 *    circle (same centre, same radius) rather than a separate shape — the
 *    head reads as a head, and pointed corner ears would read as a cat's.
 *  - **The beak is load-bearing.** Without it, two rings under a brow read
 *    as spectacles or goggles. The solid wedge is the cheapest cue that
 *    survives to 14px.
 *
 * Anatomy: circular head with two ear-tuft notches, two ring eyes set high,
 * a wedge beak below.
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
