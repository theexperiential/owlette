/**
 * MFA factor inventory — the SINGLE WRITER of `mfaEnrolled` and `requiresMfaSetup`.
 *
 * `users/{uid}.mfaEnrolled` means "this account has at least one second
 * factor", not "this account has TOTP". Passkeys count. Because the MFA gate
 * (`resolveMfaStateForUser` in `lib/sessionManager.server.ts`) reads that one
 * boolean from one document on a hot path — AuthContext re-POSTs
 * `/api/auth/session` on every page load — we do NOT query the
 * `users/{uid}/passkeys` subcollection at session time. Instead writers
 * maintain a denormalized inventory here:
 *
 *   users/{uid}.mfaFactors  = { totp: boolean, passkeys: number }
 *   users/{uid}.mfaEnrolled = mfaFactors.totp || mfaFactors.passkeys > 0
 *
 * RULES OF THE ROAD:
 *
 * - **This module is the only place permitted to write `mfaEnrolled` or
 *   `requiresMfaSetup`.** Every enrollment/removal route funnels through
 *   `applyMfaFactorChange`. A second writer re-opens the drift this
 *   denormalization exists to contain.
 * - **It owns `requiresMfaSetup` in BOTH directions.** Every call writes
 *   `requiresMfaSetup = !deriveMfaEnrolled(next)`. Re-arming it on zero factors
 *   is deliberate — removing the last factor is allowed, and puts the account
 *   straight back into mandatory setup. Clearing it to `false` when a factor
 *   exists is equally mandatory: without it a passkey-only signup finishes
 *   enrollment with the nag still set and the dashboard bounces the user to
 *   `/setup-2fa` forever.
 * - **When a caller passes `ctx.tx`, this must be called BEFORE any write on
 *   that transaction.** Firestore forbids reads after writes inside a
 *   transaction, and this module reads the user doc (and, on
 *   `recountPasskeys`, the subcollection) before it writes.
 * - **This module deliberately emits no audit event.** Callers own their own
 *   `emitMutation` so the audit verb reflects the user-visible action
 *   ("enrolled a passkey", "disabled 2FA") rather than the bookkeeping.
 */

import { getAdminDb } from '@/lib/firebase-admin';

/** Denormalized tally of the second factors an account holds. */
export interface MfaFactorInventory {
  totp: boolean;
  passkeys: number;
}

/** The inventory of an account with no second factor at all. */
export const EMPTY_MFA_FACTORS: Readonly<MfaFactorInventory> = Object.freeze({
  totp: false,
  passkeys: 0,
});

/** Context shared by both entry points. Every field is optional. */
export interface MfaFactorContext {
  /** Inject a Firestore instance — tests pass a mock; production omits. */
  db?: FirebaseFirestore.Firestore;
  /** Fold the recompute into the caller's transaction instead of opening one. */
  tx?: FirebaseFirestore.Transaction;
  /** Extra user-doc fields merged into the SAME write as the inventory. */
  extraUpdate?: Record<string, unknown>;
}

/**
 * A factor delta. Omitted legs keep their current value.
 *
 * `passkeys` and `recountPasskeys` are mutually exclusive — passing both is
 * ambiguous, and silently picking one would corrupt the inventory.
 */
export interface MfaFactorChange {
  totp?: boolean;
  /** Explicit count — opt out of recounting when the caller already knows it. */
  passkeys?: number;
  /** Recount from the `passkeys` subcollection inside the transaction. */
  recountPasskeys?: boolean;
}

export interface MfaFactorResult {
  factors: MfaFactorInventory;
  mfaEnrolled: boolean;
  requiresMfaSetup: boolean;
}

/** Subcollection holding one document per registered WebAuthn credential. */
const PASSKEYS_SUBCOLLECTION = 'passkeys';

/** The derived gate: any factor at all satisfies MFA. */
export function deriveMfaEnrolled(inv: MfaFactorInventory): boolean {
  return inv.totp || inv.passkeys > 0;
}

/** A stored passkey count is only trustworthy as a non-negative integer. */
function isValidPasskeyCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Clamp any recounted or caller-supplied total to a non-negative integer. */
function clampPasskeys(value: number): number {
  return Math.max(0, Math.trunc(value));
}

/** Firestore handle: injected for tests, the admin singleton in production. */
function resolveDb(ctx?: MfaFactorContext): FirebaseFirestore.Firestore {
  return ctx?.db ?? getAdminDb();
}

/**
 * True when BOTH legs of a stored `mfaFactors` are well-formed — i.e. the
 * inventory can be trusted without consulting the passkeys subcollection.
 * This predicate is what keeps `readMfaFactors` to a single document read on
 * the session hot path; see the header.
 */
function hasWellFormedFactors(
  userData: FirebaseFirestore.DocumentData | undefined,
): boolean {
  const stored = userData?.mfaFactors;
  if (typeof stored !== 'object' || stored === null) return false;
  const rec = stored as Record<string, unknown>;
  return typeof rec.totp === 'boolean' && isValidPasskeyCount(rec.passkeys);
}

/**
 * Read the inventory out of a user document, healing each leg independently.
 *
 * Legacy tolerance: accounts written before `mfaFactors` existed have neither
 * leg. `totp` falls back to `mfaEnrolled === true`, because TOTP is the only
 * factor that has ever set that flag. `passkeys` falls back to `passkeyCount`,
 * the real subcollection size the caller resolved. Each leg is validated on its
 * own, so a half-written document self-heals rather than being discarded
 * wholesale.
 *
 * Deliberately NOT consulted: `mfaSecret`. An in-flight TOTP setup parks its
 * secret in `mfa_pending/{uid}`, so a secret on the user doc is not proof of
 * completed enrollment.
 */
export function normalizeMfaFactors(
  userData: FirebaseFirestore.DocumentData | undefined,
  passkeyCount: number,
): MfaFactorInventory {
  const stored = userData?.mfaFactors;
  const rec =
    typeof stored === 'object' && stored !== null
      ? (stored as Record<string, unknown>)
      : undefined;

  const totp =
    typeof rec?.totp === 'boolean' ? rec.totp : userData?.mfaEnrolled === true;

  const passkeys = isValidPasskeyCount(rec?.passkeys)
    ? rec.passkeys
    : clampPasskeys(Number.isFinite(passkeyCount) ? passkeyCount : 0);

  return { totp, passkeys };
}

/**
 * Current inventory for a user, healing legacy/malformed documents.
 *
 * HOT PATH: when the stored `mfaFactors` is well-formed this performs exactly
 * ONE document read. Only a missing or malformed leg falls through to counting
 * the passkeys subcollection.
 *
 * A missing user doc yields the empty inventory rather than throwing — a
 * first-login user with no document cannot have enrolled anything.
 */
export async function readMfaFactors(
  userId: string,
  ctx?: MfaFactorContext,
): Promise<MfaFactorInventory> {
  const userRef = resolveDb(ctx).collection('users').doc(userId);
  const tx = ctx?.tx;

  const snap = tx ? await tx.get(userRef) : await userRef.get();
  if (!snap.exists) return { ...EMPTY_MFA_FACTORS };

  const data = snap.data();
  if (hasWellFormedFactors(data)) {
    // Trusted inventory — return it without touching the subcollection.
    return normalizeMfaFactors(data, 0);
  }

  const passkeysCol = userRef.collection(PASSKEYS_SUBCOLLECTION);
  const countSnap = tx ? await tx.get(passkeysCol) : await passkeysCol.get();
  return normalizeMfaFactors(data, countSnap.size);
}

/**
 * The shared transaction body. Both the `ctx.tx` path and the standalone
 * `db.runTransaction(...)` path run exactly this, so there is one ordering to
 * reason about: every read happens before the single write.
 */
async function applyInTx(
  tx: FirebaseFirestore.Transaction,
  userRef: FirebaseFirestore.DocumentReference,
  change: MfaFactorChange,
  extraUpdate?: Record<string, unknown>,
): Promise<MfaFactorResult> {
  // (1) Read the user doc. This module never creates one — a caller that has
  // not bootstrapped the user has a bug we must not paper over.
  const snap = await tx.get(userRef);
  if (!snap.exists) {
    throw new Error(`mfaFactors: user ${userRef.id} not found`);
  }

  // (2) Recount when the caller asks — and ALSO whenever the stored leg cannot
  // be trusted and the caller supplied no explicit total.
  //
  // That second condition is load-bearing, not defensive padding. A legacy
  // document has no `mfaFactors` at all, which describes EVERY account until
  // the backfill runs. Without the recount, `normalizeMfaFactors` would heal
  // that leg from `passkeyCount = 0` and a TOTP-only change would write
  // `passkeys: 0` over an account that really does hold credentials. The
  // account then reads as zero-factor once TOTP is removed — `mfaEnrolled`
  // false for a user with working passkeys, i.e. the gate fails OPEN.
  const data = snap.data();
  const storedPasskeysTrustworthy = isValidPasskeyCount(
    (data?.mfaFactors as Record<string, unknown> | undefined)?.passkeys,
  );
  const mustRecount =
    change.recountPasskeys === true ||
    (change.passkeys === undefined && !storedPasskeysTrustworthy);

  let passkeyCount = 0;
  if (mustRecount) {
    const countSnap = await tx.get(userRef.collection(PASSKEYS_SUBCOLLECTION));
    passkeyCount = countSnap.size;
  }

  // (3) Current state, healed.
  const current = normalizeMfaFactors(data, passkeyCount);

  // (4) Apply the delta. A recount overrides a stale stored copy; an explicit
  // count overrides the stored copy too; an omitted leg carries forward.
  const nextPasskeys = change.recountPasskeys
    ? passkeyCount
    : change.passkeys !== undefined
      ? change.passkeys
      : current.passkeys;

  const next: MfaFactorInventory = {
    totp: change.totp !== undefined ? change.totp : current.totp,
    passkeys: clampPasskeys(nextPasskeys),
  };

  // (5) One payload. `extraUpdate` is spread last so a caller can pair an
  // atomic cleanup (clearing `mfaSecret`, `backupCodes`, …) with the recompute;
  // it must never carry the three fields this module owns.
  const mfaEnrolled = deriveMfaEnrolled(next);
  const requiresMfaSetup = !mfaEnrolled;
  const payload: Record<string, unknown> = {
    mfaFactors: next,
    mfaEnrolled,
    requiresMfaSetup,
    ...extraUpdate,
  };

  // (6) The single write.
  tx.set(userRef, payload, { merge: true });

  return { factors: next, mfaEnrolled, requiresMfaSetup };
}

/**
 * Recompute and persist the inventory, `mfaEnrolled` and `requiresMfaSetup`.
 *
 * Pass `ctx.tx` to fold this into a caller's transaction (before any write on
 * it); omit it and the module opens its own.
 */
export async function applyMfaFactorChange(
  userId: string,
  change: MfaFactorChange,
  ctx?: MfaFactorContext,
): Promise<MfaFactorResult> {
  if (!userId) throw new Error('mfaFactors: userId is required');
  if (change.passkeys !== undefined && change.recountPasskeys) {
    throw new Error(
      'mfaFactors: pass either passkeys or recountPasskeys, not both',
    );
  }
  if (change.passkeys !== undefined && !Number.isFinite(change.passkeys)) {
    throw new Error('mfaFactors: passkeys must be a finite number');
  }

  const db = resolveDb(ctx);
  const userRef = db.collection('users').doc(userId);

  if (ctx?.tx) {
    return applyInTx(ctx.tx, userRef, change, ctx.extraUpdate);
  }
  return db.runTransaction((tx) =>
    applyInTx(tx, userRef, change, ctx?.extraUpdate),
  );
}
