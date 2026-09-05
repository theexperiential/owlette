/**
 * Which clock a schedule surface is allowed to claim.
 *
 * Process launch windows follow the SITE's clock only when the site opted in
 * (`sites/{siteId}.schedulesFollowSiteTime === true`). The flag is three-state:
 * absent = never asked, `false` = declined, `true` = site time — and absent and
 * `false` both mean the legacy behavior, where every window is evaluated on the
 * machine's own Windows clock. Read it from the Firestore snapshot
 * (`useCurrentSite` / `useSites`), never from `GET /api/sites`, which
 * deliberately collapses absent and `false` into one value.
 *
 * Scheduled REBOOTS stay machine-local in every case (plan decision D2), which
 * is why the machine tooltip splits rather than swaps: the machine clock still
 * governs restarts even after a site opts in.
 *
 * The strings live here, not inline, so the popover, the process dialog and
 * both machine views cannot drift apart, and so the flag-off wording can be
 * pinned byte-for-byte by a unit test.
 */

import { formatTimezoneShortName } from '@/lib/timeUtils';
import { isOutdated, SITE_TIME_MIN_AGENT_VERSION } from '@/lib/versionUtils';

/**
 * One-line clock label for a schedule editor surface that has no single machine
 * in scope (the schedule popover, the process dialog). `siteTimezone` is the
 * site's IANA name; the label degrades to the machine-clock wording whenever the
 * site has not opted in or has no timezone to opt in with.
 */
export function scheduleClockLabel(
  siteTimezone: string | undefined,
  schedulesFollowSiteTime: boolean | undefined,
): string {
  if (schedulesFollowSiteTime === true && siteTimezone) {
    return `times run on the site's clock (${formatTimezoneShortName(siteTimezone)})`;
  }
  return "times run on each machine's own clock";
}

/**
 * Lines for the machine-clock tooltip under a hostname. `machineLine` always
 * renders; the rest appear only once the site evaluates windows in site time
 * and the two clocks actually differ.
 */
export interface MachineClockTooltip {
  /** The machine's own clock, plus whatever still follows it. */
  machineLine: string;
  /** Where launch windows are evaluated, when that is no longer the machine. */
  scheduleLine?: string;
  /** Shown when this machine's agent is too old to honor the site's clock. */
  advisory?: string;
}

export function machineClockTooltip({
  machineTimezone,
  siteTimezone,
  schedulesFollowSiteTime,
  agentVersion,
}: {
  machineTimezone: string;
  siteTimezone?: string;
  schedulesFollowSiteTime?: boolean;
  agentVersion?: string;
}): MachineClockTooltip {
  // Flag off/absent, no site timezone to follow, or a site whose clock IS this
  // machine's clock: one sentence covers restarts and windows alike, and it is
  // the string that shipped before any of the site-time work — frozen, because
  // the machine views are the surfaces the tutorial footage frames.
  if (
    schedulesFollowSiteTime !== true ||
    !siteTimezone ||
    siteTimezone === machineTimezone
  ) {
    return {
      machineLine: `this machine's local time (${machineTimezone}). schedule entries are interpreted in this timezone.`,
    };
  }

  return {
    machineLine: `this machine's local time (${machineTimezone}). scheduled restarts run on this clock.`,
    scheduleLine: `process launch windows run on the site's clock (${siteTimezone}).`,
    // Advisory, never a block (plan decision D3): an older agent still
    // evaluates windows locally, and gating the fleet on one stale machine
    // would strand the whole site.
    advisory: isOutdated(agentVersion, SITE_TIME_MIN_AGENT_VERSION)
      ? `until this machine updates to agent ${SITE_TIME_MIN_AGENT_VERSION} or newer, its launch windows stay on the machine clock.`
      : undefined,
  };
}
