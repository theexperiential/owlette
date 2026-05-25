/**
 * Usage-based color utility functions
 *
 * Maps resource usage percentage to a color spectrum with high contrast:
 * - Low usage (0-30%): Green (healthy)
 * - Medium-low (30-50%): Violet (distinct from green)
 * - Medium (50-70%): Sky blue (distinct from violet)
 * - High usage (70-85%): Amber (warning)
 * - Critical usage (85-100%): Red (danger)
 */

/**
 * Get the accent bar color based on usage percentage
 * Returns a Tailwind CSS background color class
 *
 * @param percent - Usage percentage (0-100)
 * @returns Tailwind CSS background color class
 */
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

/**
 * Get the accent bar color as a raw CSS color value
 * For use in inline styles
 *
 * @param percent - Usage percentage (0-100)
 * @returns CSS color string (rgb format)
 */
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
