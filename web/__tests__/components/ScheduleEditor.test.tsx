/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * ScheduleEditor's timezone copy — the conditional half of `schedules follow
 * site time` (dev/active/site-time-schedules, wave 3a task 3.2).
 *
 * TWO STRINGS IN HERE ARE FROZEN, and the `exact: true` matches below are the
 * guard that keeps them that way:
 *
 * - `LEGACY_MACHINE_CLOCK_DESCRIPTION` is what the dialog says whenever the site
 *   has NOT opted into site time (`undefined` = never asked, or `false` =
 *   declined). Absence of the flag is the state every e2e fixture and every
 *   recorded tutorial frame is in, so a reworded flag-off description silently
 *   invalidates footage that is expensive to re-shoot.
 * - `OUTSIDE_WINDOW_BANNER` is asserted verbatim by the episode-06 capture
 *   (`e2e/videos/06-run-on-a-schedule.video.ts`), and is deliberately NOT
 *   conditional on the flag at all: it stays a prediction evaluated in the site
 *   timezone, because machines live at the site.
 *
 * If a change to ScheduleEditor turns these red, the copy — not the test — is
 * what has to go back.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import ScheduleEditor from '@/components/ScheduleEditor';
import type { ScheduleBlock } from '@/hooks/useFirestore';
import { SITE_TIME_MIN_AGENT_VERSION } from '@/lib/versionUtils';

jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ userPreferences: { timeFormat: '12h' } }),
}));

jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() },
}));

// jsdom has no matchMedia; `matches: false` puts DayPillSelector on its
// click-to-toggle path (same shim as ProcessDialog.test.tsx).
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

/** U+2019 (`&rsquo;`), not an ASCII apostrophe — the frozen form. */
const LEGACY_MACHINE_CLOCK_DESCRIPTION = 'times run on each machine’s own clock';
const SITE_CLOCK_DESCRIPTION = 'times run on the site’s clock';
/** U+2014 em dash. Asserted verbatim by the episode-06 capture. */
const OUTSIDE_WINDOW_BANNER =
  'this looks outside the current window — a machine outside it will stop the process shortly after saving.';

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

/**
 * A 09:00–10:00 window three days from today. Never "now" and never an
 * overnight carry-over from yesterday, whatever day or timezone the suite runs
 * in — so the outside-window banner renders deterministically without faking
 * timers (Radix's dialog mount does not survive fake timers cleanly).
 */
function alwaysOutsideWindow(): ScheduleBlock[] {
  const farDay = DAY_NAMES[(new Date().getDay() + 3) % 7];
  return [{ colorIndex: 0, days: [farDay], ranges: [{ start: '09:00', stop: '10:00' }] }];
}

interface RenderOptions {
  schedulesFollowSiteTime?: boolean;
  targetMachineAgentVersion?: string;
  siteTimezone?: string;
  currentLaunchMode?: 'off' | 'always' | 'scheduled';
  schedules?: ScheduleBlock[] | null;
}

function renderEditor(opts: RenderOptions = {}) {
  return render(
    <TooltipProvider>
      <ScheduleEditor
        open
        onOpenChange={() => {}}
        schedules={opts.schedules ?? null}
        onChange={() => {}}
        siteTimezone={opts.siteTimezone}
        currentLaunchMode={opts.currentLaunchMode}
        schedulesFollowSiteTime={opts.schedulesFollowSiteTime}
        targetMachineAgentVersion={opts.targetMachineAgentVersion}
      />
    </TooltipProvider>,
  );
}

describe('ScheduleEditor — flag off or never asked (the recorded-footage guard)', () => {
  it.each([
    ['never asked (absent)', undefined],
    ['declined (false)', false],
  ])('says the legacy machine-clock line verbatim when %s', (_label, flag) => {
    renderEditor({ schedulesFollowSiteTime: flag, siteTimezone: 'America/New_York' });

    expect(
      screen.getByText(LEGACY_MACHINE_CLOCK_DESCRIPTION, { exact: true }),
    ).toBeInTheDocument();
  });

  it('shows no site-clock line and no timezone chip when the flag is absent', () => {
    renderEditor({ siteTimezone: 'America/New_York' });

    expect(screen.queryByText(SITE_CLOCK_DESCRIPTION, { exact: true })).toBeNull();
    // The chip renders the zone ABBREVIATION, so pin the tooltip trigger's
    // accessible text rather than the IANA name.
    expect(screen.queryByText(/^EST|EDT$/)).toBeNull();
  });

  it('shows no agent-version advisory when the flag is absent, however old the agent', () => {
    renderEditor({ targetMachineAgentVersion: '2.9.0', siteTimezone: 'America/New_York' });

    expect(screen.queryByTestId('schedule-editor-agent-advisory')).toBeNull();
  });
});

describe('ScheduleEditor — flag on', () => {
  it('says times run on the site clock and shows the site timezone chip', () => {
    renderEditor({ schedulesFollowSiteTime: true, siteTimezone: 'America/New_York' });

    expect(screen.getByText(SITE_CLOCK_DESCRIPTION, { exact: true })).toBeInTheDocument();
    expect(
      screen.queryByText(LEGACY_MACHINE_CLOCK_DESCRIPTION, { exact: true }),
    ).toBeNull();
    expect(screen.getByTestId('schedule-editor-site-tz-chip')).toBeInTheDocument();
  });

  it('warns when the target machine runs an agent below the minimum', () => {
    renderEditor({
      schedulesFollowSiteTime: true,
      siteTimezone: 'America/New_York',
      targetMachineAgentVersion: '2.9.0',
    });

    const advisory = screen.getByTestId('schedule-editor-agent-advisory');
    expect(advisory).toHaveTextContent(SITE_TIME_MIN_AGENT_VERSION);
    expect(advisory).toHaveTextContent('2.9.0');
  });

  it('stays quiet for an agent at or above the minimum', () => {
    renderEditor({
      schedulesFollowSiteTime: true,
      siteTimezone: 'America/New_York',
      targetMachineAgentVersion: SITE_TIME_MIN_AGENT_VERSION,
    });

    expect(screen.queryByTestId('schedule-editor-agent-advisory')).toBeNull();
  });

  it('stays quiet when the machine has not reported a version — copy is never a block', () => {
    renderEditor({ schedulesFollowSiteTime: true, siteTimezone: 'America/New_York' });

    expect(screen.queryByTestId('schedule-editor-agent-advisory')).toBeNull();
  });
});

describe('ScheduleEditor — the outside-window banner is frozen and flag-independent', () => {
  it.each([
    ['absent', undefined],
    ['false', false],
    ['true', true],
  ])('renders the same verbatim banner when the flag is %s', (_label, flag) => {
    renderEditor({
      schedulesFollowSiteTime: flag,
      siteTimezone: 'America/New_York',
      currentLaunchMode: 'scheduled',
      schedules: alwaysOutsideWindow(),
    });

    expect(screen.getByText(OUTSIDE_WINDOW_BANNER, { exact: true })).toBeInTheDocument();
  });
});
