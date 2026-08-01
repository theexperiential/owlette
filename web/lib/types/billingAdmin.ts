/**
 * Wire contract for the superadmin billing surfaces (billing-system tasks
 * 4.1 + 4.2):
 *
 *  - `GET  /api/admin/billing/customers`      — the account list
 *  - `POST /api/admin/billing/customers/{uid}` — the three overrides
 *  - `GET  /api/admin/billing/overview`        — the ops dashboard
 *
 * A dependency-free leaf, for the same reason as `@/lib/types/billingSnapshot`
 * (plan.md pinned decision 13): both ends need these shapes, and the server
 * ends build them with `firebase-admin` in scope. A type-only import of a
 * route module is erased at compile time, but one stray value import — now or
 * in a later edit — would drag the admin SDK into the browser bundle. Keeping
 * the contract in a leaf makes that impossible rather than merely unlikely.
 */
import type { SiteTier } from '@/lib/siteTier';
import type { BillingState } from '@/lib/types/customer';

/* ─── customer list ────────────────────────────────────────────────────── */

/** One account's row in the admin customers table. */
export interface AdminBillingCustomer {
  uid: string;
  /** From `users/{uid}`; `null` when the user doc is missing. */
  email: string | null;
  /** From `users/{uid}.displayName`; `null` when unset. */
  displayName: string | null;
  /** True when `users/{uid}` carries a soft-delete marker. */
  deleted: boolean;
  /** Resolved live via `resolveBillingState()`, never read off the mirror. */
  billingState: BillingState;
  /** The stored `billingState` mirror, when it disagrees with the resolver. */
  staleMirror: BillingState | null;
  subscriptionStatus: string | null;
  subscriptionTier: SiteTier | null;
  /** Whether the tier in force is an admin comp rather than a Stripe write. */
  comped: boolean;
  /** Comp provenance, present only when `comped` is true. */
  comp: { at: number | null; by: string | null; note: string | null } | null;
  /** End of the app-managed trial, epoch ms; `null` = clock not started. */
  trialEndsAt: number | null;
  /** End of the current Stripe period, epoch ms. */
  currentPeriodEnd: number | null;
  /** Whether a Stripe subscription id is on file. */
  hasSubscription: boolean;
  /** Whether offline-alert emails are currently muted for this account. */
  alertEmailsMuted: boolean;
}

export interface AdminBillingCustomerListResponse {
  /** Rows after filtering, capped at the request's `limit`. */
  customers: AdminBillingCustomer[];
  /** Rows matching the filter before the cap. */
  matched: number;
  /** Customer docs scanned. */
  total: number;
  /** True when `matched` exceeded the cap and rows were dropped. */
  truncated: boolean;
}

/* ─── override ─────────────────────────────────────────────────────────── */

/** `POST /api/admin/billing/customers/{uid}` success body. */
export interface AdminBillingOverrideResponse {
  uid: string;
  operation: 'extend_trial' | 'set_tier' | 'force_expire';
  previousBillingState: BillingState;
  billingState: BillingState;
  trialEndsAt: number | null;
  subscriptionTier: SiteTier | null;
  comped: boolean;
  /** Trial-email milestones un-stamped so they can fire against the new clock. */
  clearedTrialEmailMarkers: string[];
  /** Whether a stale offline-alert mute was lifted. */
  clearedAlertMute: boolean;
}

/* ─── ops overview ─────────────────────────────────────────────────────── */

/** One account on a storage leaderboard. */
export interface AdminBillingStorageRow {
  uid: string;
  email: string | null;
  siteCount: number;
  /** Roost bytes in use across every site the account owns. */
  usedBytes: number;
  /** Included allowance summed across those sites. */
  includedBytes: number;
  /** `usedBytes / includedBytes`; `null` when the allowance is zero. */
  usedFraction: number | null;
  /** Bytes past the allowance; `0` when under. */
  overageBytes: number;
}

export interface AdminBillingOverviewResponse {
  /** When the aggregation ran, epoch ms. */
  generatedAt: number;
  customers: {
    total: number;
    byState: Record<BillingState, number>;
    /** `none` counts accounts with no `subscriptionTier` on file. */
    byTier: { core: number; pro: number; none: number };
    /** Accounts whose tier is a live admin comp. */
    comped: number;
  };
  /**
   * Monthly recurring revenue **projection** — not billed revenue. Built from
   * `pricing.ts` against the latest usage mirror per subscribed account, so it
   * is what today's fleet would cost at list price, not what Stripe invoiced.
   */
  mrr: {
    projectedUsd: number;
    /** Subscribed accounts considered. */
    accounts: number;
    /** How many of those had a usage mirror to project from. */
    withUsage: number;
    /** Period key (`YYYY-MM-DD`) of the newest mirror used; `null` when none. */
    latestPeriod: string | null;
  };
  conversion: {
    /** Subscribed accounts that ever had a trial clock. */
    converted: number;
    /** Accounts whose trial ran out without converting. */
    expired: number;
    /** `converted / (converted + expired)`; `null` when neither exists. */
    rate: number | null;
  };
  storage: {
    /** Fraction of the included allowance at which an account is flagged. */
    alertThreshold: number;
    /** Accounts with the most roost bytes, descending. */
    topAccounts: AdminBillingStorageRow[];
    /** Accounts at or past {@link alertThreshold}, descending by usage. */
    approachingOverage: AdminBillingStorageRow[];
  };
}
