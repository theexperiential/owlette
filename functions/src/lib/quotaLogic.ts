/**
 * Pure logic for roost per-customer storage quota enforcement (wave 2b.5).
 *
 * Plans (authoritative: roost project memory):
 *   - free       : 5 GB
 *   - starter    : 25 GB  ($8/mo)
 *   - pro        : 100 GB ($15/mo)
 *   - enterprise : BYO-bucket (no Owlette-side cap; returns Infinity)
 *
 * Alarm thresholds fire at 50 / 80 / 100 % of cap. The transition — not
 * the absolute level — is what an alerting caller wants, so the pure
 * function also reports "new crossings" by diffing the previous alarm
 * level against the current one. That way an upload that takes a tenant
 * from 40 % → 85 % in one go fires the 80 % alarm exactly once, not
 * retroactively for 50 % too.
 *
 * Atomic upload admission uses `(used + pending)` as the denominator
 * so two concurrent uploads can't both individually "fit" when their
 * sum exceeds the cap. Callers reserve `pendingBytes` before issuing
 * the signed URL.
 */

export type PlanTier = 'free' | 'starter' | 'pro' | 'enterprise';

/** Tier byte caps. Infinity for BYO-bucket enterprise. */
export const PLAN_LIMITS_BYTES: Record<PlanTier, number> = {
  free: 5 * 1024 ** 3,
  starter: 25 * 1024 ** 3,
  pro: 100 * 1024 ** 3,
  enterprise: Infinity,
};

/** Alarm threshold levels, ordered low → high. 0 means "under 50 %". */
export const ALARM_LEVELS = [0, 0.5, 0.8, 1.0] as const;
export type AlarmLevel = (typeof ALARM_LEVELS)[number];

export interface QuotaState {
  /** Plan tier, determines the cap. */
  tier: PlanTier;
  /** Bytes already finalised in R2 for this site. */
  usedBytes: number;
  /**
   * Bytes reserved for uploads that have been issued a signed URL but
   * not yet finalised. Counted toward the cap so concurrent uploads
   * can't overcommit.
   */
  pendingBytes: number;
}

export interface QuotaReport {
  planLimitBytes: number;
  /** usedBytes + pendingBytes */
  committedBytes: number;
  remainingBytes: number;
  /** committedBytes / planLimitBytes (0..1). NaN for unlimited plans. */
  fractionUsed: number;
  /** Highest threshold strictly crossed by committedBytes. */
  alarmLevel: AlarmLevel;
  /** `true` once committedBytes ≥ planLimitBytes (free tier hits 402). */
  atCap: boolean;
  /** Unlimited-plan short-circuit flag. */
  unlimited: boolean;
}

/** Compute the quota snapshot for a site without any other side-effect. */
export function reportQuota(state: QuotaState): QuotaReport {
  const planLimitBytes = PLAN_LIMITS_BYTES[state.tier];
  const committedBytes = Math.max(0, state.usedBytes + state.pendingBytes);
  const unlimited = !isFinite(planLimitBytes);

  if (unlimited) {
    return {
      planLimitBytes,
      committedBytes,
      remainingBytes: Infinity,
      fractionUsed: NaN,
      alarmLevel: 0,
      atCap: false,
      unlimited: true,
    };
  }

  const fractionUsed = committedBytes / planLimitBytes;
  const alarmLevel = currentAlarmLevel(fractionUsed);
  const atCap = committedBytes >= planLimitBytes;

  return {
    planLimitBytes,
    committedBytes,
    remainingBytes: Math.max(0, planLimitBytes - committedBytes),
    fractionUsed,
    alarmLevel,
    atCap,
    unlimited: false,
  };
}

/**
 * Pick the strictly-greatest alarm threshold crossed by `fractionUsed`.
 * For fractionUsed=0.75 this returns 0.5 (50% is crossed; 80% is not).
 */
function currentAlarmLevel(fractionUsed: number): AlarmLevel {
  let highest: AlarmLevel = 0;
  for (const t of ALARM_LEVELS) {
    if (fractionUsed >= t) highest = t;
  }
  return highest;
}

/**
 * Return the alarm levels newly crossed going from `before` → `after`.
 * Ordering guarantees monotonic alarms: a big jump fires every unfired
 * threshold in order. Empty if nothing new crossed.
 */
export function newAlarmCrossings(
  before: AlarmLevel,
  after: AlarmLevel,
): AlarmLevel[] {
  if (after <= before) return [];
  const result: AlarmLevel[] = [];
  for (const t of ALARM_LEVELS) {
    if (t > before && t <= after) result.push(t);
  }
  return result;
}

/* --------------------------------------------------------------------- */
/*  Upload admission                                                     */
/* --------------------------------------------------------------------- */

export interface UploadAdmissionInput {
  state: QuotaState;
  /** Total bytes the caller wants to upload (sum of all chunks). */
  requestedBytes: number;
}

export interface UploadAdmission {
  allowed: boolean;
  /** HTTP status the pre-upload hook should return. */
  status: 200 | 400 | 402;
  /** Machine-readable reason for logs + UI. */
  reason?:
    | 'invalid_request'
    | 'quota_exceeded'
    | 'quota_would_exceed';
  report: QuotaReport;
  /** UX hint for the dashboard when denied. */
  upgradeCta?: {
    currentTier: PlanTier;
    suggestedTier: PlanTier;
    message: string;
  };
}

/**
 * Decide if a new upload may proceed.
 *
 * Returns 402 ("Payment Required") with a suggested upgrade CTA when a
 * free/starter/pro tenant would cross their cap. Returns 400 when the
 * caller sent a non-positive `requestedBytes` (malformed).
 *
 * The caller reserves `requestedBytes` as pendingBytes on admission and
 * releases on chunk upload success/failure. This is the backpressure
 * that keeps two concurrent uploads from both fitting in isolation.
 */
export function admitUpload(input: UploadAdmissionInput): UploadAdmission {
  if (
    typeof input.requestedBytes !== 'number' ||
    !isFinite(input.requestedBytes) ||
    input.requestedBytes <= 0
  ) {
    return {
      allowed: false,
      status: 400,
      reason: 'invalid_request',
      report: reportQuota(input.state),
    };
  }

  const report = reportQuota(input.state);
  if (report.unlimited) {
    return { allowed: true, status: 200, report };
  }

  // already at cap: straight 402.
  if (report.atCap) {
    return {
      allowed: false,
      status: 402,
      reason: 'quota_exceeded',
      report,
      upgradeCta: suggestUpgrade(input.state.tier, report.committedBytes),
    };
  }

  // would the new upload push us over? compute against cap, not remaining.
  const afterBytes = report.committedBytes + input.requestedBytes;
  if (afterBytes > report.planLimitBytes) {
    return {
      allowed: false,
      status: 402,
      reason: 'quota_would_exceed',
      report,
      upgradeCta: suggestUpgrade(input.state.tier, afterBytes),
    };
  }

  return { allowed: true, status: 200, report };
}

/**
 * Suggest the cheapest tier that would admit the current/projected
 * usage. If we're already on `pro`, suggest `enterprise` (BYO bucket).
 */
function suggestUpgrade(
  currentTier: PlanTier,
  targetBytes: number,
): UploadAdmission['upgradeCta'] {
  const progression: PlanTier[] = ['free', 'starter', 'pro', 'enterprise'];
  const currentIdx = progression.indexOf(currentTier);
  for (let i = currentIdx + 1; i < progression.length; i++) {
    const tier = progression[i];
    if (targetBytes <= PLAN_LIMITS_BYTES[tier]) {
      return {
        currentTier,
        suggestedTier: tier,
        message: messageFor(currentTier, tier),
      };
    }
  }
  // nothing large enough — suggest enterprise (BYO).
  return {
    currentTier,
    suggestedTier: 'enterprise',
    message: messageFor(currentTier, 'enterprise'),
  };
}

function messageFor(from: PlanTier, to: PlanTier): string {
  if (to === 'enterprise') {
    return `storage cap exceeded on ${from} — contact us for an enterprise plan (bring your own bucket).`;
  }
  return `storage cap exceeded on ${from} — upgrade to ${to} to continue uploading.`;
}
