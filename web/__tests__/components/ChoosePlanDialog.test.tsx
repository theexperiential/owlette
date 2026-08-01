/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * Render + submit tests for ChoosePlanDialog (billing-system wave 2.1).
 *
 * The contract worth pinning: the dialog sends only a tier name, and it
 * navigates to whatever url the route hands back. Everything else about
 * conversion — prices, customer, entitlement — is server state, and a
 * regression that started deciding any of it here would be invisible until a
 * customer was billed for the wrong plan.
 */

import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChoosePlanDialog } from '@/components/billing/ChoosePlanDialog';

const mockToastError = jest.fn();
jest.mock('@/lib/toast', () => ({
  toast: {
    success: jest.fn(),
    error: (...a: unknown[]) => mockToastError(...a),
  },
}));

/** A `fetch` response with just the surface the dialog reads. */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function tierOption(tier: 'core' | 'pro'): HTMLElement {
  return screen.getByRole('radio', { name: new RegExp(`^${tier}\\b`) });
}

describe('ChoosePlanDialog', () => {
  let originalFetch: typeof window.fetch;
  let originalLocation: Location;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = window.fetch;
    originalLocation = window.location;
    // jsdom refuses real navigation; a plain object lets the assertion read
    // back whatever the component assigned to `href`.
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: { ...window.location, href: 'http://localhost/roosts' },
    });
    window.fetch = jest.fn(async () =>
      jsonResponse(200, { success: true, url: 'https://checkout.stripe.com/c/pay/cs_1' }),
    );
  });

  afterEach(() => {
    window.fetch = originalFetch;
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: originalLocation,
    });
  });

  describe('rendering', () => {
    it('renders nothing while closed', () => {
      render(<ChoosePlanDialog open={false} onOpenChange={jest.fn()} />);
      expect(screen.queryByText('choose a plan')).toBeNull();
    });

    it('shows both tiers with their prices', () => {
      render(<ChoosePlanDialog open onOpenChange={jest.fn()} />);

      expect(screen.getByText('choose a plan')).toBeInTheDocument();

      const core = tierOption('core');
      expect(within(core).getByText('$10')).toBeInTheDocument();
      expect(within(core).getAllByText('/machine/month').length).toBe(1);

      const pro = tierOption('pro');
      expect(within(pro).getByText('$50')).toBeInTheDocument();
      expect(within(pro).getByText('3-machine minimum')).toBeInTheDocument();
    });

    it('names roost and the public API as pro features', () => {
      render(<ChoosePlanDialog open onOpenChange={jest.fn()} />);

      const pro = tierOption('pro');
      expect(within(pro).getByText(/^roost —/)).toBeInTheDocument();
      expect(within(pro).getByText(/public REST API/)).toBeInTheDocument();
      // The gate the dialog is reached from is roost — offering it on core
      // would send a converting customer to the tier that can't run it.
      expect(within(tierOption('core')).queryByText(/roost/)).toBeNull();
    });

    it('selects pro by default and honours defaultTier', () => {
      const { unmount } = render(<ChoosePlanDialog open onOpenChange={jest.fn()} />);
      expect(tierOption('pro')).toHaveAttribute('aria-checked', 'true');
      expect(tierOption('core')).toHaveAttribute('aria-checked', 'false');
      unmount();

      render(<ChoosePlanDialog open onOpenChange={jest.fn()} defaultTier="core" />);
      expect(tierOption('core')).toHaveAttribute('aria-checked', 'true');
    });
  });

  describe('checkout', () => {
    it('posts the selected tier and navigates to the returned url', async () => {
      const user = userEvent.setup();
      render(<ChoosePlanDialog open onOpenChange={jest.fn()} />);

      await user.click(screen.getByRole('button', { name: /continue to checkout/i }));

      expect(window.fetch).toHaveBeenCalledWith('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier: 'pro' }),
      });
      expect(window.location.href).toBe('https://checkout.stripe.com/c/pay/cs_1');
    });

    it('posts core once the core card is picked', async () => {
      const user = userEvent.setup();
      render(<ChoosePlanDialog open onOpenChange={jest.fn()} />);

      await user.click(tierOption('core'));
      expect(tierOption('core')).toHaveAttribute('aria-checked', 'true');

      await user.click(screen.getByRole('button', { name: /continue to checkout/i }));

      expect(window.fetch).toHaveBeenCalledWith(
        '/api/billing/checkout',
        expect.objectContaining({ body: JSON.stringify({ tier: 'core' }) }),
      );
    });

    it('surfaces the route problem detail verbatim and stays open', async () => {
      // The client knows nothing about billing state; "you already have a
      // subscription" and "billing isn't enabled yet" are both the route's
      // words, shown as-is rather than flattened into a generic failure.
      window.fetch = jest.fn(async () =>
        jsonResponse(409, {
          code: 'already_subscribed',
          detail: 'this account already has a subscription; change or cancel it from billing settings',
        }),
      );
      const user = userEvent.setup();
      render(<ChoosePlanDialog open onOpenChange={jest.fn()} />);

      await user.click(screen.getByRole('button', { name: /continue to checkout/i }));

      expect(mockToastError).toHaveBeenCalledWith(
        'this account already has a subscription; change or cancel it from billing settings',
      );
      expect(window.location.href).toBe('http://localhost/roosts');
      // Button is usable again — a 409 is a dead end for this tier, not for
      // the dialog.
      expect(
        screen.getByRole('button', { name: /continue to checkout/i }),
      ).toBeEnabled();
    });

    it('falls back to its own copy when the route sends no detail', async () => {
      window.fetch = jest.fn(async () => jsonResponse(500, {}));
      const user = userEvent.setup();
      render(<ChoosePlanDialog open onOpenChange={jest.fn()} />);

      await user.click(screen.getByRole('button', { name: /continue to checkout/i }));

      expect(mockToastError).toHaveBeenCalledWith('could not start checkout');
    });

    it('toasts rather than throwing when the request itself fails', async () => {
      window.fetch = jest.fn(async () => {
        throw new TypeError('Failed to fetch');
      });
      const user = userEvent.setup();
      render(<ChoosePlanDialog open onOpenChange={jest.fn()} />);

      await user.click(screen.getByRole('button', { name: /continue to checkout/i }));

      expect(mockToastError).toHaveBeenCalledWith('could not start checkout');
      expect(window.location.href).toBe('http://localhost/roosts');
    });

    it('ignores an ok response with no url instead of navigating to "undefined"', async () => {
      window.fetch = jest.fn(async () => jsonResponse(200, { success: true }));
      const user = userEvent.setup();
      render(<ChoosePlanDialog open onOpenChange={jest.fn()} />);

      await user.click(screen.getByRole('button', { name: /continue to checkout/i }));

      expect(window.location.href).toBe('http://localhost/roosts');
      expect(mockToastError).toHaveBeenCalledWith('could not start checkout');
    });
  });

  describe('close', () => {
    it('cancel closes without calling the route', async () => {
      const user = userEvent.setup();
      const onOpenChange = jest.fn();
      render(<ChoosePlanDialog open onOpenChange={onOpenChange} />);

      await user.click(screen.getByRole('button', { name: /^cancel$/i }));

      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(window.fetch).not.toHaveBeenCalled();
    });
  });
});
