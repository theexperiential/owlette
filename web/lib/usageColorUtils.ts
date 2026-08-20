/**
 * Usage percentage → accent color. Bands are deliberately far apart in hue so
 * adjacent ones stay distinguishable: <30 emerald, <50 violet, <70 sky,
 * <85 amber, else red.
 */

/** Tailwind background class for a 0-100 usage percentage. */
export function getUsageColorClass(percent: number): string {
  if (percent < 30) {
    return 'bg-emerald-500';
  } else if (percent < 50) {
    return 'bg-violet-500';
  } else if (percent < 70) {
    return 'bg-sky-500';
  } else if (percent < 85) {
    return 'bg-amber-500';
  } else {
    return 'bg-red-500';
  }
}

/** Same bands as `getUsageColorClass`, as raw rgb() for inline styles. */
export function getUsageColor(percent: number): string {
  if (percent < 30) {
    return 'rgb(16, 185, 129)';   // emerald-500
  } else if (percent < 50) {
    return 'rgb(139, 92, 246)';   // violet-500
  } else if (percent < 70) {
    return 'rgb(14, 165, 233)';   // sky-500
  } else if (percent < 85) {
    return 'rgb(245, 158, 11)';   // amber-500
  } else {
    return 'rgb(239, 68, 68)';    // red-500
  }
}
