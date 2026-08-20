/**
 * Resolve a user-entered "extract to" string into a canonical agent-side path
 * (the UI previews the result before distribute):
 *   empty        -> ~/Documents/Owlette/
 *   drive letter -> verbatim (e.g. `C:\render`)
 *   otherwise    -> ~/Documents/<input>
 *
 * Relative paths deliberately do NOT nest under `Owlette`: the default is a
 * landing pad for operators who don't care, so a named path should be the
 * folder's actual name.
 *
 * The agent's `destination_allowlist.DEFAULT_ROOTS` permits anything under
 * `~/Documents/`, so both forms are allowlist-valid; drive-letter paths are
 * rejected unless added to `agent_config.allowed_extract_roots`.
 */
export const DEFAULT_EXTRACT_PATH = '~/Documents/Owlette/';

/** Windows drive-letter prefix: `C:\`, `D:/`, etc. */
const DRIVE_LETTER_RE = /^[a-zA-Z]:[\\/]/;

export function resolveExtractPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return DEFAULT_EXTRACT_PATH;
  if (DRIVE_LETTER_RE.test(trimmed)) {
    // verbatim, but normalise separators so the display isn't a mixed `C:/foo\bar`
    return trimmed.replace(/\//g, '\\');
  }
  // strip leading separators so the template's `/` isn't doubled
  const rel = trimmed.replace(/^[\\/]+/, '');
  // and trailing, so appending one is deterministic (agents ignore it either way)
  const cleaned = rel.replace(/[\\/]+$/, '');
  return `~/Documents/${cleaned}/`;
}

/** True when the agent's default `~/Documents/` allowlist would accept the input. */
export function isLikelyAllowed(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed) return true; // default is fine
  return !DRIVE_LETTER_RE.test(trimmed);
}
