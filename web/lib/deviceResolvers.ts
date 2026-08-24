/** Per-device selection helpers (CPUs, disks, NICs) with a primary fallback. */

/** Selected (if still present) → primary → first → null. */
export function resolveDevice<T extends { id: string }>(
  devices: T[] | undefined,
  selectedId: string | null | undefined,
  primaryId: string | null | undefined
): T | null {
  if (!devices || devices.length === 0) return null;
  if (selectedId) {
    const match = devices.find(d => d.id === selectedId);
    if (match) return match;
    // Selected device is gone from this machine — fall through to primary.
  }
  if (primaryId) {
    const match = devices.find(d => d.id === primaryId);
    if (match) return match;
  }
  return devices[0] ?? null;
}

/** Hidden when there is one device or none. */
export function shouldShowDeviceDropdown<T>(devices: T[] | undefined): boolean {
  return !!devices && devices.length > 1;
}

/**
 * De-duplicated union in first-seen order, for selectors shared across machines
 * (the list view's column-header dropdowns).
 */
export function unionIds(lists: string[][]): string[] {
  const set = new Set<string>();
  for (const list of lists) {
    for (const id of list) set.add(id);
  }
  return [...set];
}
