'use client';

import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Trash2, Loader2, Package, Search, X } from 'lucide-react';
import { toast } from 'sonner';
import { useMachines } from '@/hooks/useFirestore';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import ConfirmDialog from '@/components/ConfirmDialog';

interface Software {
  name: string;
  version: string;
  publisher: string;
  install_location: string;
  uninstall_command: string;
  installer_type: string;
  registry_key: string;
}

interface UninstallDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  siteId: string;
  onCreateUninstall: (softwareName: string, machineIds: string[], deploymentId?: string) => Promise<void>;
  initialSoftwareName?: string;
  deploymentId?: string;
}

export default function UninstallDialog({
  open,
  onOpenChange,
  siteId,
  onCreateUninstall,
  initialSoftwareName,
  deploymentId,
}: UninstallDialogProps) {
  const { machines } = useMachines(siteId);
  const [selectedMachines, setSelectedMachines] = useState<Set<string>>(new Set());
  const [availableSoftware, setAvailableSoftware] = useState<Software[]>([]);
  const [selectedSoftware, setSelectedSoftware] = useState<string>('');
  const [filterText, setFilterText] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [uninstalling, setUninstalling] = useState(false);
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false);
  const [pendingUninstall, setPendingUninstall] = useState<{ software: Software; machineCount: number } | null>(null);

  const allMachinesSelected = selectedMachines.size === machines.length && machines.length > 0;
  const onlineMachines = machines.filter(m => m.online);

  // Auto-select all online machines when dialog opens and reset filter when it closes
  useEffect(() => {
    if (open && onlineMachines.length > 0 && selectedMachines.size === 0) {
      setSelectedMachines(new Set(onlineMachines.map(m => m.machineId)));
    }
    // Reset filter when dialog closes
    if (!open) {
      setFilterText('');
    }
  }, [open, onlineMachines.length]); // Only run when dialog opens or online machines change

  // Fetch installed software from selected machines
  useEffect(() => {
    if (!open || selectedMachines.size === 0) {
      setAvailableSoftware([]);
      return;
    }

    const fetchSoftware = async () => {
      setLoading(true);
      try {
        // Fetch software from Firestore for selected machines
        const { collection, getDocs } = await import('firebase/firestore');
        const { db } = await import('@/lib/firebase');

        const softwareMap = new Map<string, Software>();

        // Fetch from each selected machine
        for (const machineId of Array.from(selectedMachines)) {
          const machine = machines.find(m => m.machineId === machineId);
          if (!machine || !machine.online) continue; // Only fetch from online machines

          try {
            const softwareRef = collection(db!, 'sites', siteId, 'machines', machineId, 'installed_software');
            const snapshot = await getDocs(softwareRef);

            snapshot.forEach((doc) => {
              const data = doc.data() as Software;
              const key = `${data.name}_${data.version}`;

              // Only add if not already in map (avoid duplicates)
              if (!softwareMap.has(key)) {
                softwareMap.set(key, data);
              }
            });
          } catch (err) {
            console.error(`Failed to fetch software from ${machineId}:`, err);
          }
        }

        const softwareList = Array.from(softwareMap.values());
        softwareList.sort((a, b) => a.name.localeCompare(b.name));
        setAvailableSoftware(softwareList);
      } catch (error: any) {
        console.error('Failed to fetch software:', error);
        toast.error('Failed to fetch installed software');
      } finally {
        setLoading(false);
      }
    };

    fetchSoftware();
  }, [open, selectedMachines, siteId]); // Removed 'machines' to prevent infinite loop

  // Auto-select software and set filter if initialSoftwareName matches
  useEffect(() => {
    if (initialSoftwareName && availableSoftware.length > 0 && !selectedSoftware) {
      // Normalize the search term - remove file extensions and special chars
      const normalizeString = (str: string) => {
        return str
          .toLowerCase()
          .replace(/\.(exe|msi|dmg|pkg)$/i, '') // Remove common file extensions
          .replace(/[-_\s]+/g, '') // Remove dashes, underscores, spaces
          .replace(/[()]/g, ''); // Remove parentheses
      };

      const normalizedSearch = normalizeString(initialSoftwareName);

      // Extract just the first word from the software name for filtering
      const firstWord = initialSoftwareName
        .replace(/\.(exe|msi|dmg|pkg)$/i, '') // Remove file extensions
        .split(/[\s\-_.]+/)[0] // Split by spaces, dashes, underscores, dots and take first word
        .trim();

      // Set the filter text to help narrow down the list
      setFilterText(firstWord);

      // Find best match - try exact match first, then partial match
      const matchingSoftware = availableSoftware.find(s => {
        const normalizedName = normalizeString(s.name);
        // Check if either contains the other (bidirectional matching)
        return normalizedName.includes(normalizedSearch) || normalizedSearch.includes(normalizedName);
      });

      if (matchingSoftware) {
        setSelectedSoftware(`${matchingSoftware.name}_${matchingSoftware.version}`);
      }
    }
  }, [initialSoftwareName, availableSoftware, selectedSoftware]);

  const toggleMachine = (machineId: string) => {
    const newSelected = new Set(selectedMachines);
    if (newSelected.has(machineId)) {
      newSelected.delete(machineId);
    } else {
      newSelected.add(machineId);
    }
    setSelectedMachines(newSelected);
    // Clear selected software and filter when machines change
    setSelectedSoftware('');
    setFilterText('');
  };

  const toggleAllMachines = () => {
    if (allMachinesSelected) {
      setSelectedMachines(new Set());
    } else {
      setSelectedMachines(new Set(machines.map(m => m.machineId)));
    }
    setSelectedSoftware('');
    setFilterText('');
  };

  const selectOnlyOnlineMachines = () => {
    setSelectedMachines(new Set(onlineMachines.map(m => m.machineId)));
    setSelectedSoftware('');
    setFilterText('');
  };

  const handleUninstall = async () => {
    // Validation
    if (selectedMachines.size === 0) {
      toast.error('Please select at least one machine');
      return;
    }

    if (!selectedSoftware) {
      toast.error('Please select software to uninstall');
      return;
    }

    const software = availableSoftware.find(s => `${s.name}_${s.version}` === selectedSoftware);
    if (!software) {
      toast.error('Selected software not found');
      return;
    }

    // Show confirmation dialog
    const machineCount = selectedMachines.size;
    setPendingUninstall({ software, machineCount });
    setConfirmDialogOpen(true);
  };

  const executeUninstall = async () => {
    if (!pendingUninstall) return;

    const { software, machineCount } = pendingUninstall;
    setConfirmDialogOpen(false);
    setUninstalling(true);

    try {
      console.log('Creating uninstall:', {
        softwareName: software.name,
        machineIds: Array.from(selectedMachines),
        deploymentId,
        siteId
      });

      await onCreateUninstall(software.name, Array.from(selectedMachines), deploymentId);

      console.log('Uninstall created successfully');
      toast.success(`Uninstall initiated for ${software.name} on ${machineCount} machine${machineCount > 1 ? 's' : ''}`);

      // Close dialog and reset
      onOpenChange(false);
      setSelectedMachines(new Set());
      setSelectedSoftware('');
      setFilterText('');
      setAvailableSoftware([]);
      setPendingUninstall(null);
    } catch (error: any) {
      console.error('Uninstall error:', error);
      toast.error(error.message || 'Failed to create uninstall task');
      setConfirmDialogOpen(true); // Reopen confirm dialog so user can try again
    } finally {
      setUninstalling(false);
    }
  };

  const selectedSoftwareInfo = availableSoftware.find(s => `${s.name}_${s.version}` === selectedSoftware);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto overflow-x-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Trash2 className="h-5 w-5" />
            uninstall software
          </DialogTitle>
          <DialogDescription>
            select machines and software to uninstall remotely
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4 max-w-full overflow-hidden">
          {/* Step 1: Select Machines */}
          <div className="space-y-3 max-w-full">
            <div className="flex items-center justify-between">
              <Label className="text-base font-semibold">1. select target machines</Label>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={selectOnlyOnlineMachines}
                  disabled={onlineMachines.length === 0}
                >
                  online only ({onlineMachines.length})
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={toggleAllMachines}
                >
                  {allMachinesSelected ? 'deselect all' : 'select all'}
                </Button>
              </div>
            </div>

            <div className="border rounded-md p-4 max-h-48 overflow-y-auto">
              {machines.length === 0 ? (
                <p className="text-sm text-muted-foreground">no machines available</p>
              ) : (
                <div className="space-y-2">
                  {machines.map((machine) => (
                    <div key={machine.machineId} className="flex items-center space-x-2">
                      <Checkbox
                        id={`machine-${machine.machineId}`}
                        checked={selectedMachines.has(machine.machineId)}
                        onCheckedChange={() => toggleMachine(machine.machineId)}
                      />
                      <label
                        htmlFor={`machine-${machine.machineId}`}
                        className="flex-1 text-sm font-medium leading-none cursor-pointer flex items-center gap-2"
                      >
                        {machine.machineId}
                        {machine.online ? (
                          <Badge variant="default" className="ml-2">online</Badge>
                        ) : (
                          <Badge variant="secondary" className="ml-2">offline</Badge>
                        )}
                      </label>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Step 2: Select Software */}
          <div className="space-y-3 max-w-full overflow-hidden">
            <Label className="text-base font-semibold">2. select software to uninstall</Label>

            {selectedMachines.size === 0 ? (
              <p className="text-sm text-muted-foreground">select machines first to see available software</p>
            ) : loading ? (
              <div className="flex items-center gap-2 p-4 border rounded-md">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="text-sm">loading installed software...</span>
              </div>
            ) : availableSoftware.length === 0 ? (
              <p className="text-sm text-muted-foreground">no software detected on selected machines (may need to wait for inventory sync)</p>
            ) : (
              <>
                {/* Inline Software List with Filter */}
                <div className="border rounded-md overflow-hidden max-w-full">
                  {/* Filter Input - Inside the list */}
                  <div className="relative border-b p-3 bg-card overflow-hidden">
                    <Search className="absolute left-6 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                    <Input
                      placeholder="filter software..."
                      value={filterText}
                      onChange={(e) => setFilterText(e.target.value)}
                      className="pl-9 pr-9 h-9"
                    />
                    {filterText && (
                      <button
                        onClick={() => setFilterText('')}
                        className="absolute right-6 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                        type="button"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    )}
                  </div>

                  {/* Scrollable Software List */}
                  <div className="max-h-[300px] overflow-y-auto overflow-x-hidden max-w-full">
                    {(() => {
                      const filteredSoftware = availableSoftware.filter(software =>
                        filterText === '' ||
                        software.name.toLowerCase().includes(filterText.toLowerCase()) ||
                        (software.version && software.version.toLowerCase().includes(filterText.toLowerCase())) ||
                        (software.publisher && software.publisher.toLowerCase().includes(filterText.toLowerCase()))
                      );

                      if (filteredSoftware.length === 0) {
                        return (
                          <div className="p-8 text-center text-muted-foreground">
                            <Package className="h-8 w-8 mx-auto mb-2 opacity-50" />
                            <p className="text-sm">No software matches "{filterText}"</p>
                          </div>
                        );
                      }

                      return (
                        <div className="divide-y max-w-full">
                          {filteredSoftware.map((software) => {
                            const softwareKey = `${software.name}_${software.version}`;
                            const isSelected = selectedSoftware === softwareKey;

                            return (
                              <div
                                key={softwareKey}
                                onClick={() => setSelectedSoftware(isSelected ? '' : softwareKey)}
                                className={`p-3 cursor-pointer transition-colors overflow-hidden relative ${
                                  isSelected
                                    ? 'bg-primary/10 border-l-4 border-l-primary'
                                    : 'hover:bg-accent border-l-4 border-l-transparent'
                                }`}
                                style={{ width: '100%', maxWidth: '100%' }}
                              >
                                <div className="flex items-center gap-3">
                                  <Package className={`h-4 w-4 shrink-0 ${isSelected ? 'text-primary' : 'text-muted-foreground'}`} />
                                  <div className="flex-1 min-w-0" style={{ maxWidth: 'calc(100% - 2rem)' }}>
                                    <p className={`text-sm font-medium truncate ${isSelected ? 'text-primary' : ''}`} title={software.name}>
                                      {software.name}
                                    </p>
                                    {software.publisher && (
                                      <p className="text-xs text-muted-foreground truncate" title={software.publisher}>{software.publisher}</p>
                                    )}
                                  </div>
                                  {isSelected && (
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setSelectedSoftware('');
                                      }}
                                      className="shrink-0 ml-2 p-1 rounded-sm hover:bg-primary/20 transition-colors cursor-pointer"
                                      title="Deselect"
                                    >
                                      <X className="h-4 w-4 text-primary" />
                                    </button>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })()}
                  </div>
                </div>

                {/* Software Details */}
                {selectedSoftwareInfo && (
                  <Card className="mt-3">
                    <CardContent className="pt-4 space-y-2">
                      <div className="grid grid-cols-2 gap-2 text-sm">
                        <div className="overflow-hidden">
                          <span className="font-semibold">name:</span> <span className="truncate inline-block max-w-full align-bottom">{selectedSoftwareInfo.name}</span>
                        </div>
                        <div className="overflow-hidden">
                          <span className="font-semibold">version:</span> <span className="truncate inline-block max-w-full align-bottom">{selectedSoftwareInfo.version || 'N/A'}</span>
                        </div>
                        <div className="overflow-hidden">
                          <span className="font-semibold">publisher:</span> <span className="truncate inline-block max-w-full align-bottom">{selectedSoftwareInfo.publisher || 'N/A'}</span>
                        </div>
                        <div className="overflow-hidden">
                          <span className="font-semibold">type:</span> <span className="truncate inline-block max-w-full align-bottom">{selectedSoftwareInfo.installer_type.toUpperCase()}</span>
                        </div>
                        {selectedSoftwareInfo.install_location && (
                          <div className="col-span-2 overflow-hidden">
                            <span className="font-semibold">location:</span>
                            <span className="text-muted-foreground ml-1 font-mono text-xs truncate block">{selectedSoftwareInfo.install_location}</span>
                          </div>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                )}
              </>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={uninstalling}>
            cancel
          </Button>
          <Button
            onClick={handleUninstall}
            disabled={selectedMachines.size === 0 || !selectedSoftware || uninstalling}
            variant="destructive"
          >
            {uninstalling ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                uninstalling...
              </>
            ) : (
              <>
                <Trash2 className="mr-2 h-4 w-4" />
                uninstall software
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>

      <ConfirmDialog
        open={confirmDialogOpen}
        onOpenChange={setConfirmDialogOpen}
        title="confirm uninstall"
        description={
          pendingUninstall
            ? `uninstall "${pendingUninstall.software.name}" from ${pendingUninstall.machineCount} machine${pendingUninstall.machineCount > 1 ? 's' : ''}?\n\nthis action cannot be undone.`
            : ''
        }
        confirmText="uninstall"
        cancelText="cancel"
        onConfirm={executeUninstall}
        variant="destructive"
      />
    </Dialog>
  );
}
