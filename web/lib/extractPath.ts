/**
 * Resolve a user-entered "extract to" string into a canonical agent-side
 * path. The UI shows the resolved form below the input so the operator
 * can see exactly where files will land before hitting distribute.
 *
 * Semantics:
 *   - Empty / whitespace only      → ~/Documents/Owlette/  (default)
 *   - Starts with a drive letter   → used verbatim          (e.g. `C:\render`)
 *   - Anything else                → ~/Documents/<input>    (relative under
 *                                                           Documents — leading
 *                                                           slashes / backslashes
 *                                                           stripped, NOT nested
 *                                                           under /Owlette/)
 *
 * Why relative paths don't nest under `Owlette`: the default is there as
 * a landing pad for operators who don't care where files go. When a user
 * explicitly names a path, they want that name to be the actual folder
 * name, not a sub-sub-folder of the fallback.
 *
 * Agent-side: `destination_allowlist.DEFAULT_ROOTS` permits anything
 * under `~/Documents/`, so both the fallback (`Documents/Owlette`) and
 * user-named relative paths (`Documents/<input>`) are allowlist-valid.
 * Absolute paths with a drive letter are rejected unless the operator
 * adds them to `agent_config.allowed_extract_roots` on the agent.
 */
export const DEFAULT_EXTRACT_PATH = '~/Documents/Owlette/';

/** Windows drive-letter prefix: `C:\`, `D:/`, etc. */
const DRIVE_LETTER_RE = /^[a-zA-Z]:[\\/]/;

export function resolveExtractPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return DEFAULT_EXTRACT_PATH;
  if (DRIVE_LETTER_RE.test(trimmed)) {
    // Absolute Windows path — preserve verbatim. Normalise separators to
    // backslashes so the display reads as a native Windows path rather
    // than a mixed `C:/foo\bar` mess.
    return trimmed.replace(/\//g, '\\');
  }
  // Relative — strip any leading slash/backslash so the `/` in our template
  // below isn't doubled, then stick it under Documents.
  const rel = trimmed.replace(/^[\\/]+/, '');
  // Also strip any trailing slash/backslash so appending one below is
  // deterministic. The trailing slash is purely cosmetic — agents treat
  // `Documents/files` and `Documents/files/` identically.
  const cleaned = rel.replace(/[\\/]+$/, '');
  return `~/Documents/${cleaned}/`;
}

/**
 * True iff the input is a path the agent's default allowlist
 * (`~/Documents/`) would accept. Use in UI to warn about absolute paths
 * that will likely be rejected without operator-side configuration.
 */
export function isLikelyAllowed(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed) return true; // default is fine
  return !DRIVE_LETTER_RE.test(trimmed);
}
