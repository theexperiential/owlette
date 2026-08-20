/**
 * !! THIS IS UX, NOT SAFETY !!
 *
 * Bump `CURRENT_SECURITY_VERSION` — in the same commit as the change — when a
 * security-relevant change ships that older client tabs can't safely take part
 * in (stricter client validation, new csrf token shape, renamed header). The
 * proxy stamps every `/api/*` response with `x-security-version`; on mismatch
 * the client shows a non-dismissible reload banner.
 *
 * NOT a security boundary: the server never trusts the header for authorization
 * and a client can spoof or omit it. Real enforcement lives in the route
 * handlers and `apiAuth.server.ts`.
 */

export const CURRENT_SECURITY_VERSION = 2;

/** Lower-case to match the canonical form Next.js / fetch emit. */
export const SECURITY_VERSION_HEADER = 'x-security-version';
