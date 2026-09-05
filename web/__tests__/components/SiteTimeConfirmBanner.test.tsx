/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * SiteTimeConfirmBanner — the one-time "whose clock runs your schedules?"
 * prompt (dev/active/site-time-schedules, wave 3a task 3.1).
 *
 * The matrix below is the whole contract: the banner appears for exactly one
 * combination (site admin × flag never asked × at least one scheduled process)
 * and renders NOTHING — not an empty wrapper, not a spacer — for every other.
 * The "no reserved space" assertions are the regression guard: an empty element
 * here pushes the machines list down on every site that already answered.
 *
 * `undefined` vs `false` is the distinction that matters most. A site that
 * declined must never be re-prompted, and a site that was never asked must never
 * be treated as having declined, so both are asserted separately rather than as
 * "falsy".
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  SiteTimeConfirmBanner,
  type SiteTimeConfirmBannerProps,
} from '@/app/dashboard/components/SiteTimeConfirmBanner';
import type { LaunchMode, Machine, Process } from '@/hooks/useFirestore';
import { SITE_TIME_MIN_AGENT_VERSION } from '@/lib/versionUtils';

const toastSuccess = jest.fn();
const toastError = jest.fn();
jest.mock('@/lib/toast', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
    info: jest.fn(),
    warning: jest.fn(),
  },
}));

const SITE_ID = 'site-A';

function proc(launchMode: LaunchMode, id = 'p1'): Process {
  return {
    id,
    name: `process ${id}`,
    status: 'INACTIVE',
    pid: null,
    autolaunch: launchMode !== 'off',
    launch_mode: launchMode,
    schedules: null,
    exe_path: 'C:/seed/app.exe',
    file_path: '',
    cwd: 'C:/seed',
    priority: 'Normal',
    visibility: 'Normal',
    time_delay: '0',
    time_to_init: '10',
    relaunch_attempts: '3',
    responsive: true,
    last_updated: 0,
    index: 0,
  };
}

function machine(overrides: Partial<Machine> = {}): Machine {
  return {
    machineId: 'lobby-pc',
    lastHeartbeat: Math.floor(Date.now() / 1000),
    online: true,
    agent_version: '3.2.4',
    machineTimezone: 'America/New_York',
    processes: [proc('scheduled')],
    ...overrides,
  };
}

function renderBanner(overrides: Partial<SiteTimeConfirmBannerProps> = {}) {
  const onUpdateSite = jest.fn().mockResolvedValue(undefined);
  const utils = render(
    <TooltipProvider>
      <SiteTimeConfirmBanner
        siteId={SITE_ID}
        siteTimezone="America/New_York"
        schedulesFollowSiteTime={undefined}
        machines={[machine()]}
        isSiteAdmin
        onUpdateSite={onUpdateSite}
        {...overrides}
      />
    </TooltipProvider>,
  );
  return { ...utils, onUpdateSite };
}

const banner = () => screen.queryByTestId('site-time-banner');

describe('the visibility matrix', () => {
  it('shows for a site admin on a site that was never asked and has a scheduled process', () => {
    renderBanner();
    expect(banner()).toBeInTheDocument();
  });

  it('shows nothing to a member — and reserves no space at all', () => {
    const { container } = renderBanner({ isSiteAdmin: false });
    expect(banner()).toBeNull();
    expect(container).toBeEmptyDOMElement();
  });

  it.each([
    ['already on site time (true)', true],
    ['declined (false)', false],
  ])('shows nothing when the site has %s — and reserves no space', (_label, flag) => {
    const { container } = renderBanner({ schedulesFollowSiteTime: flag });
    expect(banner()).toBeNull();
    expect(container).toBeEmptyDOMElement();
  });

  it('shows nothing when the site has no machines — and reserves no space', () => {
    const { container } = renderBanner({ machines: [] });
    expect(banner()).toBeNull();
    expect(container).toBeEmptyDOMElement();
  });

  it.each([
    ['off', 'off' as LaunchMode],
    ['always on', 'always' as LaunchMode],
  ])('shows nothing when every process is %s — and reserves no space', (_label, mode) => {
    const { container } = renderBanner({
      machines: [machine({ processes: [proc(mode), proc(mode, 'p2')] })],
    });
    expect(banner()).toBeNull();
    expect(container).toBeEmptyDOMElement();
  });

  it('counts an optimistic switch to scheduled that Firestore has not confirmed yet', () => {
    renderBanner({
      machines: [
        machine({
          processes: [{ ...proc('off'), _optimisticLaunchMode: 'scheduled' as LaunchMode }],
        }),
      ],
    });
    expect(banner()).toBeInTheDocument();
  });

  it('counts scheduled processes across every machine on the site', () => {
    renderBanner({
      machines: [
        machine({ machineId: 'a', processes: [proc('off')] }),
        machine({ machineId: 'b', processes: [proc('scheduled')] }),
      ],
    });
    expect(banner()).toBeInTheDocument();
    expect(banner()).toHaveTextContent('one scheduled process on this site runs');
  });
});

describe('the two terminal answers', () => {
  it('sends the timezone and the flag together when site time is chosen', async () => {
    const user = userEvent.setup();
    const { onUpdateSite } = renderBanner();

    await user.click(screen.getByTestId('site-time-banner-use-site-time'));

    await waitFor(() =>
      expect(onUpdateSite).toHaveBeenCalledWith(SITE_ID, {
        timezone: 'America/New_York',
        schedulesFollowSiteTime: true,
      }),
    );
    expect(toastSuccess).toHaveBeenCalled();
  });

  it('sends the flag alone — and never a timezone — when machine clocks are kept', async () => {
    const user = userEvent.setup();
    const { onUpdateSite } = renderBanner();

    await user.click(screen.getByTestId('site-time-banner-keep-machine-clocks'));

    await waitFor(() =>
      expect(onUpdateSite).toHaveBeenCalledWith(SITE_ID, { schedulesFollowSiteTime: false }),
    );
  });

  it('cannot enable site time until a timezone exists — the action refuses true without one', () => {
    renderBanner({ siteTimezone: undefined });

    expect(screen.getByTestId('site-time-banner-use-site-time')).toBeDisabled();
    // Declining never needs a timezone.
    expect(screen.getByTestId('site-time-banner-keep-machine-clocks')).toBeEnabled();
    expect(screen.getByText('pick a timezone to use site time')).toBeInTheDocument();
  });

  it('surfaces a rejected write and re-arms the buttons', async () => {
    const user = userEvent.setup();
    const onUpdateSite = jest
      .fn()
      .mockRejectedValue(new Error('schedulesFollowSiteTime cannot be enabled'));
    render(
      <TooltipProvider>
        <SiteTimeConfirmBanner
          siteId={SITE_ID}
          siteTimezone="America/New_York"
          schedulesFollowSiteTime={undefined}
          machines={[machine()]}
          isSiteAdmin
          onUpdateSite={onUpdateSite}
        />
      </TooltipProvider>,
    );

    await user.click(screen.getByTestId('site-time-banner-use-site-time'));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith('schedulesFollowSiteTime cannot be enabled'),
    );
    expect(screen.getByTestId('site-time-banner-use-site-time')).toBeEnabled();
  });
});

describe('the two advisories', () => {
  it('lists the machines whose own clock disagrees with the site timezone (R1d)', () => {
    renderBanner({
      machines: [
        machine({ machineId: 'lobby-pc', machineTimezone: 'America/New_York' }),
        machine({ machineId: 'stage-pc', machineTimezone: 'Europe/Berlin' }),
        machine({ machineId: 'annex-pc', machineTimezone: 'America/Los_Angeles' }),
      ],
    });

    const line = screen.getByTestId('site-time-banner-disagreement');
    expect(line).toHaveTextContent('stage-pc');
    expect(line).toHaveTextContent('annex-pc');
    // Agrees with the site timezone, so its windows do not move.
    expect(line).not.toHaveTextContent('lobby-pc');
  });

  it('says nothing about disagreement when every machine already matches the site', () => {
    renderBanner({
      machines: [
        machine({ machineId: 'lobby-pc', machineTimezone: 'America/New_York' }),
        machine({ machineId: 'stage-pc', machineTimezone: 'America/New_York' }),
      ],
    });
    expect(screen.queryByTestId('site-time-banner-disagreement')).toBeNull();
  });

  it('leaves out a machine that has never reported a timezone rather than guessing', () => {
    renderBanner({
      machines: [
        machine({ machineId: 'lobby-pc', machineTimezone: undefined }),
        machine({ machineId: 'stage-pc', machineTimezone: 'Europe/Berlin' }),
      ],
    });

    const line = screen.getByTestId('site-time-banner-disagreement');
    expect(line).toHaveTextContent('stage-pc');
    expect(line).not.toHaveTextContent('lobby-pc');
  });

  it('names the machines running an agent below the minimum', () => {
    renderBanner({
      machines: [
        machine({ machineId: 'old-pc', agent_version: '2.9.0' }),
        machine({ machineId: 'new-pc', agent_version: SITE_TIME_MIN_AGENT_VERSION }),
      ],
    });

    const advisory = screen.getByTestId('site-time-banner-version-advisory');
    expect(advisory).toHaveTextContent(SITE_TIME_MIN_AGENT_VERSION);
    expect(advisory).toHaveTextContent('old-pc');
    expect(advisory).not.toHaveTextContent('new-pc');
  });

  it('stays quiet when the whole fleet is at or above the minimum', () => {
    renderBanner({
      machines: [
        machine({ machineId: 'a', agent_version: SITE_TIME_MIN_AGENT_VERSION }),
        machine({ machineId: 'b', agent_version: '9.0.0' }),
      ],
    });
    expect(screen.queryByTestId('site-time-banner-version-advisory')).toBeNull();
  });

  it('does not flag a machine whose version is unknown — the advisory is copy, never a block', () => {
    renderBanner({ machines: [machine({ machineId: 'quiet-pc', agent_version: undefined })] });
    expect(screen.queryByTestId('site-time-banner-version-advisory')).toBeNull();
  });
});
