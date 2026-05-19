'use client';

import { useState, useCallback } from 'react';
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
  const rawSetOpen = isControlled ? (controlledOnOpenChange ?? setInternalOpen) : setInternalOpen;

  // `openInstance` bumps each time the popover is opened. PopoverContent
  // mounts only after the first open (deferred portal creation — avoids N
  // portals for N processes on a page) and is re-keyed each subsequent open,
  // so its internal `blocks` state re-seeds from the current `schedules`
  // prop via useState's lazy initializer. This replaces a sync setState-in-
  // effect reset and keeps the dialog-reset-on-open behavior.
  const [openInstance, setOpenInstance] = useState(0);
  const setOpen = useCallback((next: boolean) => {
    if (next) setOpenInstance((n) => n + 1);
    rawSetOpen(next);
  }, [rawSetOpen]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {children}
      </PopoverTrigger>
      {openInstance > 0 && (
        <PopoverContent
          align="end"
          sideOffset={8}
          className="w-[380px] bg-card border-border text-foreground p-4"
          onClick={(e) => e.stopPropagation()}
        >
          <SchedulePopoverBody
            key={openInstance}
            schedules={schedules}
            presets={presets}
            siteTimezone={siteTimezone}
            onApply={onApply}
            onCancel={() => setOpen(false)}
          />
        </PopoverContent>
      )}
    </Popover>
  );
}

interface SchedulePopoverBodyProps {
  schedules: ScheduleBlock[] | null | undefined;
  presets?: SchedulePreset[];
  siteTimezone?: string;
  onApply: (schedules: ScheduleBlock[]) => void;
  onCancel: () => void;
}

function SchedulePopoverBody({
  schedules,
  presets,
  siteTimezone,
  onApply,
  onCancel,
}: SchedulePopoverBodyProps) {
  // Seed blocks from the current `schedules` prop — mounts fresh each time
  // the popover opens, so this initializer runs once per open.
  const [blocks, setBlocks] = useState<ScheduleBlock[]>(() =>
    schedules && schedules.length > 0
      ? ensureBlockColors(schedules)
      : ensureBlockColors([
          { colorIndex: 0, days: ['mon', 'tue', 'wed', 'thu', 'fri'], ranges: [{ start: '09:00', stop: '17:00' }] },
        ])
  );

  const handleApply = useCallback(() => {
    const valid = blocks.filter(b => b.days.length > 0 && b.ranges.length > 0);
    onApply(valid.length > 0 ? valid : blocks);
    onCancel();
  }, [blocks, onApply, onCancel]);

  const applyPreset = useCallback((preset: { blocks: ScheduleBlock[] }) => {
    setBlocks(preset.blocks.map(b => ({ ...b, days: [...b.days], ranges: b.ranges.map(r => ({ ...r })) })));
  }, []);

  // Use presets from hook (already includes built-ins merged client-side),
  // fall back to hardcoded defaults if no presets prop provided
  const displayPresets = (presets && presets.length > 0)
    ? presets
    : BUILT_IN_PRESETS.map((bp, i) => ({
        id: `builtin-${i}`, ...bp, isBuiltIn: true, order: i, createdBy: '', createdAt: null,
      }));

  const matchesAnyPreset = displayPresets.some(
    (p) => JSON.stringify(blocks) === JSON.stringify(p.blocks),
  );

  return (
    <>
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
              className={`px-2.5 py-1 rounded-full text-[13px] font-medium transition-colors duration-150 cursor-pointer ${
                isMatch
                  ? 'bg-blue-600/20 text-blue-100 ring-1 ring-blue-500/40'
                  : 'bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground'
              }`}
            >
              {preset.name}
            </button>
          );
        })}
        <span
          className={`px-2.5 py-1 rounded-full text-[13px] font-medium ${
            !matchesAnyPreset
              ? 'bg-blue-600/20 text-blue-100 ring-1 ring-blue-500/40'
              : 'bg-muted text-muted-foreground'
          }`}
        >
          custom
        </span>
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
            variant="ghost"
            size="sm"
            onClick={onCancel}
            className="bg-secondary border border-border cursor-pointer text-xs"
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
    </>
  );
}
