/**
 * sanitize — defence-in-depth sanitisers for user-supplied file metadata
 * surfaced in the roost UI (wave 3.8).
 *
 * React JSX escapes text by default, so simply rendering a filename as
 * `{file.name}` is already XSS-safe. This module exists because:
 *
 *   1. Versions are stored + echoed back. Normalising at upload time
 *      prevents malicious zero-width / RTL-override payloads from ever
 *      being persisted — so a later feature that renders the name in a
 *      non-JSX context (toast, `document.title`, `aria-label`, CSS content)
 *      inherits the cleanliness.
 *   2. The agent-side `_invalid_version_path` guard (sync_version.py)
 *      will reject hostile paths at ingest, but sanitising client-side
 *      lets us show the operator a friendly error BEFORE the upload
 *      starts — instead of a late server rejection.
 *   3. Unicode control / zero-width characters can make two different
 *      files appear visually identical in the dashboard. Stripping them
 *      in one place keeps the UI trustworthy.
 *
 * NOT this module's job:
 *   - Filesystem legality. Windows rejects `< > : " | ? *` on write; the
 *     agent surfaces that error. Different platforms have different
 *     rules — we don't pre-bake any single OS's rules here.
 *   - Path traversal. Versions are the path-bearing surface; that's
 *     `sync_version.py._invalid_version_path`'s job.
 *
 * Never wrap the output in `dangerouslySetInnerHTML`. If you need HTML,
 * you're doing the wrong thing — render as text via JSX.
 */

/** max grapheme-length we persist for a filename. */
const MAX_FILENAME_LENGTH = 255;

/**
 * Characters that look invisible in most browsers + terminals and can
 * be used to spoof a file name (e.g. hide a `.exe` by making the real
 * extension RTL-reversed, or make two distinct files visually identical).
 *
 * Not a blanket Unicode whitelist — the aim is strict about *known*
 * invisibility vectors without disallowing legitimate accented characters
 * or non-latin scripts.
 */
const INVISIBLE_CODEPOINTS = [
  0x200b, // ZERO WIDTH SPACE
  0x200c, // ZERO WIDTH NON-JOINER
  0x200d, // ZERO WIDTH JOINER
  0x200e, // LEFT-TO-RIGHT MARK
  0x200f, // RIGHT-TO-LEFT MARK
  0x202a, // LEFT-TO-RIGHT EMBEDDING
  0x202b, // RIGHT-TO-LEFT EMBEDDING
  0x202c, // POP DIRECTIONAL FORMATTING
  0x202d, // LEFT-TO-RIGHT OVERRIDE
  0x202e, // RIGHT-TO-LEFT OVERRIDE
  0x2060, // WORD JOINER
  0x2066, // LEFT-TO-RIGHT ISOLATE
  0x2067, // RIGHT-TO-LEFT ISOLATE
  0x2068, // FIRST STRONG ISOLATE
  0x2069, // POP DIRECTIONAL ISOLATE
  0xfeff, // ZERO WIDTH NO-BREAK SPACE (BOM)
];

const INVISIBLE_RE = new RegExp(
  `[${INVISIBLE_CODEPOINTS.map((c) => `\\u{${c.toString(16)}}`).join('')}]`,
  'gu',
);

/**
 * C0 + C1 control characters. Includes tab / newline / CR — those are
 * legal in some text contexts but never in filenames; stripping them
 * prevents terminal-rendering spoofs and line-based parser breakage.
 */
const CONTROL_CHARS_RE = /[\x00-\x1F\x7F-\x9F]/g;

export type SanitizeResult =
  | { ok: true; value: string; changed: boolean }
  | { ok: false; reason: string };

/**
 * Normalise a filename (a single segment, not a path) for safe storage
 * and round-tripping.
 *
 * Returns `ok: true` with the cleaned value — `changed` tells callers
 * whether the sanitiser modified anything, so a UI can show a confirmation
 * prompt ("we renamed X to Y, ok?") without spam when the name was
 * already clean.
 *
 * Returns `ok: false` when the name cannot be salvaged (empty, NUL byte,
 * contains a path separator, or reduces to an empty string after cleaning).
 */
export function sanitizeFilename(input: string): SanitizeResult {
  if (typeof input !== 'string') {
    return { ok: false, reason: 'filename must be a string' };
  }

  // NUL bytes truncate C-string APIs; never allow them through. Do this
  // before any normalisation so a `foo\x00.exe` payload can't slip past
  // via a later normalise step.
  if (input.includes('\x00')) {
    return { ok: false, reason: 'filename contains NUL byte' };
  }

  // Path separators mean the caller handed us a path, not a filename.
  // We don't try to extract the basename — that decision belongs to the
  // caller since it changes the semantics of the upload.
  if (input.includes('/') || input.includes('\\')) {
    return { ok: false, reason: 'filename contains a path separator' };
  }

  // Unicode normal form C — canonical composition. Prevents NFC/NFD
  // desync where two visually identical filenames diff on disk.
  let value = input.normalize('NFC');

  // Strip control + invisible codepoints. Keeps a record of whether
  // anything was actually removed so we can set `changed` accurately.
  const withoutInvisibles = value.replace(INVISIBLE_RE, '');
  const withoutControls = withoutInvisibles.replace(CONTROL_CHARS_RE, '');

  // Windows strips trailing dots and spaces from filenames on write.
  // Apply the same trim at upload time so the name the operator sees
  // matches what will land on disk. Leading dots are fine (hidden files
  // on unix).
  value = withoutControls.replace(/[ .]+$/, '').replace(/^[ ]+/, '');

  if (value.length === 0) {
    return {
      ok: false,
      reason: 'filename is empty after stripping invisible characters',
    };
  }

  if (value === '.' || value === '..') {
    return { ok: false, reason: 'filename cannot be "." or ".."' };
  }

  // Truncate by codepoint count, not UTF-16 code-unit length, so a name
  // full of emoji or CJK doesn't silently get mangled mid-codepoint.
  // `Array.from` yields codepoint-level units (handles surrogate pairs).
  const codepoints = Array.from(value);
  if (codepoints.length > MAX_FILENAME_LENGTH) {
    value = codepoints.slice(0, MAX_FILENAME_LENGTH).join('');
  }

  return {
    ok: true,
    value,
    changed: value !== input,
  };
}

/** True if `sanitizeFilename` would succeed without modification. */
export function isFilenameClean(input: string): boolean {
  const result = sanitizeFilename(input);
  return result.ok && !result.changed;
}
