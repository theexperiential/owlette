'use client';

import { useId } from 'react';

interface OwletteFeatherProps {
  size?: number;
  className?: string;
}

/**
 * A golden owl feather in the OwletteEye's visual language: the same warm
 * cream → peach → copper → umber palette, lit from the tip like the eye is
 * lit from its center, with the eye's thin near-black rim. Hand-drawn (like
 * `HootIcon` / `OwletteEye`) because this is brand artwork, not a UI glyph —
 * the brand hexes are shared with `OwletteEye.tsx` on purpose.
 *
 * The spine is gently S-bent and the vane is asymmetric, so in the falling
 * animation it reads as a real feather settling into place rather than a
 * rigid leaf. Gradient ids go through useId — the boot splash mounts two.
 */
export function OwletteFeather({ size = 28, className = '' }: OwletteFeatherProps) {
  const uid = useId();

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        {/* Tip-lit: brightest at the tip, sinking to umber at the quill —
            the eye's radial ramp, laid out along the feather. */}
        <linearGradient id={`${uid}-vane`} x1="100%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#FFE8DC" />
          <stop offset="35%" stopColor="#F0B89A" />
          <stop offset="70%" stopColor="#D08060" />
          <stop offset="100%" stopColor="#8B4525" />
        </linearGradient>
        <linearGradient id={`${uid}-spine`} x1="100%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#FFE8DC" />
          <stop offset="100%" stopColor="#3A1810" />
        </linearGradient>
      </defs>

      {/* Vane — one asymmetric closed sweep, outer edge full, inner edge
          returning close to the spine. */}
      <path
        d="M16 58
           C11 46 15 28 27 16
           C34 9 42 7 48 8
           C39 15 29 27 23 40
           C20 47 17.5 53 16 58 Z"
        fill={`url(#${uid}-vane)`}
        stroke="#0A0604"
        strokeOpacity="0.5"
        strokeWidth="1"
        strokeLinejoin="round"
      />

      {/* Spine — the slight bend that makes it read as settling, not rigid. */}
      <path
        d="M16 58 C21 45 31 25 48 8"
        fill="none"
        stroke={`url(#${uid}-spine)`}
        strokeWidth="1.75"
        strokeLinecap="round"
      />

      {/* Barbs — three thin strokes off the spine, umber-side. */}
      <g stroke="#FFE8DC" strokeOpacity="0.35" strokeWidth="0.9" strokeLinecap="round" fill="none">
        <path d="M24.5 39 C21 37.5 18.5 35 17 32" />
        <path d="M29.5 30 C26 28.5 23.5 26 22 23" />
        <path d="M35.5 22 C32.5 20.5 30.5 18.5 29 16" />
      </g>
    </svg>
  );
}
