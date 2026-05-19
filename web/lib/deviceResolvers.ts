/**
 * Device resolution helpers for per-device selections (CPUs, disks, NICs, etc.).
 *
 * Picks the right device to display given a user selection and a primary fallback,
 * and decides when a selector UI should be shown.
 */

/**
 * Returns the user's selected device if it exists in the list,
 * else the primary device, else the first device, else null.
 */
export function resolveDevice<T extends { id: string }>(
  devices: T[] | undefined,
  selectedId: string | null | undefined,
  primaryId: string | null | undefined
): T | null {
  if (!devices || devices.length === 0) return null;
  if (selectedId) {
    const match = devices.find(d => d.id === selectedId);
    if (match) return match;
    // selected device no longer exists on this machine → fall through to primary
  }
  if (primaryId) {
    const match = devices.find(d => d.id === primaryId);
    if (match) return match;
  }
  return devices[0] ?? null;
}

/**
 * Whether a dropdown should be shown for a given device list.
 * Hide the dropdown when there's only one device (or zero).
 */
export function shouldShowDeviceDropdown<T>(devices: T[] | undefined): boolean {
  return !!devices && devices.length > 1;
}

/**
 * Union a set of device-id lists into a single de-duplicated list, preserving
 * first-seen insertion order. Used by views that render a shared device
 * selector across multiple machines (e.g. the list view's column-header
 * dropdowns) so the menu lists every id present on any visible machine exactly
 * once.
 */
export function unionIds(lists: string[][]): string[] {
  const set = new Set<string>();
  for (const list of lists) {
    for (const id of list) set.add(id);
  }
  return [...set];
}
