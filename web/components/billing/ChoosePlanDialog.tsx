'use client';

/**
 * Plan picker → Stripe Checkout (billing-system wave 2.1).
 *
 * The single client entry point into conversion. It shows the two tiers, lets
 * the owner pick one, and hands off to `POST /api/billing/checkout`, which
 * answers with a Stripe-hosted url to navigate to.
 *
 * ## Deliberately dumb about billing state
 *
 * The dialog does not know whether Stripe is configured, whether this account
 * already has a subscription, or whether the caller is the owner — all three
 * are server state, and shipping any of them to the browser would leak
 * deployment config or invite a client-side gate to disagree with the server.
 * The route's problem+json `detail` is surfaced verbatim as the toast, so
 * "billing isn't enabled yet" and "you already have a subscription" both read
 * as an explanation rather than a failure. Same posture as the "manage
 * billing" row in account settings.
 *
 * ## Prices live here in prose only
 *
 * The amounts below are copy, mirroring `components/landing/PricingSection`.
 * The authoritative prices are the Stripe price objects the route attaches;
 * nothing here is sent to Stripe but the tier name.
 *
 * Shared surface: the roost pro gate opens it, and the account-settings
 * billing tab imports it — hence its own module rather than living inside
 * either caller.
 */

import React, { useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/lib/toast';
import type { SiteTier } from '@/lib/siteTier';

export interface ChoosePlanDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Tier selected when the dialog opens. Defaults to `'pro'`. */
  defaultTier?: SiteTier;
}

interface TierCopy {
  tier: SiteTier;
  price: string;
  unit: string;
  /** Shown under the price — the pro 3-machine minimum lives here. */
  footnote?: string;
  features: string[];
}

const TIERS: readonly TierCopy[] = [
  {
    tier: 'core',
    price: '$10',
    unit: '/machine/month',
    features: [
      'process monitoring & auto-recovery',
      'remote start, stop, restart, kill',
      'software & file deployment',
      'display layouts with watchdog auto-revert',
      '1 site, unlimited machines & members',
      'email alerts + email support',
    ],
  },
  {
    tier: 'pro',
    price: '$50',
    unit: '/machine/month',
    footnote: '3-machine minimum',
    features: [
      'everything in core',
      'roost — incremental project sync with atomic deploy and rollback',
      '1 TB project storage per site, $0.05/GB overage',
      'public REST API, CLI + SDK, webhooks',
      'unlimited sites with multi-site rbac',
      'priority support',
    ],
  },
];

export function ChoosePlanDialog({
  open,
  onOpenChange,
  defaultTier = 'pro',
}: ChoosePlanDialogProps) {
  // The user's explicit pick within the current open session; `null` means
  // "no pick yet — follow `defaultTier`". Derived during render rather than
  // seeded by an effect, so a dialog reopened from a different call site (the
  // roost gate vs. the billing tab) honours that site's `defaultTier` without
  // a setState-in-effect cascade.
  const [picked, setPicked] = useState<SiteTier | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const selected = picked ?? defaultTier;

  /**
   * Close always routes through here — cancel button, escape, overlay click —
   * so it is the natural place to drop the per-session state. Clearing
   * `submitting` matters as much as clearing `picked`: a request still in
   * flight when the user closes would otherwise leave the button permanently
   * disabled on the next open. Re-firing checkout is harmless; only a
   * completed session ever becomes a subscription.
   */
  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setPicked(null);
      setSubmitting(false);
    }
    onOpenChange(next);
  };

  /**
   * `submitting` is intentionally never cleared on the success path: the
   * navigation to Stripe is already in flight, and resetting it would flash
   * the button back to its idle label while the browser is leaving the page.
   */
  const handleContinue = async () => {
    setSubmitting(true);
    try {
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier: selected }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && typeof data.url === 'string') {
        window.location.href = data.url;
        return;
      }
      toast.error(data.detail || 'could not start checkout');
    } catch {
      toast.error('could not start checkout');
    }
    setSubmitting(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="border-border bg-secondary text-white sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-white">choose a plan</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            pick a tier and continue to stripe to add a card. billing starts
            right away — machines are counted daily, so you only pay for what
            you run.
          </DialogDescription>
        </DialogHeader>

        <div
          role="radiogroup"
          aria-label="pricing tier"
          className="grid grid-cols-1 gap-3 py-2 sm:grid-cols-2"
        >
          {TIERS.map(({ tier, price, unit, footnote, features }) => {
            const isSelected = selected === tier;
            return (
              <button
                key={tier}
                type="button"
                role="radio"
                aria-checked={isSelected}
                onClick={() => setPicked(tier)}
                className={`flex flex-col rounded-lg border p-4 text-left transition-colors cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/40 ${
                  isSelected
                    ? 'border-accent-cyan/50 bg-accent-cyan/10'
                    : 'border-border bg-background hover:bg-muted/50'
                }`}
              >
                <span className="text-base font-semibold text-white">{tier}</span>
                <span className="mt-1 flex items-baseline gap-1">
                  <span className="text-2xl font-bold text-white">{price}</span>
                  <span className="text-sm text-muted-foreground">{unit}</span>
                </span>
                {footnote && (
                  <span className="mt-0.5 text-xs text-muted-foreground">{footnote}</span>
                )}
                <ul className="mt-3 flex flex-col gap-1.5">
                  {features.map((feature) => (
                    <li
                      key={feature}
                      className="flex items-start gap-2 text-xs text-muted-foreground"
                    >
                      <Check
                        className="mt-0.5 h-3 w-3 flex-shrink-0 text-accent-cyan"
                        aria-hidden="true"
                      />
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>
              </button>
            );
          })}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => handleOpenChange(false)}
            className="bg-secondary border border-border cursor-pointer"
          >
            cancel
          </Button>
          <Button
            onClick={handleContinue}
            disabled={submitting}
            className="text-gray-900 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {submitting ? 'starting checkout...' : 'continue to checkout'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
