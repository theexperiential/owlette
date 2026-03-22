'use client';

import { useState, useEffect } from 'react';
import { useSchedulePresets, type SchedulePreset } from '@/hooks/useSchedulePresets';
import { useSites } from '@/hooks/useFirestore';
import { useAuth } from '@/contexts/AuthContext';
import { formatScheduleSummary } from '@/components/ScheduleEditor';
import WeekSummaryBar from '@/components/WeekSummaryBar';
import SchedulePresetDialog from '@/components/SchedulePresetDialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Plus, Loader2, Pencil, Trash2, Clock } from 'lucide-react';
import { toast } from 'sonner';

export default function SchedulePresetsPage() {
  const { user, isAdmin, userSites } = useAuth();
  const { sites } = useSites(user?.uid, userSites, isAdmin);

  // Use first site by default
  const [selectedSiteId, setSelectedSiteId] = useState<string | null>(null);

  useEffect(() => {
    if (sites.length > 0 && !selectedSiteId) {
      setSelectedSiteId(sites[0].id);
    }
  }, [sites, selectedSiteId]);

  const {
    presets,
    loading,
    error,
    deletePreset,
    seedBuiltInPresets,
  } = useSchedulePresets(selectedSiteId);

  const [presetDialogOpen, setPresetDialogOpen] = useState(false);
  const [editingPreset, setEditingPreset] = useState<SchedulePreset | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [presetToDelete, setPresetToDelete] = useState<SchedulePreset | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [seeding, setSeeding] = useState(false);

  const handleCreateNew = () => {
    setEditingPreset(null);
    setPresetDialogOpen(true);
  };

  const handleEdit = (preset: SchedulePreset) => {
    setEditingPreset(preset);
    setPresetDialogOpen(true);
  };

  const handleDelete = (preset: SchedulePreset) => {
    setPresetToDelete(preset);
    setDeleteDialogOpen(true);
  };

  const confirmDelete = async () => {
    if (!presetToDelete) return;
    setDeleting(true);
    try {
      await deletePreset(presetToDelete.id);
      toast.success(`Preset "${presetToDelete.name}" deleted`);
      setDeleteDialogOpen(false);
      setPresetToDelete(null);
    } catch (err: any) {
      toast.error(err.message || 'Failed to delete preset');
    } finally {
      setDeleting(false);
    }
  };

  const handleSeedDefaults = async () => {
    if (!user?.uid) return;
    setSeeding(true);
    try {
      await seedBuiltInPresets(user.uid);
      toast.success('Built-in schedule presets created');
    } catch (err: any) {
      toast.error(err.message || 'Failed to seed presets');
    } finally {
      setSeeding(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="flex items-center gap-3 text-foreground">
          <Loader2 className="h-6 w-6 animate-spin" />
          <span>Loading schedule presets...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <p className="text-red-400 font-medium mb-2">Error loading schedule presets</p>
          <p className="text-muted-foreground text-sm">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-6">
      <div className="max-w-screen-2xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="text-3xl font-bold text-foreground mb-2">Schedule Presets</h1>
              <p className="text-muted-foreground">
                Manage reusable schedule presets for process scheduling across machines
              </p>
            </div>
            <div className="flex items-center gap-3">
              {sites.length > 1 && (
                <Select value={selectedSiteId || ''} onValueChange={setSelectedSiteId}>
                  <SelectTrigger className="w-[180px] border-border bg-card text-foreground">
                    <SelectValue placeholder="Select site" />
                  </SelectTrigger>
                  <SelectContent className="border-border bg-card text-foreground">
                    {sites.map(site => (
                      <SelectItem key={site.id} value={site.id}>{site.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <Button
                onClick={handleCreateNew}
                className="bg-accent-cyan hover:bg-accent-cyan-hover text-gray-900 cursor-pointer"
              >
                <Plus className="h-5 w-5 mr-2" />
                Create Preset
              </Button>
            </div>
          </div>
        </div>

        {/* Empty state */}
        {presets.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Clock className="h-12 w-12 text-muted-foreground/30 mb-4" />
            <h3 className="text-lg font-medium text-foreground mb-2">No schedule presets</h3>
            <p className="text-muted-foreground text-sm mb-6 max-w-md">
              Schedule presets let you define reusable time schedules that can be quickly applied to any process.
            </p>
            <div className="flex gap-3">
              <Button
                variant="outline"
                onClick={handleSeedDefaults}
                disabled={seeding}
                className="cursor-pointer"
              >
                {seeding && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Load Built-in Defaults
              </Button>
              <Button
                onClick={handleCreateNew}
                className="bg-accent-cyan hover:bg-accent-cyan-hover text-gray-900 cursor-pointer"
              >
                <Plus className="h-4 w-4 mr-2" />
                Create Custom
              </Button>
            </div>
          </div>
        )}

        {/* Presets table */}
        {presets.length > 0 && (
          <div className="space-y-3">
            {presets.map((preset) => (
              <div
                key={preset.id}
                className="flex items-center gap-4 p-4 rounded-lg border border-border bg-card"
              >
                <WeekSummaryBar schedules={preset.blocks} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-foreground font-medium">{preset.name}</span>
                    {preset.isBuiltIn && (
                      <Badge className="bg-blue-600/20 text-blue-400 text-[10px]">built-in</Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground truncate">
                    {preset.description || formatScheduleSummary(preset.blocks)}
                  </p>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleEdit(preset)}
                    className="bg-card border-border text-foreground hover:bg-muted cursor-pointer"
                  >
                    <Pencil className="h-3 w-3 mr-1" />
                    Edit
                  </Button>
                  {!preset.isBuiltIn && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleDelete(preset)}
                      className="bg-card border-border text-red-400 hover:bg-red-900 hover:border-red-800 hover:text-red-200 cursor-pointer"
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  )}
                </div>
              </div>
            ))}

            {/* Seed defaults button if no built-ins exist */}
            {!presets.some(p => p.isBuiltIn) && (
              <div className="pt-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleSeedDefaults}
                  disabled={seeding}
                  className="text-muted-foreground cursor-pointer"
                >
                  {seeding && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Load Built-in Defaults
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Create/Edit Dialog */}
      {selectedSiteId && user?.uid && (
        <SchedulePresetDialog
          open={presetDialogOpen}
          onOpenChange={setPresetDialogOpen}
          preset={editingPreset}
          siteId={selectedSiteId}
          userId={user.uid}
        />
      )}

      {/* Delete Confirmation */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent className="bg-card border-border text-foreground">
          <DialogHeader>
            <DialogTitle>Delete Schedule Preset</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Are you sure you want to delete &quot;{presetToDelete?.name}&quot;? This will not affect processes already using this schedule.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialogOpen(false)} className="cursor-pointer">
              Cancel
            </Button>
            <Button
              onClick={confirmDelete}
              disabled={deleting}
              className="bg-red-600 hover:bg-red-700 text-white cursor-pointer"
            >
              {deleting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
