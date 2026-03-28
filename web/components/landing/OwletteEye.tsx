'use client';

interface OwletteEyeProps {
  size?: number;
  className?: string;
  animated?: boolean;
}

export function OwletteEye({ size = 400, className = '', animated = false }: OwletteEyeProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 200 200"
      className={`${className} ${animated ? 'animate-eye-ignite' : ''}`}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <radialGradient id="eye" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#FFE8DC" />
          <stop offset="45%" stopColor="#F0B89A" />
          <stop offset="65%" stopColor="#D08060" />
          <stop offset="78%" stopColor="#8B4525" />
          <stop offset="83%" stopColor="#3A1810" />
          <stop offset="87%" stopColor="#1A0A06" />
          <stop offset="100%" stopColor="#0E0604" />
        </radialGradient>
        <radialGradient id="sheen" cx="42%" cy="40%" r="25%">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.7" />
          <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="red-wash" x1="0%" y1="50%" x2="100%" y2="50%">
          <stop offset="0%" stopColor="#C03020" stopOpacity="0.55" />
          <stop offset="35%" stopColor="#C03020" stopOpacity="0" />
        </linearGradient>
        <clipPath id="eye-clip">
          <circle cx="100" cy="100" r="88" />
        </clipPath>
      </defs>

      {/* The eye — single gradient, dark to warm to light */}
      <circle cx="100" cy="100" r="88" fill="url(#eye)" />

      {/* Red wash — left to right, only over bright center */}
      <circle cx="100" cy="100" r="68" fill="url(#red-wash)" />

      {/* Dark rim */}
      <circle cx="100" cy="100" r="88" fill="none" stroke="#0A0604" strokeWidth="2" />

      {/* White sheen */}
      <circle cx="88" cy="86" r="18" fill="url(#sheen)" />

      {/* Animated breath */}
      {animated && (
        <circle cx="100" cy="100" r="88" fill="url(#eye)" opacity="0.2">
          <animate attributeName="r" values="88;92;88" dur="5s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.2;0;0.2" dur="5s" repeatCount="indefinite" />
        </circle>
      )}
    </svg>
  );
}

export function OwletteEyeIcon({ size = 32, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 200 200"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <radialGradient id="si-eye" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#FFE8DC" />
          <stop offset="45%" stopColor="#F0B89A" />
          <stop offset="65%" stopColor="#D08060" />
          <stop offset="78%" stopColor="#8B4525" />
          <stop offset="83%" stopColor="#3A1810" />
          <stop offset="87%" stopColor="#1A0A06" />
          <stop offset="100%" stopColor="#0E0604" />
        </radialGradient>
        <radialGradient id="si-sheen" cx="42%" cy="40%" r="25%">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.65" />
          <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="si-red-wash" x1="0%" y1="50%" x2="100%" y2="50%">
          <stop offset="0%" stopColor="#C03020" stopOpacity="0.55" />
          <stop offset="35%" stopColor="#C03020" stopOpacity="0" />
        </linearGradient>
        <clipPath id="si-clip">
          <circle cx="100" cy="100" r="88" />
        </clipPath>
      </defs>
      <circle cx="100" cy="100" r="88" fill="url(#si-eye)" />
      <circle cx="100" cy="100" r="68" fill="url(#si-red-wash)" />
      <circle cx="100" cy="100" r="88" fill="none" stroke="#0A0604" strokeWidth="2" />
      <circle cx="88" cy="86" r="18" fill="url(#si-sheen)" />
    </svg>
  );
}
