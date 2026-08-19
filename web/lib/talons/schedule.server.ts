/**
 * Talon schedule math — "when does this trigger next fire?".
 *
 * The single source of truth for `nextRunAt`, shared by the store (stamped on
 * create / trigger-change / re-enable) and by the cron sweep (re-armed after
 * every run). Keeping the math in one module means a talon's next fire is
 * computed identically whether a human edited it or the runner advanced it.
 *
 * Timezone contract: fixed clock-time entries are wall-clock configuration in
 * the SITE's IANA zone — "09:30 on weekdays" means 09:30 where the site is,
 * across DST shifts, not a frozen UTC offset. `Date.setHours()` and friends
 * resolve in the *process's* zone (UTC on Railway, whatever the dev's laptop
 * says locally), so they are never used here; every conversion goes through
 * `Intl.DateTimeFormat({ timeZone })` part extraction — the same technique
 * `getNextScheduledRestart()` in `@/components/RestartScheduleDialog` uses
 * client-side, adapted to return an instant instead of a display string.
 *
 * DST edge cases are resolved the way IANA-aware libraries do:
 *   - ambiguous (fall-back, e.g. 01:30 twice on the US November Sunday) →
 *     the EARLIER occurrence. The later one is then in the past relative to
 *     the run that just fired, so the talon fires once, not twice.
 *   - nonexistent (spring-forward gap, e.g. 02:30 on the US March Sunday) →
 *     shifted forward by the gap (02:30 → 03:30 local). Firing late beats
 *     silently skipping a day, and it never throws.
 *
 * Pure and dependency-free — no Firestore, no clock reads. The caller passes
 * `from`, so the runner can compute a next-run relative to the run it just
 * completed rather than to "now".
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

/**
 * Days to scan forward. 7 is not enough: an entry whose only day is today but
 * whose time already passed fires a week later, which is `dayOffset === 7`.
 */
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
 * Formatter for the site's zone, or a UTC one when the stored value is not a
 * zone `Intl` knows (an empty string, or a Windows registry name like
 * "Eastern Standard Time" — see `getMachineTimezone` in adminUtils.server).
 * Falling back beats throwing: a bad site timezone must not take the whole
 * scheduler down.
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
 * Two passes: guess with the offset in force at the naive instant, then
 * re-guess with the offset in force at that guess. Away from a transition
 * both land on the same instant. Across one they disagree, and the disagreement
 * is exactly what identifies the case: if either guess renders back as the
 * requested wall clock the time exists (ambiguous times produce two valid
 * guesses — take the earlier), and if neither does, the wall clock falls in a
 * spring-forward gap and the later guess is the requested time shifted forward
 * past it.
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
 * The next instant a schedule trigger fires, strictly after `from`.
 *
 * Returns `null` for threshold and event triggers — they are driven by
 * incoming data, not by the clock, and carry no `nextRunAt`.
 *
 * @param trigger           the talon's trigger, already normalized by `validateTalonInput`
 * @param siteTimezoneIana  IANA zone name for the site (callers pass `'UTC'` when unset)
 * @param from              the instant to search forward from — "now" for an
 *                          edit, the completed run's start for a re-arm
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
  // Calendar anchor: midnight UTC on the site's *local* date. Only ever used
  // for day counting (`+ n * MS_PER_DAY`) and weekday lookup, both of which are
  // DST-free because they never leave the UTC calendar.
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

    // Every slot on a later calendar day is a later instant (a zone never
    // rewinds by a whole day), so the first day with a hit holds the answer.
    if (soonestOnDay !== null) return new Date(soonestOnDay);
  }

  return null;
}
