/**
 * Pure DMCA takedown + 3-strike logic.
 *
 * Safe-harbor under 17 U.S.C. § 512 requires a "reasonably implemented"
 * repeat-infringer policy (`BMG v. Cox` — not optional). Evaluation and
 * side-effect planning live here; the firestore I/O lives in the handler.
 *
 * No firestore/next imports, so every branch is testable without an emulator.
 */

/** The six § 512(c)(3)(A) elements that make a notice actionable. */
export interface DmcaNoticeInput {
  /** Typed name is acceptable for electronic notices. */
  signature: string;
  copyrightedWork: string;
  /** URL / content-id / path of the allegedly infringing material. */
  identifiedMaterial: string;
  complainant: {
    name: string;
    email: string;
    phone?: string;
    address: string;
  };
  /** Attests the use is unauthorized by owner, agent, or law. */
  goodFaithBelief: boolean;
  /** Under penalty of perjury: info accurate, complainant is owner or agent. */
  accuracyAndPerjuryAttestation: boolean;
}

export type NoticeStatus =
  | 'pending_review'
  | 'elements_incomplete'
  | 'pending_takedown'
  | 'taken_down'
  | 'rejected_abuse'
  | 'counter_noticed';

export interface ValidationResult {
  elementsComplete: boolean;
  /** Missing / malformed field names. */
  missing: string[];
}

/**
 * Check for the six § 512(c)(3)(A) elements — the "reasonably implemented"
 * threshold. A notice missing any is not actionable and does NOT count toward
 * the uploader's strikes. Merits are never judged here.
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
  // Deliberately permissive — "looks like an email", not RFC 5322. Bad addresses
  // surface as delivery bounces.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x.trim());
}

/**
 * Per-user strike record. Strikes expire after 12 months — industry convention
 * (YouTube, Google Drive), and it defeats weaponised serial-takedown targeting.
 */
export interface StrikeRecord {
  /** ISO-8601 timestamp of the originating takedown. */
  at: string;
  noticeId: string;
  /** True once cleared by a successful counter-notice. */
  cleared?: boolean;
}

export type StrikeOutcome =
  | { tier: 'warning'; newCount: number; nextAction: 'email_warning' }
  | { tier: 'suspension'; newCount: number; nextAction: 'suspend_14_days' }
  | { tier: 'termination'; newCount: number; nextAction: 'terminate_account' };

/** Strikes older than this don't count. */
export const STRIKE_EXPIRY_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Count active (uncleared, unexpired) strikes and pick the next tier.
 *
 * Takes PRIOR strikes and answers for the takedown about to be recorded — so 2
 * prior active strikes returns `termination`, not `suspension`.
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

/**
 * Anti-flood caps for the public form. Deliberately loose — a studio filing a
 * list of pirated assets might submit 30 in a day; the target is the abuse
 * pattern of thousands per hour from one source.
 */
export const RATE_LIMIT = {
  perEmailPerHour: 10,
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
