/**
 * Resolve the cli's own package version by walking up from this file
 * until we hit a `package.json` whose name === `@owlette/cli`. Works
 * identically whether we're running from `src/` (ts-node, dev) or
 * `dist/` (compiled, prod) because both tree shapes share the same
 * nearest-package.json ancestor (`cli/`).
 *
 * The result is cached at module load — every call after the first is
 * O(1). Returns `'unknown'` if the package.json can't be located (e.g.
 * the cli is being imported as a library outside its monorepo).
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';

let cachedCliVersion: string | null = null;

export function readCliVersion(): string {
  if (cachedCliVersion !== null) return cachedCliVersion;
  let dir = __dirname;
  // Hard cap on traversal depth so a misconfigured install can't loop
  // forever (`/` keeps returning itself from `dirname`).
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, 'package.json');
    try {
      const raw = readFileSync(candidate, 'utf-8');
      const parsed = JSON.parse(raw) as { name?: string; version?: string };
      if (parsed.name === '@owlette/cli' && typeof parsed.version === 'string') {
        cachedCliVersion = parsed.version;
        return cachedCliVersion;
      }
    } catch {
      // not this directory; keep walking
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cachedCliVersion = 'unknown';
  return cachedCliVersion;
}
