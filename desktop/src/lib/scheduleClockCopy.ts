/**
 * Which clock this app is allowed to claim a process's launch windows run on.
 *
 * Ported from `web/lib/scheduleClockCopy.ts` — same words, different subject.
 * The dashboard speaks about a fleet ("each machine's own clock"); this window
 * only ever speaks about the box it is running on ("this machine's own clock"),
 * and that wording predates the whole feature.
 *
 * The site's opt-in never reaches this app as a flag. The service resolves it
 * and publishes the answer as `firebase.schedule_timezone` in
 * `tmp/service_status.json` (agent 3.2.3+): a zone name when the site opted in
 * AND has a timezone, `''` in every other case. So there is nothing three-state
 * to interpret here, and no agent-version advisory to show either — the agent
 * publishing the field is the one evaluating the windows.
 *
 * The strings live here, not inline, so a unit test can pin the machine-clock
 * wording byte for byte: it is the state every recorded tutorial frame was shot
 * in, and the state of every site that has not answered the dashboard banner.
 */

/** What the service does with these windows — true whichever clock times them. */
const WINDOWS_SENTENCE =
  'the service runs this process during these windows and stops it outside them.'

/**
 * "America/New_York" → "New York". Mirrors the web's `formatTimezoneShortName`;
 * an operator reads a city, not a database key, and the full zone would not fit
 * the description line.
 */
export function shortZoneName(tz: string): string {
  return tz.replace(/_/g, ' ').split('/').pop() || tz
}

/**
 * The schedule editor's description line.
 *
 * FROZEN for the empty case: absent, opted out, or an unpaired machine all get
 * the machine-clock sentence exactly as it shipped before site time existed.
 */
export function scheduleClockDescription(scheduleTimezone: string): string {
  if (scheduleTimezone) {
    return `${WINDOWS_SENTENCE} times run on the site's clock (${shortZoneName(scheduleTimezone)}).`
  }
  return `${WINDOWS_SENTENCE} times run on this machine's own clock.`
}
