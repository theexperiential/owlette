'use client';

import { useState, useEffect, useRef } from 'react';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Plus, Minus, Trash2, ChevronUp, ChevronDown, Save, Pencil, X } from 'lucide-react';
import type { ScheduleBlock } from '@/hooks/useFirestore';
import type { SchedulePreset } from '@/hooks/useSchedulePresets';
import { BLOCK_COLORS, BUILT_IN_PRESETS, ensureBlockColors } from '@/lib/scheduleDefaults';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';

const DAY_LABELS = [
  { key: 'mon', label: 'M' },
  { key: 'tue', label: 'T' },
  { key: 'wed', label: 'W' },
  { key: 'thu', label: 'T' },
  { key: 'fri', label: 'F' },
  { key: 'sat', label: 'S' },
  { key: 'sun', label: 'S' },
];

// ─── Time Picker ─────────────────────────────────────────────────────────────

interface TimePickerProps {
  value: string; // "HH:MM" 24-hour format
  onChange: (value: string) => void;
  compact?: boolean;
}

function formatTimeDisplay(value: string, use24h: boolean): string {
  const [h, m] = value.split(':').map(Number);
  if (use24h) {
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
  }
  const ampm = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 || 12;
  return `${h12}:${m.toString().padStart(2, '0')} ${ampm}`;
}

function TimePicker({ value, onChange, compact }: TimePickerProps) {
  const { userPreferences } = useAuth();
  const use24h = (userPreferences.timeFormat || '12h') === '24h';
  const [open, setOpen] = useState(false);
  const [openAbove, setOpenAbove] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const [h, m] = value.split(':').map(Number);
  const hour12 = h % 12 || 12;
  const isPM = h >= 12;

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const handleToggle = () => {
    if (!open && ref.current) {
      const rect = ref.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      setOpenAbove(spaceBelow < 100);
    }
    setOpen(!open);
  };

  const setHour12 = (newH12: number) => {
    const h24 = isPM ? (newH12 === 12 ? 12 : newH12 + 12) : (newH12 === 12 ? 0 : newH12);
    onChange(`${h24.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`);
  };

  const setHour24 = (newH: number) => {
    onChange(`${newH.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`);
  };

  const setMinute = (newM: number) => {
    onChange(`${h.toString().padStart(2, '0')}:${newM.toString().padStart(2, '0')}`);
  };

  const toggleAmPm = () => {
    const newH = isPM ? h - 12 : h + 12;
    onChange(`${newH.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`);
  };

  const btnSize = compact ? 'text-[11px] px-2 py-1' : 'text-xs px-2.5 py-1.5';

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={handleToggle}
        className={`${btnSize} rounded-md border border-border bg-background text-foreground font-medium cursor-pointer hover:bg-muted transition-colors whitespace-nowrap`}
      >
        {formatTimeDisplay(value, use24h)}
      </button>
      {open && (
        <div className={`absolute z-50 bg-card border border-border rounded-lg shadow-lg p-2 flex gap-1 ${openAbove ? 'bottom-full mb-1' : 'top-full mt-1'}`}>
          {/* Hour column */}
          <div className="flex flex-col items-center gap-0.5">
            {use24h ? (
              <>
                <button type="button" onClick={() => setHour24((h + 1) % 24)} className="p-0.5 text-muted-foreground hover:text-foreground cursor-pointer"><ChevronUp className="h-3 w-3" /></button>
                <span className="text-sm font-medium text-foreground w-6 text-center">{h.toString().padStart(2, '0')}</span>
                <button type="button" onClick={() => setHour24((h - 1 + 24) % 24)} className="p-0.5 text-muted-foreground hover:text-foreground cursor-pointer"><ChevronDown className="h-3 w-3" /></button>
              </>
            ) : (
              <>
                <button type="button" onClick={() => setHour12(hour12 >= 12 ? 1 : hour12 + 1)} className="p-0.5 text-muted-foreground hover:text-foreground cursor-pointer"><ChevronUp className="h-3 w-3" /></button>
                <span className="text-sm font-medium text-foreground w-6 text-center">{hour12}</span>
                <button type="button" onClick={() => setHour12(hour12 <= 1 ? 12 : hour12 - 1)} className="p-0.5 text-muted-foreground hover:text-foreground cursor-pointer"><ChevronDown className="h-3 w-3" /></button>
              </>
            )}
          </div>
          <span className="text-sm text-muted-foreground self-center">:</span>
          {/* Minute column */}
          <div className="flex flex-col items-center gap-0.5">
            <button type="button" onClick={() => setMinute((m + 5) % 60)} className="p-0.5 text-muted-foreground hover:text-foreground cursor-pointer"><ChevronUp className="h-3 w-3" /></button>
            <span className="text-sm font-medium text-foreground w-6 text-center">{m.toString().padStart(2, '0')}</span>
            <button type="button" onClick={() => setMinute((m - 5 + 60) % 60)} className="p-0.5 text-muted-foreground hover:text-foreground cursor-pointer"><ChevronDown className="h-3 w-3" /></button>
          </div>
          {/* AM/PM toggle — only in 12h mode */}
          {!use24h && (
            <div className="flex flex-col items-center gap-0.5 ml-1">
              <button type="button" onClick={toggleAmPm} className="p-0.5 text-muted-foreground hover:text-foreground cursor-pointer"><ChevronUp className="h-3 w-3" /></button>
              <span className="text-sm font-medium text-foreground w-6 text-center">{isPM ? 'pm' : 'am'}</span>
              <button type="button" onClick={toggleAmPm} className="p-0.5 text-muted-foreground hover:text-foreground cursor-pointer"><ChevronDown className="h-3 w-3" /></button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Format Summary ──────────────────────────────────────────────────────────

function formatScheduleSummary(schedules: ScheduleBlock[] | null | undefined, timeFormat: '12h' | '24h' = '12h'): string {
  if (!schedules || schedules.length === 0) return 'no schedule configured';
  const use24h = timeFormat === '24h';

  const parts: string[] = [];
  for (const block of schedules) {
    const days = block.days || [];
    const ranges = block.ranges || [];

    // Use block name if available
    if (block.name) {
      parts.push(block.name);
      continue;
    }

    // Smart day grouping
    let dayStr: string;
    const weekdays = ['mon', 'tue', 'wed', 'thu', 'fri'];
    const weekends = ['sat', 'sun'];

    if (days.length === 7 || (days.length === 0)) {
      dayStr = 'daily';
    } else if (JSON.stringify([...days].sort()) === JSON.stringify([...weekdays].sort())) {
      dayStr = 'weekdays';
    } else if (JSON.stringify([...days].sort()) === JSON.stringify([...weekends].sort())) {
      dayStr = 'weekends';
    } else {
      dayStr = days.map(d => d.slice(0, 3)).join(', ');
    }

    const rangeStr = ranges.map(r => {
      const fmt = (t: string) => {
        const [h, m] = t.split(':').map(Number);
        if (use24h) {
          return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
        }
        const ampm = h >= 12 ? 'pm' : 'am';
        const h12 = h % 12 || 12;
        return m === 0 ? `${h12} ${ampm}` : `${h12}:${m.toString().padStart(2, '0')} ${ampm}`;
      };
      return `${fmt(r.start)}\u2013${fmt(r.stop)}`;
    }).join(', ');

    parts.push(`${dayStr} ${rangeStr}`);
  }
  return parts.join(' · ');
}

export { formatScheduleSummary };

// ─── Reusable Schedule Blocks Editor ────────────────────────────────────────
// Used by both the Dialog wrapper below and SchedulePopover

interface ScheduleBlocksEditorProps {
  blocks: ScheduleBlock[];
  onChange: (blocks: ScheduleBlock[]) => void;
  compact?: boolean;
}

/** Get stable color index for a block, using its colorIndex or falling back to position */
function getBlockColorIndex(block: ScheduleBlock, position: number): number {
  return block.colorIndex ?? position;
}

export function ScheduleBlocksEditor({ blocks, onChange, compact }: ScheduleBlocksEditorProps) {
  const updateBlock = (index: number, updated: ScheduleBlock) => {
    const next = [...blocks];
    next[index] = updated;
    onChange(next);
  };

  const addBlock = () => {
    // Find the next unused colorIndex
    const usedColors = new Set(blocks.map(b => b.colorIndex ?? -1));
    let nextColor = 0;
    while (usedColors.has(nextColor)) nextColor++;
    onChange([...blocks, { colorIndex: nextColor, days: ['mon', 'tue', 'wed', 'thu', 'fri'], ranges: [{ start: '09:00', stop: '17:00' }] }]);
  };

  const removeBlock = (index: number) => {
    onChange(blocks.filter((_, i) => i !== index));
  };

  const toggleDay = (blockIndex: number, day: string) => {
    const block = blocks[blockIndex];
    const days = block.days.includes(day)
      ? block.days.filter(d => d !== day)
      : [...block.days, day];
    updateBlock(blockIndex, { ...block, days });
  };

  const updateRange = (blockIndex: number, rangeIndex: number, field: 'start' | 'stop', value: string) => {
    const block = blocks[blockIndex];
    const ranges = [...block.ranges];
    ranges[rangeIndex] = { ...ranges[rangeIndex], [field]: value };
    updateBlock(blockIndex, { ...block, ranges });
  };

  const addRange = (blockIndex: number) => {
    const block = blocks[blockIndex];
    updateBlock(blockIndex, { ...block, ranges: [...block.ranges, { start: '09:00', stop: '17:00' }] });
  };

  const removeRange = (blockIndex: number, rangeIndex: number) => {
    const block = blocks[blockIndex];
    updateBlock(blockIndex, { ...block, ranges: block.ranges.filter((_, i) => i !== rangeIndex) });
  };

  const updateBlockName = (blockIndex: number, name: string) => {
    const block = blocks[blockIndex];
    updateBlock(blockIndex, { ...block, name: name || undefined });
  };

  const pillSize = compact ? 'w-7 h-7 text-[10px]' : 'w-8 h-8 text-xs';

  return (
    <div className="space-y-3">
      {blocks.map((block, blockIndex) => {
        const color = BLOCK_COLORS[getBlockColorIndex(block, blockIndex) % BLOCK_COLORS.length];
        return (
        <div key={blockIndex} className="border border-border rounded-lg p-3 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${color.pill}`} />
              <input
                type="text"
                value={block.name || ''}
                onChange={(e) => updateBlockName(blockIndex, e.target.value)}
                placeholder={`block ${blockIndex + 1}`}
                className="text-xs font-medium bg-background border border-border rounded-md px-2 py-1 text-foreground placeholder:text-muted-foreground/50 w-full min-w-0 outline-none focus:border-muted-foreground transition-colors"
              />
            </div>
            {blocks.length > 1 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => removeBlock(blockIndex)}
                className="h-6 w-6 p-0 text-red-400 hover:text-red-300 hover:bg-red-950/30 cursor-pointer flex-shrink-0"
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            )}
          </div>

          {/* Day pills */}
          <div className="flex gap-1">
            {DAY_LABELS.map((day, i) => {
              const isActive = block.days.includes(day.key);
              return (
                <button
                  key={day.key}
                  type="button"
                  onClick={() => toggleDay(blockIndex, day.key)}
                  className={`${pillSize} rounded-full font-medium transition-colors cursor-pointer ${
                    isActive
                      ? `${color.pill} ${color.pillText}`
                      : 'bg-muted text-muted-foreground hover:bg-muted/80'
                  }`}
                  title={['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'][i]}
                >
                  {day.label}
                </button>
              );
            })}
          </div>

          {/* Time ranges */}
          <div className="space-y-2">
            {block.ranges.map((range, rangeIndex) => (
              <div key={rangeIndex} className="flex items-center gap-2">
                <TimePicker
                  value={range.start}
                  onChange={(v) => updateRange(blockIndex, rangeIndex, 'start', v)}
                  compact={compact}
                />
                <span className="text-muted-foreground text-xs">to</span>
                <TimePicker
                  value={range.stop}
                  onChange={(v) => updateRange(blockIndex, rangeIndex, 'stop', v)}
                  compact={compact}
                />
                {block.ranges.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeRange(blockIndex, rangeIndex)}
                    className="h-6 w-6 rounded-md text-muted-foreground hover:text-red-400 hover:bg-muted transition-colors cursor-pointer flex items-center justify-center flex-shrink-0"
                    title="remove time range"
                  >
                    <Minus className="h-3 w-3" />
                  </button>
                )}
                {/* Add time range button on the last row */}
                {rangeIndex === block.ranges.length - 1 && (
                  <button
                    type="button"
                    onClick={() => addRange(blockIndex)}
                    className="h-6 w-6 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer flex items-center justify-center flex-shrink-0"
                    title="add time range"
                  >
                    <Plus className="h-3 w-3" />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
        );
      })}

      <Button
        variant="outline"
        size="sm"
        onClick={addBlock}
        className="w-full border-dashed border-border text-muted-foreground hover:text-foreground cursor-pointer"
      >
        <Plus className="h-3 w-3 mr-1" />
        add schedule block
      </Button>
    </div>
  );
}

// ─── Dialog Wrapper ─────────────────────────────────────────────────────────

interface ScheduleEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  schedules: ScheduleBlock[] | null;
  initialPresetId?: string | null;
  onChange: (schedules: ScheduleBlock[], presetId: string | null) => void;
  siteTimezone?: string;
  presets?: SchedulePreset[];
  onCreatePreset?: (name: string, blocks: ScheduleBlock[]) => Promise<void>;
  onDeletePreset?: (id: string) => Promise<void>;
  onUpdatePreset?: (id: string, updates: { name?: string; blocks?: ScheduleBlock[] }) => Promise<void>;
}

export default function ScheduleEditor({
  open, onOpenChange, schedules, initialPresetId, onChange, siteTimezone,
  presets, onCreatePreset, onDeletePreset, onUpdatePreset,
}: ScheduleEditorProps) {
  // Always show built-in presets, then append any custom presets from Firestore
  const builtInAsPresets = BUILT_IN_PRESETS.map((bp, i) => ({
    id: `builtin-${i}`, ...bp, isBuiltIn: true, order: i, createdBy: '', createdAt: null as any,
  }));
  const customPresets = (presets || []).filter(p => !p.isBuiltIn);
  const displayPresets = [...builtInAsPresets, ...customPresets];

  // Component remounts each time dialog opens — useState initializers run fresh
  const defaultBlocks: ScheduleBlock[] = [{ colorIndex: 0, days: ['mon', 'tue', 'wed', 'thu', 'fri'], ranges: [{ start: '08:00', stop: '17:00' }] }];
  const initialBlocks = ensureBlockColors(schedules && schedules.length > 0 ? schedules : defaultBlocks);

  // Auto-detect preset if no stored preset ID
  const detectedPresetId = (() => {
    if (initialPresetId) return initialPresetId;
    const blocksKey = JSON.stringify(initialBlocks.map(b => ({ days: [...b.days].sort(), ranges: b.ranges })));
    const match = displayPresets.find(p => {
      const presetKey = JSON.stringify(p.blocks.map((b: ScheduleBlock) => ({ days: [...b.days].sort(), ranges: b.ranges })));
      return blocksKey === presetKey;
    });
    return match?.id ?? null;
  })();

  const [blocks, setBlocks] = useState<ScheduleBlock[]>(initialBlocks);
  const [activePresetId, setActivePresetId] = useState<string | null>(detectedPresetId);
  const [savingPreset, setSavingPreset] = useState(false);
  const [newPresetName, setNewPresetName] = useState('');
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null);
  const [editPresetName, setEditPresetName] = useState('');


  const handleSave = () => {
    const valid = blocks.filter(b => b.days.length > 0 && b.ranges.length > 0);
    onChange(valid, activePresetId);
    onOpenChange(false);
  };

  const applyPreset = (preset: SchedulePreset) => {
    setBlocks(ensureBlockColors(preset.blocks.map(b => ({ ...b, days: [...b.days], ranges: b.ranges.map(r => ({ ...r })) }))));
    setActivePresetId(preset.id);
  };

  const handleCreatePreset = async () => {
    if (!onCreatePreset) return;
    if (!newPresetName.trim()) {
      toast.error('please enter a name for the preset');
      return;
    }
    const valid = blocks.filter(b => b.days.length > 0 && b.ranges.length > 0);
    await onCreatePreset(newPresetName.trim(), valid);
    setNewPresetName('');
    setSavingPreset(false);
  };

  const handleRenamePreset = async () => {
    if (!editingPresetId || !editPresetName.trim() || !onUpdatePreset) return;
    await onUpdatePreset(editingPresetId, { name: editPresetName.trim() });
    setEditingPresetId(null);
    setEditPresetName('');
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg bg-card border-border text-foreground">
        <DialogHeader>
          <DialogTitle>configure schedule</DialogTitle>
          {siteTimezone && (
            <DialogDescription className="text-muted-foreground text-xs">
              times in {siteTimezone.replace(/_/g, ' ').split('/').pop()}
            </DialogDescription>
          )}
        </DialogHeader>

        {/* Preset bar */}
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {displayPresets.map((preset) => {
              const isActive = activePresetId === preset.id;
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => applyPreset(preset)}
                  className={`px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors cursor-pointer ${
                    isActive
                      ? 'bg-blue-600 text-white'
                      : 'bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground'
                  }`}
                >
                  {preset.name}
                </button>
              );
            })}
            {/* New preset */}
            {onCreatePreset && !savingPreset && (
              <button
                type="button"
                onClick={() => setSavingPreset(true)}
                className="px-2 py-1 rounded-full text-[11px] text-muted-foreground hover:text-foreground border border-dashed border-border hover:border-muted-foreground transition-colors cursor-pointer"
              >
                <Plus className="h-3 w-3 inline mr-0.5" />
                new preset
              </button>
            )}
          </div>
          {/* Rename/delete row for selected custom preset */}
          {(() => {
            const selectedPreset = activePresetId ? displayPresets.find(p => p.id === activePresetId) : null;
            if (editingPresetId) {
              return (
                <form onSubmit={(e) => { e.preventDefault(); handleRenamePreset(); }} className="flex items-center gap-1.5">
                  <Input
                    value={editPresetName}
                    onChange={(e) => setEditPresetName(e.target.value)}
                    className="h-7 w-28 text-[11px] px-2 bg-background border-border"
                    autoFocus
                  />
                  <button type="submit" className="p-1 text-muted-foreground hover:text-foreground cursor-pointer" title="save"><Save className="h-3.5 w-3.5" /></button>
                  <button type="button" onClick={() => setEditingPresetId(null)} className="p-1 text-muted-foreground hover:text-foreground cursor-pointer" title="cancel"><X className="h-3.5 w-3.5" /></button>
                </form>
              );
            }
            if (savingPreset && onCreatePreset) {
              return (
                <form onSubmit={(e) => { e.preventDefault(); handleCreatePreset(); }} className="flex items-center gap-1.5">
                  <Input
                    value={newPresetName}
                    onChange={(e) => setNewPresetName(e.target.value)}
                    placeholder="preset name"
                    className="h-7 w-28 text-[11px] px-2 bg-background border-border"
                    autoFocus
                  />
                  <button type="submit" className="p-1 text-muted-foreground hover:text-foreground cursor-pointer" title="save preset"><Save className="h-3.5 w-3.5" /></button>
                  <button type="button" onClick={() => { setSavingPreset(false); setNewPresetName(''); }} className="p-1 text-muted-foreground hover:text-foreground cursor-pointer" title="cancel"><X className="h-3.5 w-3.5" /></button>
                </form>
              );
            }
            if (selectedPreset && !selectedPreset.isBuiltIn && onDeletePreset && onUpdatePreset) {
              // Check if current blocks differ from the preset's stored blocks
              const currentKey = JSON.stringify(blocks.map(b => ({ days: [...b.days].sort(), ranges: b.ranges })));
              const presetKey = JSON.stringify(selectedPreset.blocks.map((b: ScheduleBlock) => ({ days: [...b.days].sort(), ranges: b.ranges })));
              const hasChanges = currentKey !== presetKey;

              return (
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  {hasChanges && (
                    <button
                      type="button"
                      onClick={() => {
                        const valid = blocks.filter(b => b.days.length > 0 && b.ranges.length > 0);
                        onUpdatePreset(selectedPreset.id, { blocks: valid });
                      }}
                      className="flex items-center gap-1 text-accent-cyan hover:text-accent-cyan-hover cursor-pointer transition-colors"
                    >
                      <Save className="h-3 w-3" />
                      update preset
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => { setEditingPresetId(selectedPreset.id); setEditPresetName(selectedPreset.name); }}
                    className="flex items-center gap-1 hover:text-foreground cursor-pointer transition-colors"
                  >
                    <Pencil className="h-3 w-3" />
                    rename
                  </button>
                  <button
                    type="button"
                    onClick={() => onDeletePreset(selectedPreset.id)}
                    className="flex items-center gap-1 hover:text-red-400 cursor-pointer transition-colors"
                  >
                    <Trash2 className="h-3 w-3" />
                    delete
                  </button>
                </div>
              );
            }
            return null;
          })()}
        </div>

        <div className="max-h-[60vh] overflow-y-auto pr-1">
          <ScheduleBlocksEditor blocks={blocks} onChange={setBlocks} />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} className="cursor-pointer">
            cancel
          </Button>
          <Button onClick={handleSave} className="bg-accent-cyan hover:bg-accent-cyan-hover text-gray-900 cursor-pointer">
            save schedule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
