/**
 * Neutralise user-controlled text before it reaches a log sink.
 *
 * Log forging: machine names, process names, chat ids and nonces all arrive
 * from request bodies and agent registration, and they land inside `console.*`
 * template literals. A value containing a newline lets its author append
 * whatever they like as a fresh, well-formed-looking log line - which is how a
 * reader, an alerting rule, or an incident responder gets told a story that
 * never happened. C0/C1 control characters do the same to a terminal.
 *
 * Deliberately NOT a general-purpose escaper: it keeps text readable, because a
 * log nobody can read is its own kind of failure. Newlines become a visible
 * escaped token rather than vanishing, so a flattened value is obvious at a
 * glance instead of silently joining two lines.
 *
 * Dependency-free on purpose - the hoot turn runner is a hot path and should
 * not pull Sentry in just to flatten a string.
 */

/** C0 (U+0000-U+001F) and C1 (U+007F-U+009F) ranges - unwanted in a log line. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;

/** Cap a single field so a pathological value cannot flood the log. */
export const MAX_LOG_FIELD_LENGTH = 512;

/**
 * Flatten `value` to a single-line, control-character-free string.
 *
 * Non-strings are stringified first so callers can pass ids, numbers, or an
 * unknown caught error without a cast at every site.
 */
export function sanitizeForLog(value: unknown): string {
  const raw = typeof value === 'string' ? value : String(value);

  // Order matters: escape newlines into a visible token FIRST. Stripping
  // control characters first would delete them and silently join two lines,
  // which is the exact forgery this is meant to prevent.
  const flattened = raw
    .replace(/\r\n/g, '\\n')
    .replace(/[\r\n]/g, '\\n')
    .replace(CONTROL_CHARS, '');

  return flattened.length > MAX_LOG_FIELD_LENGTH
    ? `${flattened.slice(0, MAX_LOG_FIELD_LENGTH)}...[truncated]`
    : flattened;
}
