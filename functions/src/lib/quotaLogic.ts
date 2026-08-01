/**
 * Pure logic for roost per-site storage quota enforcement.
 *
 * Tier model (billing sprint wave 0.4 — authoritative:
 * `dev/active/billing-system/plan.md`):
 *   - core : roost not available — no included storage at all
 *   - pro  : 1 TiB included per site
 *
 * The tier is a property of the site doc (`sites/{siteId}.tier`), the same
 * field `web/lib/siteTier.ts` reads, so the dashboard gate and the server
 * enforcement can never disagree about what a customer bought. Overage
 * billing ($0.05/GB past the inclusion) and the 110 % hard cap are billing
 * sprint wave 2; this module models only the included allowance.
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

export type SiteTier = 'core' | 'pro';

/**
 * Tier assumed for a site doc whose `tier` field is missing or unknown.
 *
 * Mirrors `BETA_DEFAULT_TIER` in `web/lib/siteTier.ts` — web can't import
 * from functions/, so the constant exists on both sides and the two must
 * stay in sync: a divergent default would show roost in the dashboard
 * while every upload is denied server-side. Both are deleted at go-live
 * (billing sprint task 5.3), once every site doc carries an explicit tier.
 */
export const BETA_DEFAULT_TIER: SiteTier = 'pro';

const TIB = 1024 ** 4;

/**
 * Included storage per site, in bytes. `core` is 0 rather than a small
 * allowance — roost is a pro-tier feature, so a core site has nothing to
 * spend at all (see `roostAvailable` on QuotaReport).
 */
export const TIER_STORAGE_BYTES: Record<SiteTier, number> = {
  core: 0,
  pro: 1 * TIB,
};

/**
 * Narrow a raw `tier` field (Firestore data is untyped) to a known tier,
 * falling back to the documented beta default.
 */
export function resolveSiteTier(raw: unknown): SiteTier {
  if (raw === 'core') return 'core';
  if (raw === 'pro') return 'pro';
  return BETA_DEFAULT_TIER;
}

/** Alarm threshold levels, ordered low → high. 0 means "under 50 %". */
export const ALARM_LEVELS = [0, 0.5, 0.8, 1.0] as const;
export type AlarmLevel = (typeof ALARM_LEVELS)[number];

export interface QuotaState {
  /** Site tier, determines the cap. */
  tier: SiteTier;
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
  /** Included storage for the tier. 0 on core. */
  planLimitBytes: number;
  /** usedBytes + pendingBytes */
  committedBytes: number;
  remainingBytes: number;
  /** committedBytes / planLimitBytes (0..1). NaN when the tier has no storage. */
  fractionUsed: number;
  /** Highest threshold strictly crossed by committedBytes. */
  alarmLevel: AlarmLevel;
  /** `true` once committedBytes ≥ planLimitBytes. */
  atCap: boolean;
  /** `false` on core — the tier carries no storage entitlement to spend. */
  roostAvailable: boolean;
}

/** Compute the quota snapshot for a site without any other side-effect. */
export function reportQuota(state: QuotaState): QuotaReport {
  const planLimitBytes = TIER_STORAGE_BYTES[state.tier];
  const committedBytes = Math.max(0, state.usedBytes + state.pendingBytes);

  // Core has no allowance, so there is no ratio to take. Short-circuit
  // before the division: a site downgraded to core while still holding
  // roost bytes would otherwise divide by zero into a permanent 100 %
  // alarm, spamming an alarm doc every reconcile. Uploads are already
  // denied by the tier gate in admitUpload — alarms would add nothing.
  if (planLimitBytes <= 0) {
    return {
      planLimitBytes: 0,
      committedBytes,
      remainingBytes: 0,
      fractionUsed: NaN,
      alarmLevel: 0,
      atCap: true,
      roostAvailable: false,
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
    roostAvailable: true,
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
  status: 200 | 400 | 402 | 403;
  /**
   * Machine-readable reason for logs + UI. `tier_insufficient` is the
   * shared code for "pro-only feature on a core site" (billing sprint
   * task 0.5 uses the same code on the web gating helpers).
   */
  reason?:
    | 'invalid_request'
    | 'tier_insufficient'
    | 'quota_exceeded'
    | 'quota_would_exceed';
  report: QuotaReport;
  /**
   * UX hint for the dashboard when denied. `suggestedTier` is set only
   * when changing tier actually resolves the denial (core → pro); a pro
   * site that has filled its included storage has no higher tier to move
   * to, so it carries the message alone.
   */
  upgradeCta?: {
    currentTier: SiteTier;
    suggestedTier?: SiteTier;
    message: string;
  };
}

/**
 * Decide if a new upload may proceed.
 *
 * Returns 403 (`tier_insufficient`) for a core site — roost isn't part of
 * that tier — and 402 ("Payment Required") when a pro site would cross its
 * included storage. Returns 400 when the caller sent a non-positive
 * `requestedBytes` (malformed).
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

  // roost isn't sold on core, so this is a feature gate (403), not a
  // quota that could be topped up by deleting versions (402).
  if (!report.roostAvailable) {
    return {
      allowed: false,
      status: 403,
      reason: 'tier_insufficient',
      report,
      upgradeCta: denialHint(input.state.tier, report.planLimitBytes),
    };
  }

  // already at cap: straight 402.
  if (report.atCap) {
    return {
      allowed: false,
      status: 402,
      reason: 'quota_exceeded',
      report,
      upgradeCta: denialHint(input.state.tier, report.planLimitBytes),
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
      upgradeCta: denialHint(input.state.tier, report.planLimitBytes),
    };
  }

  return { allowed: true, status: 200, report };
}

/**
 * Build the hint the dashboard / CLI shows on a denial.
 *
 * Only one upgrade path exists in the two-tier model (core → pro). A pro
 * site that has consumed its inclusion has nowhere higher to go, so it
 * gets a "free up space" message instead — until billing sprint wave 2
 * lands metered overage and this message becomes "pay the overage or
 * remove versions".
 */
function denialHint(
  currentTier: SiteTier,
  limitBytes: number,
): UploadAdmission['upgradeCta'] {
  if (currentTier === 'core') {
    return {
      currentTier,
      suggestedTier: 'pro',
      message:
        'roost is a pro-tier feature — upgrade to pro to store project versions.',
    };
  }
  return {
    currentTier,
    message: `included storage full (${limitBytes / TIB} TB per site) — delete old roost versions to free space.`,
  };
}
