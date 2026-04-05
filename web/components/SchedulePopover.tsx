'use client';

import { useState, useEffect, useCallback } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { ScheduleBlocksEditor } from '@/components/ScheduleEditor';
import WeekSummaryBar from '@/components/WeekSummaryBar';
import type { ScheduleBlock } from '@/hooks/useFirestore';
import type { SchedulePreset } from '@/hooks/useSchedulePresets';
import { BUILT_IN_PRESETS, ensureBlockColors } from '@/lib/scheduleDefaults';

interface SchedulePopoverProps {
  schedules: ScheduleBlock[] | null | undefined;
  onApply: (schedules: ScheduleBlock[]) => void;
  presets?: SchedulePreset[];
  children: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  siteTimezone?: string;
}

export default function SchedulePopover({
  schedules,
  onApply,
  presets,
  children,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  siteTimezone,
}: SchedulePopoverProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;
  const setOpen = isControlled ? (controlledOnOpenChange ?? setInternalOpen) : setInternalOpen;

  // Track if popover has ever been opened — defer portal creation until first use
  const [hasOpened, setHasOpened] = useState(false);
  const [blocks, setBlocks] = useState<ScheduleBlock[]>([]);

  useEffect(() => {
    if (open) {
      setHasOpened(true);
      // Reset blocks from props each time popover opens
      if (schedules && schedules.length > 0) {
        setBlocks(ensureBlockColors(schedules));
      } else {
        setBlocks(ensureBlockColors([{ colorIndex: 0, days: ['mon', 'tue', 'wed', 'thu', 'fri'], ranges: [{ start: '09:00', stop: '17:00' }] }]));
      }
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleApply = useCallback(() => {
    const valid = blocks.filter(b => b.days.length > 0 && b.ranges.length > 0);
    onApply(valid.length > 0 ? valid : blocks);
    setOpen(false);
  }, [blocks, onApply, setOpen]);

  const applyPreset = useCallback((preset: { blocks: ScheduleBlock[] }) => {
    setBlocks(preset.blocks.map(b => ({ ...b, days: [...b.days], ranges: b.ranges.map(r => ({ ...r })) })));
  }, []);

  // Use presets from hook (already includes built-ins merged client-side),
  // fall back to hardcoded defaults if no presets prop provided
  const displayPresets = (presets && presets.length > 0)
    ? presets
    : BUILT_IN_PRESETS.map((bp, i) => ({
        id: `builtin-${i}`, ...bp, isBuiltIn: true, order: i, createdBy: '', createdAt: null as any,
      }));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {children}
      </PopoverTrigger>
      {/* Defer portal creation until first open — avoids mounting N portals for N processes */}
      {hasOpened && (
        <PopoverContent
          align="end"
          sideOffset={8}
          className="w-[380px] bg-card border-border text-foreground p-4"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Visual summary — enlarged, no text */}
          <div className="flex justify-center mb-3">
            <WeekSummaryBar schedules={blocks} tall />
          </div>

          {/* Preset pills + Custom */}
          <div className="flex flex-wrap gap-1.5 mb-3">
            {displayPresets.map((preset) => {
              const isMatch = JSON.stringify(blocks) === JSON.stringify(preset.blocks);
              return (
                <button
                  key={preset.id ?? preset.name}
                  type="button"
                  onClick={() => applyPreset(preset)}
                  className={`px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors cursor-pointer ${
                    isMatch
                      ? 'bg-blue-600 text-white'
                      : 'bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground'
                  }`}
                >
                  {preset.name}
                </button>
              );
            })}
            {(() => {
              const matchesAnyPreset = displayPresets.some(
                (p) => JSON.stringify(blocks) === JSON.stringify(p.blocks)
              );
              return (
                <span
                  className={`px-2.5 py-1 rounded-full text-[11px] font-medium ${
                    !matchesAnyPreset
                      ? 'bg-blue-600 text-white'
                      : 'bg-muted text-muted-foreground'
                  }`}
                >
                  custom
                </span>
              );
            })()}
          </div>

          {/* Schedule blocks editor */}
          <div className="max-h-[300px] overflow-y-auto pr-1 mb-3">
            <ScheduleBlocksEditor blocks={blocks} onChange={setBlocks} compact />
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between pt-2 border-t border-border">
            {siteTimezone ? (
              <span className="text-[10px] text-muted-foreground">
                times in {siteTimezone.replace(/_/g, ' ').split('/').pop()}
              </span>
            ) : <span />}
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setOpen(false)}
                className="cursor-pointer text-xs"
              >
                cancel
              </Button>
              <Button
                size="sm"
                onClick={handleApply}
                className="bg-accent-cyan hover:bg-accent-cyan-hover text-gray-900 cursor-pointer text-xs"
              >
                apply schedule
              </Button>
            </div>
          </div>
        </PopoverContent>
      )}
    </Popover>
  );
}
