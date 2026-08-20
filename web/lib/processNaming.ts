/**
 * Process-name helpers shared by the dashboard.
 */

/**
 * Collision-free name for a duplicated process: " (copy)", " (copy 2)", …
 * until no clash. Matching is case-INSENSITIVE, deliberately stricter than the
 * server's case-sensitive check, so the suggestion is always safe to submit.
 */
export function nextDuplicateName(baseName: string, existingNames: string[]): string {
  const taken = new Set(existingNames.map((n) => n.toLowerCase()));
  const first = `${baseName} (copy)`;
  if (!taken.has(first.toLowerCase())) {
    return first;
  }
  let n = 2;
  while (taken.has(`${baseName} (copy ${n})`.toLowerCase())) {
    n += 1;
  }
  return `${baseName} (copy ${n})`;
}
