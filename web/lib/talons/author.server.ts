/**
 * Fire-time re-resolution of a talon's AUTHOR — the person an unattended run
 * acts as and whose llm key it spends.
 *
 * ## why a talon has an author at all
 *
 * Since BYOK collapsed to one key in one place (`users/{uid}/settings/llm` —
 * see `resolveLlmConfig`), there is no site-shared key an unattended run could
 * fall back to. Something has to name whose key a 3am talon is spending, and
 * the only honest answer is the person who wrote the talon: `createdBy`.
 *
 * ## never trusted from authoring time
 *
 * The author's site access is re-resolved on EVERY run. A talon written by an
 * admin who has since left the site, been demoted, or been soft-deleted must
 * not keep executing with the privileges — or on the key — they held the day
 * they wrote it.
 *
 * ## fatal vs transient
 *
 * Everything this module throws as a {@link TalonAuthorError} is UNRECOVERABLE:
 * the same call will fail identically on the next firing, so the engine
 * disables the talon immediately with the carried reason rather than burning
 * ten runs discovering it. That distinction is why `verifyUserSiteAccess`
 * throws a typed `SiteAccessError` — a Firestore outage surfaces as some other
 * error class entirely and is deliberately allowed to escape this module
 * un-narrowed, so an unreachable database can never disable a talon.
 *
 * IMPORTANT: Server-side only — never import this in client components.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  SiteAccessError,
  assertLlmKeyAvailable,
  resolveLlmConfig,
  verifyUserSiteAccess,
  type SiteAccessLevel,
} from '@/lib/hoot-utils.server';
import type { LlmConfig } from '@/lib/llm';
import type { StoredTalon } from './store.server';
import type { TalonDisabledReason } from './types';

/**
 * `createdBy` prefix the store writes for a non-user author
 * (`authorIdentifier` in `store.server.ts`). Such a talon has no uid whose
 * access could be re-resolved and no key it could spend.
 */
const SYSTEM_AUTHOR_PREFIX = 'system:';

/**
 * An author problem that retrying cannot fix. `reason` is what gets stamped on
 * the talon and its run; `message` is the diagnostic for whoever reads a log.
 */
export class TalonAuthorError extends Error {
  readonly reason: TalonDisabledReason;

  constructor(reason: TalonDisabledReason, message: string) {
    super(message);
    this.name = 'TalonAuthorError';
    this.reason = reason;
  }
}

/** The author, resolved: their uid and the access level they hold RIGHT NOW. */
export interface TalonAuthor {
  userId: string;
  access: SiteAccessLevel;
}

/**
 * Map a site-access refusal onto the disable reason it means.
 *
 * `site_not_found` is deliberately absent: the site being gone is not the
 * author's fault, and a talon in a collection that no longer exists has bigger
 * problems than its enabled flag. It falls through as a plain failure.
 */
const REASON_BY_ACCESS_CODE: Readonly<Partial<Record<string, TalonDisabledReason>>> = {
  user_not_found: 'creator_deleted',
  user_deleted: 'creator_deleted',
  no_site_access: 'creator_access_revoked',
};

/**
 * Re-resolve the talon's author and their current site access.
 *
 * @throws {TalonAuthorError} when the author can never back this talon again.
 * @throws {Error} unchanged for anything transient (a failed read, a missing
 *                 site) — those must NOT disable the talon.
 */
export async function resolveTalonAuthor(
  db: Firestore,
  siteId: string,
  talon: StoredTalon,
): Promise<TalonAuthor> {
  const userId = talon.createdBy;
  if (!userId || userId.startsWith(SYSTEM_AUTHOR_PREFIX)) {
    throw new TalonAuthorError(
      'creator_not_a_user',
      `Talon ${talon.id} has no user author, so no access or llm key can be resolved for it.`,
    );
  }

  try {
    const access = await verifyUserSiteAccess(db, userId, siteId);
    return { userId, access };
  } catch (error) {
    if (error instanceof SiteAccessError) {
      const reason = REASON_BY_ACCESS_CODE[error.code];
      if (reason) {
        throw new TalonAuthorError(
          reason,
          `Talon ${talon.id} author ${userId} can no longer run it: ${error.message}`,
        );
      }
    }
    throw error;
  }
}

/**
 * The author's llm config, for a caller that needs the model itself.
 *
 * @throws {TalonAuthorError} `creator_missing_llm_key` when no usable key is
 *                            saved — including the un-decryptable case, which
 *                            is equally un-runnable until a human re-saves it.
 */
export async function resolveTalonAuthorLlmConfig(
  db: Firestore,
  userId: string,
): Promise<LlmConfig> {
  try {
    return await resolveLlmConfig(db, userId);
  } catch (error) {
    throw missingKeyError(userId, error);
  }
}

/**
 * The same precondition WITHOUT the key. Used by the pre-flight in front of a
 * hoot turn, which needs to know the key is there but must never hold it — the
 * turn runner resolves it for itself, in the one scope that uses it.
 *
 * @throws {TalonAuthorError} `creator_missing_llm_key`.
 */
export async function assertTalonAuthorLlmKey(
  db: Firestore,
  userId: string,
): Promise<void> {
  try {
    await assertLlmKeyAvailable(db, userId);
  } catch (error) {
    throw missingKeyError(userId, error);
  }
}

function missingKeyError(userId: string, error: unknown): TalonAuthorError {
  return new TalonAuthorError(
    'creator_missing_llm_key',
    `Talon author ${userId} has no usable llm key: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
}
