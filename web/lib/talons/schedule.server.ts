/**
 * Talon schedule math — the single source of truth for `nextRunAt`, used by the
 * store (create / trigger change / re-enable) and the cron sweep (re-arm).
 *
 * TIMEZONE CONTRACT: clock-time entries are wall clock in the SITE's IANA zone —
 * "09:30 on weekdays" means 09:30 where the site is, across DST. Never use
 * `Date.setHours()` and friends: they resolve in the PROCESS's zone (UTC on
 * Railway). Every conversion goes through `Intl.DateTimeFormat({ timeZone })`
 * part extraction.
 *
 * DST: ambiguous times (fall-back) take the EARLIER occurrence, so the talon fires
 * once; nonexistent times (spring-forward gap) shift forward past the gap. Firing
 * late beats skipping a day, and neither case throws.
 *
 * Pure — no Firestore, no clock reads. The caller supplies `from`, so the runner
 * can re-arm relative to the run it just finished rather than to "now".
 */
import type { DayKey, TalonTrigger } from './types';

/** `Date.prototype.getUTCDay()` order (0 = Sunday), not `DAY_KEYS` order. */
const DAY_KEY_BY_JS_DAY: readonly DayKey[] = [
  'sun',
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
];

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

/** 7 is not enough: an entry whose only day is today, already past, fires at
 *  `dayOffset === 7`. */
const SCAN_DAYS = 7;

const FORMAT_OPTIONS: Intl.DateTimeFormatOptions = {
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
};

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * Site-zone formatter, falling back to UTC when the stored value is not an Intl
 * zone (empty, or a Windows name like "Eastern Standard Time"). A bad site
 * timezone must not take the scheduler down.
 */
function createZoneFormatter(timeZone: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat('en-US', { ...FORMAT_OPTIONS, timeZone });
  } catch {
    return new Intl.DateTimeFormat('en-US', { ...FORMAT_OPTIONS, timeZone: 'UTC' });
  }
}

/** The wall-clock reading in the formatter's zone at a given instant. */
function wallClockAt(formatter: Intl.DateTimeFormat, instantMs: number): WallClock {
  const parts = formatter.formatToParts(new Date(instantMs));
  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
}

/** Those same components re-read as if they had been UTC. */
function wallClockAsUtcMs(wall: WallClock): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
}

/** The zone's UTC offset (ms) at a given instant — positive east of Greenwich. */
function zoneOffsetMsAt(formatter: Intl.DateTimeFormat, instantMs: number): number {
  return wallClockAsUtcMs(wallClockAt(formatter, instantMs)) - instantMs;
}

/**
 * The instant at which the formatter's zone reads the given wall clock.
 *
 * Two passes: guess using the offset at the naive instant, then re-guess using
 * the offset at that guess. Away from a transition both agree. Across one they
 * disagree, and that identifies the case — a guess that renders back as the
 * requested wall clock means the time exists (ambiguous gives two: take the
 * earlier); neither matching means a spring-forward gap, so take the later guess.
 */
function zonedWallClockToUtcMs(
  formatter: Intl.DateTimeFormat,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  const firstGuess = naive - zoneOffsetMsAt(formatter, naive);
  const secondGuess = naive - zoneOffsetMsAt(formatter, firstGuess);
  const guesses = firstGuess === secondGuess ? [firstGuess] : [firstGuess, secondGuess];

  const matching = guesses.filter((guess) => {
    const wall = wallClockAt(formatter, guess);
    return (
      wall.year === year &&
      wall.month === month &&
      wall.day === day &&
      wall.hour === hour &&
      wall.minute === minute
    );
  });

  return matching.length > 0 ? Math.min(...matching) : Math.max(...guesses);
}

/**
 * The next instant a schedule trigger fires, strictly after `from`. `null` for
 * threshold and event triggers — data-driven, so they carry no `nextRunAt`.
 *
 * `trigger` must already be normalized by `validateTalonInput`; callers pass
 * `'UTC'` for `siteTimezoneIana` when the site has none. `from` is "now" for an
 * edit, the completed run's start for a re-arm.
 */
export function computeNextRunAt(
  trigger: TalonTrigger,
  siteTimezoneIana: string,
  from: Date,
): Date | null {
  if (trigger.type !== 'schedule') return null;

  const fromMs = from.getTime();
  if (!Number.isFinite(fromMs)) return null;

  if (typeof trigger.intervalMinutes === 'number') {
    return new Date(fromMs + trigger.intervalMinutes * MS_PER_MINUTE);
  }

  const entries = trigger.entries ?? [];
  if (entries.length === 0) return null;

  const formatter = createZoneFormatter(siteTimezoneIana);
  const today = wallClockAt(formatter, fromMs);
  // Midnight UTC on the site's LOCAL date. Only used for day counting and weekday
  // lookup, both DST-free because they never leave the UTC calendar.
  const anchorMs = Date.UTC(today.year, today.month - 1, today.day);

  for (let dayOffset = 0; dayOffset <= SCAN_DAYS; dayOffset++) {
    const calendarDay = new Date(anchorMs + dayOffset * MS_PER_DAY);
    const dayKey = DAY_KEY_BY_JS_DAY[calendarDay.getUTCDay()];

    let soonestOnDay: number | null = null;
    for (const entry of entries) {
      if (!entry.days.includes(dayKey)) continue;

      const hour = Number(entry.time.slice(0, 2));
      const minute = Number(entry.time.slice(3, 5));
      if (!Number.isInteger(hour) || !Number.isInteger(minute)) continue;

      const candidate = zonedWallClockToUtcMs(
        formatter,
        calendarDay.getUTCFullYear(),
        calendarDay.getUTCMonth() + 1,
        calendarDay.getUTCDate(),
        hour,
        minute,
      );
      if (candidate <= fromMs) continue;
      if (soonestOnDay === null || candidate < soonestOnDay) soonestOnDay = candidate;
    }

    // A zone never rewinds a whole day, so the first day with a hit wins.
    if (soonestOnDay !== null) return new Date(soonestOnDay);
  }

  return null;
}
