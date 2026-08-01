'use client';

/**
 * Dashboard trial banner + read-only signage (billing-system wave 3.1).
 *
 * The dashboard's honest account of where the account stands in the trial
 * lifecycle: an announcement before billing goes live, a countdown in the last
 * week of the trial, and a persistent notice once the account is locked out.
 *
 * ## Signage, not a second enforcement layer
 *
 * Nothing here gates anything. The lockout is already enforced server-side —
 * `authorizedSiteHandler` throws `402 trial_expired` on the capabilities in
 * plan.md's lockout matrix, and the existing error toasts surface it. Disabling
 * every control in the client would duplicate that decision in a place where it
 * can drift out of step with the server, and would leave a customer with a
 * greyed-out dashboard and no explanation. So {@link ReadOnlyNotice} tells them
 * what is happening and why, and lets the server keep saying no.
 *
 * For the same reason the notice is a strip above the machine list rather than
 * an overlay: the lockout matrix keeps metrics, status, and history readable on
 * purpose (`data keeps flowing so reactivation is seamless`), so covering them
 * up would take away exactly what an expired account is still entitled to see.
 *
 * ## Owner-only
 *
 * Every state keys off `snapshot.sites`, which the route populates from
 * `sites where owner == <verified uid>` — so it is non-empty precisely for the
 * accounts that receive an invoice. A member of somebody else's site is never
 * billed for it and is never locked out by their *own* trial clock (the
 * server resolves a site's lockout through that site's owner, see
 * `getBillingSnapshot`), so telling them their trial ended would be both
 * useless and wrong. {@link ReadOnlyNotice} narrows further to the site
 * currently on screen: an owner whose own site is locked should not be told
 * they are "viewing only" while looking at somebody else's paid-up site.
 *
 * ## Nothing renders when there is nothing to say
 *
 * Every path returns `null` rather than an empty container. The dashboard has
 * a standing regression around reserving vertical space that pushes the machine
 * list below the fold; a banner that is absent must occupy zero pixels.
 */

import { useState } from 'react';
import { AlertTriangle, CalendarClock, Clock, Eye, Sparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ChoosePlanDialog } from '@/components/billing/ChoosePlanDialog';
import { useTrialBannerDismissal } from '@/hooks/useTrialBannerDismissal';
import { TRIAL_LENGTH_DAYS } from '@/lib/types/customer';
import type { BillingSnapshotResponse } from '@/lib/types/billingSnapshot';

/**
 * How close the trial's end has to be before the countdown appears.
 *
 * Deliberately not the whole 14 days: a banner that is up from the moment the
 * account is created is wallpaper by day three, and the plan's lifecycle puts
 * the countdown at "from day 7".
 */
export const COUNTDOWN_THRESHOLD_DAYS = 7;

export type TrialBannerState =
  | { kind: 'hidden' }
  /** Pre-T0: a go-live date exists, the account's clock has not started. */
  | { kind: 'announcement'; goLiveAt: number }
  /** Trial running, inside {@link COUNTDOWN_THRESHOLD_DAYS} of its end. */
  | { kind: 'countdown'; daysLeft: number }
  /** Locked out: the trial ran out, or the subscription was canceled. */
  | { kind: 'locked'; billingState: 'expired' | 'canceled' };

/** Local date, e.g. `3/14/2026`. Matches `BillingTab`. */
function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString();
}

/**
 * Which banner — if any — this snapshot calls for.
 *
 * Pure and exported so the state machine can be tested without rendering:
 * the difference between "your trial ends tomorrow" and "your trial ended" is
 * the difference between a nudge and a lockout, and it must not be able to
 * regress quietly.
 */
export function resolveTrialBannerState(
  snapshot: BillingSnapshotResponse | null,
): TrialBannerState {
  if (!snapshot) return { kind: 'hidden' };
  // Owner-only — see the module comment. An account that owns no sites has no
  // invoice and nothing to lock out.
  if (snapshot.sites.length === 0) return { kind: 'hidden' };

  const { billingState, trialEndsAt, goLiveAt, daysLeft } = snapshot;

  if (billingState === 'expired' || billingState === 'canceled') {
    return { kind: 'locked', billingState };
  }
  // 'active' — a paying subscriber has nothing to be warned about.
  if (billingState !== 'trialing') return { kind: 'hidden' };

  if (trialEndsAt === null) {
    // The pre-go-live sentinel: the clock has not started. With a date
    // configured that is an announcement; without one there is nothing
    // truthful to say, so say nothing.
    return goLiveAt === null ? { kind: 'hidden' } : { kind: 'announcement', goLiveAt };
  }

  // Plenty of runway left — don't nag.
  if (daysLeft === null || daysLeft > COUNTDOWN_THRESHOLD_DAYS) return { kind: 'hidden' };
  return { kind: 'countdown', daysLeft };
}

/** The banner's one-line message. */
function bannerMessage(state: Exclude<TrialBannerState, { kind: 'hidden' }>): string {
  switch (state.kind) {
    case 'announcement':
      return `billing starts ${formatDate(state.goLiveAt)} — your ${TRIAL_LENGTH_DAYS}-day free trial begins then`;
    case 'countdown':
      // `daysLeft` is rounded up server-side, so 0 only shows up if the clock
      // ran out between the resolve and the response. Say "today" rather than
      // "0 days left", which would read as broken.
      if (state.daysLeft <= 0) return 'your free trial ends today — choose a plan';
      if (state.daysLeft === 1) return '1 day left in your free trial — choose a plan';
      return `${state.daysLeft} days left in your free trial — choose a plan`;
    case 'locked':
      return state.billingState === 'canceled'
        ? 'your subscription was canceled — choose a plan to reactivate'
        : 'your trial ended — choose a plan to reactivate';
  }
}

const BANNER_ICONS = {
  announcement: CalendarClock,
  countdown: Clock,
  locked: AlertTriangle,
} as const;

export interface TrialBannerProps {
  /**
   * The account's billing snapshot. `null` while it loads, or when the fetch
   * failed — either way the banner renders nothing rather than guessing.
   */
  snapshot: BillingSnapshotResponse | null;
}

export function TrialBanner({ snapshot }: TrialBannerProps) {
  const [planDialogOpen, setPlanDialogOpen] = useState(false);
  const { dismissed, dismiss, ready } = useTrialBannerDismissal();

  const state = resolveTrialBannerState(snapshot);
  if (state.kind === 'hidden') return null;

  const locked = state.kind === 'locked';
  // The lockout notice has no close affordance: the account is read-only until
  // a plan is chosen, and hiding the reason would leave the owner guessing why
  // their controls stopped working. The other two are dismissable, and stay
  // hidden until the stored dismissal has been read so a dismissed banner
  // never flashes in on load.
  if (!locked && (!ready || dismissed)) return null;

  const Icon = BANNER_ICONS[state.kind];
  const tone = locked
    ? 'border-destructive/40 bg-destructive/10'
    : 'border-accent-cyan/40 bg-accent-cyan/5';
  const iconTone = locked ? 'text-destructive' : 'text-accent-cyan';
  // The announcement is informational — conversion is a T0 concern, and the
  // billing tab is right there for anyone eager to convert early.
  const offersCheckout = state.kind !== 'announcement';
  // A button that can only 503 is worse than no button — mirrors the billing
  // tab's posture when the deployment has no Stripe keys.
  const stripeReady = snapshot?.stripeConfigured ?? false;

  return (
    <>
      <div
        data-testid="trial-banner"
        data-banner-state={state.kind}
        role="status"
        className={`mb-4 flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3 ${tone}`}
      >
        <Icon className={`h-4 w-4 flex-shrink-0 ${iconTone}`} aria-hidden="true" />
        <p className="min-w-0 flex-1 text-sm text-foreground">{bannerMessage(state)}</p>

        {offersCheckout &&
          (stripeReady ? (
            <Button
              type="button"
              size="sm"
              onClick={() => setPlanDialogOpen(true)}
              className="cursor-pointer"
            >
              <Sparkles className="mr-1 h-3.5 w-3.5" aria-hidden="true" /> choose a plan
            </Button>
          ) : (
            <p className="text-xs text-muted-foreground">billing setup in progress</p>
          ))}

        {!locked && (
          <button
            type="button"
            onClick={dismiss}
            aria-label="dismiss"
            data-testid="trial-banner-dismiss"
            className="flex-shrink-0 cursor-pointer rounded-md p-1 text-muted-foreground outline-none transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent-cyan/40"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </div>

      {/* Mounted only where it is reachable — the announcement carries no
          checkout affordance, and neither does an unconfigured deployment. */}
      {offersCheckout && stripeReady && (
        <ChoosePlanDialog
          open={planDialogOpen}
          onOpenChange={setPlanDialogOpen}
          defaultTier={snapshot?.subscriptionTier ?? undefined}
        />
      )}
    </>
  );
}

/**
 * Whether the site currently on screen is one this account owns *and* is
 * locked out — i.e. whether the server will refuse its control-plane actions.
 *
 * Exported for tests, and narrow on purpose: a locked owner looking at a site
 * they merely belong to is not viewing-only there.
 */
export function isSiteReadOnly(
  snapshot: BillingSnapshotResponse | null,
  currentSiteId: string,
): boolean {
  if (!snapshot || !currentSiteId) return false;
  if (snapshot.billingState !== 'expired' && snapshot.billingState !== 'canceled') return false;
  return snapshot.sites.some((site) => site.siteId === currentSiteId);
}

export interface ReadOnlyNoticeProps {
  snapshot: BillingSnapshotResponse | null;
  /** The site the dashboard is currently showing. */
  currentSiteId: string;
}

/**
 * The paywall treatment: a strip above the machine list saying the controls
 * are paused. Renders nothing — no placeholder, no reserved height — when the
 * account is not locked out.
 */
export function ReadOnlyNotice({ snapshot, currentSiteId }: ReadOnlyNoticeProps) {
  if (!isSiteReadOnly(snapshot, currentSiteId)) return null;

  return (
    <div
      data-testid="dashboard-read-only-notice"
      role="status"
      className="flex items-center gap-2.5 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-2.5"
    >
      <Eye className="h-4 w-4 flex-shrink-0 text-destructive" aria-hidden="true" />
      <p className="text-sm text-muted-foreground">
        viewing only — controls are paused until a plan is chosen. metrics and history keep
        updating, and nothing is deleted.
      </p>
    </div>
  );
}
