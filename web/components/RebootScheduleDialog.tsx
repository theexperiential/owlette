'use client';

import { useState, useEffect, useMemo } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useMachines } from '@/hooks/useFirestore';
import { useRebootPresets, type RebootPreset } from '@/hooks/useRebootPresets';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Plus, X, Save, Pencil, Trash2, Users } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from 'sonner';
import DayPillSelector from '@/components/DayPillSelector';
import { TimePicker } from '@/components/ScheduleEditor';
import ApplyScheduleToMachinesDialog from '@/components/ApplyScheduleToMachinesDialog';
import { TimezoneChip } from '@/components/TimezoneChip';
import type { RebootSchedule, RebootScheduleEntry } from '@/hooks/useFirestore';

interface RebootScheduleDialogProps {
  siteId: string;
  machineId: string;
  machineName: string;
  /** IANA timezone (e.g. "America/Los_Angeles") for THIS machine. Used by
   * the chip and the "next at" preview. Undefined if the agent has not yet
   * deployed the IANA-aware build, in which case the preview falls back
   * to the browser's local time and the chip shows "unknown". */
  machineTimezone?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentSchedule?: RebootSchedule;
}

/** Generate a stable ID for a new reboot entry. */
function newEntryId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `entry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Compute the next scheduled reboot across all entries for the preview line.
 *
 * The returned text is from the perspective of the MACHINE'S local timezone —
 * a "14:00" entry on a Tokyo kiosk reads "today at 14:00" (or "tomorrow at
 * 14:00") regardless of where in the world the user editing the schedule
 * happens to be sitting. This matches what the agent actually does at
 * fire-time (resolves entries against machine local tz).
 *
 * If `machineTimezone` is undefined (older agent that hasn't reported its IANA
 * timezone yet), falls back to the browser's local time so the dialog still
 * works — but the per-machine label rendered next to this dialog will say
 * "unknown" so the user knows the preview may not match what the agent will
 * actually do.
 */
function getNextScheduledReboot(
  enabled: boolean,
  entries: RebootScheduleEntry[],
  timeFormat: '12h' | '24h' = '12h',
  machineTimezone?: string
): string {
  if (!enabled || entries.length === 0) return 'none';

  // Get the current wall-clock components in the machine's timezone.
  // Intl.DateTimeFormat with timeZone is the only browser-native way to ask
  // "what is the date/time in IANA zone X right now?" — Date.setHours() etc.
  // operate in the BROWSER's local zone, which is exactly the bug we're fixing.
  const tz = machineTimezone || undefined; // undefined → browser local
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  });
  const parts = fmt.formatToParts(new Date());
  const get = (type: string) => parts.find(p => p.type === type)?.value || '';
  const machineNowHour = parseInt(get('hour'), 10);
  const machineNowMinute = parseInt(get('minute'), 10);
  // weekday in en-US 'short' is 'Sun', 'Mon', etc — normalize to lowercase 3-letter
  const weekdayShort = get('weekday').toLowerCase().slice(0, 3);
  const dayNameOrder = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const machineNowDayIdx = dayNameOrder.indexOf(weekdayShort);

  // Walk forward day-by-day in the machine's local calendar, checking each
  // entry. We work entirely in (year, month, day, hour, minute) tuples to
  // avoid any browser-tz ambiguity.
  type Slot = { dayOffset: number; hour: number; minute: number; dayName: string };
  const upcoming: Slot[] = [];
  for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
    const slotDayIdx = (machineNowDayIdx + dayOffset) % 7;
    const slotDayName = dayNameOrder[slotDayIdx];
    for (const entry of entries) {
      if (!entry.days.includes(slotDayName)) continue;
      const [h, m] = entry.time.split(':').map(Number);
      if (Number.isNaN(h) || Number.isNaN(m)) continue;
      // Is this slot in the future relative to machine "now"?
      const isFuture =
        dayOffset > 0 ||
        h > machineNowHour ||
        (h === machineNowHour && m > machineNowMinute);
      if (!isFuture) continue;
      upcoming.push({ dayOffset, hour: h, minute: m, dayName: slotDayName });
    }
  }
  if (upcoming.length === 0) return 'none';

  // Pick the earliest upcoming slot (smallest dayOffset, then smallest time).
  upcoming.sort((a, b) => {
    if (a.dayOffset !== b.dayOffset) return a.dayOffset - b.dayOffset;
    if (a.hour !== b.hour) return a.hour - b.hour;
    return a.minute - b.minute;
  });
  const next = upcoming[0];

  // Format the time in the user's preferred 12h/24h. The TZ doesn't change
  // the rendered HH:MM here because we already extracted it as raw integers
  // in the machine's timezone above.
  const timeStr = (() => {
    if (timeFormat === '24h') {
      return `${next.hour.toString().padStart(2, '0')}:${next.minute.toString().padStart(2, '0')}`;
    }
    const ampm = next.hour >= 12 ? 'pm' : 'am';
    const h12 = next.hour % 12 || 12;
    return `${h12}:${next.minute.toString().padStart(2, '0')} ${ampm}`;
  })();

  const dayLongNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  if (next.dayOffset === 0) return `today at ${timeStr}`;
  if (next.dayOffset === 1) return `tomorrow at ${timeStr}`;
  const slotDayLong = dayLongNames[dayNameOrder.indexOf(next.dayName)];
  return `${slotDayLong} at ${timeStr}`;
}

/** Stable JSON key for entries — used to detect "is current state == preset state?" */
function entriesKey(entries: RebootScheduleEntry[]): string {
  return JSON.stringify(
    entries.map(e => ({ days: [...e.days].sort(), time: e.time }))
  );
}

export default function RebootScheduleDialog({
  siteId,
  machineId,
  machineName,
  machineTimezone,
  open,
  onOpenChange,
  currentSchedule,
}: RebootScheduleDialogProps) {
  const { userPreferences } = useAuth();
  const { updateRebootSchedule } = useMachines(siteId);
  const { presets, createPreset, updatePreset, deletePreset } = useRebootPresets(siteId);

  const [enabled, setEnabled] = useState(false);
  const [entries, setEntries] = useState<RebootScheduleEntry[]>([]);
  const [saving, setSaving] = useState(false);
  const [activePresetId, setActivePresetId] = useState<string | null>(null);
  const [savingNewPreset, setSavingNewPreset] = useState(false);
  const [newPresetName, setNewPresetName] = useState('');
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null);
  const [editPresetName, setEditPresetName] = useState('');
  const [confirmDeletePresetId, setConfirmDeletePresetId] = useState<string | null>(null);
  const [pendingReplacePreset, setPendingReplacePreset] = useState<RebootPreset | null>(null);
  const [showApplyToMachines, setShowApplyToMachines] = useState(false);

  // Initialize from currentSchedule when dialog opens
  useEffect(() => {
    if (!open) return;
    if (currentSchedule) {
      setEnabled(currentSchedule.enabled ?? false);
      setEntries(
        (currentSchedule.entries ?? []).map(e => ({
          id: e.id || newEntryId(),
          days: e.days || [],
          time: e.time || '03:00',
        }))
      );
    } else {
      setEnabled(false);
      setEntries([]);
    }
    setActivePresetId(null);
    setSavingNewPreset(false);
    setNewPresetName('');
    setEditingPresetId(null);
    setConfirmDeletePresetId(null);
    setPendingReplacePreset(null);
  }, [open, currentSchedule]);

  // Auto-detect which preset matches the current state (if any)
  useEffect(() => {
    if (!open) return;
    const key = entriesKey(entries);
    const match = presets.find(p => entriesKey(p.entries) === key);
    setActivePresetId(match?.id ?? null);
  }, [open, entries, presets]);

  const nextReboot = useMemo(
    () => getNextScheduledReboot(enabled, entries, userPreferences.timeFormat || '12h', machineTimezone),
    [enabled, entries, userPreferences.timeFormat, machineTimezone]
  );

  const addEntry = () => {
    setEntries(prev => [
      ...prev,
      { id: newEntryId(), days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], time: '03:00' },
    ]);
  };

  const removeEntry = (id: string) => {
    setEntries(prev => prev.filter(e => e.id !== id));
  };

  const updateEntry = (id: string, patch: Partial<RebootScheduleEntry>) => {
    setEntries(prev => prev.map(e => (e.id === id ? { ...e, ...patch } : e)));
  };

  const applyPreset = (preset: RebootPreset) => {
    // Clone entries with fresh IDs so the per-machine state doesn't share IDs across machines
    setEntries(
      preset.entries.map(e => ({
        id: newEntryId(),
        days: [...e.days],
        time: e.time,
      }))
    );
    setActivePresetId(preset.id);
  };

  const handleCreatePreset = async () => {
    if (!newPresetName.trim()) {
      toast.error('please enter a name for the preset');
      return;
    }
    const validEntries = entries.filter(e => e.days.length > 0);
    if (validEntries.length === 0) {
      toast.error('add at least one reboot entry first');
      return;
    }

    // Check for name collision (case-insensitive). If found, defer to the
    // replace-confirm flow rather than silently creating a duplicate.
    const trimmedName = newPresetName.trim();
    const existing = presets.find(p => p.name.toLowerCase() === trimmedName.toLowerCase());
    if (existing) {
      setPendingReplacePreset(existing);
      return;
    }

    try {
      await createPreset({
        name: trimmedName,
        entries: validEntries,
        isBuiltIn: false,
        order: 100,
        createdBy: '',
      });
      toast.success('preset saved');
      setNewPresetName('');
      setSavingNewPreset(false);
    } catch (err: any) {
      toast.error('failed to save preset', { description: err.message });
    }
  };

  const handleConfirmReplace = async () => {
    if (!pendingReplacePreset) return;
    const validEntries = entries.filter(e => e.days.length > 0);
    try {
      await updatePreset(pendingReplacePreset.id, { entries: validEntries });
      toast.success(`preset "${pendingReplacePreset.name}" replaced`);
      setPendingReplacePreset(null);
      setNewPresetName('');
      setSavingNewPreset(false);
      setActivePresetId(pendingReplacePreset.id);
    } catch (err: any) {
      toast.error('failed to replace preset', { description: err.message });
    }
  };

  const handleRenamePreset = async () => {
    if (!editingPresetId || !editPresetName.trim()) return;
    try {
      await updatePreset(editingPresetId, { name: editPresetName.trim() });
      setEditingPresetId(null);
      setEditPresetName('');
    } catch (err: any) {
      toast.error('failed to rename preset', { description: err.message });
    }
  };

  const handleSave = async () => {
    if (enabled) {
      // Validate: all entries must have at least one day selected
      const invalid = entries.find(e => e.days.length === 0);
      if (invalid) {
        toast.error('every reboot entry needs at least one day');
        return;
      }
    }

    setSaving(true);
    try {
      await updateRebootSchedule(machineId, { enabled, entries });
      toast.success('reboot schedule saved');
      onOpenChange(false);
    } catch (error: any) {
      toast.error('failed to save reboot schedule', {
        description: error.message,
      });
    } finally {
      setSaving(false);
    }
  };

  const selectedPreset = activePresetId ? presets.find(p => p.id === activePresetId) : null;
  const presetIsModified = selectedPreset && entriesKey(selectedPreset.entries) !== entriesKey(entries);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="bg-card border-border sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>reboot schedule — {machineName}</DialogTitle>
            <DialogDescription className="text-muted-foreground text-pretty">
              automatically reboot this machine on a recurring schedule.
              the machine must have been up for at least 30 minutes.
            </DialogDescription>
            <div className="pt-1">
              <TimezoneChip tz={machineTimezone} source="machine" />
            </div>
          </DialogHeader>

          <div className="space-y-5 py-2">
            {/* Preset bar */}
            <div className="space-y-2">
              <Label className="text-sm text-muted-foreground">presets</Label>
              <div className="flex flex-wrap items-center gap-1.5">
                {presets.map(preset => {
                  const isActive = activePresetId === preset.id;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => applyPreset(preset)}
                      className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors cursor-pointer ${
                        isActive
                          ? 'bg-cyan-600 text-white'
                          : 'bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground'
                      }`}
                    >
                      {preset.name}
                    </button>
                  );
                })}
                {!savingNewPreset && (
                  <button
                    type="button"
                    onClick={() => setSavingNewPreset(true)}
                    className="px-3 py-1.5 rounded-full text-sm text-muted-foreground hover:text-foreground border border-dashed border-border hover:border-muted-foreground transition-colors cursor-pointer"
                  >
                    <Plus className="h-3.5 w-3.5 inline mr-1" />
                    new preset
                  </button>
                )}
              </div>

              {/* Preset action row (rename/delete/save inline) */}
              {savingNewPreset && !pendingReplacePreset && (
                <form onSubmit={(e) => { e.preventDefault(); handleCreatePreset(); }} className="flex items-center gap-1.5">
                  <Input
                    value={newPresetName}
                    onChange={(e) => setNewPresetName(e.target.value)}
                    placeholder="preset name"
                    className="h-7 w-32 text-[11px] px-2 bg-background border-border"
                    autoFocus
                  />
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button type="submit" className="p-1 text-muted-foreground hover:text-foreground cursor-pointer">
                        <Save className="h-3.5 w-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>save preset</p>
                    </TooltipContent>
                  </Tooltip>
                  <button
                    type="button"
                    onClick={() => { setSavingNewPreset(false); setNewPresetName(''); }}
                    className="p-1 text-muted-foreground hover:text-foreground cursor-pointer"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </form>
              )}

              {/* Inline replace-confirm — preset with this name already exists */}
              {pendingReplacePreset && (
                <div className="flex flex-wrap items-center gap-2 text-[11px]">
                  <span className="text-muted-foreground">
                    preset &ldquo;{pendingReplacePreset.name}&rdquo; already exists. replace it?
                  </span>
                  <button
                    type="button"
                    onClick={handleConfirmReplace}
                    className="flex items-center gap-1 px-2 py-0.5 rounded bg-cyan-600/20 text-cyan-300 hover:bg-cyan-600/40 hover:text-cyan-200 cursor-pointer transition-colors font-medium"
                  >
                    <Save className="h-3 w-3" /> yes, replace
                  </button>
                  <button
                    type="button"
                    onClick={() => setPendingReplacePreset(null)}
                    className="px-2 py-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted cursor-pointer transition-colors"
                  >
                    cancel
                  </button>
                </div>
              )}

              {editingPresetId && (
                <form onSubmit={(e) => { e.preventDefault(); handleRenamePreset(); }} className="flex items-center gap-1.5">
                  <Input
                    value={editPresetName}
                    onChange={(e) => setEditPresetName(e.target.value)}
                    className="h-7 w-32 text-[11px] px-2 bg-background border-border"
                    autoFocus
                  />
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button type="submit" className="p-1 text-muted-foreground hover:text-foreground cursor-pointer">
                        <Save className="h-3.5 w-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>save</p>
                    </TooltipContent>
                  </Tooltip>
                  <button
                    type="button"
                    onClick={() => setEditingPresetId(null)}
                    className="p-1 text-muted-foreground hover:text-foreground cursor-pointer"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </form>
              )}

              {selectedPreset && !selectedPreset.isBuiltIn && !editingPresetId && !savingNewPreset && confirmDeletePresetId !== selectedPreset.id && (
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  {presetIsModified && (
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await updatePreset(selectedPreset.id, { entries });
                          toast.success('preset updated');
                        } catch (err: any) {
                          toast.error('failed to update preset', { description: err.message });
                        }
                      }}
                      className="flex items-center gap-1 text-cyan-400 hover:text-cyan-300 cursor-pointer transition-colors"
                    >
                      <Save className="h-3 w-3" /> update preset
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => { setEditingPresetId(selectedPreset.id); setEditPresetName(selectedPreset.name); }}
                    className="flex items-center gap-1 hover:text-foreground cursor-pointer transition-colors"
                  >
                    <Pencil className="h-3 w-3" /> rename
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDeletePresetId(selectedPreset.id)}
                    className="flex items-center gap-1 hover:text-red-400 cursor-pointer transition-colors"
                  >
                    <Trash2 className="h-3 w-3" /> delete
                  </button>
                </div>
              )}

              {/* Inline two-step delete confirmation — destructive actions need a deliberate second click. */}
              {selectedPreset && confirmDeletePresetId === selectedPreset.id && (
                <div className="flex items-center gap-2 text-[11px]">
                  <span className="text-muted-foreground">delete preset &ldquo;{selectedPreset.name}&rdquo;?</span>
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        await deletePreset(selectedPreset.id);
                        setConfirmDeletePresetId(null);
                        setActivePresetId(null);
                        toast.success('preset deleted');
                      } catch (err: any) {
                        toast.error('failed to delete preset', { description: err.message });
                      }
                    }}
                    className="flex items-center gap-1 px-2 py-0.5 rounded bg-red-600/20 text-red-400 hover:bg-red-600/40 hover:text-red-300 cursor-pointer transition-colors font-medium"
                  >
                    <Trash2 className="h-3 w-3" /> yes, delete
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDeletePresetId(null)}
                    className="px-2 py-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted cursor-pointer transition-colors"
                  >
                    cancel
                  </button>
                </div>
              )}
            </div>

            {/* Enable toggle */}
            <div className="flex items-center justify-between">
              <Label htmlFor="reboot-enabled" className="text-sm">
                enable scheduled reboots
              </Label>
              <Switch
                id="reboot-enabled"
                checked={enabled}
                onCheckedChange={setEnabled}
              />
            </div>

            {/* Entry list */}
            <div className={`space-y-2 ${enabled ? '' : 'opacity-50 pointer-events-none'}`}>
              {entries.length === 0 && (
                <div className="text-xs text-muted-foreground italic px-1 py-3 text-center">
                  no reboots scheduled
                </div>
              )}
              {entries.map((entry) => (
                <div
                  key={entry.id}
                  className="border border-border rounded-md p-3 flex flex-wrap items-center gap-x-3 gap-y-2"
                >
                  <DayPillSelector
                    value={entry.days}
                    onChange={(days) => updateEntry(entry.id, { days })}
                    variant="rect"
                  />
                  {/* Time + delete grouped together so they wrap as a unit, never split. */}
                  <div className="flex items-center gap-2 ml-auto">
                    <TimePicker
                      value={entry.time}
                      onChange={(time) => updateEntry(entry.id, { time })}
                    />
                    <button
                      type="button"
                      onClick={() => removeEntry(entry.id)}
                      className="h-6 w-6 rounded-md text-muted-foreground hover:text-red-400 hover:bg-muted transition-colors cursor-pointer flex items-center justify-center flex-shrink-0"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))}

              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addEntry}
                className="w-full border-dashed border-border text-muted-foreground hover:text-foreground cursor-pointer"
              >
                <Plus className="h-3 w-3 mr-1" />
                add reboot
              </Button>
            </div>

            {/* Next reboot preview */}
            {enabled && entries.length > 0 && (
              <div className="text-sm text-muted-foreground">
                next scheduled reboot:{' '}
                <span className="text-cyan-400">{nextReboot}</span>
              </div>
            )}
          </div>

          <DialogFooter className="sm:justify-between">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setShowApplyToMachines(true)}
              className="bg-secondary border border-border cursor-pointer"
            >
              <Users className="h-3.5 w-3.5 mr-1.5" />
              apply to other machines...
            </Button>
            <div className="flex gap-2 justify-end">
              <Button
                type="button"
                variant="ghost"
                onClick={() => onOpenChange(false)}
                className="bg-secondary border border-border cursor-pointer"
              >
                cancel
              </Button>
              <Button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="bg-cyan-600 hover:bg-cyan-700"
              >
                {saving ? 'saving...' : 'save'}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ApplyScheduleToMachinesDialog
        open={showApplyToMachines}
        onOpenChange={setShowApplyToMachines}
        siteId={siteId}
        currentMachineId={machineId}
        schedule={{ enabled, entries }}
      />
    </>
  );
}
