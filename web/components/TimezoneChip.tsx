'use client';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/** Which setting drives the chip; renders the explanatory tooltip. */
export type TimezoneChipSource = 'machine' | 'user' | 'site';

interface TimezoneChipProps {
  /** IANA timezone name (e.g. "America/Los_Angeles") or undefined if unknown. */
  tz: string | undefined;
  /** Where the tz value came from — drives the tooltip text. */
  source: TimezoneChipSource;
  /** Optional prefix word ("times in", "history in", etc). Default "times in". */
  prefix?: string;
}

/**
 * "times in [TZ]" chip at the top of any surface that shows or collects times,
 * so individual rows stay clean (no `14:35 PT` on every line).
 *
 * Renders the ABBREVIATION via `Intl.DateTimeFormat`, not the IANA city
 * segment: abbreviations are observance-aware (PDT in summer, PST in winter),
 * and zones without one fall back to a clear `GMT±N`.
 *
 * The tooltip carries the full IANA name plus which setting
 * (machine / user / site) drives this surface. "unknown" when `tz` is
 * undefined — e.g. agents predating the IANA-aware build.
 */
export function tzAbbreviation(tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'short',
    }).formatToParts(new Date());
    const abbr = parts.find((p) => p.type === 'timeZoneName')?.value;
    if (abbr) return abbr;
  } catch {
    /* invalid IANA name — fall through to city segment */
  }
  return tz.replace(/_/g, ' ').split('/').pop() ?? tz;
}

export function TimezoneChip({ tz, source, prefix = 'times in' }: TimezoneChipProps) {
  const display = tz ? tzAbbreviation(tz) : 'unknown';

  const tooltipText = (() => {
    if (!tz) {
      return "this machine has not reported its timezone yet (older agent build, or first heartbeat hasn't arrived). times below are interpreted as the machine's local clock.";
    }
    switch (source) {
      case 'machine':
        return `this machine's local timezone (${tz})`;
      case 'user':
        return `your preferred timezone (${tz}). change in settings → preferences.`;
      case 'site':
        return `site timezone (${tz})`;
    }
  })();

  return (
    <span className="text-muted-foreground text-xs">
      {prefix}{' '}
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex items-center px-1.5 py-0.5 rounded-md bg-muted/60 border border-border text-foreground text-[11px] font-medium cursor-help">
            {display}
          </span>
        </TooltipTrigger>
        <TooltipContent>
          <p className="max-w-xs">{tooltipText}</p>
        </TooltipContent>
      </Tooltip>
    </span>
  );
}
