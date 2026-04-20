'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { FolderArchive, Loader2, Pencil, Plus, Save, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { useMachines } from '@/hooks/useFirestore';
import { ProjectDistribution } from '@/hooks/useProjectDistributions';
import {
  useProjectDistributionPresets,
  type ProjectDistributionPreset,
} from '@/hooks/useProjectDistributionPresets';
import { Badge } from '@/components/ui/badge';
import { sanitizeError } from '@/lib/errorHandler';

interface ProjectDistributionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  siteId: string;
  onCreateDistribution: (
    distribution: Omit<ProjectDistribution, 'id' | 'createdAt' | 'status'>,
    machineIds: string[]
  ) => Promise<string>;
}

/** Stable key for detecting whether current form matches a preset's config. */
function presetConfigKey(
  projectUrl: string | undefined,
  extractPath: string | undefined,
  verifyFiles: string[] | undefined
): string {
  return JSON.stringify({
    project_url: projectUrl || '',
    extract_path: extractPath || '',
    verify_files: [...(verifyFiles || [])].sort(),
  });
}

export default function ProjectDistributionDialog({
  open,
  onOpenChange,
  siteId,
  onCreateDistribution,
}: ProjectDistributionDialogProps) {
  const { machines } = useMachines(siteId);
  const { presets, createPreset, updatePreset, deletePreset } = useProjectDistributionPresets(siteId);

  const [distributionName, setDistributionName] = useState('');
  const [projectUrl, setProjectUrl] = useState('');
  const [extractPath, setExtractPath] = useState('');
  const [verifyFiles, setVerifyFiles] = useState('');
  const [selectedMachines, setSelectedMachines] = useState<Set<string>>(new Set());
  const [distributing, setDistributing] = useState(false);

  // Preset bar state (mirrors RebootScheduleDialog pattern)
  const [activePresetId, setActivePresetId] = useState<string | null>(null);
  const [savingNewPreset, setSavingNewPreset] = useState(false);
  const [newPresetName, setNewPresetName] = useState('');
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null);
  const [editPresetName, setEditPresetName] = useState('');
  const [confirmDeletePresetId, setConfirmDeletePresetId] = useState<string | null>(null);
  const [pendingReplacePreset, setPendingReplacePreset] = useState<ProjectDistributionPreset | null>(null);

  // Autosave state. `idle` = no changes pending; `saving` = debounce flushed,
  // write in flight; `saved` = recently persisted (returns to idle after a tick).
  const [autosaveStatus, setAutosaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  // Set to true right after applyPreset so the resulting field updates don't
  // immediately schedule a redundant write back to Firestore.
  const suppressNextAutosaveRef = useRef(false);

  const allMachinesSelected = selectedMachines.size === machines.length && machines.length > 0;
  const onlineMachines = machines.filter(m => m.online);

  // Reset form state when dialog opens
  useEffect(() => {
    if (!open) return;
    setActivePresetId(null);
    setSavingNewPreset(false);
    setNewPresetName('');
    setEditingPresetId(null);
    setConfirmDeletePresetId(null);
    setPendingReplacePreset(null);
  }, [open]);

  // Autosave field edits back to the active non-builtin preset, debounced.
  // Built-ins are excluded so editing one doesn't silently create an override.
  // The suppress ref short-circuits the write that would otherwise fire
  // immediately after applyPreset (we just LOADED these values from the preset).
  //
  // Note: there is intentionally NO auto-detect effect that flips activePresetId
  // based on field contents. With autosave, the active preset is the source of
  // truth for "where edits go" — having an effect deselect the preset whenever
  // fields differ would cancel in-flight autosaves and confuse the user.
  useEffect(() => {
    if (!open) return;
    if (suppressNextAutosaveRef.current) {
      suppressNextAutosaveRef.current = false;
      return;
    }
    if (!activePresetId) return;
    const preset = presets.find(p => p.id === activePresetId);
    if (!preset || preset.isBuiltIn) return;

    const verifyFilesArray = verifyFiles
      .split(',')
      .map(f => f.trim())
      .filter(f => f.length > 0);
    // Skip when current values already match the preset (no diff to write).
    const currentKey = presetConfigKey(projectUrl || undefined, extractPath || undefined, verifyFilesArray);
    const presetKey = presetConfigKey(preset.project_url, preset.extract_path, preset.verify_files);
    if (currentKey === presetKey) return;

    // Debounce — don't flag "saving" yet, just queue the write. Status flips
    // to "saving" only when the actual Firestore call is in flight, so the
    // indicator reflects reality rather than every keystroke.
    const handle = setTimeout(async () => {
      setAutosaveStatus('saving');
      try {
        await updatePreset(preset.id, {
          project_url: projectUrl || undefined,
          extract_path: extractPath || undefined,
          verify_files: verifyFilesArray.length > 0 ? verifyFilesArray : undefined,
        });
        setAutosaveStatus('saved');
        // Drop the "saved" indicator after a short window so it doesn't
        // linger and imply pending changes.
        setTimeout(() => setAutosaveStatus('idle'), 1500);
      } catch (err) {
        setAutosaveStatus('idle');
        toast.error('failed to save preset', { description: sanitizeError(err) });
      }
    }, 800);

    return () => clearTimeout(handle);
  }, [open, activePresetId, projectUrl, extractPath, verifyFiles, presets, updatePreset]);

  const applyPreset = async (preset: ProjectDistributionPreset) => {
    // Clicking the already-active preset deselects it (since auto-detect was
    // removed, this is the user's escape hatch). Form fields are left as-is
    // so they can keep working with the values without losing them.
    if (activePresetId === preset.id) {
      setActivePresetId(null);
      return;
    }

    // Flush pending autosave to the OUTGOING preset before switching. Without
    // this, edits made within the 800ms debounce window get cancelled by the
    // effect cleanup when we change activePresetId, and the next time the
    // user comes back to that preset they see stale (pre-edit) values.
    const outgoing = activePresetId ? presets.find(p => p.id === activePresetId) : null;
    if (outgoing && !outgoing.isBuiltIn) {
      const verifyFilesArray = verifyFiles
        .split(',')
        .map(f => f.trim())
        .filter(f => f.length > 0);
      const currentKey = presetConfigKey(projectUrl || undefined, extractPath || undefined, verifyFilesArray);
      const outgoingKey = presetConfigKey(outgoing.project_url, outgoing.extract_path, outgoing.verify_files);
      if (currentKey !== outgoingKey) {
        setAutosaveStatus('saving');
        try {
          await updatePreset(outgoing.id, {
            project_url: projectUrl || undefined,
            extract_path: extractPath || undefined,
            verify_files: verifyFilesArray.length > 0 ? verifyFilesArray : undefined,
          });
        } catch (err) {
          // Don't block the switch on save failure — but tell the user so
          // they're not surprised when they come back and find stale values.
          toast.error('failed to save preset before switching', {
            description: sanitizeError(err),
          });
        }
        setAutosaveStatus('idle');
      }
    }

    // Switching presets fully replaces form fields — including clearing them
    // when the new preset doesn't have a value. Anything else creates a
    // confusing "stuck" state where old values bleed into the new preset.
    // Distribution name stays per-deployment since names tend to be time-bound
    // (e.g. "Summer Show 2024").
    setProjectUrl(preset.project_url || '');
    setExtractPath(preset.extract_path || '');
    setVerifyFiles((preset.verify_files || []).join(', '));
    setActivePresetId(preset.id);
    // Suppress the autosave that would otherwise fire from the field updates
    // above — we just loaded these values FROM the preset, so writing them
    // back would be a wasteful no-op.
    suppressNextAutosaveRef.current = true;
  };

  const handleCreatePreset = async () => {
    if (!newPresetName.trim()) {
      toast.error('please enter a name for the preset');
      return;
    }

    const verifyFilesArray = verifyFiles
      .split(',')
      .map(f => f.trim())
      .filter(f => f.length > 0);

    // Name collision → defer to replace-confirm flow
    const trimmedName = newPresetName.trim();
    const existing = presets.find(p => p.name.toLowerCase() === trimmedName.toLowerCase());
    if (existing) {
      setPendingReplacePreset(existing);
      return;
    }

    try {
      await createPreset({
        name: trimmedName,
        project_url: projectUrl || undefined,
        extract_path: extractPath || undefined,
        verify_files: verifyFilesArray.length > 0 ? verifyFilesArray : undefined,
        isBuiltIn: false,
        order: 100,
        createdBy: '',
      });
      toast.success('preset saved');
      setNewPresetName('');
      setSavingNewPreset(false);
    } catch (err) {
      toast.error('failed to save preset', { description: sanitizeError(err) });
    }
  };

  const handleConfirmReplace = async () => {
    if (!pendingReplacePreset) return;
    const verifyFilesArray = verifyFiles
      .split(',')
      .map(f => f.trim())
      .filter(f => f.length > 0);
    try {
      await updatePreset(pendingReplacePreset.id, {
        project_url: projectUrl || undefined,
        extract_path: extractPath || undefined,
        verify_files: verifyFilesArray.length > 0 ? verifyFilesArray : undefined,
      });
      toast.success(`preset "${pendingReplacePreset.name}" replaced`);
      setPendingReplacePreset(null);
      setNewPresetName('');
      setSavingNewPreset(false);
      setActivePresetId(pendingReplacePreset.id);
    } catch (err) {
      toast.error('failed to replace preset', { description: sanitizeError(err) });
    }
  };

  const handleRenamePreset = async () => {
    if (!editingPresetId || !editPresetName.trim()) return;
    try {
      await updatePreset(editingPresetId, { name: editPresetName.trim() });
      setEditingPresetId(null);
      setEditPresetName('');
    } catch (err) {
      toast.error('failed to rename preset', { description: sanitizeError(err) });
    }
  };

  const toggleMachine = (machineId: string) => {
    const newSelected = new Set(selectedMachines);
    if (newSelected.has(machineId)) {
      newSelected.delete(machineId);
    } else {
      newSelected.add(machineId);
    }
    setSelectedMachines(newSelected);
  };

  const toggleAllMachines = () => {
    if (allMachinesSelected) {
      setSelectedMachines(new Set());
    } else {
      setSelectedMachines(new Set(machines.map(m => m.machineId)));
    }
  };

  const selectOnlyOnlineMachines = () => {
    setSelectedMachines(new Set(onlineMachines.map(m => m.machineId)));
  };

  const handleDistribute = async () => {
    // Validation
    if (!distributionName.trim()) {
      toast.error('please provide a roost name');
      return;
    }

    if (!projectUrl.trim()) {
      toast.error('please provide a project URL');
      return;
    }

    // Validate URL format
    let parsedUrl;
    try {
      parsedUrl = new URL(projectUrl);
    } catch {
      toast.error('invalid project URL format');
      return;
    }

    if (selectedMachines.size === 0) {
      toast.error('please select at least one machine');
      return;
    }

    setDistributing(true);

    try {
      // Auto-extract project filename from URL
      const urlPath = parsedUrl.pathname;
      const projectName = urlPath.substring(urlPath.lastIndexOf('/') + 1) || 'project.zip';

      // Parse verify files (comma-separated)
      const verifyFilesArray = verifyFiles
        .split(',')
        .map(f => f.trim())
        .filter(f => f.length > 0);

      // Create distribution
      await onCreateDistribution(
        {
          name: distributionName,
          file_name: projectName,
          project_url: projectUrl,
          extract_path: extractPath || undefined,
          verify_files: verifyFilesArray.length > 0 ? verifyFilesArray : undefined,
          targets: [],  // Will be filled by the hook
        },
        Array.from(selectedMachines)
      );

      toast.success(`roost started — syncing to ${selectedMachines.size} machine${selectedMachines.size > 1 ? 's' : ''}`);

      // Reset form
      setDistributionName('');
      setProjectUrl('');
      setExtractPath('');
      setVerifyFiles('');
      setSelectedMachines(new Set());

      onOpenChange(false);
    } catch (error) {
      console.error('Distribution error:', error);
      toast.error('failed to create distribution', { description: sanitizeError(error) });
    } finally {
      setDistributing(false);
    }
  };

  const selectedPreset = activePresetId ? presets.find(p => p.id === activePresetId) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-secondary text-white max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-white">roost a project</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            sync project files (zips, archives) to one or more machines
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
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

            {/* Inline create form */}
            {savingNewPreset && !pendingReplacePreset && (
              <form onSubmit={(e) => { e.preventDefault(); handleCreatePreset(); }} className="flex items-center gap-1.5">
                <Input
                  value={newPresetName}
                  onChange={(e) => setNewPresetName(e.target.value)}
                  placeholder="preset name"
                  className="h-7 w-40 text-[11px] px-2 bg-background border-border"
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

            {/* Inline replace-confirm */}
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

            {/* Inline rename form */}
            {editingPresetId && (
              <form onSubmit={(e) => { e.preventDefault(); handleRenamePreset(); }} className="flex items-center gap-1.5">
                <Input
                  value={editPresetName}
                  onChange={(e) => setEditPresetName(e.target.value)}
                  className="h-7 w-40 text-[11px] px-2 bg-background border-border"
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

            {/* Action row for selected non-builtin preset.
                Edits autosave (debounced) — no manual save action needed. The
                indicator shows save state so the user knows changes persist. */}
            {selectedPreset && !selectedPreset.isBuiltIn && !editingPresetId && !savingNewPreset && confirmDeletePresetId !== selectedPreset.id && (
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <span
                  aria-live="polite"
                  className={`flex items-center gap-1 ${
                    autosaveStatus === 'saving'
                      ? 'text-cyan-400'
                      : autosaveStatus === 'saved'
                        ? 'text-green-400'
                        : 'text-muted-foreground/70'
                  }`}
                >
                  <Save className="h-3 w-3" />
                  {autosaveStatus === 'saving'
                    ? 'saving…'
                    : autosaveStatus === 'saved'
                      ? 'saved'
                      : 'autosaves'}
                </span>
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

            {/* Two-step delete confirmation */}
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
                    } catch (err) {
                      toast.error('failed to delete preset', { description: sanitizeError(err) });
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

          {/* Distribution Name */}
          <div className="space-y-2">
            <Label htmlFor="distribution-name" className="text-white">distribution name</Label>
            <Input
              id="distribution-name"
              placeholder="e.g., Summer Show 2024"
              value={distributionName}
              onChange={(e) => setDistributionName(e.target.value)}
              className="border-border bg-background text-white"
            />
          </div>

          {/* Project URL */}
          <div className="space-y-2">
            <Label htmlFor="project-url" className="text-white">project URL</Label>
            <Input
              id="project-url"
              placeholder="https://example.com/project.zip"
              value={projectUrl}
              onChange={(e) => setProjectUrl(e.target.value)}
              className="border-border bg-background text-white font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">direct download link to your project ZIP (Dropbox, Google Drive, etc.)</p>
          </div>

          {/* Extract Path */}
          <div className="space-y-2">
            <Label htmlFor="extract-path" className="text-white">extract to (optional)</Label>
            <Input
              id="extract-path"
              placeholder='Leave empty for default location'
              value={extractPath}
              onChange={(e) => setExtractPath(e.target.value)}
              className="border-border bg-background text-white"
            />
            <p className="text-xs text-muted-foreground">
              custom extraction path. default: <span className="font-mono text-accent-cyan">~/Documents/Owlette/</span>
            </p>
          </div>

          {/* Verify Files (Optional) */}
          <div className="space-y-2">
            <Label htmlFor="verify-files" className="text-white">verify critical files (optional)</Label>
            <Input
              id="verify-files"
              placeholder='project.toe, Assets/video.mp4'
              value={verifyFiles}
              onChange={(e) => setVerifyFiles(e.target.value)}
              className="border-border bg-background text-white"
            />
            <p className="text-xs text-muted-foreground">
              check specific files exist after extraction (comma-separated). leave empty to skip verification.
            </p>
          </div>

          {/* Target Machines */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-white">target machines ({selectedMachines.size} selected)</Label>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={selectOnlyOnlineMachines}
                  className="border-border bg-background text-white hover:bg-muted hover:text-white cursor-pointer text-xs"
                >
                  online only ({onlineMachines.length})
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={toggleAllMachines}
                  className="border-border bg-background text-white hover:bg-muted hover:text-white cursor-pointer text-xs"
                >
                  {allMachinesSelected ? 'deselect all' : 'select all'}
                </Button>
              </div>
            </div>

            <div className="border border-border rounded-lg p-3 bg-background max-h-48 overflow-y-auto space-y-2">
              {machines.length === 0 ? (
                <p className="text-muted-foreground text-sm text-center py-2">no machines available</p>
              ) : (
                machines.map((machine) => (
                  <div
                    key={machine.machineId}
                    className="flex items-center justify-between p-2 rounded hover:bg-secondary cursor-pointer"
                    onClick={() => toggleMachine(machine.machineId)}
                  >
                    <div className="flex items-center gap-3">
                      <Checkbox
                        checked={selectedMachines.has(machine.machineId)}
                        onCheckedChange={() => toggleMachine(machine.machineId)}
                        className="cursor-pointer"
                      />
                      <span className="text-white">{machine.machineId}</span>
                    </div>
                    <Badge className={`text-xs ${machine.online ? 'bg-green-600' : 'bg-red-600'}`}>
                      {machine.online ? 'online' : 'offline'}
                    </Badge>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            className="bg-secondary border border-border cursor-pointer"
            disabled={distributing}
          >
            cancel
          </Button>
          <Button
            onClick={handleDistribute}
            className="bg-accent-cyan hover:bg-accent-cyan-hover text-gray-900 cursor-pointer"
            disabled={distributing}
          >
            {distributing ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                distributing...
              </>
            ) : (
              <>
                <FolderArchive className="h-4 w-4 mr-2" />
                distribute to {selectedMachines.size} machine{selectedMachines.size !== 1 ? 's' : ''}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
