/**
 * Time utility functions for heartbeat display with timezone support
 *
 * Heartbeat display rules:
 * - Online (< 5 min since heartbeat): Show HH:MM AM/PM in muted color
 * - Offline (> 5 min since heartbeat): Show relative time (e.g., "14h ago") in red
 * - Tooltip: Always shows full timestamp with timezone
 */

const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes in milliseconds

/**
 * Check if a heartbeat is stale (> 5 minutes ago)
 *
 * @param timestampSeconds - Unix timestamp in seconds
 * @returns true if heartbeat is stale
 */
export function isHeartbeatStale(timestampSeconds: number): boolean {
  const now = Date.now();
  const heartbeatMs = timestampSeconds * 1000;
  return now - heartbeatMs > STALE_THRESHOLD_MS;
}

/**
 * Format relative time (e.g., "14h ago", "3m ago", "2d ago")
 *
 * @param timestampSeconds - Unix timestamp in seconds
 * @returns Relative time string
 */
export function formatRelativeTime(timestampSeconds: number): string {
  const now = Date.now();
  const heartbeatMs = timestampSeconds * 1000;
  const diffMs = now - heartbeatMs;

  const minutes = Math.floor(diffMs / (1000 * 60));
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (days > 0) {
    return `${days}d ago`;
  } else if (hours > 0) {
    return `${hours}h ago`;
  } else if (minutes > 0) {
    return `${minutes}m ago`;
  } else {
    return 'just now';
  }
}

/**
 * Format time in the specified timezone with 12h or 24h format
 *
 * @param timestampSeconds - Unix timestamp in seconds
 * @param timezone - IANA timezone string (e.g., "America/New_York")
 * @param timeFormat - '12h' for 12-hour format (3:09 PM), '24h' for 24-hour format (15:09)
 * @returns Formatted time string
 */
export function formatTimeOnly(
  timestampSeconds: number,
  timezone: string = 'UTC',
  timeFormat: '12h' | '24h' = '12h'
): string {
  const date = new Date(timestampSeconds * 1000);
  const hour12 = timeFormat === '12h';

  try {
    return date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12,
      timeZone: timezone,
    }).toLowerCase();
  } catch {
    // Fallback if timezone is invalid
    return date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12,
    }).toLowerCase();
  }
}

/**
 * Format full timestamp for tooltip display
 *
 * @param timestampSeconds - Unix timestamp in seconds
 * @param timezone - IANA timezone string (e.g., "America/New_York")
 * @param timeFormat - '12h' for 12-hour format, '24h' for 24-hour format
 * @returns Full formatted timestamp (e.g., "January 2, 2026, 3:09:15 PM EST")
 */
export function formatFullTimestamp(
  timestampSeconds: number,
  timezone: string = 'UTC',
  timeFormat: '12h' | '24h' = '12h'
): string {
  const date = new Date(timestampSeconds * 1000);
  const hour12 = timeFormat === '12h';

  try {
    return date.toLocaleString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12,
      timeZone: timezone,
      timeZoneName: 'short',
    });
  } catch {
    // Fallback if timezone is invalid
    return date.toLocaleString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12,
    });
  }
}

/**
 * Format heartbeat time for display based on online status
 *
 * @param timestampSeconds - Unix timestamp in seconds
 * @param timezone - IANA timezone string (e.g., "America/New_York")
 * @param timeFormat - '12h' for 12-hour format, '24h' for 24-hour format
 * @returns Object with display text, stale status, and tooltip text
 */
export function formatHeartbeatTime(
  timestampSeconds: number,
  timezone: string = 'UTC',
  timeFormat: '12h' | '24h' = '12h'
): { display: string; isStale: boolean; tooltip: string } {
  // Guard against missing/invalid timestamps (epoch 0, negative, etc.)
  if (!timestampSeconds || timestampSeconds < 86400) {
    return { display: '--', isStale: true, tooltip: 'No heartbeat received' };
  }
  const isStale = isHeartbeatStale(timestampSeconds);
  const tooltip = formatFullTimestamp(timestampSeconds, timezone, timeFormat);

  if (isStale) {
    // Offline: show relative time
    return {
      display: formatRelativeTime(timestampSeconds),
      isStale: true,
      tooltip,
    };
  } else {
    // Online: show time in chosen format
    return {
      display: formatTimeOnly(timestampSeconds, timezone, timeFormat),
      isStale: false,
      tooltip,
    };
  }
}

/**
 * Get browser's detected timezone
 *
 * @returns IANA timezone string (e.g., "America/New_York")
 */
export function getBrowserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
}

// ─── Multi-actor timezone helpers ────────────────────────────────────────────
//
// Owlette has three timezone actors:
//   1. machine — the kiosk/render-node's own Windows local tz, written by the
//      agent to Firestore as machine_timezone_iana on every heartbeat
//   2. user — the dashboard viewer's preferred tz, set in user preferences
//   3. site — the site's configured tz, set in manage-sites dialog
//
// The user picks ONE display mode in their preferences (`timeDisplayMode`),
// and the dashboard renders absolute timestamps according to that mode for
// every machine. Schedule editors are unaffected by this — they always show
// times in the *machine's* local tz with an explicit chip label, because
// schedules are wall-clock configuration tied to the physical machine.

/** User-chosen reference frame for displaying absolute timestamps. */
export type TimeDisplayMode = 'user' | 'machine' | 'site';

/**
 * Resolve which IANA timezone to render absolute times in for a given
 * machine, given the user's chosen display mode and the available sources.
 *
 * Each call is per-machine because in `'machine'` mode two machines on the
 * same dashboard page may render in two different timezones.
 *
 * Fallback chain (when the primary source is missing):
 *   - 'user'    → user's tz → browser → 'UTC'
 *   - 'machine' → machine tz → site tz → browser → 'UTC'
 *   - 'site'    → site tz → browser → 'UTC'
 *
 * The 'machine' mode falls back to site (not user) because if the agent
 * hasn't reported its own tz yet, the site's tz is the closest "this
 * installation lives in X" approximation. Browser is the last resort.
 */
export function getDisplayTimezone(
  mode: TimeDisplayMode,
  userTz: string | undefined,
  machineTz: string | undefined,
  siteTz: string | undefined
): string {
  switch (mode) {
    case 'user':
      return userTz || getBrowserTimezone() || 'UTC';
    case 'machine':
      return machineTz || siteTz || getBrowserTimezone() || 'UTC';
    case 'site':
      return siteTz || getBrowserTimezone() || 'UTC';
  }
}

/**
 * Resolve the timezone AND the source label that explains where it came
 * from, in a single call. Used by surfaces that want to render a
 * `<TimezoneChip>` next to a list of times — the chip needs to know both
 * the IANA name (for display) and the source (for tooltip text).
 *
 * The `source` reflects which mode actually delivered a value, not the
 * mode the user originally picked. Example: in 'machine' mode for an old
 * agent that hasn't reported its tz yet, this returns
 * `{ tz: <site or browser>, source: 'site' }` so the chip tooltip
 * doesn't lie about where the value came from.
 */
export function getDisplayTimezoneWithSource(
  mode: TimeDisplayMode,
  userTz: string | undefined,
  machineTz: string | undefined,
  siteTz: string | undefined
): { tz: string; source: TimeDisplayMode } {
  switch (mode) {
    case 'user':
      if (userTz) return { tz: userTz, source: 'user' };
      // No user tz set — fall through to browser, but mislabeling as 'site'
      // would be wrong. Show 'user' source so the tooltip points the user
      // at where to fix it (their preferences).
      return { tz: getBrowserTimezone() || 'UTC', source: 'user' };
    case 'machine':
      if (machineTz) return { tz: machineTz, source: 'machine' };
      if (siteTz) return { tz: siteTz, source: 'site' };
      return { tz: getBrowserTimezone() || 'UTC', source: 'machine' };
    case 'site':
      if (siteTz) return { tz: siteTz, source: 'site' };
      return { tz: getBrowserTimezone() || 'UTC', source: 'site' };
  }
}

/**
 * Format the current wall-clock time in a specific machine's local
 * timezone — used for the live "22:35 local" label under each hostname
 * on the dashboard. Updates whenever the caller re-renders (typically
 * once per minute via a setInterval).
 *
 * @param machineTimezone IANA tz, or undefined if the machine hasn't
 *   reported yet
 * @param timeFormat '12h' or '24h' (defaults to 24h)
 * @returns Formatted clock string ("22:35"), or empty string if tz missing
 */
export function formatMachineLocalClock(
  machineTimezone: string | undefined,
  timeFormat: '12h' | '24h' = '24h'
): string {
  if (!machineTimezone) return '';
  try {
    return new Date().toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: timeFormat === '12h',
      timeZone: machineTimezone,
    });
  } catch {
    return '';
  }
}

/**
 * Pretty-format an IANA timezone for display (e.g.
 * "America/Los_Angeles" → "Los Angeles"). Strips underscores and
 * shows the most-specific component.
 */
export function formatTimezoneShortName(tz: string | undefined): string {
  if (!tz) return 'unknown';
  return tz.replace(/_/g, ' ').split('/').pop() || tz;
}

/**
 * Format a timestamp for display on a SITE-SCOPED surface (deployments,
 * activity logs, projects, admin tokens) — i.e. surfaces where there is
 * no single "machine" to anchor to.
 *
 * Resolves the timezone via the user's chosen `timeDisplayMode`:
 *   - 'machine' mode → falls back to site → browser (since there's no machine here)
 *   - 'user' mode → user's preferred tz
 *   - 'site' mode → site tz
 *
 * Accepts anything `Date.parse`-able OR a Date / number / undefined.
 * Returns a fully-formatted "Month D, YYYY, HH:MM:SS TZ" string with
 * the timezone name suffix included so the user can always see which
 * frame the time is in.
 *
 * Returns '—' if the input is falsy or unparseable.
 */
export function formatSiteScopedTimestamp(
  input: Date | number | string | undefined | null,
  mode: TimeDisplayMode,
  userTz: string | undefined,
  siteTz: string | undefined,
  timeFormat: '12h' | '24h' = '12h'
): string {
  if (input == null) return '—';

  let ms: number;
  if (input instanceof Date) {
    ms = input.getTime();
  } else if (typeof input === 'number') {
    ms = input;
  } else if (typeof input === 'string') {
    ms = Date.parse(input);
  } else {
    return '—';
  }

  if (!Number.isFinite(ms) || ms <= 0) return '—';

  const seconds = Math.floor(ms / 1000);
  // Site-scoped surfaces have no single machine — pass undefined for machineTz.
  // In 'machine' mode this falls through to siteTz, then browser, then UTC.
  const tz = getDisplayTimezone(mode, userTz, undefined, siteTz);
  return formatFullTimestamp(seconds, tz, timeFormat);
}

/**
 * Common timezone options for the timezone selector
 * Ordered by approximate UTC offset from west to east
 */
export const COMMON_TIMEZONES = [
  { value: 'Pacific/Honolulu', label: 'Hawaii (HST)' },
  { value: 'America/Anchorage', label: 'Alaska (AKST)' },
  { value: 'America/Los_Angeles', label: 'Pacific Time (PST)' },
  { value: 'America/Denver', label: 'Mountain Time (MST)' },
  { value: 'America/Chicago', label: 'Central Time (CST)' },
  { value: 'America/New_York', label: 'Eastern Time (EST)' },
  { value: 'America/Sao_Paulo', label: 'Brasilia (BRT)' },
  { value: 'UTC', label: 'UTC' },
  { value: 'Europe/London', label: 'London (GMT)' },
  { value: 'Europe/Paris', label: 'Paris (CET)' },
  { value: 'Europe/Berlin', label: 'Berlin (CET)' },
  { value: 'Europe/Moscow', label: 'Moscow (MSK)' },
  { value: 'Asia/Dubai', label: 'Dubai (GST)' },
  { value: 'Asia/Kolkata', label: 'India (IST)' },
  { value: 'Asia/Singapore', label: 'Singapore (SGT)' },
  { value: 'Asia/Shanghai', label: 'China (CST)' },
  { value: 'Asia/Tokyo', label: 'Tokyo (JST)' },
  { value: 'Australia/Sydney', label: 'Sydney (AEDT)' },
  { value: 'Pacific/Auckland', label: 'Auckland (NZDT)' },
] as const;

/**
 * Validate if a string is a valid IANA timezone
 *
 * @param timezone - String to validate
 * @returns true if valid IANA timezone
 */
export function isValidTimezone(timezone: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Timezone option for the searchable timezone picker
 */
export interface TimezoneOption {
  value: string;
  label: string;
  offset: number;
  offsetLabel: string;
  region: string;
  /** Extra search terms (alternative city spellings, old IANA names, etc.) */
  aliases?: string[];
}

/**
 * Map of IANA timezone IDs → alternative search terms.
 * Covers renamed cities, transliterations, and common misspellings.
 */
const TIMEZONE_SEARCH_ALIASES: Record<string, string[]> = {
  'Europe/Kiev': ['kyiv'],
  'Europe/Kyiv': ['kiev'],
  'Asia/Kolkata': ['bombay', 'mumbai', 'calcutta'],
  'Asia/Ho_Chi_Minh': ['saigon'],
  'Asia/Yangon': ['rangoon'],
  'Atlantic/Reykjavik': ['reykjavík'],
  'America/Nuuk': ['godthab', 'godthåb'],
  'Pacific/Honolulu': ['hawaii'],
  'America/Anchorage': ['alaska'],
  'Asia/Istanbul': ['constantinople'],
  'Europe/Istanbul': ['constantinople'],
  'Africa/Abidjan': ['gmt', 'greenwich'],
};

/**
 * Get the current UTC offset for a timezone
 */
export function getTimezoneOffset(timezone: string): { offset: number; offsetLabel: string } {
  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'shortOffset',
    });
    const parts = formatter.formatToParts(now);
    const tzPart = parts.find((p) => p.type === 'timeZoneName')?.value || 'UTC';

    // Parse "GMT+2", "GMT-5:30", "GMT+5:45", "GMT" etc.
    if (tzPart === 'GMT' || tzPart === 'UTC') {
      return { offset: 0, offsetLabel: 'UTC+00:00' };
    }

    const match = tzPart.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
    if (match) {
      const sign = match[1] === '+' ? 1 : -1;
      const hours = parseInt(match[2], 10);
      const minutes = parseInt(match[3] || '0', 10);
      const offset = sign * (hours * 60 + minutes);
      const offsetLabel = `UTC${match[1]}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
      return { offset, offsetLabel };
    }

    return { offset: 0, offsetLabel: 'UTC+00:00' };
  } catch {
    return { offset: 0, offsetLabel: 'UTC+00:00' };
  }
}

/**
 * Format an IANA timezone ID as a readable label
 * e.g., "America/New_York" → "America / New York"
 */
export function formatTimezoneLabel(timezone: string): string {
  if (timezone === 'UTC') return 'UTC';
  return timezone.replace(/_/g, ' ').replace(/\//g, ' / ');
}

let cachedTimezones: TimezoneOption[] | null = null;

/**
 * Get all IANA timezones with labels and UTC offsets.
 * Uses Intl.supportedValuesOf (browser-native), cached after first call.
 * Falls back to COMMON_TIMEZONES if the API is unavailable.
 */
export function getAllTimezones(): TimezoneOption[] {
  if (cachedTimezones) return cachedTimezones;

  let tzIds: string[];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tzIds = (Intl as any).supportedValuesOf('timeZone');
  } catch {
    // Fallback for SSR or old browsers
    cachedTimezones = COMMON_TIMEZONES.map((tz) => {
      const { offset, offsetLabel } = getTimezoneOffset(tz.value);
      const region = tz.value.includes('/') ? tz.value.split('/')[0] : 'Other';
      const aliases = TIMEZONE_SEARCH_ALIASES[tz.value];
      return { value: tz.value, label: formatTimezoneLabel(tz.value), offset, offsetLabel, region, ...(aliases && { aliases }) };
    });
    return cachedTimezones;
  }

  cachedTimezones = tzIds.map((tz) => {
    const { offset, offsetLabel } = getTimezoneOffset(tz);
    const region = tz.includes('/') ? tz.split('/')[0] : 'Other';
    const aliases = TIMEZONE_SEARCH_ALIASES[tz];
    return { value: tz, label: formatTimezoneLabel(tz), offset, offsetLabel, region, ...(aliases && { aliases }) };
  });

  cachedTimezones.sort((a, b) => a.offset - b.offset || a.label.localeCompare(b.label));
  return cachedTimezones;
}
