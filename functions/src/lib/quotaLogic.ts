/**
 * Pure logic for roost per-site storage quota enforcement. A flat
 * `SITE_STORAGE_BYTES` cap per site — not an entitlement; nothing consults a plan.
 *
 * Alarms fire on the TRANSITION across 50/80/100 %, diffed against the previous
 * level, so a 40 % → 85 % jump fires 80 % once and never 50 % retroactively.
 *
 * Admission counts `(used + pending)` so two concurrent uploads can't each "fit"
 * while their sum exceeds the cap. Callers reserve `pendingBytes` before issuing
 * the signed URL.
 */

const TIB = 1024 ** 4;

/**
 * Included storage per site. Duplicated as `SITE_STORAGE_BYTES` in
 * `web/lib/roostStorage.ts` (web can't import from functions/) — keep in sync.
 */
export const SITE_STORAGE_BYTES = 1 * TIB;

/** Alarm threshold levels, ordered low → high. 0 means "under 50 %". */
export const ALARM_LEVELS = [0, 0.5, 0.8, 1.0] as const;
export type AlarmLevel = (typeof ALARM_LEVELS)[number];

export interface QuotaState {
  /** Bytes already finalised in R2 for this site. */
  usedBytes: number;
  /** Signed-URL-issued but unfinalised bytes; counted so concurrency can't overcommit. */
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

/** Greatest threshold crossed: 0.75 → 0.5, since 80 % is not yet crossed. */
function currentAlarmLevel(fractionUsed: number): AlarmLevel {
  let highest: AlarmLevel = 0;
  for (const t of ALARM_LEVELS) {
    if (fractionUsed >= t) highest = t;
  }
  return highest;
}

/**
 * Alarm levels newly crossed from `before` → `after`, in order, so a big jump
 * fires every unfired threshold. Empty when nothing new crossed.
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
 * Decide if a new upload may proceed: 402 when it would cross the allowance,
 * 400 on a non-positive `requestedBytes`.
 *
 * The caller reserves `requestedBytes` as pendingBytes on admission and releases
 * on success/failure — the backpressure that stops two concurrent uploads from
 * each fitting in isolation.
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

  if (report.atCap) {
    return {
      allowed: false,
      status: 402,
      reason: 'quota_exceeded',
      report,
      denialHint: denialHint(report.planLimitBytes),
    };
  }

  // Against the cap, not `remaining`.
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
