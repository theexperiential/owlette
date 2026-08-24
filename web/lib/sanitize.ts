/**
 * sanitize — defence-in-depth sanitisers for user-supplied file metadata in
 * the roost UI. JSX already escapes text; this exists so zero-width/RTL
 * payloads are never PERSISTED (non-JSX sinks — toasts, `document.title`,
 * `aria-label` — inherit the cleanliness), and so the operator sees the error
 * before the upload rather than at agent ingest.
 *
 * Not this module's job: filesystem legality (per-OS, the agent surfaces it)
 * or path traversal (`sync_version.py._invalid_version_path`).
 *
 * Never feed the output to `dangerouslySetInnerHTML`.
 */

/** max grapheme-length we persist for a filename. */
const MAX_FILENAME_LENGTH = 255;

/**
 * Codepoints that render invisibly and can spoof a filename (RTL-reversing a
 * `.exe`, or making two distinct files look identical). Deliberately a
 * targeted list, not a Unicode whitelist — accents and non-latin scripts stay.
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

/** C0 + C1 controls, tab/newline/CR included — never legal in a filename. */
const CONTROL_CHARS_RE = /[\x00-\x1F\x7F-\x9F]/g;

export type SanitizeResult =
  | { ok: true; value: string; changed: boolean }
  | { ok: false; reason: string };

/**
 * Normalise a filename (one segment, not a path). `changed` lets the UI
 * confirm a rename only when something was actually modified. `ok: false`
 * when unsalvageable: empty, NUL byte, path separator, or empty after
 * cleaning.
 */
export function sanitizeFilename(input: string): SanitizeResult {
  if (typeof input !== 'string') {
    return { ok: false, reason: 'filename must be a string' };
  }

  // Before normalisation: NUL truncates C-string APIs, and a later normalise
  // step could otherwise hide a `foo\x00.exe` payload.
  if (input.includes('\x00')) {
    return { ok: false, reason: 'filename contains NUL byte' };
  }

  // A path, not a filename. Extracting the basename would change the upload's
  // semantics, so that decision stays with the caller.
  if (input.includes('/') || input.includes('\\')) {
    return { ok: false, reason: 'filename contains a path separator' };
  }

  // NFC: stops NFC/NFD desync where visually identical names diff on disk.
  let value = input.normalize('NFC');

  const withoutInvisibles = value.replace(INVISIBLE_RE, '');
  const withoutControls = withoutInvisibles.replace(CONTROL_CHARS_RE, '');

  // Windows strips trailing dots/spaces on write; match that here so the name
  // shown matches what lands on disk. Leading dots stay (unix hidden files).
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

  // Codepoints, not UTF-16 units — `Array.from` won't split a surrogate pair.
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

/** Max grapheme-length we persist for a user display name. */
const MAX_DISPLAY_NAME_LENGTH = 64;

/** Max pictographic codepoints we keep — beyond this is emoji-spam. */
const MAX_DISPLAY_NAME_EMOJI = 2;

/**
 * URL shapes signup bots stuff into display names (`15K lira bonus!
 * https://bit.ly/xxxx 🔥`). Each is replaced with a space so neighbouring
 * words don't merge. The bare-domain form requires a real `host.tld` shape,
 * so initials like "J.R." or "Ph.D" survive.
 */
const URL_SCHEME_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
const WWW_RE = /\bwww\.\S+/gi;
const BARE_DOMAIN_RE =
  /\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|ly|gl|gd|me|co|app|link|click|xyz|top|info|biz|ru|tr|de|uk|cn|site|online|store|live|vip|win|bet)\b\/?\S*/gi;

/** All extended-pictographic (emoji) codepoints. */
const PICTOGRAPHIC_RE = /\p{Extended_Pictographic}/gu;

/**
 * Normalise a user-supplied display name. Never rejects — an empty display
 * name is legal, so hostile input just cleans down to `''`. Strips the
 * actionable payload (links) and visual noise (emoji spam, RTL spoofs) before
 * the value is persisted and echoed into admin tables, toasts, `aria-label`s.
 *
 * NFC → strip invisible/control → strip URLs → cap emoji → collapse → trim → cap.
 */
export function sanitizeDisplayName(input: unknown): string {
  if (typeof input !== 'string') return '';

  let value = input.normalize('NFC');
  // Invisible/RTL chars are pure spoofs and go; controls become a space so
  // they separate words instead of silently joining them.
  value = value.replace(INVISIBLE_RE, '').replace(CONTROL_CHARS_RE, ' ');
  value = value
    .replace(URL_SCHEME_RE, ' ')
    .replace(WWW_RE, ' ')
    .replace(BARE_DOMAIN_RE, ' ');

  // A single flag/star is fine; a wall of 🔥🔥🔥 is decoration around spam.
  let emojiSeen = 0;
  value = value.replace(PICTOGRAPHIC_RE, (m) =>
    ++emojiSeen > MAX_DISPLAY_NAME_EMOJI ? '' : m,
  );

  value = value.replace(/\s+/g, ' ').trim();

  // Truncate by codepoint (not UTF-16 unit) so CJK/emoji aren't split.
  const codepoints = Array.from(value);
  if (codepoints.length > MAX_DISPLAY_NAME_LENGTH) {
    value = codepoints.slice(0, MAX_DISPLAY_NAME_LENGTH).join('').trim();
  }

  return value;
}
