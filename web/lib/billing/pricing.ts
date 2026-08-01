/**
 * Billing price math (billing-system wave 2.5).
 *
 * The single source of every number a customer's bill is built from: the
 * per-machine prices, the pro tier's 3-machine minimum, the roost storage
 * overage rate, and the window that decides whether a machine counts as
 * "active" this period.
 *
 * Why one module: the projection the billing tab renders, the metered usage
 * the daily cron reports to Stripe (task 2.3 / 2.4), and any future invoice
 * preview all have to agree to the cent. Duplicating `$50` or `max(3, n)` in
 * a component is how a UI ends up quoting a number the invoice contradicts.
 *
 * Pure and dependency-free — no Firestore, no Stripe, no clock of its own
 * beyond an injectable `now`. Same posture as `@/lib/siteTier` and
 * `@/lib/billing/billingState`, so client components, route handlers, and
 * cron jobs can all import it.
 *
 * **The prices here are the marketing page's prices.** They are what the
 * customer was quoted; the Stripe Price objects (task 1.1) must be created to
 * match. Stripe remains authoritative for what is actually charged — this
 * module produces a *projection*, and the tab labels it as one.
 */
import { getSiteTier, TIER_STORAGE_BYTES, type SiteTier } from '@/lib/siteTier';
import type { BillingTimestamp } from '@/lib/types/customer';

/**
 * Monthly price per billable machine, in whole US dollars.
 *
 * Mirrors the pricing table in `dev/active/billing-system/plan.md` and the
 * public pricing cards. `core` is $10/machine/month on a single site; `pro` is
 * $50/machine/month with the {@link PRO_MINIMUM_MACHINES} floor.
 */
export const TIER_PRICES_USD: Record<SiteTier, number> = {
  core: 10,
  pro: 50,
};

/**
 * Machines a pro site is billed for at minimum.
 *
 * A billing calculation, never a gate: a customer running two machines on pro
 * pays for three, but nothing blocks them from running two. See plan.md
 * strategic decision 3.
 */
export const PRO_MINIMUM_MACHINES = 3;

/** Roost storage overage past the site's included allowance, in USD per GB. */
export const STORAGE_OVERAGE_USD_PER_GB = 0.05;

/**
 * Bytes per GB used for the overage rate.
 *
 * Binary (GiB), not decimal, because the *included* allowance it is measured
 * against is binary: `TIER_STORAGE_BYTES.pro` is `1024 ** 4` (1 TiB) and
 * `functions/src/lib/telemetryLogic.ts` prices R2 storage on the same
 * `1024 ** 3` divisor. Mixing the two conventions would put a ~7 % error into
 * every overage line.
 */
export const BYTES_PER_GB = 1024 ** 3;

/**
 * How recently a machine must have checked in to be billed for the period.
 *
 * Seven days, per plan.md's per-machine billing section. Deliberately generous:
 * a touring rig crated for a weekend, a signage player behind a router reboot,
 * or a kiosk off for a holiday must not silently drop off the invoice and then
 * reappear — churn in the billed count is worse for the customer's trust than
 * a few days of grace costs us.
 */
export const ACTIVE_MACHINE_WINDOW_DAYS = 7;

/** {@link ACTIVE_MACHINE_WINDOW_DAYS} in milliseconds. */
export const ACTIVE_MACHINE_WINDOW_MS = ACTIVE_MACHINE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/**
 * Coerce a machine doc's `lastHeartbeat` into epoch milliseconds, or `null`
 * when it can't be read as a time.
 *
 * The agent writes `lastHeartbeat` as a Firestore server timestamp
 * (`firebase_client.py`), so in practice this receives an admin-SDK
 * `Timestamp`. The wider union is defensive against the same shape drift
 * `parseFirestoreSeconds()` in `@/hooks/useFirestore` was written to absorb —
 * cache rehydration, JSON round-trips, and legacy `{_seconds}` payloads all
 * describe the same instant differently.
 *
 * A local converter rather than importing that hook's parser: `useFirestore`
 * is `'use client'` and pulls in the client Firebase SDK, which must not be
 * dragged into a route handler or a cron job. It also differs in units — the
 * hook returns Unix *seconds* to match the dashboard's heartbeat-age math,
 * while everything in this module works in milliseconds.
 */
export function heartbeatToMillis(value: BillingTimestamp | null | undefined): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === 'object') {
    const v = value as {
      toMillis?: () => number;
      seconds?: number;
      _seconds?: number;
    };
    if (typeof v.toMillis === 'function') {
      try {
        const ms = v.toMillis();
        return Number.isFinite(ms) ? ms : null;
      } catch {
        return null;
      }
    }
    if (typeof v.seconds === 'number') return v.seconds * 1000;
    if (typeof v._seconds === 'number') return v._seconds * 1000;
  }
  return null;
}

/**
 * True when a machine has checked in inside the billing window.
 *
 * A machine with no readable heartbeat at all is **not** active. That is the
 * customer-favourable direction (an unparseable timestamp costs us the line
 * item rather than billing them for a machine we can't prove exists), and it
 * is the opposite of `resolveBillingState()`'s fail-open — there, failing open
 * keeps a customer working; here, failing open would charge them.
 */
export function isMachineActive(
  lastHeartbeat: BillingTimestamp | null | undefined,
  now: Date = new Date(),
): boolean {
  const ms = heartbeatToMillis(lastHeartbeat);
  if (ms === null) return false;
  return now.getTime() - ms <= ACTIVE_MACHINE_WINDOW_MS;
}

/**
 * Machines a site is billed for, given how many are active.
 *
 * `core` bills exactly what is running. `pro` applies the
 * {@link PRO_MINIMUM_MACHINES} floor — including at zero active machines,
 * which is the documented behaviour, not an edge case we round away.
 */
export function billableMachines(tier: SiteTier, activeMachineCount: number): number {
  const count = Number.isFinite(activeMachineCount) ? Math.max(0, Math.trunc(activeMachineCount)) : 0;
  return tier === 'pro' ? Math.max(PRO_MINIMUM_MACHINES, count) : count;
}

/** Round to whole cents. Money must never surface as `149.99999999999997`. */
export function roundUsd(amount: number): number {
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount * 100) / 100;
}

/** Included roost storage for a tier, in bytes (0 for `core` — roost is pro-only). */
export function includedStorageBytes(tier: SiteTier): number {
  return TIER_STORAGE_BYTES[tier];
}

/**
 * Bytes past the site's included allowance. Never negative.
 *
 * `core` has a zero allowance, so any bytes at all read as overage. That is
 * arithmetically true but not a bill we send: roost is unavailable on core, so
 * a core site holding bytes is legacy data, and {@link projectSiteBill} charges
 * overage on pro only. See its note.
 */
export function storageOverageBytes(tier: SiteTier, usedBytes: number): number {
  if (!Number.isFinite(usedBytes) || usedBytes <= 0) return 0;
  return Math.max(0, usedBytes - includedStorageBytes(tier));
}

/** Overage charge in USD for `usedBytes` on `tier`, rounded to cents. */
export function storageOverageUsd(tier: SiteTier, usedBytes: number): number {
  const overBytes = storageOverageBytes(tier, usedBytes);
  if (overBytes <= 0) return 0;
  return roundUsd((overBytes / BYTES_PER_GB) * STORAGE_OVERAGE_USD_PER_GB);
}

/** One site's line on the projected bill. */
export interface SiteBillProjection {
  siteId: string;
  tier: SiteTier;
  /** Machines seen in the last {@link ACTIVE_MACHINE_WINDOW_DAYS} days. */
  activeMachineCount: number;
  /** What the invoice counts — `max(3, active)` on pro. */
  billableMachines: number;
  /** `billableMachines × TIER_PRICES_USD[tier]`. */
  machinesUsd: number;
  /** Roost bytes stored, from the usage mirror; `null` when no usage data yet. */
  storageBytes: number | null;
  /** The tier's included allowance, for the storage bar's denominator. */
  includedStorageBytes: number;
  /** Bytes past the allowance; `0` when under, or when no usage data yet. */
  storageOverageBytes: number;
  /** Overage charge for those bytes. */
  storageOverageUsd: number;
  /** `machinesUsd + storageOverageUsd` — this site's whole monthly projection. */
  monthlyUsd: number;
}

/** The whole account's projected bill. */
export interface BillProjection {
  perSite: SiteBillProjection[];
  /** Sum of every site's `monthlyUsd`, rounded to cents. */
  totalUsd: number;
}

export interface SiteBillInput {
  siteId: string;
  /** Raw `sites/{siteId}.tier`; resolved through `getSiteTier()`. */
  tier?: SiteTier | string | null;
  activeMachineCount: number;
  /** Roost bytes for the site; omit or pass `null` when usage data is absent. */
  storageBytes?: number | null;
}

/**
 * Project one site's monthly charge.
 *
 * Storage overage is charged on **pro only**. A core site has no roost
 * entitlement, so it also has no roost bill: any bytes it still holds are
 * pre-downgrade leftovers, and dunning a core customer for storage they can no
 * longer even use would be indefensible. Enforcement of the allowance lives in
 * `functions/src/lib/quotaLogic.ts`; this is the invoice preview.
 */
export function projectSiteBill(input: SiteBillInput): SiteBillProjection {
  const tier = getSiteTier({ tier: input.tier });
  const active = Number.isFinite(input.activeMachineCount)
    ? Math.max(0, Math.trunc(input.activeMachineCount))
    : 0;
  const billable = billableMachines(tier, active);
  const machinesUsd = roundUsd(billable * TIER_PRICES_USD[tier]);

  const storageBytes =
    typeof input.storageBytes === 'number' && Number.isFinite(input.storageBytes)
      ? Math.max(0, input.storageBytes)
      : null;

  const chargesStorage = tier === 'pro' && storageBytes !== null;
  const overBytes = chargesStorage ? storageOverageBytes(tier, storageBytes) : 0;
  const overUsd = chargesStorage ? storageOverageUsd(tier, storageBytes) : 0;

  return {
    siteId: input.siteId,
    tier,
    activeMachineCount: active,
    billableMachines: billable,
    machinesUsd,
    storageBytes,
    includedStorageBytes: includedStorageBytes(tier),
    storageOverageBytes: overBytes,
    storageOverageUsd: overUsd,
    monthlyUsd: roundUsd(machinesUsd + overUsd),
  };
}

/** Project every site, and the account total. */
export function projectAccountBill(sites: SiteBillInput[]): BillProjection {
  const perSite = sites.map(projectSiteBill);
  const totalUsd = roundUsd(perSite.reduce((sum, s) => sum + s.monthlyUsd, 0));
  return { perSite, totalUsd };
}

/**
 * Format a USD amount for display: `$150` when whole, `$150.25` otherwise.
 *
 * Trailing `.00` is noise on a per-machine bill where most numbers are round
 * multiples of $10 or $50; cents only appear once storage overage does, and
 * that is exactly when they matter.
 */
export function formatUsd(amount: number): string {
  const rounded = roundUsd(amount);
  return Number.isInteger(rounded) ? `$${rounded}` : `$${rounded.toFixed(2)}`;
}
