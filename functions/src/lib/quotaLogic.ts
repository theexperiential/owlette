/**
 * Pure logic for roost per-site storage quota enforcement.
 *
 * A flat capacity limit — `SITE_STORAGE_BYTES` per site, applied to every
 * site identically. This bounds what one site may hold in R2; it is not an
 * entitlement, and nothing here consults a plan.
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

const TIB = 1024 ** 4;

/**
 * Included storage per site, in bytes.
 *
 * Mirrored by `SITE_STORAGE_BYTES` in `web/lib/roostStorage.ts` — web can't
 * import from functions/, so the number exists on both sides and the two
 * must stay in sync.
 */
export const SITE_STORAGE_BYTES = 1 * TIB;

/** Alarm threshold levels, ordered low → high. 0 means "under 50 %". */
export const ALARM_LEVELS = [0, 0.5, 0.8, 1.0] as const;
export type AlarmLevel = (typeof ALARM_LEVELS)[number];

export interface QuotaState {
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
  /** Included storage per site. */
  planLimitBytes: number;
  /** usedBytes + pendingBytes */
  committedBytes: number;
  remainingBytes: number;
  /** committedBytes / planLimitBytes (0..1). */
  fractionUsed: number;
  /** Highest threshold strictly crossed by committedBytes. */
  alarmLevel: AlarmLevel;
  /** `true` once committedBytes ≥ planLimitBytes. */
  atCap: boolean;
}

/** Compute the quota snapshot for a site without any other side-effect. */
export function reportQuota(state: QuotaState): QuotaReport {
  const planLimitBytes = SITE_STORAGE_BYTES;
  const committedBytes = Math.max(0, state.usedBytes + state.pendingBytes);

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
  reason?: 'invalid_request' | 'quota_exceeded' | 'quota_would_exceed';
  report: QuotaReport;
  /** UX hint for the dashboard when denied. */
  denialHint?: { message: string };
}

/**
 * Decide if a new upload may proceed.
 *
 * Returns 402 ("Payment Required") when the site would cross its storage
 * allowance, and 400 when the caller sent a non-positive `requestedBytes`
 * (malformed).
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

  // already at cap: straight 402.
  if (report.atCap) {
    return {
      allowed: false,
      status: 402,
      reason: 'quota_exceeded',
      report,
      denialHint: denialHint(report.planLimitBytes),
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
      denialHint: denialHint(report.planLimitBytes),
    };
  }

  return { allowed: true, status: 200, report };
}

/** Build the hint the dashboard / CLI shows on a denial. */
function denialHint(limitBytes: number): UploadAdmission['denialHint'] {
  return {
    message: `storage full (${limitBytes / TIB} TB per site) — delete old roost versions to free space.`,
  };
}
