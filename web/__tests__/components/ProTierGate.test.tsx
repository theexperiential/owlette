/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * Render tests for ProTierGate (billing-system wave 3.2).
 *
 * Four things are worth pinning, because getting any of them wrong is
 * invisible until it reaches a customer:
 *
 *   - `'core'` and only `'core'` renders the gate. `undefined` is an
 *     unresolved tier, not a core one — gating on it would flash an upgrade
 *     card at every pro customer on every page load.
 *   - the children a gate stands in front of are not rendered while it is up,
 *     so a core account can't reach a control the server would reject.
 *   - the CTA opens the plan picker on `pro`. Opening it on `core` would send
 *     a converting customer to the tier that can't run the feature they just
 *     clicked upgrade for.
 *   - both variants make the same tier decision. The inline variant stands in
 *     for a single create control while the list around it stays live, so a
 *     divergence between the two would either hide a revoke button the server
 *     still honours or leave a create button the server rejects.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProTierGate } from '@/components/billing/ProTierGate';

const choosePlanProps = jest.fn();
jest.mock('@/components/billing/ChoosePlanDialog', () => ({
  ChoosePlanDialog: (props: { open: boolean; defaultTier?: string }) => {
    choosePlanProps(props);
    return props.open ? (
      <div data-testid="choose-plan" data-default-tier={props.defaultTier} />
    ) : null;
  },
}));

const GATE_PROPS = {
  feature: 'webhook delivery',
  blurb: 'webhooks are included in the pro tier — upgrade your site to enable.',
} as const;

describe('ProTierGate', () => {
  describe('tier states', () => {
    it('renders the gate and hides the children on core', () => {
      render(
        <ProTierGate tier="core" {...GATE_PROPS}>
          <div data-testid="managed-ui" />
        </ProTierGate>,
      );

      expect(screen.getByTestId('pro-tier-gate')).toBeInTheDocument();
      expect(screen.queryByTestId('managed-ui')).toBeNull();
    });

    it('renders the children and no gate on pro', () => {
      render(
        <ProTierGate tier="pro" {...GATE_PROPS}>
          <div data-testid="managed-ui" />
        </ProTierGate>,
      );

      expect(screen.getByTestId('managed-ui')).toBeInTheDocument();
      expect(screen.queryByTestId('pro-tier-gate')).toBeNull();
    });

    it('renders the children while the tier is still resolving', () => {
      // Trialing accounts reach the gated surfaces through this branch too:
      // their tier resolves `'pro'`, and it is `undefined` on the way there.
      render(
        <ProTierGate tier={undefined} {...GATE_PROPS}>
          <div data-testid="managed-ui" />
        </ProTierGate>,
      );

      expect(screen.getByTestId('managed-ui')).toBeInTheDocument();
      expect(screen.queryByTestId('pro-tier-gate')).toBeNull();
    });
  });

  describe('copy', () => {
    it('names the feature in the heading and shows the blurb verbatim', () => {
      render(<ProTierGate tier="core" feature="roost" blurb="roost is included in the pro tier." />);

      expect(
        screen.getByRole('heading', { name: 'roost is a pro feature.' }),
      ).toBeInTheDocument();
      expect(screen.getByText('roost is included in the pro tier.')).toBeInTheDocument();
    });
  });

  describe('upgrade cta', () => {
    it('keeps the plan dialog closed until the button is clicked', () => {
      render(<ProTierGate tier="core" {...GATE_PROPS} />);

      expect(screen.queryByTestId('choose-plan')).toBeNull();
      expect(choosePlanProps).toHaveBeenLastCalledWith(
        expect.objectContaining({ open: false, defaultTier: 'pro' }),
      );
    });

    it('opens the plan dialog on pro when the cta is clicked', async () => {
      const user = userEvent.setup();
      render(<ProTierGate tier="core" {...GATE_PROPS} />);

      await user.click(screen.getByRole('button', { name: /upgrade to pro/i }));

      expect(screen.getByTestId('choose-plan')).toHaveAttribute('data-default-tier', 'pro');
    });

    it('mounts no plan dialog at all when the gate is down', () => {
      render(<ProTierGate tier="pro" {...GATE_PROPS} />);

      expect(choosePlanProps).not.toHaveBeenCalled();
    });
  });

  describe('inline variant', () => {
    it('replaces the create control on core, without the full card', () => {
      render(
        <ProTierGate tier="core" variant="inline" item="api keys">
          <button type="button">create key</button>
        </ProTierGate>,
      );

      expect(screen.getByTestId('pro-tier-gate-inline')).toBeInTheDocument();
      expect(screen.getByText('creating new api keys requires pro')).toBeInTheDocument();
      // The compact row stands in for one button — it must not also render the
      // page-sized card, which is what replaces a surface with nothing on it.
      expect(screen.queryByTestId('pro-tier-gate')).toBeNull();
      expect(screen.queryByRole('button', { name: 'create key' })).toBeNull();
    });

    it('renders the create control untouched on pro', () => {
      render(
        <ProTierGate tier="pro" variant="inline" item="api keys">
          <button type="button">create key</button>
        </ProTierGate>,
      );

      expect(screen.getByRole('button', { name: 'create key' })).toBeInTheDocument();
      expect(screen.queryByTestId('pro-tier-gate-inline')).toBeNull();
    });

    it('renders the create control while the tier is still resolving', () => {
      render(
        <ProTierGate tier={undefined} variant="inline" item="webhooks">
          <button type="button">create webhook</button>
        </ProTierGate>,
      );

      expect(screen.getByRole('button', { name: 'create webhook' })).toBeInTheDocument();
      expect(screen.queryByTestId('pro-tier-gate-inline')).toBeNull();
    });

    it('opens the same plan dialog on pro from its cta', async () => {
      const user = userEvent.setup();
      render(<ProTierGate tier="core" variant="inline" item="webhooks" />);

      await user.click(screen.getByRole('button', { name: /upgrade to pro/i }));

      expect(screen.getByTestId('choose-plan')).toHaveAttribute('data-default-tier', 'pro');
    });
  });
});
