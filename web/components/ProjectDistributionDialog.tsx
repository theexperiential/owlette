'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { FolderArchive, Link2, Loader2, Pencil, Plus, Save, Trash2, TriangleAlert, Upload, X } from 'lucide-react';
import { toast } from 'sonner';
import { useMachines } from '@/hooks/useFirestore';
import { ProjectDistribution } from '@/hooks/useProjectDistributions';
import {
  useProjectDistributionPresets,
  type ProjectDistributionPreset,
} from '@/hooks/useProjectDistributionPresets';
import { Badge } from '@/components/ui/badge';
import { sanitizeError } from '@/lib/errorHandler';
import { FolderDropzone } from '@/components/FolderDropzone';
import type { NamedBlob } from '@/lib/chunking';
import { summariseManifest } from '@/lib/chunking';
import { resolveExtractPath, isLikelyAllowed } from '@/lib/extractPath';
import { formatBytes } from '@/lib/preUploadCheck';
import { useRoostUpload, type UseRoostUploadApi } from '@/hooks/useRoostUpload';

interface ProjectDistributionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  siteId: string;
  onCreateDistribution: (
    distribution: Omit<ProjectDistribution, 'id' | 'createdAt' | 'status'>,
    machineIds: string[]
  ) => Promise<string>;
  /**
   * Upload state lives on the parent page (via `useRoostUpload`) so a
   * multi-GB run isn't killed when the user dismisses the dialog. When
   * omitted, falls back to dialog-local state — tests use that path to
   * avoid wiring a full hook into every render call.
   */
  upload?: UseRoostUploadApi;
}

/**
 * Collapse a human-entered distribution name to a firestore-safe doc id.
 * The server-side validator requires 8-64 chars (see api/_shared.ts
 * RESOURCE_ID_RE); pad short slugs deterministically so repeat deploys
 * of the same short name ("assets", "prod", etc.) keep hitting the same
 * roostId and build up a shared manifest history.
 */
function slugify(s: string): string {
  const core = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
  if (core.length >= 8) return core;
  return `${core || 'roost'}-roost-folder`.slice(0, 64);
}

/** Short byte formatter for toast copy. */
function formatBytesShort(n: number): string {
  if (!isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

/** Compact duration formatter for ETA ("2m 14s", "42s", "1h 5m"). */
function formatDurationShort(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds - m * 60);
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m - h * 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

/** Stable key for detecting whether current form matches a preset's config. */
function presetConfigKey(
  projectUrl: string | undefined,
  extractPath: string | undefined,
): string {
  return JSON.stringify({
    project_url: projectUrl || '',
    extract_path: extractPath || '',
  });
}

export default function ProjectDistributionDialog({
  open,
  onOpenChange,
  siteId,
  onCreateDistribution,
  upload: externalUpload,
}: ProjectDistributionDialogProps) {
  const { machines } = useMachines(siteId);
  const { presets, createPreset, updatePreset, deletePreset } = useProjectDistributionPresets(siteId);

  // Upload state lives outside the dialog (via `useRoostUpload`) so the
  // in-flight run survives a dismissal. If the parent didn't supply one
  // (e.g. standalone render in tests), fall back to a hook scoped to the
  // dialog — conditional call is safe because the fallback never toggles
  // within a component's lifetime (prop is fixed at construction time).
  const localUpload = useRoostUpload();
  const upload: UseRoostUploadApi = externalUpload ?? localUpload;

  const [distributionName, setDistributionName] = useState('');
  const namePlaceholder = React.useMemo(() => {
    const examples = [
      'e.g., summer vibes (final final v3)',
      'e.g., lobby loop — do not delete',
      'e.g., the one that actually works',
      'e.g., tuesday\'s revenge',
      'e.g., definitely not last minute',
      'e.g., client approved this one',
      'e.g., conference room b (rip conference room a)',
      'e.g., untitled masterpiece',
      'e.g., please work please work',
    ];
    return examples[Math.floor(Math.random() * examples.length)];
  }, []);
  const [projectUrl, setProjectUrl] = useState('');
  const [extractPath, setExtractPath] = useState('');
  const [selectedMachines, setSelectedMachines] = useState<Set<string>>(new Set());
  const [distributing, setDistributing] = useState(false);

  // Wave 3.1 — upload-source state. Files dropped via FolderDropzone land here;
  // clicking "start upload" runs the uploadFolder() orchestrator. The
  // actual upload execution + progress lives on the `upload` hook above
  // (see JSDoc on props) so a dismissal while uploading doesn't kill the
  // run — the floating minimized card picks it up.
  const [droppedFiles, setDroppedFiles] = useState<NamedBlob[] | null>(null);
  const [droppedRootName, setDroppedRootName] = useState<string>('');
  // Source mode — url (v1 one-shot download link) vs upload (v2 roost
  // chunked upload). Upload is the default because it's the expected
  // path for a first-party roost (drag a folder/files, go) — URL mode
  // is the escape hatch for mirroring an existing public archive.
  type SourceMode = 'url' | 'upload';
  const [sourceMode, setSourceMode] = useState<SourceMode>('upload');

  // Derive upload runtime state from the hook. `uploadProgress` is the
  // live payload we render into the in-dialog progress card; `uploading`
  // is the boolean form used for button/cancel gating.
  const uploadProgress = upload.state.progress;
  const uploading = upload.state.status === 'uploading';

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

  // Reset form state when dialog opens. We deliberately DO NOT reset
  // the upload hook here — if the user dismissed the dialog mid-upload
  // and then reopened, the in-flight progress needs to resume rendering
  // (minimize-to-corner handoff). The hook resets itself on a new
  // `start()` call, or on terminal states inside the minimized card.
  useEffect(() => {
    if (!open) return;
    setActivePresetId(null);
    setSavingNewPreset(false);
    setNewPresetName('');
    setEditingPresetId(null);
    setConfirmDeletePresetId(null);
    setPendingReplacePreset(null);
    setSourceMode('upload');
    // Preserve droppedFiles + name if the upload is live so reopening
    // mid-run shows the same summary chip the user dropped.
    if (upload.state.status !== 'uploading') {
      setDroppedFiles(null);
      setDroppedRootName('');
    }
  }, [open, upload.state.status]);

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

    // Skip when current values already match the preset (no diff to write).
    const currentKey = presetConfigKey(projectUrl || undefined, extractPath || undefined);
    const presetKey = presetConfigKey(preset.project_url, preset.extract_path);
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
  }, [open, activePresetId, projectUrl, extractPath, presets, updatePreset]);

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
      const currentKey = presetConfigKey(projectUrl || undefined, extractPath || undefined);
      const outgoingKey = presetConfigKey(outgoing.project_url, outgoing.extract_path);
      if (currentKey !== outgoingKey) {
        setAutosaveStatus('saving');
        try {
          await updatePreset(outgoing.id, {
            project_url: projectUrl || undefined,
            extract_path: extractPath || undefined,
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
    try {
      await updatePreset(pendingReplacePreset.id, {
        project_url: projectUrl || undefined,
        extract_path: extractPath || undefined,
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

      // Create distribution. verify_files is dropped as of the v2 clean-cutover
      // (manifest is authoritative; spot-check is dead weight).
      await onCreateDistribution(
        {
          name: distributionName,
          file_name: projectName,
          project_url: projectUrl,
          extract_path: extractPath.trim() ? resolveExtractPath(extractPath) : undefined,
          targets: [],  // Will be filled by the hook
        },
        Array.from(selectedMachines)
      );

      toast.success(`roost started — syncing to ${selectedMachines.size} machine${selectedMachines.size > 1 ? 's' : ''}`);

      // Reset form
      setDistributionName('');
      setProjectUrl('');
      setExtractPath('');
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

  // Wave 3.1 — upload-source handler. Runs the roost orchestrator
  // (chunk → check → upload → finalize) via the `useRoostUpload` hook.
  // Execution state lives on the hook, not the dialog, so a dismissal
  // while uploading doesn't kill the run — the minimized card picks up.
  //
  // The dialog's target-machines selector still applies: once the manifest
  // is finalised, the fan-out cloud function (wave 2b.3) dispatches
  // sync_pull commands to targets stored on the roost doc.
  const handleUploadDistribute = async () => {
    if (!droppedFiles || droppedFiles.length === 0) {
      toast.error('drop a folder first');
      return;
    }
    if (!distributionName.trim()) {
      toast.error('please provide a roost name');
      return;
    }
    if (selectedMachines.size === 0) {
      toast.error('select at least one target machine');
      return;
    }

    const roostId = slugify(distributionName) || droppedRootName || 'roost-folder';
    const totalBytes = droppedFiles.reduce((n, f) => n + f.blob.size, 0);

    // Fire and forget — the hook tracks progress + result. We close the
    // dialog immediately after kickoff so the user is free to navigate;
    // the minimized card will surface completion (success toast fired by
    // the effect below that watches `upload.state.status`).
    upload.start({
      siteId,
      roostId,
      files: droppedFiles,
      name: distributionName.trim(),
      targets: Array.from(selectedMachines),
      extractPath: extractPath.trim() ? resolveExtractPath(extractPath) : undefined,
      totalBytes,
      fileCount: droppedFiles.length,
    });
  };

  // React to upload hook terminal states. We fire the user-facing toast
  // here rather than inside handleUploadDistribute because the dialog may
  // have been dismissed by the time the hook resolves — the toast still
  // needs to land. The `lastReportedStatusRef` guards against emitting
  // the same toast twice when the status is read across multiple renders.
  const lastReportedStatusRef = useRef<string | null>(null);
  useEffect(() => {
    const status = upload.state.status;
    if (status === lastReportedStatusRef.current) return;
    lastReportedStatusRef.current = status;
    if (status === 'success' && upload.state.result) {
      const result = upload.state.result;
      toast.success(
        `roost published — manifest ${result.manifestId.slice(0, 12)}…` +
          ` (uploaded ${formatBytesShort(result.uploadedBytes)} of ${formatBytesShort(result.totalBytes)})`,
      );
      // Clear the per-deploy inputs so a follow-up roost starts clean.
      setDistributionName('');
      setExtractPath('');
      setDroppedFiles(null);
      setDroppedRootName('');
      setSelectedMachines(new Set());
      // Close the dialog on success if it's still open — matches the
      // prior behavior where the distribute button awaited completion
      // and then dismissed the modal. The minimized card flashes
      // "synced" for a moment before disappearing on its own.
      if (open) onOpenChange(false);
    } else if (status === 'error' && upload.state.error) {
      toast.error('upload failed', { description: upload.state.error });
    }
  }, [upload.state.status, upload.state.result, upload.state.error, open, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Wave 3.10 — responsive at 375px:
          - default (mobile): dialog takes ≥95% of the viewport with 4px
            inset so edge-of-screen taps are still reachable.
          - sm+ (640px): reverts to the desktop `max-w-2xl` layout.
          - `max-h-[90vh]` + overflow-y keeps the body scrollable on
            short mobile viewports so the footer buttons stay reachable. */}
      <DialogContent className="border-border bg-secondary text-white w-[calc(100vw-1rem)] max-w-[calc(100vw-1rem)] sm:max-w-2xl max-h-[90vh] overflow-y-auto overflow-x-hidden">
        <DialogHeader>
          <DialogTitle className="text-white">roost a project</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            push a folder or set of files to one or more machines. drag in files directly, or point at a <code className="font-mono text-xs">.zip</code> URL the agents should fetch.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Preset bar.
              Each pill sits in a `relative` wrapper; the per-pill action row
              (autosaves/rename/delete) or inline rename/delete-confirm form
              is absolutely positioned under it and centered horizontally, so
              the actions read as belonging to that specific chip without
              stretching the pill's flex slot (which would blow out the row
              layout). The pill row reserves `pb-10` when a panel is attached
              so the next section doesn't collide with the overlay. */}
          <div className="space-y-1.5">
            <Label className="text-white">presets</Label>
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

                    {/* Per-pill two-step delete confirmation */}
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

                    {/* Per-pill action row (autosave indicator + rename + delete).
                        Autosave is debounced — no manual save. The indicator
                        reflects save state so the user knows changes persist. */}
                    {showActions && selectedPreset && (
                      <div className="absolute left-1/2 top-full z-10 mt-1 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap text-[11px] leading-5 text-muted-foreground">
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

            {/* Inline replace-confirm — sits below the row; not scoped to the selected pill
                because the conflict is with a different preset (same name). */}
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

          {/* Distribution Name */}
          <div className="space-y-2">
            <Label htmlFor="distribution-name" className="text-white">roost name</Label>
            <Input
              id="distribution-name"
              placeholder={namePlaceholder}
              value={distributionName}
              onChange={(e) => setDistributionName(e.target.value)}
              className="border-border bg-background text-white"
            />
          </div>

          {/* Source picker — inline segmented control. Wave 3.5 (revised):
              choosing the bytes-source (url download vs drag-drop upload)
              is a sub-choice WITHIN a deployment, not a top-level mode. */}
          <div className="space-y-2">
            <Label className="text-white">source</Label>
            <div
              role="radiogroup"
              aria-label="source"
              className="inline-flex rounded-md border border-border bg-background/50 p-0.5 text-xs"
            >
              {(['upload', 'url'] as const).map((src) => {
                const isActive = sourceMode === src;
                const labels: Record<SourceMode, { label: string; icon: React.ComponentType<{ className?: string }> }> = {
                  url: { label: 'by url', icon: Link2 },
                  upload: { label: 'upload files', icon: Upload },
                };
                const { label, icon: Icon } = labels[src];
                return (
                  <button
                    key={src}
                    role="radio"
                    type="button"
                    aria-checked={isActive}
                    onClick={() => setSourceMode(src)}
                    className={`inline-flex items-center gap-1.5 rounded px-3 py-1.5 cursor-pointer transition-colors ${
                      isActive
                        ? 'bg-muted text-white'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    <Icon className="h-3 w-3" />
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          {sourceMode === 'url' && (
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
          )}

          {sourceMode === 'upload' && (
            <div className="space-y-2">
              <Label className="text-white">folder to upload</Label>
              <FolderDropzone
                onFilesReady={(files, rootName) => {
                  setDroppedFiles(files);
                  setDroppedRootName(rootName);
                  // Pre-fill distribution name from the folder if the field is empty.
                  if (!distributionName) setDistributionName(rootName);
                }}
                onClear={() => {
                  setDroppedFiles(null);
                  setDroppedRootName('');
                }}
                summary={
                  droppedFiles
                    ? (() => {
                        const s = summariseManifest([]);
                        // light-weight summary from the raw blobs; the full
                        // manifest summary (with dedup) only exists after hashing.
                        s.fileCount = droppedFiles.length;
                        s.totalBytes = droppedFiles.reduce((n, f) => n + f.blob.size, 0);
                        return { fileCount: s.fileCount, totalBytes: s.totalBytes };
                      })()
                    : undefined
                }
                files={droppedFiles ?? undefined}
                disabled={distributing || uploading}
              />
              {/* Sanity warnings — non-blocking. Surface BEFORE submit so the
                  user knows upfront that the run will take time and what the
                  minimize-to-corner indicator is for. Thresholds match what
                  we've seen hit the pain points in practice:
                    - >5k files → manifest size + hashing time get noticeable
                    - >20 GB   → expect minutes, warn about keeping the tab
                  Both can trigger together; we only show whichever apply. */}
              {droppedFiles && droppedFiles.length > 0 && (() => {
                const fileCount = droppedFiles.length;
                const totalBytes = droppedFiles.reduce((n, f) => n + f.blob.size, 0);
                const LARGE_FILE_COUNT = 5_000;
                const LARGE_TOTAL_BYTES = 20 * 1024 ** 3; // 20 GiB
                const warnCount = fileCount > LARGE_FILE_COUNT;
                const warnBytes = totalBytes > LARGE_TOTAL_BYTES;
                if (!warnCount && !warnBytes) return null;
                return (
                  <div
                    role="status"
                    className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-400/90 space-y-1"
                  >
                    <div className="flex items-center gap-1.5 font-medium text-amber-300">
                      <TriangleAlert className="h-3.5 w-3.5" />
                      heads up
                    </div>
                    {warnCount && (
                      <p className="text-amber-400/75">
                        large file count ({fileCount.toLocaleString()}) — manifest will be big;
                        hashing may take several minutes. consider archiving into fewer files
                        if this is a one-off.
                      </p>
                    )}
                    {warnBytes && (
                      <p className="text-amber-400/75">
                        large upload ({formatBytes(totalBytes)}) — hashing and upload will take
                        significant time. keep this tab open; the minimize-to-corner indicator
                        handles if you click away.
                      </p>
                    )}
                  </div>
                );
              })()}
              {uploadProgress && uploadProgress.phase !== 'idle' && (() => {
                // Pick the fraction that belongs to the active phase so the
                // bar doesn't snap 0% → 100% when we cross hashing→uploading
                // (both fields can be set on the same payload during the
                // transition tick).
                const frac =
                  uploadProgress.phase === 'hashing'
                    ? uploadProgress.hashFraction
                    : uploadProgress.phase === 'uploading'
                      ? uploadProgress.uploadFraction
                      : undefined;
                const pct = frac !== undefined ? Math.round(frac * 100) : null;
                const isError = uploadProgress.phase === 'error';
                // ETA/throughput are populated by useRoostUpload once it has
                // enough samples (~3s). Below that we deliberately hide them
                // rather than flash a nonsense number.
                const throughput = uploadProgress.throughputBytesPerSec;
                const eta = uploadProgress.etaSeconds;
                const showRate =
                  !isError &&
                  throughput !== undefined &&
                  eta !== undefined &&
                  (uploadProgress.phase === 'hashing' || uploadProgress.phase === 'uploading');
                return (
                  <div className="rounded-md border border-border bg-muted/20 px-3 py-2 text-xs">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-medium text-white">
                        {uploadProgress.phase}
                      </span>
                      {pct !== null && (
                        <span className="text-muted-foreground tabular-nums">{pct}%</span>
                      )}
                    </div>
                    {/* thin track — 3px, aligns with the roost-row overall bar
                        so the upload→sync transition feels continuous. */}
                    {frac !== undefined && !isError && (
                      <div className="mt-1.5 h-[3px] w-full overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full bg-accent-cyan transition-[width] duration-200 ease-out"
                          style={{ width: `${Math.max(0, Math.min(1, frac)) * 100}%` }}
                        />
                      </div>
                    )}
                    {showRate && throughput !== undefined && eta !== undefined && (
                      <div className="mt-1 text-muted-foreground tabular-nums">
                        {formatBytes(throughput)}/s · ~{formatDurationShort(eta)} remaining
                      </div>
                    )}
                    {uploadProgress.message && (
                      <div className="mt-1 text-muted-foreground">
                        {uploadProgress.message}
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          )}

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
              {extractPath.trim() ? 'resolves to' : 'default'}:{' '}
              <span className="font-mono text-accent-cyan">{resolveExtractPath(extractPath)}</span>
            </p>
            {!isLikelyAllowed(extractPath) && (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-400/90 space-y-1.5">
                <p className="font-medium">
                  absolute path — agent needs to be told this is OK to write to
                </p>
                <p className="text-amber-400/75">
                  the agent runs as SYSTEM on the target machine, so by default we
                  only allow writes under <code className="font-mono">~/Documents/</code>.
                  to write to <code className="font-mono">{resolveExtractPath(extractPath)}</code>,
                  add it to the allowlist on that machine:
                </p>
                <ol className="list-decimal list-inside space-y-0.5 pt-0.5 text-amber-400/75">
                  <li>open <code className="font-mono">C:\ProgramData\Owlette\config\config.json</code> as admin</li>
                  <li>
                    add (or append to) the <code className="font-mono">agent_config</code> block:
                    <pre className="mt-1 ml-4 p-2 rounded bg-background/60 text-[10px] leading-snug overflow-x-auto">
{`"agent_config": {
  "allowed_extract_roots": [
    "~/Documents",
    "${resolveExtractPath(extractPath).replace(/\\\\/g, '\\\\')}"
  ]
}`}
                    </pre>
                  </li>
                  <li>right-click the owlette tray icon and pick <em>restart</em></li>
                </ol>
              </div>
            )}
          </div>

          {/* Target Machines */}
          <div className="space-y-2">
            {/* Wave 3.10 — wraps at 375px: label stacks above the two
                action buttons when the row can't fit on one line. */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label className="text-white">target machines ({selectedMachines.size} selected)</Label>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={selectOnlyOnlineMachines}
                  className="border-border bg-background/50 text-white hover:bg-muted hover:text-white cursor-pointer text-xs"
                >
                  online only ({onlineMachines.length})
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={toggleAllMachines}
                  className="border-border bg-background/50 text-white hover:bg-muted hover:text-white cursor-pointer text-xs"
                >
                  {allMachinesSelected ? 'deselect all' : 'select all'}
                </Button>
              </div>
            </div>

            <div className="border border-border rounded-lg p-3 bg-background/50 max-h-48 overflow-y-auto space-y-2">
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
          {/* Cancel: always enabled — the whole point of the minimize-to-corner
              flow is the user can dismiss during an upload. The URL-source
              path still blocks dismissal because its handleDistribute doesn't
              have a lifted hook; while distributing=true the dialog is the
              only thing holding that promise alive. */}
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            className="bg-secondary border border-border cursor-pointer"
            disabled={distributing}
          >
            {uploading && sourceMode === 'upload' ? 'minimize' : 'cancel'}
          </Button>
          {/*
            Gating: disable until the user has provided enough to submit.
            Required: name, a target machine, and source-specific bytes
            (a URL for `url`, a dropped folder for `upload`). `title`
            surfaces the first missing requirement so the user knows
            what to fill in next.

            `uploading` also disables re-submit — a second start() would
            abort the first one, which is almost never what the user wants.
          */}
          {(() => {
            const missing: string[] = [];
            if (!distributionName.trim()) missing.push('name');
            if (sourceMode === 'url' && !projectUrl.trim()) missing.push('project URL');
            if (sourceMode === 'upload' && (!droppedFiles || droppedFiles.length === 0)) {
              missing.push('folder');
            }
            if (selectedMachines.size === 0) missing.push('target machine');
            const reason =
              missing.length === 0
                ? undefined
                : `needs: ${missing.join(', ')}`;
            const busy = distributing || (sourceMode === 'upload' && uploading);
            const isDisabled = busy || missing.length > 0;
            return (
          <Button
            onClick={
              sourceMode === 'upload' ? handleUploadDistribute : handleDistribute
            }
            className="bg-accent-cyan hover:bg-accent-cyan-hover text-gray-900 cursor-pointer"
            disabled={isDisabled}
            title={reason}
          >
            {busy ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                {uploading && sourceMode === 'upload' ? 'uploading...' : 'distributing...'}
              </>
            ) : (
              <>
                <FolderArchive className="h-4 w-4 mr-2" />
                distribute to {selectedMachines.size} machine{selectedMachines.size !== 1 ? 's' : ''}
              </>
            )}
          </Button>
            );
          })()}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
