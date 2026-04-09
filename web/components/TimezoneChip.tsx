'use client';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * Source of a displayed timezone — used to render the explanatory tooltip
 * so the user can understand which timezone setting drives the chip.
 */
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
 * Small "times in [City]" chip used at the top of every dialog/panel that
 * displays or collects times. The chip names the timezone once per surface so
 * times themselves can stay clean (no `14:35 PT` redundancy on every row).
 *
 * Visual is the same as the inline JSX that previously lived in
 * ScheduleEditor — extracted into a shared component so we can reuse it
 * everywhere with consistent styling and tooltip behavior.
 *
 * Hover tooltip explains the source so the user always knows which setting
 * drives this surface's reference frame:
 *   - 'machine' → "this machine's local timezone (America/Los_Angeles)"
 *   - 'user'    → "your preferred timezone (America/Los_Angeles)"
 *   - 'site'    → "site timezone (America/Los_Angeles)"
 *
 * Falls back to "unknown" when `tz` is undefined (e.g. older agents that
 * have not yet deployed the IANA-aware build).
 */
export function TimezoneChip({ tz, source, prefix = 'times in' }: TimezoneChipProps) {
  const display = tz ? tz.replace(/_/g, ' ').split('/').pop() : 'unknown';

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
    <span className="text-muted-foreground text-sm">
      {prefix}{' '}
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-muted/60 border border-border text-foreground text-xs font-medium cursor-help">
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
