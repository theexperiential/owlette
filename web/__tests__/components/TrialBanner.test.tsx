/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * Render tests for the dashboard trial banner + read-only signage
 * (billing-system wave 3.1).
 *
 * The banner is the only place an owner learns that a clock is running on
 * their fleet, so each case below pins a message that would mislead them if it
 * regressed:
 *
 *   - **announcement**: a configured go-live date and an unstarted clock —
 *     and, critically, *silence* when no date is configured, which is every
 *     deployment today,
 *   - **countdown**: the last week of the trial, and nothing before it,
 *   - **locked**: expired vs. canceled, with no way to dismiss it,
 *   - **not the owner**: a member of somebody else's site is never billed for
 *     it and must never be told their trial ended,
 *   - **read-only notice**: scoped to a site the account actually owns.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  COUNTDOWN_THRESHOLD_DAYS,
  ReadOnlyNotice,
  TrialBanner,
  isSiteReadOnly,
  resolveTrialBannerState,
} from '@/app/dashboard/components/TrialBanner';
import type { BillingSnapshotResponse, BillingSnapshotSite } from '@/lib/types/billingSnapshot';

jest.mock('@/lib/toast', () => ({
  toast: { error: jest.fn(), success: jest.fn(), info: jest.fn(), warning: jest.fn() },
}));

const mockDismiss = jest.fn();
let dismissalState = { dismissed: false, ready: true };
jest.mock('@/hooks/useTrialBannerDismissal', () => ({
  useTrialBannerDismissal: () => ({ ...dismissalState, dismiss: mockDismiss }),
}));

const DAY_MS = 24 * 60 * 60 * 1000;

/** One owned site — enough to make the account the billed party. */
const OWNED_SITE: BillingSnapshotSite = {
  siteId: 'site-a',
  name: 'atrium',
  tier: 'pro',
  activeMachineCount: 3,
};

function snapshotBody(overrides: Partial<BillingSnapshotResponse> = {}): BillingSnapshotResponse {
  return {
    billingState: 'trialing',
    trialEndsAt: null,
    goLiveAt: null,
    daysLeft: null,
    subscriptionTier: null,
    currentPeriodEnd: null,
    stripeConfigured: true,
    hasBillingAccount: false,
    sites: [OWNED_SITE],
    usage: null,
    projectedBill: { perSite: [], totalUsd: 0 },
    ...overrides,
  };
}

/** A trialing account with `daysLeft` remaining on a real clock. */
function trialing(daysLeft: number, overrides: Partial<BillingSnapshotResponse> = {}) {
  return snapshotBody({
    billingState: 'trialing',
    trialEndsAt: Date.now() + daysLeft * DAY_MS,
    daysLeft,
    ...overrides,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  dismissalState = { dismissed: false, ready: true };
});

describe('resolveTrialBannerState', () => {
  it('hides everything while the snapshot is still loading', () => {
    expect(resolveTrialBannerState(null)).toEqual({ kind: 'hidden' });
  });

  it('hides everything for an account that owns no sites', () => {
    // A member of somebody else's site: their own trial clock has no bearing
    // on that site, which the server resolves through *its* owner.
    expect(
      resolveTrialBannerState(snapshotBody({ billingState: 'expired', sites: [] })),
    ).toEqual({ kind: 'hidden' });
  });

  it('says nothing to a paying subscriber', () => {
    expect(resolveTrialBannerState(snapshotBody({ billingState: 'active' }))).toEqual({
      kind: 'hidden',
    });
  });

  it('announces a configured go-live date to an unstarted clock', () => {
    const t0 = Date.now() + 30 * DAY_MS;
    expect(resolveTrialBannerState(snapshotBody({ trialEndsAt: null, goLiveAt: t0 }))).toEqual({
      kind: 'announcement',
      goLiveAt: t0,
    });
  });

  it('stays silent pre-go-live when no date is configured', () => {
    // Today's state on every deployment. An unstarted clock with no announced
    // date has nothing truthful to say.
    expect(resolveTrialBannerState(snapshotBody({ trialEndsAt: null, goLiveAt: null }))).toEqual({
      kind: 'hidden',
    });
  });

  it('counts down only inside the threshold', () => {
    expect(resolveTrialBannerState(trialing(COUNTDOWN_THRESHOLD_DAYS))).toEqual({
      kind: 'countdown',
      daysLeft: COUNTDOWN_THRESHOLD_DAYS,
    });
    expect(resolveTrialBannerState(trialing(COUNTDOWN_THRESHOLD_DAYS + 1))).toEqual({
      kind: 'hidden',
    });
  });

  it('locks on expired and on canceled alike', () => {
    expect(resolveTrialBannerState(snapshotBody({ billingState: 'expired' }))).toEqual({
      kind: 'locked',
      billingState: 'expired',
    });
    expect(resolveTrialBannerState(snapshotBody({ billingState: 'canceled' }))).toEqual({
      kind: 'locked',
      billingState: 'canceled',
    });
  });
});

describe('TrialBanner', () => {
  /* ------------------------- announcement ------------------------- */

  it('announces the go-live date and the trial that follows it', () => {
    const t0 = Date.now() + 30 * DAY_MS;
    render(<TrialBanner snapshot={snapshotBody({ trialEndsAt: null, goLiveAt: t0 })} />);

    expect(
      screen.getByText(
        `billing starts ${new Date(t0).toLocaleDateString()} — your 14-day free trial begins then`,
      ),
    ).toBeInTheDocument();
    // Informational: conversion is a T0 concern, and the billing tab is right
    // there for anyone eager to convert early.
    expect(screen.queryByRole('button', { name: /choose a plan/i })).toBeNull();
  });

  it('renders nothing at all when there is nothing to announce', () => {
    const { container } = render(<TrialBanner snapshot={snapshotBody()} />);
    // Not an empty container — the dashboard must not reserve vertical space
    // for an absent banner.
    expect(container).toBeEmptyDOMElement();
  });

  /* --------------------------- countdown -------------------------- */

  it('counts the days left and offers checkout', () => {
    render(<TrialBanner snapshot={trialing(5)} />);

    expect(screen.getByText('5 days left in your free trial — choose a plan')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /choose a plan/i })).toBeInTheDocument();
  });

  it('says "1 day", not "1 days", on the last full day', () => {
    render(<TrialBanner snapshot={trialing(1)} />);
    expect(screen.getByText('1 day left in your free trial — choose a plan')).toBeInTheDocument();
  });

  it('says "today" rather than "0 days left"', () => {
    render(<TrialBanner snapshot={trialing(0)} />);
    expect(screen.getByText('your free trial ends today — choose a plan')).toBeInTheDocument();
  });

  it('does not nag with more than a week to go', () => {
    const { container } = render(<TrialBanner snapshot={trialing(8)} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('opens the plan picker from the banner', async () => {
    const user = userEvent.setup();
    render(<TrialBanner snapshot={trialing(3)} />);

    await user.click(screen.getByRole('button', { name: /choose a plan/i }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  /* ---------------------------- locked ---------------------------- */

  it('states the trial ended and stays put', () => {
    render(<TrialBanner snapshot={snapshotBody({ billingState: 'expired' })} />);

    expect(screen.getByText('your trial ended — choose a plan to reactivate')).toBeInTheDocument();
    // No close affordance: the account is read-only until a plan is chosen,
    // and hiding the reason would leave the owner guessing.
    expect(screen.queryByRole('button', { name: /dismiss/i })).toBeNull();
  });

  it('distinguishes a canceled subscription from an expired trial', () => {
    render(<TrialBanner snapshot={snapshotBody({ billingState: 'canceled' })} />);
    expect(
      screen.getByText('your subscription was canceled — choose a plan to reactivate'),
    ).toBeInTheDocument();
  });

  it('shows nothing to a member of somebody else’s locked-out site', () => {
    const { container } = render(
      <TrialBanner snapshot={snapshotBody({ billingState: 'expired', sites: [] })} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  /* -------------------------- dismissal --------------------------- */

  it('persists a dismissal through the hook', async () => {
    const user = userEvent.setup();
    render(<TrialBanner snapshot={trialing(4)} />);

    await user.click(screen.getByRole('button', { name: /dismiss/i }));

    expect(mockDismiss).toHaveBeenCalledTimes(1);
  });

  it('stays hidden while a dismissal is in effect', () => {
    dismissalState = { dismissed: true, ready: true };
    const { container } = render(<TrialBanner snapshot={trialing(4)} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('holds off rendering until the stored dismissal has been read', () => {
    // Otherwise a dismissed banner flashes in on every load and then vanishes.
    dismissalState = { dismissed: false, ready: false };
    const { container } = render(<TrialBanner snapshot={trialing(4)} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the lockout regardless of any stored dismissal', () => {
    dismissalState = { dismissed: true, ready: true };
    render(<TrialBanner snapshot={snapshotBody({ billingState: 'expired' })} />);
    expect(screen.getByText('your trial ended — choose a plan to reactivate')).toBeInTheDocument();
  });

  /* ---------------------- stripe unconfigured ---------------------- */

  it('replaces the dead-end button with an explanation when stripe is unconfigured', () => {
    render(<TrialBanner snapshot={trialing(2, { stripeConfigured: false })} />);

    expect(screen.getByText('2 days left in your free trial — choose a plan')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /choose a plan/i })).toBeNull();
    expect(screen.getByText('billing setup in progress')).toBeInTheDocument();
  });
});

describe('ReadOnlyNotice', () => {
  it('explains the paused controls on a locked-out site the account owns', () => {
    render(
      <ReadOnlyNotice
        snapshot={snapshotBody({ billingState: 'expired' })}
        currentSiteId="site-a"
      />,
    );

    expect(screen.getByTestId('dashboard-read-only-notice')).toHaveTextContent(
      'viewing only — controls are paused until a plan is chosen.',
    );
  });

  it('says nothing about a site the account does not own', () => {
    // The lockout follows the *site owner's* billing state, so a locked owner
    // looking at somebody else's paid-up site is not viewing-only there.
    const { container } = render(
      <ReadOnlyNotice
        snapshot={snapshotBody({ billingState: 'expired' })}
        currentSiteId="someone-elses-site"
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing while the account is in good standing', () => {
    const { container } = render(
      <ReadOnlyNotice snapshot={trialing(3)} currentSiteId="site-a" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing before a site is selected', () => {
    expect(isSiteReadOnly(snapshotBody({ billingState: 'expired' }), '')).toBe(false);
    expect(isSiteReadOnly(null, 'site-a')).toBe(false);
  });
});
