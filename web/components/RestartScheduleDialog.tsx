'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useMachines } from '@/hooks/useFirestore';
import { useRestartPresets, type RestartPreset } from '@/hooks/useRestartPresets';
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
import { tzAbbreviation } from '@/components/TimezoneChip';
import type { RestartSchedule, RestartScheduleEntry } from '@/hooks/useFirestore';

interface RestartScheduleDialogProps {
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
  currentSchedule?: RestartSchedule;
}

/** Generate a stable ID for a new restart entry. */
function newEntryId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `entry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Compute the next scheduled restart across all entries for the preview line.
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
function getNextScheduledRestart(
  enabled: boolean,
  entries: RestartScheduleEntry[],
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
function entriesKey(entries: RestartScheduleEntry[]): string {
  return JSON.stringify(
    entries.map(e => ({ days: [...e.days].sort(), time: e.time }))
  );
}

export default function RestartScheduleDialog({
  siteId,
  machineId,
  machineName,
  machineTimezone,
  open,
  onOpenChange,
  currentSchedule,
}: RestartScheduleDialogProps) {
  const { userPreferences } = useAuth();
  const { updateRestartSchedule } = useMachines(siteId);
  const { presets, createPreset, updatePreset, deletePreset } = useRestartPresets(siteId);

  const [enabled, setEnabled] = useState(false);
  const [entries, setEntries] = useState<RestartScheduleEntry[]>([]);
  const [saving, setSaving] = useState(false);
  const [activePresetId, setActivePresetId] = useState<string | null>(null);
  const [savingNewPreset, setSavingNewPreset] = useState(false);
  const [newPresetName, setNewPresetName] = useState('');
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null);
  const [editPresetName, setEditPresetName] = useState('');
  const [confirmDeletePresetId, setConfirmDeletePresetId] = useState<string | null>(null);
  const [pendingReplacePreset, setPendingReplacePreset] = useState<RestartPreset | null>(null);
  const [showApplyToMachines, setShowApplyToMachines] = useState(false);
  const [updatingPreset, setUpdatingPreset] = useState(false);

  // Initialize from currentSchedule and detect matching preset in a SINGLE
  // effect that runs once per opening. Two separate effects both depending on
  // `open` raced: the auto-detect ran with the previous session's `entries`
  // closure and stamped a wrong activePresetId before init's setEntries
  // materialized, which then locked the dialog into the wrong preset on every
  // reopen.
  //
  // Initialization happens only on the open→true transition; after that,
  // activePresetId is mutated only by user actions (applyPreset, etc.) so
  // editing entries no longer auto-clears or auto-snaps the selection.
  const initOnceRef = useRef(false);
  useEffect(() => {
    if (!open) {
      initOnceRef.current = false;
      return;
    }
    if (initOnceRef.current) return;
    initOnceRef.current = true;

    const initialEntries: RestartScheduleEntry[] = currentSchedule
      ? (currentSchedule.entries ?? []).map(e => ({
          id: e.id || newEntryId(),
          days: e.days || [],
          time: e.time || '03:00',
        }))
      : [];

    setEnabled(currentSchedule?.enabled ?? false);
    setEntries(initialEntries);

    const key = entriesKey(initialEntries);
    const match = presets.find(p => entriesKey(p.entries) === key);
    setActivePresetId(match?.id ?? null);

    setSavingNewPreset(false);
    setNewPresetName('');
    setEditingPresetId(null);
    setConfirmDeletePresetId(null);
    setPendingReplacePreset(null);
  }, [open, currentSchedule, presets]);

  const nextRestart = useMemo(
    () => getNextScheduledRestart(enabled, entries, userPreferences.timeFormat || '12h', machineTimezone),
    [enabled, entries, userPreferences.timeFormat, machineTimezone]
  );

  // Short timezone abbreviation (e.g. "PDT") used as an inline label next to
  // every time field and the next-restart line. Empty when we don't know the
  // machine's IANA timezone — we just omit the suffix in that case.
  const tzShort = useMemo(
    () => (machineTimezone ? tzAbbreviation(machineTimezone) : ''),
    [machineTimezone]
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

  const updateEntry = (id: string, patch: Partial<RestartScheduleEntry>) => {
    setEntries(prev => prev.map(e => (e.id === id ? { ...e, ...patch } : e)));
  };

  const applyPreset = (preset: RestartPreset) => {
    // Clone entries with fresh IDs so the per-machine state doesn't share IDs across machines
    setEntries(
      preset.entries.map(e => ({
        id: newEntryId(),
        days: [...e.days],
        time: e.time,
      }))
    );
    // Adopt the preset's enabled state when defined — keeps the toggle in sync
    // with the schedule the user just picked. Legacy presets without this field
    // leave the current toggle alone.
    if (preset.enabled !== undefined) setEnabled(preset.enabled);
    setActivePresetId(preset.id);
  };

  const handleCreatePreset = async () => {
    if (!newPresetName.trim()) {
      toast.error('please enter a name for the preset');
      return;
    }
    const validEntries = entries.filter(e => e.days.length > 0);
    if (validEntries.length === 0) {
      toast.error('add at least one restart entry first');
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
      const presetId = await createPreset({
        name: trimmedName,
        enabled,
        entries: validEntries,
        isBuiltIn: false,
        order: 100,
        createdBy: '',
      });
      toast.success('preset saved');
      setNewPresetName('');
      setSavingNewPreset(false);
      setActivePresetId(presetId);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error('failed to save preset', { description: message });
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
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error('failed to replace preset', { description: message });
    }
  };

  const handleRenamePreset = async () => {
    if (!editingPresetId || !editPresetName.trim()) return;
    try {
      await updatePreset(editingPresetId, { name: editPresetName.trim() });
      setEditingPresetId(null);
      setEditPresetName('');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error('failed to rename preset', { description: message });
    }
  };

  const handleSave = async () => {
    if (enabled) {
      // Validate: all entries must have at least one day selected
      const invalid = entries.find(e => e.days.length === 0);
      if (invalid) {
        toast.error('every restart entry needs at least one day');
        return;
      }
    }

    // If a preset name is pending in the inline form but the user hasn't
    // explicitly submitted it, persist it now so it isn't silently dropped
    // when the dialog closes. Name collision short-circuits to the existing
    // replace-confirm flow.
    if (pendingReplacePreset) {
      toast.error('resolve the preset name conflict before saving');
      return;
    }
    if (savingNewPreset && newPresetName.trim()) {
      const trimmedName = newPresetName.trim();
      const validEntries = entries.filter(e => e.days.length > 0);
      if (validEntries.length === 0) {
        toast.error('add at least one restart entry first');
        return;
      }
      const existing = presets.find(p => p.name.toLowerCase() === trimmedName.toLowerCase());
      if (existing) {
        setPendingReplacePreset(existing);
        return;
      }
      try {
        const presetId = await createPreset({
          name: trimmedName,
          enabled,
          entries: validEntries,
          isBuiltIn: false,
          order: 100,
          createdBy: '',
        });
        toast.success('preset saved');
        setNewPresetName('');
        setSavingNewPreset(false);
        setActivePresetId(presetId);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        toast.error('failed to save preset', { description: message });
        return;
      }
    }

    setSaving(true);
    try {
      // If a custom preset is selected and entries have drifted, persist the
      // edits back to the preset so the user doesn't have to click both
      // "update preset" and "save" separately.
      let didUpdatePreset = false;
      if (selectedPreset && !selectedPreset.isBuiltIn && presetIsModified) {
        const validEntries = entries.filter(e => e.days.length > 0);
        await updatePreset(selectedPreset.id, { entries: validEntries, enabled });
        didUpdatePreset = true;
      }
      await updateRestartSchedule(machineId, { enabled, entries });
      toast.success(didUpdatePreset ? 'preset and restart schedule saved' : 'restart schedule saved');
      onOpenChange(false);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error('failed to save restart schedule', {
        description: message,
      });
    } finally {
      setSaving(false);
    }
  };

  const selectedPreset = activePresetId ? presets.find(p => p.id === activePresetId) : null;
  // Compare entries always; only compare enabled if the preset has one stored
  // (legacy presets predate this field — don't mark them dirty on toggle).
  const presetIsModified = !!selectedPreset && (
    entriesKey(selectedPreset.entries) !== entriesKey(entries) ||
    (selectedPreset.enabled !== undefined && selectedPreset.enabled !== enabled)
  );

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="bg-card border-border sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>restart schedule — {machineName}</DialogTitle>
            <DialogDescription className="text-muted-foreground text-pretty">
              automatically restart this machine on a recurring schedule.
              the machine must have been up for at least 30 minutes.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5 py-2">
            {/* Preset bar.
                Each pill sits in a `relative` wrapper; the per-pill action
                row (update/rename/delete) or inline rename/delete-confirm is
                absolutely positioned under it and centered horizontally, so
                the actions read as belonging to that specific chip without
                stretching the pill's flex slot. The row reserves `pb-10`
                when a panel is attached so the next section doesn't collide
                with the overlay. */}
            <div className="space-y-1.5">
              <Label className="text-sm text-muted-foreground">presets</Label>
              <div
                className={`flex flex-wrap items-start gap-x-1.5 gap-y-2 ${
                  selectedPreset && !selectedPreset.isBuiltIn && !savingNewPreset && !pendingReplacePreset ? 'pb-10' : ''
                }`}
              >
                {presets.map(preset => {
                  const isActive = activePresetId === preset.id;
                  const showActionRow =
                    isActive &&
                    selectedPreset &&
                    !selectedPreset.isBuiltIn &&
                    !savingNewPreset &&
                    !pendingReplacePreset;
                  const showRenameForm = showActionRow && editingPresetId === preset.id;
                  const showDeleteConfirm = showActionRow && confirmDeletePresetId === preset.id;
                  const showActions =
                    showActionRow && !showRenameForm && !showDeleteConfirm;
                  return (
                    <div key={preset.id} className="relative">
                      <button
                        type="button"
                        onClick={() => applyPreset(preset)}
                        className={`px-2.5 py-1 rounded-full text-[13px] font-medium transition-colors duration-150 cursor-pointer ${
                          isActive
                            ? 'bg-cyan-600/20 text-cyan-100 ring-1 ring-cyan-500/40'
                            : 'bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground'
                        }`}
                      >
                        {preset.name}
                      </button>

                      {/* Per-pill inline rename form */}
                      {showRenameForm && (
                        <form
                          onSubmit={(e) => { e.preventDefault(); handleRenamePreset(); }}
                          className="absolute left-1/2 top-full z-10 mt-1 flex -translate-x-1/2 items-center gap-1.5 whitespace-nowrap"
                        >
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

                      {/* Per-pill two-step delete confirmation — destructive actions need a deliberate second click. */}
                      {showDeleteConfirm && selectedPreset && (
                        <div className="absolute left-1/2 top-full z-10 mt-1 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap text-[11px] leading-5">
                          <span className="text-muted-foreground">delete &ldquo;{selectedPreset.name}&rdquo;?</span>
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                await deletePreset(selectedPreset.id);
                                setConfirmDeletePresetId(null);
                                setActivePresetId(null);
                                toast.success('preset deleted');
                              } catch (err: unknown) {
                                const message = err instanceof Error ? err.message : String(err);
                                toast.error('failed to delete preset', { description: message });
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

                      {/* Per-pill action row: update (when dirty) + rename + delete. */}
                      {showActions && selectedPreset && (
                        <div className="absolute left-1/2 top-full z-10 mt-1 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap text-[11px] leading-5 text-muted-foreground">
                          {presetIsModified && (
                            <button
                              type="button"
                              disabled={updatingPreset}
                              onClick={async () => {
                                setUpdatingPreset(true);
                                try {
                                  await updatePreset(selectedPreset.id, { entries, enabled });
                                  toast.success('preset updated');
                                } catch (err: unknown) {
                                  const message = err instanceof Error ? err.message : String(err);
                                  toast.error('failed to update preset', { description: message });
                                } finally {
                                  setUpdatingPreset(false);
                                }
                              }}
                              className="flex items-center gap-1 text-cyan-400 hover:text-cyan-300 cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              <Save className={`h-3 w-3 ${updatingPreset ? 'animate-pulse' : ''}`} />
                              {updatingPreset ? 'updating...' : 'update preset'}
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
                    </div>
                  );
                })}
                {!savingNewPreset && (
                  <button
                    type="button"
                    onClick={() => setSavingNewPreset(true)}
                    className="px-2.5 py-1 rounded-full text-[13px] text-muted-foreground/80 hover:text-foreground border border-dashed border-border/70 hover:border-muted-foreground transition-colors duration-150 cursor-pointer"
                  >
                    <Plus className="h-3.5 w-3.5 inline mr-1" />
                    new preset
                  </button>
                )}
              </div>

              {/* Inline create form — not scoped to any one pill, sits below the row. */}
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

              {/* Inline replace-confirm — preset with this name already exists.
                  Sits below the row; not scoped to the selected pill because the
                  conflict is with a different preset (same name). */}
              {pendingReplacePreset && (
                <div className="flex flex-wrap items-center gap-2 text-[11px] leading-5">
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
            </div>

            {/* Enable toggle */}
            <div className="flex items-center justify-between">
              <Label htmlFor="restart-enabled" className="text-sm">
                enable scheduled restarts
              </Label>
              <Switch
                id="restart-enabled"
                checked={enabled}
                onCheckedChange={setEnabled}
              />
            </div>

            {/* Entry list */}
            <div className={`space-y-2 ${enabled ? '' : 'opacity-50 pointer-events-none'}`}>
              {entries.length === 0 && (
                <div className="text-xs text-muted-foreground italic px-1 py-3 text-center">
                  no restarts scheduled
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
                    {tzShort && (
                      <span className="text-[11px] font-medium text-muted-foreground tabular-nums">
                        {tzShort}
                      </span>
                    )}
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
                add restart
              </Button>
            </div>

            {/* Next restart preview */}
            {enabled && entries.length > 0 && (
              <div className="text-sm text-muted-foreground">
                next scheduled restart:{' '}
                <span className="text-cyan-400">
                  {nextRestart === 'none' || !tzShort ? nextRestart : `${nextRestart} ${tzShort}`}
                </span>
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
