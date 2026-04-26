/**
 * Security Version Constants
 *
 * !! THIS IS UX, NOT SAFETY !!
 *
 * `CURRENT_SECURITY_VERSION` is bumped when a security-relevant change ships
 * that older client tabs cannot safely participate in (e.g. a stricter
 * client-side validation pass, a new csrf token shape, a renamed header).
 * The proxy stamps every `/api/*` response with `x-security-version`, the
 * client compares, and on mismatch a non-dismissible banner asks the user
 * to reload.
 *
 * This is a defence-in-depth nudge for stale tabs — it is NOT a security
 * boundary. The server never trusts the header for authorization decisions;
 * a malicious client can spoof or omit it freely. All real enforcement
 * lives server-side in the relevant route handlers and `apiAuth.server.ts`.
 *
 * Bump this constant in the same commit as the security-relevant change so
 * any tab open at deploy time prompts the user to reload.
 */

export const CURRENT_SECURITY_VERSION = 1;

/**
 * Response header name used by the proxy and read by the client hook.
 * Lower-case to match the canonical form Next.js / fetch emit.
 */
export const SECURITY_VERSION_HEADER = 'x-security-version';
