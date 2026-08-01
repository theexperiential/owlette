'use client';

/**
 * ProTierGate (billing-system wave 3.2).
 *
 * The one "this is a pro-tier feature" empty state. Every pro-only surface a
 * subscribed-core customer can still navigate to renders this instead of its
 * management UI, so the tier is something they read once in plain language
 * rather than something they infer from a `403 tier_insufficient` toast after
 * filling in a form.
 *
 * ## Two shapes, because the server gates creation and nothing else
 *
 * Across both gated feature families the *only* pro-gated operations are
 * `POST /api/webhooks` (`requirePro`) and `POST /api/account/api-keys`
 * (`requireProAccount`). Listing, rotating, patching, and deleting are
 * deliberately ungated — `app/api/webhooks/route.ts` says so in as many
 * words: "GET is not tier-gated, so a downgraded site can still audit what it
 * has subscribed", and revocation is a security action the lockout matrix
 * keeps reachable on principle. So:
 *
 *   - `variant="card"` (default) — the full empty state, for a surface with
 *     nothing behind it. Nothing to audit, nothing to revoke; the upgrade
 *     card *is* the page.
 *   - `variant="inline"` — a compact bordered row that stands in for a create
 *     affordance while the list around it stays live. Same visual language,
 *     one line of copy, same CTA.
 *
 * A downgraded customer therefore keeps every control the server would still
 * honour, and loses exactly the button the server would reject.
 *
 * ## One prop shape for two tier sources
 *
 * `tier` is whatever the surface's entitlement resolves to — `useSiteTier()`
 * for a site-scoped feature (roost, webhooks), `useAccountTier()` for an
 * account-scoped one (api keys). Both hooks return `SiteTier | undefined`, so
 * every call site reads the same:
 *
 *     <ProTierGate tier={…} feature="…" blurb="…">…</ProTierGate>
 *     <ProTierGate tier={…} variant="inline" item="…">…</ProTierGate>
 *
 * ## `undefined` renders the children, never the gate
 *
 * An unresolved tier is not a core tier. Gating on `undefined` would flash the
 * upgrade card at every pro customer for the frame or two their site doc /
 * billing snapshot takes to arrive. The server enforces the same rule on every
 * mutation these surfaces can reach, so rendering the ungated UI a beat early
 * costs nothing; rendering the gate a beat early costs trust.
 *
 * ## Trial accounts never see this
 *
 * Not by a check here — by the tier both sources hand it. `useAccountTier()`
 * short-circuits `'trialing'` to `'pro'`, and no site is ever *stamped*
 * `'core'` while its owner is trialing (`deriveSiteTier` in
 * `createSite.server.ts` mints trial-era sites at pro, and the core stamp only
 * lands with a core subscription). Trial = pro, top to bottom.
 *
 * ## Copy
 *
 * `feature` is the subject of the card heading — keep it a singular noun
 * phrase ("roost", "api access", "webhook delivery") so `{feature} is a pro
 * feature.` stays grammatical. `blurb` is the one-liner naming what pro
 * actually unlocks. `item` is the inline variant's plural object noun ("api
 * keys", "webhooks"), so `creating new {item} requires pro` reads.
 */

import React, { useState, type ReactNode } from 'react';
import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ChoosePlanDialog } from '@/components/billing/ChoosePlanDialog';
import { cn } from '@/lib/utils';
import type { SiteTier } from '@/lib/siteTier';

interface ProTierGateBaseProps {
  /**
   * The entitlement this surface gates on. `'core'` renders the gate;
   * `'pro'` and `undefined` (still resolving) render `children`.
   */
  tier: SiteTier | undefined;
  /** Layout override for the gate's own wrapper. */
  className?: string;
  /** The management UI — or the single create control — this stands in for. */
  children?: ReactNode;
}

interface ProTierGateCardProps extends ProTierGateBaseProps {
  variant?: 'card';
  /** Singular noun phrase naming the feature, e.g. `'roost'`. */
  feature: string;
  /** One line on what the pro tier unlocks here. */
  blurb: string;
  item?: never;
}

interface ProTierGateInlineProps extends ProTierGateBaseProps {
  variant: 'inline';
  /** Plural object noun for what can't be created, e.g. `'api keys'`. */
  item: string;
  feature?: never;
  blurb?: never;
}

export type ProTierGateProps = ProTierGateCardProps | ProTierGateInlineProps;

export function ProTierGate(props: ProTierGateProps) {
  const { tier, className, children } = props;

  // Declared before the branch below — a hook may not be conditional, and the
  // gate owning its own dialog state is what keeps the call sites to one tag.
  const [choosePlanOpen, setChoosePlanOpen] = useState(false);

  if (tier !== 'core') return <>{children}</>;

  return (
    <>
      {props.variant === 'inline' ? (
        <div
          data-testid="pro-tier-gate-inline"
          className={cn(
            'flex flex-wrap items-center gap-3 rounded-md border border-border bg-card px-3 py-2',
            className,
          )}
        >
          <span className="inline-flex flex-shrink-0 rounded-md bg-accent-cyan/10 p-1.5 text-accent-cyan">
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
          </span>
          <span className="text-xs text-muted-foreground">
            creating new {props.item} requires pro
          </span>
          <Button size="sm" onClick={() => setChoosePlanOpen(true)}>
            upgrade to pro →
          </Button>
        </div>
      ) : (
        <div className={cn('mt-12 md:mt-16 flex justify-center', className)}>
          <div
            data-testid="pro-tier-gate"
            className="max-w-md rounded-lg border border-border bg-card p-8 text-center"
          >
            <div className="mx-auto mb-4 inline-flex rounded-md bg-accent-cyan/10 p-2.5 text-accent-cyan">
              <Sparkles className="h-5 w-5" aria-hidden="true" />
            </div>
            <h2 className="text-lg font-semibold text-foreground">
              {props.feature} is a pro feature.
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">{props.blurb}</p>
            <div className="mt-6">
              <Button onClick={() => setChoosePlanOpen(true)}>upgrade to pro →</Button>
            </div>
          </div>
        </div>
      )}

      <ChoosePlanDialog
        open={choosePlanOpen}
        onOpenChange={setChoosePlanOpen}
        defaultTier="pro"
      />
    </>
  );
}
