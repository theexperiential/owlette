/**
 * ProcessDialog Component
 *
 * Dual-purpose dialog for creating new processes or editing existing ones.
 * Displays a comprehensive form for all process configuration options.
 *
 * Used by: Dashboard page for process management
 */

import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Trash2, Clock } from 'lucide-react';
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
  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="border-border bg-card text-foreground max-w-3xl">
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
        <div className="space-y-4 py-4">
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
            <div className="flex rounded-lg overflow-hidden border border-border">
              {(['off', 'always', 'scheduled'] as const).map((m) => {
                const labels = { off: 'Off', always: 'Always On', scheduled: 'Scheduled' };
                const isActive = (form.launch_mode || 'off') === m;
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

          {/* Schedule Configuration (shown when mode is 'scheduled') */}
          {(form.launch_mode || 'off') === 'scheduled' && (
            <div className="space-y-3 rounded-lg border border-blue-600/30 bg-blue-950/10 p-3">
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
              <div className="flex justify-center mb-2">
                <WeekSummaryBar schedules={form.schedules} tall />
              </div>
              <div className="max-h-[200px] overflow-y-auto pr-1">
                <ScheduleBlocksEditor
                  blocks={form.schedules && form.schedules.length > 0 ? form.schedules : DEFAULT_SCHEDULE}
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
              variant="outline"
              onClick={onClose}
              className="border-border bg-card text-foreground hover:bg-accent hover:border-foreground/30 hover:text-white cursor-pointer"
            >
              cancel
            </Button>
            <Button
              onClick={onSave}
              className="bg-accent-cyan hover:bg-accent-cyan-hover text-gray-900 cursor-pointer"
            >
              {mode === 'create' ? 'create process' : 'save changes'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
