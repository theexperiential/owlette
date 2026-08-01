/**
 * bootstrapUser action core (security-boundary-migration wave 3.9).
 *
 * Creates `users/{uid}` on first sign-in / sign-up. Replaces the
 * client-side `setDoc` calls in `web/contexts/AuthContext.tsx` (line 421
 * unsubscribe-listener path; line 527 signUp path) so user-doc creation
 * is server-mediated and audit-logged.
 *
 * Idempotent — calling twice for the same uid is a no-op (returns
 * `already_exists`). The route is gated by a session/id-token from the
 * caller's OWN account; capability checks don't apply (capabilities only
 * make sense for actions on someone else's resources, and bootstrap is
 * the moment the caller's user record comes into existence). The handler
 * verifies that the bearer's uid matches the bootstrap target.
 *
 * Defaults baked in match the legacy AuthContext writes exactly:
 *   - `role: 'member'`
 *   - `sites: []`
 *   - `mfaEnrolled: false`, `requiresMfaSetup: true`
 *   - `preferences: { temperatureUnit: 'C', timezone: <input or 'UTC'> }`
 *
 * billing-system wave 0.1 adds the paired `customers/{uid}` doc — this is
 * the one server-mediated point where an account comes into existence, so
 * it's where the free-trial clock starts. Wave 1.2 adds the Stripe customer
 * that doc points at.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import { emitMutation } from '@/lib/auditLogClient';
import { isValidTimezone } from '@/lib/timeUtils';
import { sanitizeDisplayName } from '@/lib/sanitize';
import logger from '@/lib/logger';
import { newCustomerDoc } from '@/lib/types/customer';
import { linkStripeCustomer } from '@/lib/billing/stripeCustomer.server';

export interface BootstrapUserInput {
  uid: string;
  email: string;
  displayName?: string;
  /** IANA tz id from the client; defaults to UTC if invalid/missing. */
  timezone?: string;
  /** Inject a Firestore instance — tests pass a mock; production omits. */
  db?: Firestore;
  /** Inject a clock — tests pass a fixed value; production omits. */
  now?: () => Date;
}

export interface BootstrapUserContext {
  /** Audit actor string ("user:<uid>") — always the bootstrap target itself. */
  auditActor: string;
  endpoint?: string;
  method?: string;
}

export type BootstrapUserResult =
  | { kind: 'already_exists'; createdAt: number | null }
  | {
      kind: 'created';
      uid: string;
      email: string;
      displayName: string;
      timezone: string;
      createdAt: number;
    };

const UID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Outcome of {@link mintCustomerDoc}. `stripeCustomerId` is what the doc
 * carries once this returns — `null` on a freshly minted doc, and whatever a
 * pre-existing doc already held. `ok: false` means the doc is in an unknown
 * state and nothing downstream may write to it.
 */
type MintCustomerResult =
  | { ok: true; stripeCustomerId: string | null }
  | { ok: false };

/**
 * Mint the paired `customers/{uid}` billing doc with a fresh 14-day trial
 * clock (billing-system wave 0.1).
 *
 * Idempotent: an existing doc is never overwritten. The only writer that
 * could have got there first is `scripts/backfill-customers.mjs`, whose
 * `trialEndsAt: null` sentinel means "pre-go-live account, clock starts at
 * T0" — clobbering it with `now + 14d` would silently hand an account that
 * already has a trial a second one.
 *
 * Never throws. A billing bookkeeping write must not be able to fail a
 * signup: the caller is a brand-new user, a thrown error here would leave
 * them with a `users/{uid}` doc and an error toast, and the retry would
 * short-circuit on the `already_exists` path without ever repairing the
 * customer doc. The backfill script is the repair path for exactly this
 * gap, and the logged error reaches Sentry in production.
 */
async function mintCustomerDoc(
  db: Firestore,
  uid: string,
  now: Date,
): Promise<MintCustomerResult> {
  try {
    const customerRef = db.collection('customers').doc(uid);
    const existing = await customerRef.get();
    if (existing.exists) {
      const stored = existing.data()?.stripeCustomerId;
      return {
        ok: true,
        stripeCustomerId: typeof stored === 'string' && stored.length > 0 ? stored : null,
      };
    }
    await customerRef.set(newCustomerDoc(now));
    return { ok: true, stripeCustomerId: null };
  } catch (err) {
    logger.error('failed to mint customers doc at bootstrap', {
      context: 'bootstrapUser',
      data: { uid, error: err instanceof Error ? err.message : String(err) },
    });
    return { ok: false };
  }
}

export async function bootstrapUser(
  ctx: BootstrapUserContext,
  input: BootstrapUserInput,
): Promise<BootstrapUserResult> {
  if (!input.uid || !UID_REGEX.test(input.uid)) {
    throw new Error('uid is required and must match user-id format');
  }
  if (!input.email || typeof input.email !== 'string') {
    throw new Error('email is required');
  }

  const db = input.db ?? getAdminDb();
  const userRef = db.collection('users').doc(input.uid);

  // Sanitise the display name at the single write chokepoint — strips link
  // payloads / emoji-spam / invisible chars regardless of whether the caller
  // came through the signup form or hit the API directly with a scraped key.
  const displayName = sanitizeDisplayName(input.displayName);
  const timezone =
    typeof input.timezone === 'string' && isValidTimezone(input.timezone)
      ? input.timezone
      : 'UTC';
  const nowDate = (input.now ?? (() => new Date()))();
  const createdAtMs = nowDate.getTime();

  // Pre-existence check — bootstrap is idempotent. We can't use a
  // transaction's create() here because users/{uid} may already exist
  // from a previous bootstrap call for the same caller (e.g. retry after
  // network error).
  const existing = await userRef.get();
  if (existing.exists) {
    const data = existing.data() ?? {};
    const createdAtRaw = data.createdAt;
    let createdAt: number | null = null;
    if (typeof createdAtRaw === 'number') {
      createdAt = createdAtRaw;
    } else if (
      createdAtRaw &&
      typeof (createdAtRaw as { toMillis?: () => number }).toMillis === 'function'
    ) {
      try {
        createdAt = (createdAtRaw as { toMillis: () => number }).toMillis();
      } catch {
        createdAt = null;
      }
    }
    return { kind: 'already_exists', createdAt };
  }

  await userRef.set({
    email: input.email,
    role: 'member',
    sites: [],
    createdAt: nowDate,
    displayName,
    mfaEnrolled: false,
    requiresMfaSetup: true,
    preferences: {
      temperatureUnit: 'C',
      timezone,
    },
  });

  // Billing bookkeeping. Both steps are best-effort by design and neither
  // can fail the signup; `scripts/backfill-customers.mjs` and
  // `scripts/backfill-stripe-customers.mjs` are the repair paths.
  //
  // Signup latency is protected on three fronts: this only ever runs on the
  // genuine first-signup path (a returning caller short-circuits at
  // `already_exists` above), it makes zero network calls while Stripe is
  // unconfigured, and the Stripe calls it does make are capped by the
  // signup-path timeout in `stripeCustomer.server.ts`. It is awaited rather
  // than floated because a floating promise is killed when the response ends
  // on a serverless origin (the Vercel failover), losing the write-back with
  // no error to surface.
  const minted = await mintCustomerDoc(db, input.uid, nowDate);
  if (minted.ok && minted.stripeCustomerId === null) {
    await linkStripeCustomer({
      db,
      uid: input.uid,
      email: input.email,
      signupPath: true,
    });
  }

  emitMutation({
    kind: 'user_mutated',
    siteId: '',
    actor: ctx.auditActor,
    targetId: input.uid,
    attributes: {
      endpoint: ctx.endpoint ?? '',
      method: ctx.method ?? 'POST',
      verb: 'bootstrapped',
      email: input.email,
    },
  });

  return {
    kind: 'created',
    uid: input.uid,
    email: input.email,
    displayName,
    timezone,
    createdAt: createdAtMs,
  };
}
