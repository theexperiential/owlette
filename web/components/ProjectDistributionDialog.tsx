'use client';

import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Plus, FolderArchive, Loader2, Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useMachines } from '@/hooks/useFirestore';
import { ProjectDistributionTemplate, ProjectDistribution } from '@/hooks/useProjectDistributions';
import { Badge } from '@/components/ui/badge';

interface ProjectDistributionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  siteId: string;
  templates: ProjectDistributionTemplate[];
  onCreateDistribution: (distribution: Omit<ProjectDistribution, 'id' | 'createdAt' | 'status'>, machineIds: string[]) => Promise<string>;
  onCreateTemplate: (template: Omit<ProjectDistributionTemplate, 'id' | 'createdAt'>) => Promise<string>;
  onUpdateTemplate: (templateId: string, template: Partial<Omit<ProjectDistributionTemplate, 'id' | 'createdAt'>>) => Promise<void>;
  onDeleteTemplate: (templateId: string) => Promise<void>;
}

export default function ProjectDistributionDialog({
  open,
  onOpenChange,
  siteId,
  templates,
  onCreateDistribution,
  onCreateTemplate,
  onUpdateTemplate,
  onDeleteTemplate,
}: ProjectDistributionDialogProps) {
  const { machines } = useMachines(siteId);
  const [distributionName, setDistributionName] = useState('');
  const [projectUrl, setProjectUrl] = useState('');
  const [extractPath, setExtractPath] = useState('');
  const [verifyFiles, setVerifyFiles] = useState('');
  const [selectedMachines, setSelectedMachines] = useState<Set<string>>(new Set());
  const [saveAsTemplate, setSaveAsTemplate] = useState(false);
  const [distributing, setDistributing] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<string>('');
  const [editingTemplate, setEditingTemplate] = useState<string>('');  // ID of template being edited

  const allMachinesSelected = selectedMachines.size === machines.length && machines.length > 0;
  const onlineMachines = machines.filter(m => m.online);

  const handleTemplateSelect = (templateId: string) => {
    if (templateId === 'none') {
      setSelectedTemplate('');
      setEditingTemplate('');
      return;
    }

    const template = templates.find(t => t.id === templateId);
    if (template) {
      setSelectedTemplate(templateId);
      setDistributionName(template.name);
      setProjectUrl(template.project_url);
      setExtractPath(template.extract_path || '');
      setVerifyFiles(template.verify_files?.join(', ') || '');
      setEditingTemplate('');
    }
  };

  const handleEditTemplate = () => {
    if (selectedTemplate) {
      setEditingTemplate(selectedTemplate);
      setSaveAsTemplate(false);
      toast.info('Edit the template fields below and distribute to save changes');
    }
  };

  const handleDeleteTemplate = async () => {
    if (!selectedTemplate) return;

    const template = templates.find(t => t.id === selectedTemplate);
    if (!template) return;

    if (!confirm(`Delete template "${template.name}"? This cannot be undone.`)) {
      return;
    }

    try {
      await onDeleteTemplate(selectedTemplate);
      toast.success('Template deleted successfully');

      // Clear form
      setSelectedTemplate('');
      setEditingTemplate('');
      setDistributionName('');
      setProjectUrl('');
      setExtractPath('');
      setVerifyFiles('');
    } catch (error: any) {
      toast.error(error.message || 'Failed to delete template');
    }
  };

  const handleTouchDesignerPreset = () => {
    setDistributionName('TouchDesigner Project Distribution');
    setProjectUrl('https://example.com/path/to/project.zip');
    setExtractPath('C:\\TouchDesigner\\Projects');
    setVerifyFiles('MyProject.toe, Assets/');
    toast.success('TouchDesigner preset loaded. Update the project URL.');
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
      toast.error('Please provide a distribution name');
      return;
    }

    if (!projectUrl.trim()) {
      toast.error('Please provide a project URL');
      return;
    }

    // Validate URL format
    let parsedUrl;
    try {
      parsedUrl = new URL(projectUrl);
    } catch (e) {
      toast.error('Invalid project URL format');
      return;
    }

    if (selectedMachines.size === 0) {
      toast.error('Please select at least one machine');
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

      // Update existing template if in edit mode
      if (editingTemplate) {
        await onUpdateTemplate(editingTemplate, {
          name: distributionName,
          project_name: projectName,
          project_url: projectUrl,
          extract_path: extractPath || undefined,
          verify_files: verifyFilesArray.length > 0 ? verifyFilesArray : undefined,
        });
        toast.success('Template updated successfully!');
        setEditingTemplate('');
      }
      // Save as new template if requested
      else if (saveAsTemplate) {
        await onCreateTemplate({
          name: distributionName,
          project_name: projectName,
          project_url: projectUrl,
          extract_path: extractPath || undefined,
          verify_files: verifyFilesArray.length > 0 ? verifyFilesArray : undefined,
        });
        toast.success('Template saved successfully!');
      }

      // Create distribution
      const distributionId = await onCreateDistribution(
        {
          name: distributionName,
          project_name: projectName,
          project_url: projectUrl,
          extract_path: extractPath || undefined,
          verify_files: verifyFilesArray.length > 0 ? verifyFilesArray : undefined,
          targets: [],  // Will be filled by the hook
        },
        Array.from(selectedMachines)
      );

      toast.success(`Distribution started! Syncing to ${selectedMachines.size} machine${selectedMachines.size > 1 ? 's' : ''}`);

      // Reset form
      setDistributionName('');
      setProjectUrl('');
      setExtractPath('');
      setVerifyFiles('');
      setSelectedMachines(new Set());
      setSaveAsTemplate(false);
      setSelectedTemplate('');

      onOpenChange(false);
    } catch (error: any) {
      console.error('Distribution error:', error);
      toast.error(error.message || 'Failed to create distribution');
    } finally {
      setDistributing(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-secondary text-white max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-white">distribute projects</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            distribute project files (ZIPs, archives) across multiple machines
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Template Selection */}
          {templates.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor="template" className="text-white">load from template</Label>
              <div className="flex gap-2">
                <Select value={selectedTemplate} onValueChange={handleTemplateSelect}>
                  <SelectTrigger className="border-border bg-background text-white flex-1">
                    <SelectValue placeholder="select a template..." />
                  </SelectTrigger>
                  <SelectContent className="border-border bg-secondary">
                    <SelectItem value="none" className="text-white focus:bg-accent focus:text-white">
                      none
                    </SelectItem>
                    {templates.map((template) => (
                      <SelectItem
                        key={template.id}
                        value={template.id}
                        className="text-white focus:bg-accent focus:text-white"
                      >
                        {template.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedTemplate && (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={handleEditTemplate}
                      className="border-border bg-background text-white hover:bg-muted hover:text-white cursor-pointer"
                      title="Edit template"
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={handleDeleteTemplate}
                      className="border-border bg-background text-red-400 hover:bg-red-900 hover:text-red-300 cursor-pointer"
                      title="Delete template"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </>
                )}
              </div>
              {editingTemplate && (
                <div className="flex items-center gap-2 p-2 bg-accent-cyan/10 border border-accent-cyan/30 rounded text-sm">
                  <Pencil className="h-3 w-3 text-accent-cyan" />
                  <span className="text-accent-cyan">Editing template - changes will be saved when you distribute</span>
                </div>
              )}
            </div>
          )}

          {/* TouchDesigner Preset */}
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleTouchDesignerPreset}
              className="border-border bg-background text-white hover:bg-muted cursor-pointer"
            >
              <FolderArchive className="h-4 w-4 mr-2" />
              TouchDesigner preset
            </Button>
            <span className="text-xs text-muted-foreground">quick preset for TouchDesigner project distribution</span>
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
              custom extraction path. default: <span className="font-mono text-accent-cyan">~/Documents/OwletteProjects</span>
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

          {/* Save as Template */}
          <div className="flex items-center gap-2">
            <Checkbox
              id="save-template"
              checked={saveAsTemplate}
              onCheckedChange={(checked) => setSaveAsTemplate(checked as boolean)}
              className="cursor-pointer"
            />
            <Label htmlFor="save-template" className="text-white cursor-pointer">
              save as template for future distributions
            </Label>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="border-border bg-secondary text-white hover:bg-muted hover:text-white cursor-pointer"
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
