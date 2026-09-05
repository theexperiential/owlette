/**
 * Exact-string guards for the schedule clock copy.
 *
 * Two of these strings are frozen and two are new:
 *
 * - The flag-off machine tooltip is FROZEN. It is what shipped in
 *   MachineCardView / MachineListView before any site-time work, it is what the
 *   tutorial footage frames, and a site that never opted in must keep it
 *   byte-for-byte. If a change here goes red, the change is wrong — not the test.
 * - The dialog labels are NEW. "times in <site tz>" (SchedulePopover /
 *   ProcessDialog before this change) asserted site-time evaluation
 *   unconditionally, which the agent only performs for an opted-in site; that
 *   string is deliberately retired, not preserved.
 */

import {
  machineClockTooltip,
  scheduleClockLabel,
} from '@/lib/scheduleClockCopy';
import { SITE_TIME_MIN_AGENT_VERSION } from '@/lib/versionUtils';

const MACHINE_TZ = 'America/New_York';
const SITE_TZ = 'America/Chicago';

/** Byte-for-byte what both machine views rendered before the site-time work. */
const LEGACY_TOOLTIP =
  "this machine's local time (America/New_York). schedule entries are interpreted in this timezone.";

describe('machineClockTooltip — flag off/absent is frozen', () => {
  it.each([
    ['absent (never asked)', undefined],
    ['false (declined)', false],
  ])('renders the legacy single line when the flag is %s', (_label, flag) => {
    expect(
      machineClockTooltip({
        machineTimezone: MACHINE_TZ,
        siteTimezone: SITE_TZ,
        schedulesFollowSiteTime: flag,
        agentVersion: '3.2.4',
      }),
    ).toEqual({ machineLine: LEGACY_TOOLTIP });
  });

  it('renders the legacy single line when the site opted in but has no timezone', () => {
    expect(
      machineClockTooltip({
        machineTimezone: MACHINE_TZ,
        siteTimezone: undefined,
        schedulesFollowSiteTime: true,
      }),
    ).toEqual({ machineLine: LEGACY_TOOLTIP });
  });

  it('renders the legacy single line when the site clock IS this machine clock', () => {
    // Both halves are true of one timezone, so splitting them would be noise.
    expect(
      machineClockTooltip({
        machineTimezone: MACHINE_TZ,
        siteTimezone: MACHINE_TZ,
        schedulesFollowSiteTime: true,
        agentVersion: '1.0.0',
      }),
    ).toEqual({ machineLine: LEGACY_TOOLTIP });
  });

  it('never leaks a second line or an advisory while the flag is off', () => {
    const tip = machineClockTooltip({
      machineTimezone: MACHINE_TZ,
      siteTimezone: SITE_TZ,
      schedulesFollowSiteTime: false,
      agentVersion: undefined,
    });
    expect(tip.scheduleLine).toBeUndefined();
    expect(tip.advisory).toBeUndefined();
  });
});

describe('machineClockTooltip — flag on splits the two clocks', () => {
  it('labels the machine clock and the site clock separately', () => {
    expect(
      machineClockTooltip({
        machineTimezone: MACHINE_TZ,
        siteTimezone: SITE_TZ,
        schedulesFollowSiteTime: true,
        agentVersion: SITE_TIME_MIN_AGENT_VERSION,
      }),
    ).toEqual({
      machineLine:
        "this machine's local time (America/New_York). scheduled restarts run on this clock.",
      scheduleLine:
        "process launch windows run on the site's clock (America/Chicago).",
      advisory: undefined,
    });
  });

  it.each([
    ['newer than the minimum', '3.9.0'],
    ['exactly the minimum', SITE_TIME_MIN_AGENT_VERSION],
  ])('omits the advisory for an agent %s', (_label, agentVersion) => {
    expect(
      machineClockTooltip({
        machineTimezone: MACHINE_TZ,
        siteTimezone: SITE_TZ,
        schedulesFollowSiteTime: true,
        agentVersion,
      }).advisory,
    ).toBeUndefined();
  });

  it.each([
    ['older than the minimum', '3.2.2'],
    ['not reported at all', undefined],
  ])('advises, never blocks, for an agent %s', (_label, agentVersion) => {
    expect(
      machineClockTooltip({
        machineTimezone: MACHINE_TZ,
        siteTimezone: SITE_TZ,
        schedulesFollowSiteTime: true,
        agentVersion,
      }).advisory,
    ).toBe(
      `until this machine updates to agent ${SITE_TIME_MIN_AGENT_VERSION} or newer, its launch windows stay on the machine clock.`,
    );
  });

  it('quotes the shared constant rather than a version literal', () => {
    const advisory = machineClockTooltip({
      machineTimezone: MACHINE_TZ,
      siteTimezone: SITE_TZ,
      schedulesFollowSiteTime: true,
      agentVersion: '1.0.0',
    }).advisory;
    expect(advisory).toContain(SITE_TIME_MIN_AGENT_VERSION);
  });
});

describe('scheduleClockLabel', () => {
  it.each([
    ['absent (never asked)', undefined],
    ['false (declined)', false],
  ])('claims the machine clock when the flag is %s', (_label, flag) => {
    expect(scheduleClockLabel(SITE_TZ, flag)).toBe(
      "times run on each machine's own clock",
    );
  });

  it('claims the machine clock when the site opted in but has no timezone', () => {
    expect(scheduleClockLabel(undefined, true)).toBe(
      "times run on each machine's own clock",
    );
    expect(scheduleClockLabel('', true)).toBe(
      "times run on each machine's own clock",
    );
  });

  it('claims the site clock only once the site has opted in', () => {
    expect(scheduleClockLabel(SITE_TZ, true)).toBe(
      "times run on the site's clock (Chicago)",
    );
  });

  it('strips the underscores out of the IANA city segment', () => {
    expect(scheduleClockLabel('America/Los_Angeles', true)).toBe(
      "times run on the site's clock (Los Angeles)",
    );
  });
});
