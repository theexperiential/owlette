/** @jest-environment node */

/**
 * Unit tests for `computeNextRunAt` (talons wave 1, task 1.1).
 *
 * Every expectation is a hand-computed UTC instant rather than a value derived from the
 * implementation, so a timezone-math regression fails loudly instead of agreeing with
 * itself. DST cases use America/New_York (2026: 03-08 02:00 EST→03:00 EDT, 11-01 02:00
 * EDT→01:00 EST). They must pass whatever the host TZ — precisely the bug the `Intl`-based
 * implementation exists to prevent.
 */

import { computeNextRunAt } from '@/lib/talons/schedule.server';
import type { DayKey, TalonScheduleEntry, TalonTrigger } from '@/lib/talons/types';

const NY = 'America/New_York';

function entry(days: DayKey[], time: string, id = `${days.join('-')}-${time}`): TalonScheduleEntry {
  return { id, days, time };
}

function scheduleOf(...entries: TalonScheduleEntry[]): TalonTrigger {
  return { type: 'schedule', entries };
}

function nextIso(
  trigger: TalonTrigger,
  timezone: string,
  fromIso: string,
): string | undefined {
  return computeNextRunAt(trigger, timezone, new Date(fromIso))?.toISOString();
}

describe('computeNextRunAt — non-schedule triggers', () => {
  it('returns null for a threshold trigger', () => {
    expect(
      computeNextRunAt(
        { type: 'threshold', metric: 'cpu_percent', operator: '>', value: 90 },
        NY,
        new Date('2026-08-10T12:00:00Z'),
      ),
    ).toBeNull();
  });

  it('returns null for an event trigger', () => {
    expect(
      computeNextRunAt(
        { type: 'event', eventTypes: ['process_crash'] },
        NY,
        new Date('2026-08-10T12:00:00Z'),
      ),
    ).toBeNull();
  });
});

describe('computeNextRunAt — interval schedules', () => {
  it('adds the interval to `from`', () => {
    expect(
      nextIso({ type: 'schedule', intervalMinutes: 30 }, NY, '2026-08-10T12:00:00Z'),
    ).toBe('2026-08-10T12:30:00.000Z');
  });

  it('is timezone-independent — the same interval in any zone', () => {
    const trigger: TalonTrigger = { type: 'schedule', intervalMinutes: 1440 };
    expect(nextIso(trigger, NY, '2026-08-10T12:00:00Z')).toBe('2026-08-11T12:00:00.000Z');
    expect(nextIso(trigger, 'UTC', '2026-08-10T12:00:00Z')).toBe('2026-08-11T12:00:00.000Z');
  });
});

describe('computeNextRunAt — fixed clock-time entries', () => {
  // 2026-08-10T12:00:00Z is Monday 08:00 in New York (EDT, UTC-4).
  const MONDAY_0800_NY = '2026-08-10T12:00:00Z';

  it('finds the next matching weekday later in the week', () => {
    // Wednesday 09:30 EDT.
    expect(nextIso(scheduleOf(entry(['wed'], '09:30')), NY, MONDAY_0800_NY)).toBe(
      '2026-08-12T13:30:00.000Z',
    );
  });

  it('fires later the same day when the time is still ahead', () => {
    expect(nextIso(scheduleOf(entry(['mon'], '09:00')), NY, MONDAY_0800_NY)).toBe(
      '2026-08-10T13:00:00.000Z',
    );
  });

  it('wraps to next week when today’s only slot has passed', () => {
    // 2026-08-10T14:00:00Z is Monday 10:00 in New York — 09:00 is behind us.
    expect(nextIso(scheduleOf(entry(['mon'], '09:00')), NY, '2026-08-10T14:00:00Z')).toBe(
      '2026-08-17T13:00:00.000Z',
    );
  });

  it('picks the soonest across several entries', () => {
    expect(
      nextIso(
        scheduleOf(entry(['wed'], '09:30'), entry(['mon'], '09:00'), entry(['fri'], '06:00')),
        NY,
        MONDAY_0800_NY,
      ),
    ).toBe('2026-08-10T13:00:00.000Z');
  });

  it('picks the earlier of two slots on the same day', () => {
    expect(
      nextIso(scheduleOf(entry(['mon'], '23:00'), entry(['mon'], '09:00')), NY, MONDAY_0800_NY),
    ).toBe('2026-08-10T13:00:00.000Z');
  });

  it('is strictly forward-looking — a slot exactly at `from` is skipped', () => {
    expect(
      nextIso(scheduleOf(entry(['mon'], '09:00')), NY, '2026-08-10T13:00:00.000Z'),
    ).toBe('2026-08-17T13:00:00.000Z');
  });

  it('resolves a half-hour-offset zone (Asia/Kolkata, UTC+5:30)', () => {
    // 2026-08-10T12:00:00Z is Monday 17:30 in Kolkata, so 09:00 has passed.
    expect(
      nextIso(scheduleOf(entry(['mon'], '09:00')), 'Asia/Kolkata', MONDAY_0800_NY),
    ).toBe('2026-08-17T03:30:00.000Z');
  });

  it('handles midnight entries', () => {
    expect(nextIso(scheduleOf(entry(['tue'], '00:00')), NY, MONDAY_0800_NY)).toBe(
      '2026-08-11T04:00:00.000Z',
    );
  });

  it('falls back to UTC for a timezone Intl cannot parse', () => {
    // Windows registry names (what `machine_timezone` holds) make Intl throw —
    // the scheduler must degrade to UTC, not crash.
    expect(
      nextIso(scheduleOf(entry(['mon'], '15:00')), 'Eastern Standard Time', MONDAY_0800_NY),
    ).toBe('2026-08-10T15:00:00.000Z');
    expect(nextIso(scheduleOf(entry(['mon'], '15:00')), '', MONDAY_0800_NY)).toBe(
      '2026-08-10T15:00:00.000Z',
    );
  });

  it('returns null when there are no entries', () => {
    expect(nextIso(scheduleOf(), NY, MONDAY_0800_NY)).toBeUndefined();
  });

  it('returns null for an invalid `from`', () => {
    expect(
      computeNextRunAt(scheduleOf(entry(['mon'], '09:00')), NY, new Date('nonsense')),
    ).toBeNull();
  });
});

describe('computeNextRunAt — DST spring forward (2026-03-08, America/New_York)', () => {
  // Local 02:00–02:59 does not exist that Sunday: the clock jumps 02:00 EST →
  // 03:00 EDT.
  const SATURDAY_NOON_NY = '2026-03-07T17:00:00Z';

  it('shifts a nonexistent 02:30 forward past the gap instead of throwing', () => {
    // 07:30Z is 03:30 EDT — 02:30 plus the one-hour gap.
    expect(nextIso(scheduleOf(entry(['sun'], '02:30')), NY, SATURDAY_NOON_NY)).toBe(
      '2026-03-08T07:30:00.000Z',
    );
  });

  it('does not fire twice — the following run is a week later', () => {
    const first = nextIso(scheduleOf(entry(['sun'], '02:30')), NY, SATURDAY_NOON_NY)!;
    // 06:30Z is 02:30 EDT on 2026-03-15 — the entry's normal wall-clock time.
    expect(nextIso(scheduleOf(entry(['sun'], '02:30')), NY, first)).toBe(
      '2026-03-15T06:30:00.000Z',
    );
  });

  it('keeps wall-clock times on either side of the gap correct', () => {
    // 01:30 EST = 06:30Z; 03:30 EDT = 07:30Z.
    expect(nextIso(scheduleOf(entry(['sun'], '01:30')), NY, SATURDAY_NOON_NY)).toBe(
      '2026-03-08T06:30:00.000Z',
    );
    expect(nextIso(scheduleOf(entry(['sun'], '03:30')), NY, SATURDAY_NOON_NY)).toBe(
      '2026-03-08T07:30:00.000Z',
    );
  });

  it('resolves a daily entry across the transition day', () => {
    const daily = scheduleOf(entry(['sat', 'sun', 'mon'], '09:00'));
    // Saturday 09:00 EST = 14:00Z; Sunday 09:00 EDT = 13:00Z (offset changed).
    expect(nextIso(daily, NY, '2026-03-07T05:00:00Z')).toBe('2026-03-07T14:00:00.000Z');
    expect(nextIso(daily, NY, '2026-03-07T14:00:00.000Z')).toBe('2026-03-08T13:00:00.000Z');
  });
});

describe('computeNextRunAt — DST fall back (2026-11-01, America/New_York)', () => {
  // Local 01:00–01:59 happens twice: once at EDT (UTC-4), again at EST (UTC-5).
  const SATURDAY_NOON_NY = '2026-10-31T16:00:00Z';

  it('picks the first occurrence of an ambiguous 01:30', () => {
    // 05:30Z is 01:30 EDT; the repeat is 06:30Z (01:30 EST).
    expect(nextIso(scheduleOf(entry(['sun'], '01:30')), NY, SATURDAY_NOON_NY)).toBe(
      '2026-11-01T05:30:00.000Z',
    );
  });

  it('does not fire again during the repeated hour', () => {
    const first = nextIso(scheduleOf(entry(['sun'], '01:30')), NY, SATURDAY_NOON_NY)!;
    // Next Sunday at 01:30 EST, not 06:30Z the same night.
    expect(nextIso(scheduleOf(entry(['sun'], '01:30')), NY, first)).toBe(
      '2026-11-08T06:30:00.000Z',
    );
  });

  it('keeps a post-transition time on standard offset', () => {
    // 09:00 EST = 14:00Z.
    expect(nextIso(scheduleOf(entry(['sun'], '09:00')), NY, SATURDAY_NOON_NY)).toBe(
      '2026-11-01T14:00:00.000Z',
    );
  });
});
