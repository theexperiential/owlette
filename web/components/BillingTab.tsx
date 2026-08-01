'use client';

/**
 * BillingTab — the "billing" section of account settings
 * (billing-system wave 2.5).
 *
 * Answers three questions in one screen: what state is my account in, what
 * will it cost, and what do I do next. Everything it renders comes from a
 * single `GET /api/billing/snapshot` call — see `useBillingSnapshot` for why
 * that is a route rather than a Firestore listener.
 *
 * ## The numbers are a projection, and say so
 *
 * The per-site and total figures are computed from `@/lib/billing/pricing`,
 * the same module the metered usage cron reports from, so the tab and the
 * invoice cannot quote different prices. But an invoice also carries proration,
 * tax, and mid-period changes that only Stripe knows, so the copy calls this an
 * estimate and the portal remains the source of truth for what was charged.
 *
 * ## States it must survive
 *
 * - **stripe unconfigured** (today's state on every deployment): the trial
 *   information is still true and still worth showing, so the tab renders in
 *   full and only the checkout/portal actions are replaced with a note. A
 *   button that can only 503 is worse than no button.
 * - **snapshot error**: an explained retry, not a blank tab.
 * - **zero sites**: an empty state. A brand-new account with nothing deployed
 *   is a normal thing to be, not a missing resource.
 * - **no usage data**: storage bars are hidden entirely rather than drawn at
 *   zero, which would read as "you have used none of your 1 TiB" when the
 *   truth is "the daily usage job hasn't reported yet".
 */

import { useState } from 'react';
import { AlertTriangle, CreditCard, Loader2, RefreshCw, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ChoosePlanDialog } from '@/components/billing/ChoosePlanDialog';
import { useBillingSnapshot } from '@/hooks/useBillingSnapshot';
import { formatUsd, STORAGE_OVERAGE_USD_PER_GB } from '@/lib/billing/pricing';
import { formatBytes } from '@/lib/preUploadCheck';
import { toast } from '@/lib/toast';
import type { SiteBillProjection } from '@/lib/billing/pricing';
import type { BillingSnapshotResponse, BillingSnapshotSite } from '@/lib/types/billingSnapshot';

/** Local date, e.g. `3/14/2026`. Matches the api-keys rows in this dialog. */
function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString();
}

/**
 * The one-line answer to "where do I stand".
 *
 * `trialEndsAt === null` is the pre-go-live sentinel, not a missing value — it
 * means the trial clock has not been started for this account yet, so a
 * countdown would be a lie. See `Customer.trialEndsAt`.
 */
function billingStateLine(snapshot: BillingSnapshotResponse): string {
  const { billingState, trialEndsAt, daysLeft, subscriptionTier, currentPeriodEnd } = snapshot;

  if (billingState === 'trialing') {
    if (trialEndsAt === null) return "free during beta — billing hasn't started";
    if (daysLeft === null || daysLeft <= 0) return 'your free trial ends today';
    if (daysLeft === 1) return '1 day left in your free trial';
    return `${daysLeft} days left in your free trial`;
  }

  if (billingState === 'active') {
    const tier = subscriptionTier ? `you're on ${subscriptionTier}` : "you're subscribed";
    return currentPeriodEnd === null ? tier : `${tier} — renews ${formatDate(currentPeriodEnd)}`;
  }

  if (billingState === 'canceled') {
    return 'your subscription was canceled — choose a plan to reactivate';
  }

  return 'your trial ended — choose a plan to reactivate';
}

/** Roost usage bar for one pro site. Rendered only when usage data exists. */
function StorageBar({ projection }: { projection: SiteBillProjection }) {
  const { storageBytes, includedStorageBytes, storageOverageBytes, storageOverageUsd } = projection;
  if (storageBytes === null || includedStorageBytes <= 0) return null;

  // Clamped so an over-quota site fills the track rather than overflowing it;
  // the overage line below carries the "and then some" information.
  const percent = Math.min(100, Math.round((storageBytes / includedStorageBytes) * 100));
  const over = storageOverageBytes > 0;

  return (
    <div className="space-y-1.5 pt-1">
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span>roost storage</span>
        <span>
          {formatBytes(storageBytes)} of {formatBytes(includedStorageBytes)}
        </span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label="roost storage used"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={`h-full rounded-full ${over ? 'bg-destructive' : 'bg-accent-cyan'}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      {over && (
        <p className="text-[11px] text-muted-foreground">
          {formatBytes(storageOverageBytes)} over — {formatUsd(storageOverageUsd)}/mo at $
          {STORAGE_OVERAGE_USD_PER_GB}/gb
        </p>
      )}
    </div>
  );
}

/** One owned site: name, tier, billed machine count, monthly projection. */
function SiteRow({
  site,
  projection,
}: {
  site: BillingSnapshotSite;
  projection: SiteBillProjection | undefined;
}) {
  const machines = projection?.billableMachines ?? site.activeMachineCount;
  // The pro floor is a billing calculation, not a gate — say so inline rather
  // than letting a 1-machine site look like it is being overcharged.
  const showsMinimum = machines > site.activeMachineCount;

  return (
    <div className="rounded-md border border-border bg-card/50 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm text-white">{site.name}</p>
            <Badge variant={site.tier === 'pro' ? 'default' : 'secondary'}>{site.tier}</Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            {site.activeMachineCount} active {site.activeMachineCount === 1 ? 'machine' : 'machines'}
            {showsMinimum ? ` — billed at the ${machines}-machine pro minimum` : ''}
          </p>
        </div>
        <p className="flex-shrink-0 text-sm text-white">
          {projection ? `${formatUsd(projection.monthlyUsd)}/mo` : '—'}
        </p>
      </div>
      {projection && <StorageBar projection={projection} />}
    </div>
  );
}

export function BillingTab() {
  // Account settings mounts each section only while it is the visible one, so
  // mounting *is* the "tab opened" signal and the hook's default (fetch once,
  // never poll) is exactly right here.
  const { snapshot, loading, error, refetch } = useBillingSnapshot();
  const [portalLoading, setPortalLoading] = useState(false);
  const [planDialogOpen, setPlanDialogOpen] = useState(false);

  /**
   * Open the Stripe-hosted billing portal (wave 1.4, moved here from the
   * profile section).
   *
   * `portalLoading` is intentionally never cleared on the success path: the
   * navigation is already in flight, and resetting it would flash the button
   * back to its idle label while the browser is leaving the page.
   */
  const handleManageBilling = async () => {
    setPortalLoading(true);
    try {
      const res = await fetch('/api/billing/portal', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (res.ok && typeof data.url === 'string') {
        window.location.href = data.url;
        return;
      }
      toast.error(data.detail || 'could not open billing portal');
    } catch {
      toast.error('could not open billing portal');
    }
    setPortalLoading(false);
  };

  const header = (
    <div>
      <h3 className="text-base font-medium text-white">billing</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        your plan, usage, and what it costs
      </p>
    </div>
  );

  if (loading && !snapshot) {
    return (
      <div className="space-y-5">
        {header}
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          loading billing details…
        </div>
      </div>
    );
  }

  if (error && !snapshot) {
    return (
      <div className="space-y-5">
        {header}
        <div className="rounded-md border border-border bg-card/50 px-4 py-3 space-y-2">
          <div className="flex items-center gap-2 text-sm text-white">
            <AlertTriangle className="h-4 w-4 flex-shrink-0 text-red-400" />
            {error}
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => void refetch()}>
            <RefreshCw className="mr-1 h-3.5 w-3.5" /> try again
          </Button>
        </div>
      </div>
    );
  }

  if (!snapshot) return <div className="space-y-5">{header}</div>;

  const projectionsBySite = new Map(
    snapshot.projectedBill.perSite.map((p) => [p.siteId, p]),
  );
  const canConvert = snapshot.billingState !== 'active';
  const isTrialing = snapshot.billingState === 'trialing';

  return (
    <div className="space-y-5">
      {header}

      {/* Where the account stands right now. */}
      <div className="rounded-md border border-border bg-card/50 px-4 py-3">
        <p className="text-sm text-white">{billingStateLine(snapshot)}</p>
        {isTrialing && snapshot.trialEndsAt !== null && (
          <p className="mt-1 text-xs text-muted-foreground">
            trial ends {formatDate(snapshot.trialEndsAt)} — all pro features are included until then
          </p>
        )}
      </div>

      {/* Per-site projection. */}
      <div className="space-y-2">
        <p className="text-sm text-white">sites</p>
        {snapshot.sites.length === 0 ? (
          <div className="rounded-md border border-border bg-card/50 px-4 py-3">
            <p className="text-sm text-muted-foreground">
              you don&apos;t own any sites yet — nothing to bill
            </p>
          </div>
        ) : (
          <>
            {snapshot.sites.map((site) => (
              <SiteRow
                key={site.siteId}
                site={site}
                projection={projectionsBySite.get(site.siteId)}
              />
            ))}
            <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-card/50 px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm text-white">estimated monthly total</p>
                <p className="text-xs text-muted-foreground">
                  based on machines active in the last 7 days; taxes and proration are settled by
                  stripe
                </p>
              </div>
              <p className="flex-shrink-0 text-sm text-white">
                {formatUsd(snapshot.projectedBill.totalUsd)}/mo
              </p>
            </div>
          </>
        )}
      </div>

      {/* Footer actions — the wave 1.4 "manage billing" row lives here now. */}
      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
        {!snapshot.stripeConfigured ? (
          <p className="text-xs text-muted-foreground">
            billing setup in progress — plan changes and payment management aren&apos;t available
            yet
          </p>
        ) : (
          <>
            {canConvert && (
              <Button type="button" size="sm" onClick={() => setPlanDialogOpen(true)}>
                <Sparkles className="mr-1 h-3.5 w-3.5" /> choose a plan
              </Button>
            )}
            {snapshot.hasBillingAccount && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleManageBilling}
                disabled={portalLoading}
              >
                {portalLoading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <>
                    <CreditCard className="mr-1 h-3.5 w-3.5" /> manage billing
                  </>
                )}
              </Button>
            )}
            <p className="text-[11px] text-muted-foreground">
              payment method, invoices, and cancellation are handled by stripe
            </p>
          </>
        )}
      </div>

      <ChoosePlanDialog
        open={planDialogOpen}
        onOpenChange={setPlanDialogOpen}
        defaultTier={snapshot.subscriptionTier ?? undefined}
      />
    </div>
  );
}
