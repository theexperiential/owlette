'use client';

import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { AlertTriangle, ChevronDown, ChevronRight, Download, Loader2, Pencil, Save, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useMachines, Process } from '@/hooks/useFirestore';
import { DeploymentTemplate, Deployment } from '@/hooks/useDeployments';
import { Badge } from '@/components/ui/badge';
import { useSystemPresets } from '@/hooks/useSystemPresets';
import { SelectGroup, SelectLabel } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface DeploymentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  siteId: string;
  templates: DeploymentTemplate[];
  onCreateDeployment: (deployment: Omit<Deployment, 'id' | 'createdAt' | 'status'>, machineIds: string[]) => Promise<string>;
  onCreateTemplate: (template: Omit<DeploymentTemplate, 'id' | 'createdAt'>) => Promise<string>;
  onUpdateTemplate: (templateId: string, template: Partial<Omit<DeploymentTemplate, 'id' | 'createdAt'>>) => Promise<void>;
  onDeleteTemplate: (templateId: string) => Promise<void>;
}

// Prefix constants for the unified select value
const PRESET_PREFIX = 'preset:';
const TEMPLATE_PREFIX = 'template:';

export default function DeploymentDialog({
  open,
  onOpenChange,
  siteId,
  templates,
  onCreateDeployment,
  onCreateTemplate,
  onUpdateTemplate,
  onDeleteTemplate,
}: DeploymentDialogProps) {
  const { machines } = useMachines(siteId);
  const { presets, categories } = useSystemPresets();

  const [deploymentName, setDeploymentName] = useState('');
  const [installerName, setInstallerName] = useState('');
  const [installerUrl, setInstallerUrl] = useState('');
  const [silentFlags, setSilentFlags] = useState('');
  const [verifyPath, setVerifyPath] = useState('');
  const [selectedMachines, setSelectedMachines] = useState<Set<string>>(new Set());
  const [deploying, setDeploying] = useState(false);
  const [selectedItem, setSelectedItem] = useState<string>('');  // 'preset:id' or 'template:id'
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showCloseProcesses, setShowCloseProcesses] = useState(false);
  const [selectedProjectIds, setSelectedProjectIds] = useState<Set<string>>(new Set());
  const [additionalProcesses, setAdditionalProcesses] = useState('');
  const [parallelInstall, setParallelInstall] = useState(false);
  const [editingName, setEditingName] = useState(false);

  const allMachinesSelected = selectedMachines.size === machines.length && machines.length > 0;
  const onlineMachines = machines.filter(m => m.online);

  // Derive selection type from the unified selectedItem
  const isTemplateSelected = selectedItem.startsWith(TEMPLATE_PREFIX);
  const isPresetSelected = selectedItem.startsWith(PRESET_PREFIX);
  const selectedTemplateId = isTemplateSelected ? selectedItem.slice(TEMPLATE_PREFIX.length) : '';

  // Filter out Owlette Agent presets from the library
  const filteredPresets = presets.filter(p => !p.is_owlette_agent);
  const filteredCategories = categories.filter(cat =>
    filteredPresets.some(p => p.category === cat)
  );

  const hasItems = filteredPresets.length > 0 || templates.length > 0;

  // Get display name for the selected item
  const getSelectedLabel = (): string => {
    if (!selectedItem) return '';
    if (selectedItem.startsWith(PRESET_PREFIX)) {
      const id = selectedItem.slice(PRESET_PREFIX.length);
      return filteredPresets.find(p => p.id === id)?.name || '';
    }
    if (selectedItem.startsWith(TEMPLATE_PREFIX)) {
      const id = selectedItem.slice(TEMPLATE_PREFIX.length);
      return templates.find(t => t.id === id)?.name || '';
    }
    return '';
  };

  // Reset form when modal opens
  useEffect(() => {
    if (open) {
      setDeploymentName('');
      setInstallerName('');
      setInstallerUrl('');
      setSilentFlags('');
      setVerifyPath('');
      setSelectedMachines(new Set());
      setSelectedItem('');
      setShowCloseProcesses(false);
      setSelectedProjectIds(new Set());
      setAdditionalProcesses('');
      setParallelInstall(false);
    }
  }, [open]);

  const handleItemSelect = (value: string) => {
    if (value === 'none') {
      setSelectedItem('');
      return;
    }

    setSelectedItem(value);

    if (value.startsWith(PRESET_PREFIX)) {
      const presetId = value.slice(PRESET_PREFIX.length);
      const preset = filteredPresets.find(p => p.id === presetId);
      if (preset) {
        setDeploymentName(`Deploy ${preset.software_name}`);
        setInstallerName(preset.installer_name);
        setInstallerUrl(preset.installer_url);
        setSilentFlags(preset.silent_flags);
        setVerifyPath(preset.verify_path || '');
        setParallelInstall(preset.parallel_install || false);
        if (preset.close_processes?.length) {
          setAdditionalProcesses(preset.close_processes.join(', '));
          setShowCloseProcesses(true);
        } else {
          setAdditionalProcesses('');
        }
      }
    } else if (value.startsWith(TEMPLATE_PREFIX)) {
      const templateId = value.slice(TEMPLATE_PREFIX.length);
      const template = templates.find(t => t.id === templateId);
      if (template) {
        setDeploymentName(template.name);
        setInstallerName(template.installer_name);
        setInstallerUrl(template.installer_url);
        setSilentFlags(template.silent_flags);
        setVerifyPath(template.verify_path || '');
        setParallelInstall(template.parallel_install || false);
        if (template.close_processes?.length) {
          setAdditionalProcesses(template.close_processes.join(', '));
          setShowCloseProcesses(true);
        } else {
          setAdditionalProcesses('');
        }
      }
    }
  };

  const handleSaveTemplate = async () => {
    if (!deploymentName.trim()) {
      // Switch to edit mode so user can type a name
      setEditingName(true);
      toast.error('Enter a name first');
      return;
    }

    // Build close_processes for template
    const templateCloseProcesses: string[] = [];
    machines
      .filter(m => selectedMachines.has(m.machineId))
      .forEach(machine => {
        (machine.processes || []).forEach((proc: Process) => {
          if (selectedProjectIds.has(proc.id)) {
            const exeName = proc.exe_path?.split(/[/\\]/).pop() || '';
            if (exeName && !templateCloseProcesses.includes(exeName)) templateCloseProcesses.push(exeName);
          }
        });
      });
    const additionalNames = additionalProcesses.split(',').map(s => s.trim()).filter(Boolean);
    additionalNames.forEach(name => {
      if (!templateCloseProcesses.includes(name)) templateCloseProcesses.push(name);
    });

    const templateData: any = {
      name: deploymentName,
      installer_name: installerName,
      installer_url: installerUrl,
      silent_flags: silentFlags,
      parallel_install: parallelInstall,
    };
    if (verifyPath?.trim()) templateData.verify_path = verifyPath.trim();
    if (templateCloseProcesses.length > 0) templateData.close_processes = templateCloseProcesses;

    try {
      if (isTemplateSelected) {
        // Update existing user-saved template
        await onUpdateTemplate(selectedTemplateId, templateData);
        toast.success('Template updated');
      } else {
        // Save as new template (also covers system presets — never overwrite those)
        const newId = await onCreateTemplate(templateData);
        setSelectedItem(`${TEMPLATE_PREFIX}${newId}`);
        toast.success('Saved as new template');
      }
    } catch (error: any) {
      toast.error(error.message || 'Failed to save template');
    }
  };

  const handleDeleteTemplate = () => {
    if (!selectedTemplateId) return;
    setShowDeleteConfirm(true);
  };

  const confirmDeleteTemplate = async () => {
    if (!selectedTemplateId) return;

    try {
      await onDeleteTemplate(selectedTemplateId);
      toast.success('Template deleted successfully');

      setSelectedItem('');
      setDeploymentName('');
      setInstallerName('');
      setInstallerUrl('');
      setSilentFlags('');
      setVerifyPath('');
      setShowDeleteConfirm(false);
    } catch (error: any) {
      toast.error(error.message || 'Failed to delete template');
      setShowDeleteConfirm(false);
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

  const handleDeploy = async () => {
    // Auto-derive deployment name if not set
    const effectiveName = deploymentName.trim() || getSelectedLabel() || installerName || 'Deployment';

    if (!installerName.trim()) {
      toast.error('Please provide an installer URL');
      return;
    }

    if (!installerUrl.trim()) {
      toast.error('Please provide an installer URL');
      return;
    }

    try {
      new URL(installerUrl);
    } catch (e) {
      toast.error('Invalid installer URL format');
      return;
    }

    if (selectedMachines.size === 0) {
      toast.error('Please select at least one machine');
      return;
    }

    setDeploying(true);

    try {
      // Build deployment object
      const deploymentData: any = {
        name: effectiveName,
        installer_name: installerName,
        installer_url: installerUrl,
        silent_flags: silentFlags,
        parallel_install: parallelInstall,
        targets: [],
      };

      if (verifyPath?.trim()) deploymentData.verify_path = verifyPath.trim();

      // Build close_processes and suppress_projects from UI selections
      const closeProcesses: string[] = [];
      const suppressProjects: string[] = [];

      // Add exe names from selected managed projects
      machines
        .filter(m => selectedMachines.has(m.machineId))
        .forEach(machine => {
          (machine.processes || []).forEach((proc: Process) => {
            if (selectedProjectIds.has(proc.id)) {
              if (!suppressProjects.includes(proc.id)) suppressProjects.push(proc.id);
              const exeName = proc.exe_path?.split(/[/\\]/).pop() || '';
              if (exeName && !closeProcesses.includes(exeName)) closeProcesses.push(exeName);
            }
          });
        });

      // Add free-text process names
      const additionalNames = additionalProcesses.split(',').map(s => s.trim()).filter(Boolean);
      additionalNames.forEach(name => {
        if (!closeProcesses.includes(name)) closeProcesses.push(name);
      });

      if (closeProcesses.length > 0) deploymentData.close_processes = closeProcesses;
      if (suppressProjects.length > 0) deploymentData.suppress_projects = suppressProjects;

      const deploymentId = await onCreateDeployment(
        deploymentData,
        Array.from(selectedMachines)
      );

      toast.success(`Deployment started! Installing on ${selectedMachines.size} machine${selectedMachines.size > 1 ? 's' : ''}`);

      setDeploymentName('');
      setInstallerName('');
      setInstallerUrl('');
      setSilentFlags('');
      setVerifyPath('');
      setParallelInstall(false);
      setEditingName(false);
      setSelectedMachines(new Set());
      setSelectedItem('');
      setSelectedProjectIds(new Set());
      setAdditionalProcesses('');
      setShowCloseProcesses(false);

      onOpenChange(false);
    } catch (error: any) {
      console.error('Deployment error:', error);
      toast.error(error.message || 'Failed to create deployment');
    } finally {
      setDeploying(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-secondary text-white max-w-3xl max-h-[90vh] overflow-y-auto overflow-x-hidden">
        <DialogHeader>
          <DialogTitle className="text-white">deploy software</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            install software across multiple machines simultaneously
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4 pr-2">
          {/* Template — single row: dropdown/edit + pencil + save + trash */}
          <div className="space-y-2">
            <Label className="text-white">template</Label>
            <div className="flex gap-2">
              {editingName ? (
                <Input
                  placeholder="e.g., TouchDesigner 2025.32280"
                  value={deploymentName}
                  onChange={(e) => setDeploymentName(e.target.value)}
                  className="border-border bg-background text-white flex-1"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setEditingName(false);
                  }}
                />
              ) : (
                <Select value={selectedItem} onValueChange={(value) => {
                  handleItemSelect(value);
                  setEditingName(false);
                }}>
                  <SelectTrigger className="border-border bg-background text-white flex-1 overflow-hidden">
                    {selectedItem ? (
                      <span className="truncate">{deploymentName || getSelectedLabel()}</span>
                    ) : (
                      <span className="text-muted-foreground">select or create template...</span>
                    )}
                  </SelectTrigger>
                  <SelectContent className="border-border bg-secondary">
                    <SelectItem value="none" className="text-white focus:bg-accent focus:text-white">
                      none
                    </SelectItem>
                    {/* Library presets by category */}
                    {filteredCategories.map(category => {
                      const categoryPresets = filteredPresets.filter(p => p.category === category);
                      if (categoryPresets.length === 0) return null;

                      return (
                        <SelectGroup key={category}>
                          <SelectLabel className="text-muted-foreground">{category}</SelectLabel>
                          {categoryPresets.map(preset => (
                            <SelectItem
                              key={preset.id}
                              value={`${PRESET_PREFIX}${preset.id}`}
                              className="text-white focus:bg-accent focus:text-white"
                            >
                              <span className="flex items-center gap-2">
                                {preset.icon && <span>{preset.icon}</span>}
                                <span>{preset.name}</span>
                              </span>
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      );
                    })}
                    {/* User saved templates */}
                    {templates.length > 0 && (
                      <SelectGroup>
                        <SelectLabel className="text-muted-foreground">Saved</SelectLabel>
                        {templates.map((template) => (
                          <SelectItem
                            key={template.id}
                            value={`${TEMPLATE_PREFIX}${template.id}`}
                            className="text-white focus:bg-accent focus:text-white"
                          >
                            {template.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    )}
                  </SelectContent>
                </Select>
              )}
              {/* Action buttons — hidden for system presets */}
              {!isPresetSelected && (
                <>
                  {/* Pencil: toggle edit name mode */}
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={() => {
                      if (!editingName && !deploymentName) {
                        setDeploymentName(getSelectedLabel());
                      }
                      setEditingName(!editingName);
                    }}
                    className={`border-border bg-background cursor-pointer shrink-0 ${editingName ? 'text-accent-cyan hover:bg-accent-cyan/20 hover:text-accent-cyan' : 'text-white hover:bg-muted hover:text-white'}`}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  {/* Save template */}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        onClick={handleSaveTemplate}
                        className="border-border bg-background text-white hover:bg-muted hover:text-white cursor-pointer shrink-0"
                      >
                        <Save className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{isTemplateSelected ? 'save changes to template' : 'save as new template'}</p>
                    </TooltipContent>
                  </Tooltip>
                  {/* Delete template */}
                  {isTemplateSelected && (
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={handleDeleteTemplate}
                      className="border-border bg-background text-red-400 hover:bg-red-900 hover:text-red-300 cursor-pointer shrink-0"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Installer URL */}
          <div className="space-y-2">
            <Label htmlFor="installer-url" className="text-white">installer URL</Label>
            <Input
              id="installer-url"
              placeholder="https://example.com/installer.exe"
              value={installerUrl}
              onChange={(e) => {
                setInstallerUrl(e.target.value);
                // Auto-derive installer filename from URL
                try {
                  const url = new URL(e.target.value);
                  const filename = url.pathname.split('/').pop() || '';
                  if (filename && filename.includes('.')) setInstallerName(filename);
                } catch { /* ignore invalid URLs while typing */ }
              }}
              className="border-border bg-background text-white font-mono text-sm"
            />
            {installerName && (
              <p className="text-xs text-muted-foreground">filename: {installerName}</p>
            )}
          </div>

          {/* Silent Flags */}
          <div className="space-y-2">
            <Label htmlFor="silent-flags" className="text-white">silent install flags</Label>
            <Input
              id="silent-flags"
              placeholder='/VERYSILENT /DIR="C:\\Program Files\\App"'
              value={silentFlags}
              onChange={(e) => setSilentFlags(e.target.value)}
              className="border-border bg-background text-white"
            />
            <p className="text-xs text-muted-foreground">command-line flags for silent installation</p>
          </div>

          {/* Parallel Install */}
          <div className="flex items-center gap-2">
            <Checkbox
              id="parallel-install"
              checked={parallelInstall}
              onCheckedChange={(checked) => setParallelInstall(checked as boolean)}
              className="cursor-pointer"
            />
            <div>
              <Label htmlFor="parallel-install" className="text-white cursor-pointer">
                parallel install (keep existing versions)
              </Label>
              <p className="text-xs text-muted-foreground">
                install alongside existing versions instead of replacing them
              </p>
            </div>
          </div>

          {/* Close Running Processes (collapsible) */}
          <div className="space-y-2">
            <button
              type="button"
              className="flex items-center gap-2 text-sm text-muted-foreground hover:text-white transition-colors"
              onClick={() => setShowCloseProcesses(!showCloseProcesses)}
            >
              {showCloseProcesses ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              close running processes before install
              {(selectedProjectIds.size > 0 || additionalProcesses.trim()) && (
                <Badge className="bg-amber-600 text-xs ml-1">active</Badge>
              )}
            </button>

            {showCloseProcesses && (
              <div className="space-y-3 pl-5">
                {/* Managed projects from selected machines */}
                {(() => {
                  // Collect unique processes across selected machines
                  const managedProcesses: { id: string; name: string; exeName: string; machineIds: string[] }[] = [];
                  const seenNames = new Set<string>();

                  machines
                    .filter(m => selectedMachines.has(m.machineId))
                    .forEach(machine => {
                      (machine.processes || []).forEach((proc: Process) => {
                        const exeName = proc.exe_path?.split(/[/\\]/).pop() || '';
                        const key = `${proc.name}-${exeName}`;
                        if (!seenNames.has(key)) {
                          seenNames.add(key);
                          managedProcesses.push({
                            id: proc.id,
                            name: proc.name,
                            exeName,
                            machineIds: [machine.machineId],
                          });
                        } else {
                          const existing = managedProcesses.find(p => `${p.name}-${p.exeName}` === key);
                          if (existing) existing.machineIds.push(machine.machineId);
                        }
                      });
                    });

                  if (managedProcesses.length === 0 && selectedMachines.size === 0) {
                    return (
                      <p className="text-xs text-muted-foreground">select target machines to see managed processes</p>
                    );
                  }

                  if (managedProcesses.length === 0) {
                    return (
                      <p className="text-xs text-muted-foreground">no managed processes on selected machines</p>
                    );
                  }

                  return (
                    <div className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground">managed processes</Label>
                      {managedProcesses.map(proc => (
                        <div
                          key={proc.id}
                          className="flex items-center gap-2 cursor-pointer"
                          onClick={() => {
                            const newSet = new Set(selectedProjectIds);
                            if (newSet.has(proc.id)) {
                              newSet.delete(proc.id);
                            } else {
                              newSet.add(proc.id);
                            }
                            setSelectedProjectIds(newSet);
                          }}
                        >
                          <Checkbox
                            checked={selectedProjectIds.has(proc.id)}
                            onCheckedChange={() => {
                              const newSet = new Set(selectedProjectIds);
                              if (newSet.has(proc.id)) {
                                newSet.delete(proc.id);
                              } else {
                                newSet.add(proc.id);
                              }
                              setSelectedProjectIds(newSet);
                            }}
                            className="cursor-pointer"
                          />
                          <span className="text-white text-sm">{proc.name}</span>
                          <span className="text-muted-foreground text-xs">({proc.exeName})</span>
                        </div>
                      ))}
                    </div>
                  );
                })()}

                {/* Additional process names (free text) */}
                <div className="space-y-1">
                  <Label htmlFor="additional-processes" className="text-xs text-muted-foreground">additional process names</Label>
                  <Input
                    id="additional-processes"
                    placeholder="e.g., msiexec.exe, CodeMeter.exe"
                    value={additionalProcesses}
                    onChange={(e) => setAdditionalProcesses(e.target.value)}
                    className="border-border bg-background text-white text-sm"
                  />
                  <p className="text-xs text-muted-foreground">comma-separated exe names for non-managed processes</p>
                </div>

                {/* Warning banner */}
                {(selectedProjectIds.size > 0 || additionalProcesses.trim()) && (() => {
                  const allProcessNames: string[] = [];
                  machines
                    .filter(m => selectedMachines.has(m.machineId))
                    .forEach(machine => {
                      (machine.processes || []).forEach((proc: Process) => {
                        if (selectedProjectIds.has(proc.id)) {
                          const exeName = proc.exe_path?.split(/[/\\]/).pop() || proc.name;
                          if (!allProcessNames.includes(exeName)) allProcessNames.push(exeName);
                        }
                      });
                    });
                  const additionalNames = additionalProcesses.split(',').map(s => s.trim()).filter(Boolean);
                  additionalNames.forEach(n => { if (!allProcessNames.includes(n)) allProcessNames.push(n); });

                  return (
                    <div className="flex items-start gap-2 p-2 bg-amber-900/30 border border-amber-600/40 rounded text-sm">
                      <AlertTriangle className="h-4 w-4 text-amber-400 mt-0.5 shrink-0" />
                      <div className="text-amber-200">
                        <span className="font-medium">The following processes will be closed on target machines before installation: </span>
                        <span>{allProcessNames.join(', ')}</span>
                        {selectedProjectIds.size > 0 && (
                          <span className="block text-xs text-amber-300/70 mt-1">Managed processes will restart automatically after installation.</span>
                        )}
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}
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
            disabled={deploying}
          >
            cancel
          </Button>
          <Button
            onClick={handleDeploy}
            className="bg-accent-cyan hover:bg-accent-cyan-hover text-gray-900 cursor-pointer"
            disabled={deploying}
          >
            {deploying ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                deploying...
              </>
            ) : (
              <>
                <Download className="h-4 w-4 mr-2" />
                deploy to {selectedMachines.size} machine{selectedMachines.size !== 1 ? 's' : ''}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>

      {/* Delete Confirmation Dialog */}
      <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <DialogContent className="border-border bg-secondary text-white max-w-md">
          <DialogHeader>
            <DialogTitle className="text-white">delete template</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              delete template &ldquo;{templates.find(t => t.id === selectedTemplateId)?.name}&rdquo;? this cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              variant="ghost"
              onClick={() => setShowDeleteConfirm(false)}
              className="bg-secondary border border-border cursor-pointer"
            >
              cancel
            </Button>
            <Button
              onClick={confirmDeleteTemplate}
              className="bg-red-600 hover:bg-red-700 text-white cursor-pointer"
            >
              delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}
