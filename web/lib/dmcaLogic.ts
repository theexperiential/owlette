/**
 * Pure DMCA takedown + 3-strike logic (wave 0.2).
 *
 * Safe-harbor under 17 U.S.C. § 512 requires a "reasonably implemented"
 * repeat-infringer policy. `BMG v. Cox` made clear this is not optional.
 * This module implements the evaluation + side-effect-plan pieces of
 * that policy; the firestore I/O lives in the handler.
 *
 * No imports from firestore / next — tests can exercise every branch
 * without a firebase emulator.
 */

/* --------------------------------------------------------------------- */
/*  Notice shape                                                         */
/* --------------------------------------------------------------------- */

/** The six § 512(c)(3)(A) elements that make a notice actionable. */
export interface DmcaNoticeInput {
  /** Signature (typed name acceptable for electronic notices). */
  signature: string;
  /** Description of the copyrighted work claimed to be infringed. */
  copyrightedWork: string;
  /** URL / content-id / path identifying the allegedly infringing material. */
  identifiedMaterial: string;
  /** Complainant contact info. */
  complainant: {
    name: string;
    email: string;
    phone?: string;
    address: string;
  };
  /**
   * Good-faith-belief attestation that the use is not authorized by
   * the copyright owner, its agent, or the law.
   */
  goodFaithBelief: boolean;
  /**
   * Accuracy + perjury attestation (under penalty of perjury, info is
   * accurate, complainant is the owner or authorised agent).
   */
  accuracyAndPerjuryAttestation: boolean;
}

export type NoticeStatus =
  | 'pending_review'
  | 'elements_incomplete'
  | 'pending_takedown'
  | 'taken_down'
  | 'rejected_abuse'
  | 'counter_noticed';

/* --------------------------------------------------------------------- */
/*  Element-completeness validator                                       */
/* --------------------------------------------------------------------- */

export interface ValidationResult {
  /** True if the notice contains all six § 512(c)(3)(A) elements. */
  elementsComplete: boolean;
  /** Machine-readable list of missing/malformed fields. */
  missing: string[];
}

/**
 * Check a raw notice for the six required elements. This is the
 * "reasonably implemented" threshold — a notice missing any of these
 * is not actionable and does NOT count toward the uploader's strikes.
 *
 * Does NOT judge the merits of the claim — the copyright owner's
 * good-faith belief is what they certified, not something we evaluate.
 */
export function validateNotice(input: Partial<DmcaNoticeInput>): ValidationResult {
  const missing: string[] = [];

  if (!isNonEmptyString(input.signature)) missing.push('signature');
  if (!isNonEmptyString(input.copyrightedWork)) missing.push('copyrightedWork');
  if (!isNonEmptyString(input.identifiedMaterial)) missing.push('identifiedMaterial');

  const c = input.complainant;
  if (!c || typeof c !== 'object') {
    missing.push('complainant');
  } else {
    if (!isNonEmptyString(c.name)) missing.push('complainant.name');
    if (!isValidEmail(c.email)) missing.push('complainant.email');
    if (!isNonEmptyString(c.address)) missing.push('complainant.address');
  }

  if (input.goodFaithBelief !== true) missing.push('goodFaithBelief');
  if (input.accuracyAndPerjuryAttestation !== true) missing.push('accuracyAndPerjuryAttestation');

  return { elementsComplete: missing.length === 0, missing };
}

function isNonEmptyString(x: unknown): x is string {
  return typeof x === 'string' && x.trim().length > 0;
}

function isValidEmail(x: unknown): boolean {
  if (typeof x !== 'string') return false;
  // deliberately permissive; email-validity gate is "looks like an email",
  // not full RFC 5322 — complainant email bounces are caught at delivery.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x.trim());
}

/* --------------------------------------------------------------------- */
/*  Strike policy                                                        */
/* --------------------------------------------------------------------- */

/**
 * Per-user strike record — the uploader's DMCA history. Strikes expire
 * after 12 months (industry convention — YouTube, Google Drive — and
 * defeats weaponised serial-takedown targeting).
 */
export interface StrikeRecord {
  /** ISO-8601 timestamp of the takedown that created this strike. */
  at: string;
  /** Firestore doc id of the originating DMCA notice. */
  noticeId: string;
  /** Set to true if the strike was cleared by a successful counter-notice. */
  cleared?: boolean;
}

export type StrikeOutcome =
  | { tier: 'warning'; newCount: number; nextAction: 'email_warning' }
  | { tier: 'suspension'; newCount: number; nextAction: 'suspend_14_days' }
  | { tier: 'termination'; newCount: number; nextAction: 'terminate_account' };

/** Strikes older than this are not counted. 12 months = 365 days. */
export const STRIKE_EXPIRY_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Count active (not cleared, not expired) strikes from history + decide
 * which tier the next takedown lands in.
 *
 * Inputs are the PRIOR strikes — caller is about to record one new strike
 * and wants to know what to do AFTER that. So a user with 2 prior active
 * strikes who gets a third takedown lands in `termination`.
 */
export function evaluateStrike(
  priorStrikes: readonly StrikeRecord[],
  now: Date = new Date(),
): StrikeOutcome {
  const cutoff = now.getTime() - STRIKE_EXPIRY_MS;
  let active = 0;
  for (const s of priorStrikes) {
    if (s.cleared) continue;
    const t = Date.parse(s.at);
    if (!isFinite(t)) continue;
    if (t < cutoff) continue;
    active++;
  }
  const newCount = active + 1;
  if (newCount >= 3) {
    return { tier: 'termination', newCount, nextAction: 'terminate_account' };
  }
  if (newCount === 2) {
    return { tier: 'suspension', newCount, nextAction: 'suspend_14_days' };
  }
  return { tier: 'warning', newCount, nextAction: 'email_warning' };
}

/* --------------------------------------------------------------------- */
/*  Rate-limiting (anti-abuse)                                           */
/* --------------------------------------------------------------------- */

/**
 * Guard the public form against notice-flooding. A single complainant
 * email / IP is limited to N notices per hour — past that, we 429 and
 * the review queue doesn't drown.
 *
 * The window + cap are deliberately loose for legit complainants — a
 * studio submitting a list of pirated assets might file 30 in a day.
 * Tuned against the abuse pattern: thousands per hour from one source.
 */
export const RATE_LIMIT = {
  /** Notices per complainant email per hour. */
  perEmailPerHour: 10,
  /** Notices per source IP per hour. */
  perIpPerHour: 30,
};

export interface RateLimitCheck {
  emailCount: number;
  ipCount: number;
}

export function rateLimitVerdict(c: RateLimitCheck): {
  allowed: boolean;
  reason?: 'email_rate' | 'ip_rate';
} {
  if (c.emailCount >= RATE_LIMIT.perEmailPerHour) {
    return { allowed: false, reason: 'email_rate' };
  }
  if (c.ipCount >= RATE_LIMIT.perIpPerHour) {
    return { allowed: false, reason: 'ip_rate' };
  }
  return { allowed: true };
}
