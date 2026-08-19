/**
 * hoot's internal shared secret — the credential every server-to-server caller
 * of the internal endpoints presents (`/api/hoot/autonomous`,
 * `/api/hoot/escalation`, `/api/alerts/trigger`, `/api/talons/internal/match`,
 * and the audit-emit hop in `lib/auditLogClient.ts`).
 *
 * The deployed environment variable is still named `CORTEX_INTERNAL_SECRET`. It
 * is provisioned on Railway (dev + prod), on Vercel, and in the Firebase
 * Functions runtime config, and `functions/src/lib/requireInternalSecret`
 * compares against the same value. Renaming it would mean rotating the same
 * secret across four deploy targets inside one release window, so the env name
 * stays put and this module is the only place in `web/` that spells it.
 *
 * Read at call time rather than at module scope so a test (or a lazily-loaded
 * server module) that assigns the variable after import still observes it.
 *
 * See `web/lib/hoot/WIRE_NAMES.md` for the full survivor inventory.
 */

/** The deployed env-var name. Referenced in operator-facing diagnostics. */
export const HOOT_INTERNAL_SECRET_ENV = 'CORTEX_INTERNAL_SECRET';

/** The configured internal secret, or `undefined` when the env is unset. */
export function hootInternalSecret(): string | undefined {
  return process.env.CORTEX_INTERNAL_SECRET;
}
