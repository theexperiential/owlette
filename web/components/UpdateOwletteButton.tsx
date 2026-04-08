/**
 * UpdateOwletteButton Component
 *
 * Provides a one-click button to update all owlette agents to the latest version.
 * Displays current version, outdated machine count, and confirmation dialog.
 *
 * Features:
 * - Shows latest available version
 * - Counts machines needing updates
 * - Confirmation dialog with machine selection
 * - Progress tracking during update
 * - Success/error notifications
 */

'use client';

import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { RefreshCw, AlertCircle, AlertTriangle, CheckCircle2, Loader2, X } from 'lucide-react';
import { useOwletteUpdates } from '@/hooks/useOwletteUpdates';
import { Machine } from '@/hooks/useFirestore';
import { toast } from 'sonner';

interface UpdateOwletteButtonProps {
  siteId: string;
  machines: Machine[];
}

export function UpdateOwletteButton({ siteId, machines }: UpdateOwletteButtonProps) {
  const {
    outdatedMachines,
    latestVersion,
    totalMachinesNeedingUpdate,
    isLoading,
    updateMachines,
    updatingMachines,
    cancelUpdate,
    staleMachines,
  } = useOwletteUpdates(machines);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedMachines, setSelectedMachines] = useState<Set<string>>(new Set());
  const [isUpdating, setIsUpdating] = useState(false);

  // Initialize selected machines when dialog opens
  const handleOpenDialog = () => {
    // Select all outdated machines by default
    setSelectedMachines(new Set(outdatedMachines.map(m => m.machineId)));
    setDialogOpen(true);
  };

  const handleToggleMachine = (machineId: string) => {
    setSelectedMachines(prev => {
      const newSet = new Set(prev);
      if (newSet.has(machineId)) {
        newSet.delete(machineId);
      } else {
        newSet.add(machineId);
      }
      return newSet;
    });
  };

  const handleSelectAll = () => {
    setSelectedMachines(new Set(outdatedMachines.map(m => m.machineId)));
  };

  const handleDeselectAll = () => {
    setSelectedMachines(new Set());
  };

  const handleUpdate = async () => {
    if (selectedMachines.size === 0) {
      toast.error('Please select at least one machine to update');
      return;
    }

    setIsUpdating(true);

    try {
      await updateMachines(siteId, Array.from(selectedMachines));

      toast.success(
        `Update initiated for ${selectedMachines.size} machine(s)`,
        {
          description: 'The owlette service will restart automatically after updating',
          duration: 5000,
        }
      );

      setDialogOpen(false);
      setSelectedMachines(new Set());
    } catch (error) {
      console.error('Failed to update machines:', error);
      toast.error(
        'Failed to initiate update',
        {
          description: error instanceof Error ? error.message : 'Unknown error occurred',
          duration: 5000,
        }
      );
    } finally {
      setIsUpdating(false);
    }
  };

  // Don't show button if no machines or all up-to-date
  if (isLoading || totalMachinesNeedingUpdate === 0) {
    return null;
  }

  // Count machines currently being updated
  const inProgressCount = updatingMachines.size;

  return (
    <>
      <Button
        onClick={handleOpenDialog}
        variant="outline"
        className="border-orange-600 text-orange-600 hover:bg-orange-50 dark:hover:bg-orange-950 cursor-pointer"
      >
        <RefreshCw className={`h-4 w-4 mr-2 ${inProgressCount > 0 ? 'animate-spin' : ''}`} />
        {inProgressCount > 0 ? 'updating owlette' : 'update owlette'}
        {latestVersion && (
          <span className="ml-2 text-xs">to v{latestVersion}</span>
        )}
        {totalMachinesNeedingUpdate > 0 && (
          <Badge className="ml-2 bg-orange-600 text-white">
            {totalMachinesNeedingUpdate}
          </Badge>
        )}
        {inProgressCount > 0 && (
          <Badge className="ml-2 bg-accent-cyan text-gray-900">
            in progress: {inProgressCount}
          </Badge>
        )}
      </Button>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>update owlette agents</DialogTitle>
            <DialogDescription>
              update selected machines to owlette v{latestVersion || 'latest'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {/* Info banner */}
            <div className="bg-accent-cyan/10 border border-accent-cyan/30 rounded-lg p-4">
              <div className="flex items-start gap-3">
                <AlertCircle className="h-5 w-5 text-accent-cyan mt-0.5 flex-shrink-0" />
                <div className="text-sm text-foreground">
                  <p className="font-medium mb-1">what happens during an update:</p>
                  <ul className="list-disc list-inside space-y-1 text-muted-foreground">
                    <li>the owlette service will stop automatically</li>
                    <li>the new version will install silently</li>
                    <li>the owlette service will restart automatically</li>
                    <li>the machine will appear online again within 1-2 minutes</li>
                  </ul>
                </div>
              </div>
            </div>

            {/* Machine selection */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-medium">
                  select machines to update ({selectedMachines.size} of {outdatedMachines.length} selected)
                </h3>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={handleSelectAll}
                    disabled={selectedMachines.size === outdatedMachines.length}
                  >
                    select all
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={handleDeselectAll}
                    disabled={selectedMachines.size === 0}
                  >
                    deselect all
                  </Button>
                </div>
              </div>

              <div className="border rounded-lg divide-y max-h-96 overflow-y-auto">
                {outdatedMachines.map((machine) => {
                  const isSelected = selectedMachines.has(machine.machineId);
                  const isMachineUpdating = updatingMachines.has(machine.machineId);
                  const isStale = staleMachines.has(machine.machineId);

                  return (
                    <label
                      key={machine.machineId}
                      className="flex items-center gap-4 p-4 hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer"
                    >
                      <Checkbox
                        checked={isSelected}
                        onCheckedChange={() => handleToggleMachine(machine.machineId)}
                        disabled={isMachineUpdating && !isStale}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-3 mb-1">
                          <span className="font-medium truncate">
                            {machine.machineId}
                          </span>
                        </div>
                        <div className="text-sm text-gray-500 dark:text-gray-400">
                          current: {machine.agent_version ? `v${machine.agent_version}` : '< v2.0.8'} → latest: v{latestVersion}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {isMachineUpdating && !isStale && (
                          <>
                            <Badge variant="secondary" className="flex items-center gap-1.5 px-3 py-1">
                              <Loader2 className="h-3 w-3 animate-spin" />
                              updating...
                            </Badge>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-8 px-2 text-xs hover:bg-gray-100 dark:hover:bg-gray-700"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                cancelUpdate(machine.machineId);
                                toast.info('Update status cleared', {
                                  description: `Cleared updating status for ${machine.machineId}`,
                                  duration: 3000,
                                });
                              }}
                            >
                              <X className="h-3.5 w-3.5 mr-1" />
                              clear
                            </Button>
                          </>
                        )}
                        {isStale && (
                          <>
                            <Badge variant="destructive" className="flex items-center gap-1.5 px-3 py-1">
                              <AlertTriangle className="h-3 w-3" />
                              may have failed
                            </Badge>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-8 px-2 text-xs hover:bg-gray-100 dark:hover:bg-gray-700"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                cancelUpdate(machine.machineId);
                                toast.info('Update status cleared — you can retry', {
                                  description: `Cleared stale update status for ${machine.machineId}`,
                                  duration: 3000,
                                });
                              }}
                            >
                              <X className="h-3.5 w-3.5 mr-1" />
                              clear
                            </Button>
                          </>
                        )}
                        {machine.online ? (
                          <Badge className="bg-green-100 text-green-800 border-green-200 px-3 py-1">
                            online
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="px-3 py-1">
                            offline
                          </Badge>
                        )}
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDialogOpen(false)}
              disabled={isUpdating}
            >
              cancel
            </Button>
            <Button
              type="button"
              onClick={handleUpdate}
              disabled={isUpdating || selectedMachines.size === 0}
              className="bg-orange-600 hover:bg-orange-700 text-white"
            >
              {isUpdating ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  updating...
                </>
              ) : (
                <>
                  <CheckCircle2 className="h-4 w-4 mr-2" />
                  update {selectedMachines.size} machine{selectedMachines.size !== 1 ? 's' : ''}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
