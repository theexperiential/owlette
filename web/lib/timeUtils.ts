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
