/**
 * ProcessDialog Component
 *
 * Dual-purpose dialog for creating new processes or editing existing ones.
 * Displays a comprehensive form for all process configuration options.
 *
 * Used by: Dashboard page for process management
 */

import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Trash2, Clock, Settings2 } from 'lucide-react';
import { ScheduleBlocksEditor } from '@/components/ScheduleEditor';
import WeekSummaryBar from '@/components/WeekSummaryBar';
import { DEFAULT_SCHEDULE } from '@/lib/scheduleDefaults';
import type { LaunchMode, ScheduleBlock } from '@/hooks/useFirestore';

export interface ProcessFormData {
  name: string;
  exe_path: string;
  file_path: string;
  cwd: string;
  priority: string;
  visibility: string;
  time_delay: string;
  time_to_init: string;
  relaunch_attempts: string;
  autolaunch: boolean;
  launch_mode?: LaunchMode;
  schedules?: ScheduleBlock[] | null;
}

interface ProcessDialogProps {
  open: boolean;
  mode: 'create' | 'edit';
  form: ProcessFormData;
  onFormChange: (form: ProcessFormData) => void;
  onClose: () => void;
  onSave: () => void;
  onDelete: () => void;
  siteTimezone?: string;
}

export function ProcessDialog({
  open,
  mode,
  form,
  onFormChange,
  onClose,
  onSave,
  onDelete,
  siteTimezone,
}: ProcessDialogProps) {
  // Disclosure for the schedule section. The schedule is editable in every
  // launch mode (same rule the desktop app ships): from `off`/`always on` this
  // is pre-configuring — the windows are written on save and the mode stays
  // where it was. In `scheduled` the section is pinned open, so this flag only
  // drives the other two modes.
  const [scheduleSectionOpen, setScheduleSectionOpen] = useState(false);
  const launchMode = form.launch_mode || 'off';
  const scheduleSectionVisible = launchMode === 'scheduled' || scheduleSectionOpen;
  // Prefill with the default windows when the process has none stored — the
  // summary bar and the editor must show the same thing. Nothing is written to
  // the form until the user actually edits a block.
  const scheduleBlocks = form.schedules && form.schedules.length > 0 ? form.schedules : DEFAULT_SCHEDULE;

  // Collapse again once the dialog closes so the next process opens clean.
  // Adjusting during render (React's documented "state derived from a prop
  // change" pattern) rather than in an effect: an effect would re-render the
  // whole dialog a second time on every close.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open) setScheduleSectionOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="border-border bg-card text-foreground sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="text-white">
            {mode === 'create' ? 'add process' : 'edit process'}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {mode === 'create'
              ? 'add a process to this machine'
              : 'update process configuration'}
          </DialogDescription>
        </DialogHeader>
        {/* The form scrolls inside the dialog: with the schedule section open
            the fields alone can outgrow a laptop viewport, and a Dialog that
            overflows puts its footer (save/cancel) out of reach. */}
        <div className="space-y-4 py-4 max-h-[70vh] overflow-y-auto pr-1">
          {/* Name */}
          <div className="space-y-2">
            <Label htmlFor="edit-name" className="text-white">name</Label>
            <Input
              id="edit-name"
              value={form.name}
              onChange={(e) => onFormChange({ ...form, name: e.target.value })}
              className="border-border bg-background text-white"
            />
          </div>

          {/* Launch Mode — prominently after name */}
          <div className="space-y-2">
            <Label className="text-white text-sm">launch mode</Label>
            <div className="flex items-stretch rounded-lg overflow-hidden border border-border">
              {(['off', 'always', 'scheduled'] as const).map((m) => {
                const labels = { off: 'off', always: 'always on', scheduled: 'scheduled' };
                const isActive = launchMode === m;
                const colors = {
                  off: isActive ? 'bg-muted text-foreground' : '',
                  always: isActive ? 'bg-emerald-600 text-white' : '',
                  scheduled: isActive ? 'bg-blue-600 text-white' : '',
                };
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => onFormChange({ ...form, launch_mode: m, autolaunch: m !== 'off' })}
                    className={`flex-1 px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer ${colors[m]} ${!isActive ? 'bg-card text-muted-foreground hover:bg-muted/50' : ''}`}
                  >
                    {labels[m]}
                  </button>
                );
              })}
              {/* Schedule disclosure — the machine rows' gear affordance: flush
                  at the end of the segmented control, one hairline between. It
                  is offered in EVERY mode (the schedule is always editable);
                  in `scheduled` the section below is pinned open, so the gear
                  reads as the marker for a section that is already showing.
                  It never selects a mode — only the segments do that. */}
              <span className={`w-px ${launchMode === 'scheduled' ? 'bg-blue-400/50' : 'bg-border'}`} />
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label="configure schedule"
                    aria-expanded={scheduleSectionVisible}
                    data-testid="process-dialog-configure-schedule"
                    onClick={() => setScheduleSectionOpen((isOpen) => !isOpen)}
                    className={`px-2 transition-colors cursor-pointer flex items-center ${launchMode === 'scheduled' ? 'bg-blue-600 text-white hover:bg-blue-500' : 'bg-card text-muted-foreground hover:bg-muted/50'}`}
                  >
                    <Settings2 className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>configure schedule</p>
                </TooltipContent>
              </Tooltip>
            </div>
          </div>

          {/* Executable Path */}
          <div className="space-y-2">
            <Label htmlFor="edit-exe-path" className="text-white">executable path</Label>
            <Input
              id="edit-exe-path"
              value={form.exe_path}
              onChange={(e) => onFormChange({ ...form, exe_path: e.target.value })}
              className="border-border bg-background text-white"
              placeholder="C:/Program Files/..."
            />
          </div>

          {/* File Path / Cmd Args */}
          <div className="space-y-2">
            <Label htmlFor="edit-file-path" className="text-white">file path / command arguments</Label>
            <Input
              id="edit-file-path"
              value={form.file_path}
              onChange={(e) => onFormChange({ ...form, file_path: e.target.value })}
              className="border-border bg-background text-white"
              placeholder="optional"
            />
          </div>

          {/* Working Directory */}
          <div className="space-y-2">
            <Label htmlFor="edit-cwd" className="text-white">working directory</Label>
            <Input
              id="edit-cwd"
              value={form.cwd}
              onChange={(e) => onFormChange({ ...form, cwd: e.target.value })}
              className="border-border bg-background text-white"
              placeholder="optional"
            />
          </div>

          <div className="grid grid-cols-3 gap-4">
            {/* Priority */}
            <div className="space-y-2">
              <Label htmlFor="edit-priority" className="text-white">task priority</Label>
              <Select
                value={form.priority}
                onValueChange={(value) => onFormChange({ ...form, priority: value })}
              >
                <SelectTrigger id="edit-priority" className="border-border bg-background text-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-border bg-background text-white">
                  <SelectItem value="Low">low</SelectItem>
                  <SelectItem value="Normal">normal</SelectItem>
                  <SelectItem value="High">high</SelectItem>
                  <SelectItem value="Realtime">realtime</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Visibility */}
            <div className="space-y-2">
              <Label htmlFor="edit-visibility" className="text-white">window visibility</Label>
              <Select
                value={form.visibility}
                onValueChange={(value) => onFormChange({ ...form, visibility: value })}
              >
                <SelectTrigger id="edit-visibility" className="border-border bg-background text-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-border bg-background text-white">
                  <SelectItem value="Normal">normal</SelectItem>
                  <SelectItem value="Hidden">hidden (console apps only)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Empty space for alignment */}
            <div></div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            {/* Time Delay */}
            <div className="space-y-2">
              <Label htmlFor="edit-time-delay" className="text-white">launch delay (sec)</Label>
              <Input
                id="edit-time-delay"
                type="number"
                value={form.time_delay}
                onChange={(e) => onFormChange({ ...form, time_delay: e.target.value })}
                className="border-border bg-background text-white"
              />
            </div>

            {/* Time to Init */}
            <div className="space-y-2">
              <Label htmlFor="edit-time-init" className="text-white">init timeout (sec)</Label>
              <Input
                id="edit-time-init"
                type="number"
                value={form.time_to_init}
                onChange={(e) => onFormChange({ ...form, time_to_init: e.target.value })}
                className="border-border bg-background text-white"
              />
            </div>

            {/* Relaunch Attempts */}
            <div className="space-y-2">
              <Label htmlFor="edit-relaunch" className="text-white">relaunch attempts</Label>
              <Input
                id="edit-relaunch"
                type="number"
                value={form.relaunch_attempts}
                onChange={(e) => onFormChange({ ...form, relaunch_attempts: e.target.value })}
                className="border-border bg-background text-white"
              />
            </div>
          </div>

          {/* Schedule Configuration — auto-shown in `scheduled` mode, disclosed
              by the gear in `off` / `always on`. Edits here are saved with the
              rest of the form and never move the launch mode. */}
          {scheduleSectionVisible && (
            <div className="space-y-3 rounded-lg border border-blue-600/30 bg-blue-500/5 p-3" data-testid="process-dialog-schedule-section">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Clock className="h-3.5 w-3.5 text-blue-400" />
                  <span className="text-xs font-medium text-blue-400">schedule configuration</span>
                </div>
                {siteTimezone && (
                  <span className="text-[10px] text-muted-foreground">
                    times in {siteTimezone.replace(/_/g, ' ').split('/').pop()}
                  </span>
                )}
              </div>
              {launchMode !== 'scheduled' && (
                <p className="text-[11px] text-muted-foreground">
                  saved with the process — switch to scheduled whenever you want these windows to run it
                </p>
              )}
              <div className="flex justify-center mb-2">
                <WeekSummaryBar schedules={scheduleBlocks} tall />
              </div>
              <div className="max-h-[200px] overflow-y-auto pr-1">
                <ScheduleBlocksEditor
                  blocks={scheduleBlocks}
                  onChange={(blocks) => onFormChange({ ...form, schedules: blocks })}
                  compact
                />
              </div>
            </div>
          )}
        </div>
        <DialogFooter className="flex items-center">
          {mode === 'edit' && (
            <Button
              variant="ghost"
              onClick={onDelete}
              className="text-red-400 hover:text-red-300 hover:bg-red-950/30 cursor-pointer"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
          <div className="flex gap-2 ml-auto">
            <Button
              variant="ghost"
              onClick={onClose}
              className="bg-secondary border border-border cursor-pointer"
            >
              cancel
            </Button>
            <Button
              onClick={onSave}
              className="text-gray-900 cursor-pointer"
            >
              {mode === 'create' ? 'create process' : 'save changes'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
