/**
 * Process-name helpers shared by the dashboard.
 */

/**
 * Compute a collision-free name for a duplicated process.
 *
 * Appends " (copy)", then " (copy 2)", " (copy 3)", … until the result does
 * not collide with an existing process name on the machine. Matching is
 * case-insensitive — intentionally stricter than the server's case-sensitive
 * uniqueness check — so the suggested name is always safe to submit.
 *
 * @param baseName      the original process's name
 * @param existingNames the machine's current process names
 * @returns a name not already present in existingNames
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
