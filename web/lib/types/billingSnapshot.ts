/**
 * Wire contract for `GET /api/billing/snapshot` (billing-system wave 2.5).
 *
 * Lives here rather than in the route module because both ends need it: the
 * route builds it with `firebase-admin` and the Stripe SDK in scope, and
 * `useBillingSnapshot` consumes it from a `'use client'` hook. A type-only
 * import of the route would be erased at compile time, but a single stray
 * value import — now or in a later edit — would drag the admin SDK into the
 * browser bundle. A dependency-free leaf makes that impossible rather than
 * merely unlikely.
 *
 * Same reasoning (and same neighbourhood) as `@/lib/types/customer`, which
 * owns the `customers/{uid}` document shape.
 */
import type { BillProjection } from '@/lib/billing/pricing';
import type { SiteTier } from '@/lib/siteTier';
import type { BillingState } from '@/lib/types/customer';

/** A site the calling account owns, as the billing tab lists it. */
export interface BillingSnapshotSite {
  siteId: string;
  name: string;
  tier: SiteTier;
  /** Machines with a heartbeat inside the billing window. */
  activeMachineCount: number;
}

/** One site's row in the most recent usage mirror. */
export interface BillingSnapshotUsageSite {
  siteId: string;
  activeMachineCount: number | null;
  storageBytes: number | null;
}

/**
 * The most recent `billing/{uid}/usage/{YYYY-MM-DD}` mirror, normalised.
 *
 * Written by the daily usage cron (tasks 2.3 / 2.4). Absent until that cron
 * has run at least once for this account, which is the state every account is
 * in today — hence `usage: null` on the response rather than a zeroed object,
 * so the tab can tell "no storage used" apart from "no data yet" and hide the
 * storage bar in the latter case.
 */
export interface BillingSnapshotUsage {
  /** The mirror's document id — a `YYYY-MM-DD` period key. */
  period: string;
  sites: BillingSnapshotUsageSite[];
  totals: {
    activeMachineCount: number | null;
    storageBytes: number | null;
  };
}

export interface BillingSnapshotResponse {
  billingState: BillingState;
  /** End of the app-managed trial, epoch ms; `null` = clock not started. */
  trialEndsAt: number | null;
  /**
   * The announced billing go-live date (T0), epoch ms; `null` when no date has
   * been configured yet.
   *
   * Deployment-level, not account-level: it mirrors `config/billing.goLiveAt`,
   * a single admin-owned document that **task 5.1 writes** when the go-live
   * date is set. Until then the field is `null` on every response and the
   * dashboard's announcement banner stays hidden — which is the correct
   * behaviour, since there is no date to announce.
   *
   * Paired with `trialEndsAt === null` (the pre-go-live sentinel) it is what
   * distinguishes "billing starts on the 14th" from "your trial is running".
   * See `TrialBanner`'s announcement state.
   */
  goLiveAt: number | null;
  /**
   * Whole days until `trialEndsAt`, rounded up; `null` when there is no clock
   * to count (pre-go-live sentinel) or the account is not trialing.
   */
  daysLeft: number | null;
  /** Tier the account pays for; `null` while trialing / never converted. */
  subscriptionTier: SiteTier | null;
  /** End of the current Stripe period — the renewal date, epoch ms. */
  currentPeriodEnd: number | null;
  /** Whether this deployment can reach Stripe at all. */
  stripeConfigured: boolean;
  /** Whether this account has a Stripe customer to open a portal against. */
  hasBillingAccount: boolean;
  sites: BillingSnapshotSite[];
  usage: BillingSnapshotUsage | null;
  projectedBill: BillProjection;
}
