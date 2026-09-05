/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * SchedulePopover — the compact schedule editor behind a trigger. Covered here
 * for its footer clock label: before this, it printed "times in <site tz>"
 * whenever a site timezone existed, asserting site-time evaluation the agent
 * only performs for a site that opted in via
 * `sites/{siteId}.schedulesFollowSiteTime`.
 *
 * The popover mounts its content lazily (one portal per opened popover, not per
 * process on the page), so every case here has to click the trigger first.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/tooltip';
import SchedulePopover from '@/components/SchedulePopover';

// jsdom ships no ResizeObserver; Radix's popover positioning constructs one.
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// jsdom has no matchMedia; `matches: false` = coarse pointer, which puts
// DayPillSelector on its plain click-to-toggle path rather than drag-select.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: jest.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    addListener: jest.fn(),
    removeListener: jest.fn(),
    dispatchEvent: jest.fn(),
  })),
});

async function openPopover(props: {
  siteTimezone?: string;
  schedulesFollowSiteTime?: boolean;
}) {
  const user = userEvent.setup();
  render(
    <TooltipProvider>
      <SchedulePopover schedules={null} onApply={() => {}} {...props}>
        <button type="button">edit schedule</button>
      </SchedulePopover>
    </TooltipProvider>,
  );
  await user.click(screen.getByRole('button', { name: 'edit schedule' }));
  return user;
}

describe('SchedulePopover — schedule clock label', () => {
  it.each([
    ['absent (never asked)', undefined],
    ['false (declined)', false],
  ])('claims the machine clock when the flag is %s', async (_label, flag) => {
    await openPopover({
      siteTimezone: 'America/New_York',
      schedulesFollowSiteTime: flag,
    });

    expect(
      screen.getByText("times run on each machine's own clock"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/site's clock/)).not.toBeInTheDocument();
    // The retired string, which claimed the site's clock unconditionally.
    expect(screen.queryByText(/times in New York/)).not.toBeInTheDocument();
  });

  it('claims the site clock once the site has opted in', async () => {
    await openPopover({
      siteTimezone: 'America/New_York',
      schedulesFollowSiteTime: true,
    });

    expect(
      screen.getByText("times run on the site's clock (New York)"),
    ).toBeInTheDocument();
  });

  it('still answers the clock question with no site timezone at all', async () => {
    // This used to render an empty placeholder span: the machine clock is the
    // honest answer whether or not the site has named a timezone.
    await openPopover({});

    expect(
      screen.getByText("times run on each machine's own clock"),
    ).toBeInTheDocument();
  });

  it('agrees word for word with the process dialog', async () => {
    await openPopover({
      siteTimezone: 'America/New_York',
      schedulesFollowSiteTime: true,
    });

    // Both surfaces render lib/scheduleClockCopy — this pins the shared source,
    // so the two can never drift into contradicting each other.
    const { scheduleClockLabel } = await import('@/lib/scheduleClockCopy');
    expect(
      screen.getByText(scheduleClockLabel('America/New_York', true)),
    ).toBeInTheDocument();
  });
});
