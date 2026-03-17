'use client';

import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Loader2, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { useSystemPresets, type SystemPreset } from '@/hooks/useSystemPresets';
import { useAuth } from '@/contexts/AuthContext';
import { useInstallerVersion } from '@/hooks/useInstallerVersion';
import { serverTimestamp } from 'firebase/firestore';

/**
 * SystemPresetDialog Component
 *
 * Form dialog for creating and editing system presets.
 * Used by admin to manage global software deployment presets.
 *
 * Features:
 * - Create new preset (preset prop is null)
 * - Edit existing preset (preset prop provided)
 * - Form validation
 * - Category selection
 * - Special handling for Owlette Agent preset
 */
interface SystemPresetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preset: SystemPreset | null; // null for create, preset object for edit
}

export default function SystemPresetDialog({
  open,
  onOpenChange,
  preset,
}: SystemPresetDialogProps) {
  const { createPreset, updatePreset } = useSystemPresets();
  const { user } = useAuth();
  const { version: latestInstallerVersion, downloadUrl: latestInstallerUrl, isLoading: installerLoading } = useInstallerVersion();

  // Form state
  const [name, setName] = useState('');
  const [softwareName, setSoftwareName] = useState('');
  const [category, setCategory] = useState('');
  const [description, setDescription] = useState('');
  const [icon, setIcon] = useState('');
  const [installerName, setInstallerName] = useState('');
  const [installerUrl, setInstallerUrl] = useState('');
  const [silentFlags, setSilentFlags] = useState('/VERYSILENT /NORESTART /SUPPRESSMSGBOXES');
  const [verifyPath, setVerifyPath] = useState('');
  const [isOwletteAgent, setIsOwletteAgent] = useState(false);
  const [timeoutSeconds, setTimeoutSeconds] = useState(600);
  const [order, setOrder] = useState(100);

  const [saving, setSaving] = useState(false);

  const isEditMode = preset !== null;

  // Load preset data when editing
  useEffect(() => {
    if (preset) {
      setName(preset.name);
      setSoftwareName(preset.software_name);
      setCategory(preset.category);
      setDescription(preset.description || '');
      setIcon(preset.icon || '');
      setInstallerName(preset.installer_name);
      setInstallerUrl(preset.installer_url);
      setSilentFlags(preset.silent_flags);
      setVerifyPath(preset.verify_path || '');
      setIsOwletteAgent(preset.is_owlette_agent);
      setTimeoutSeconds(preset.timeout_seconds || 600);
      setOrder(preset.order);
    } else {
      // Reset form for new preset
      setName('');
      setSoftwareName('');
      setCategory('');
      setDescription('');
      setIcon('');
      setInstallerName('');
      setInstallerUrl('');
      setSilentFlags('/VERYSILENT /NORESTART /SUPPRESSMSGBOXES');
      setVerifyPath('');
      setIsOwletteAgent(false);
      setTimeoutSeconds(600);
      setOrder(100);
    }
  }, [preset, open]);

  // Auto-fill Owlette Agent preset
  const handleAutoFillOwlette = () => {
    if (!latestInstallerUrl || !latestInstallerVersion) {
      toast.error('Installer Not Available', {
        description: 'No Owlette installer found. Please upload one in Admin > Installers first.',
      });
      return;
    }

    setName(`Owlette Agent v${latestInstallerVersion}`);
    setSoftwareName('Owlette Agent');
    setCategory('System');
    setDescription('Remote process management and monitoring agent for Windows');
    setIcon('🦉');
    setInstallerName('OwletteInstaller.exe');
    setInstallerUrl(latestInstallerUrl);
    setSilentFlags('/VERYSILENT /NORESTART /SUPPRESSMSGBOXES');
    setVerifyPath('C:\\Program Files\\Owlette\\OwletteService.exe');
    setIsOwletteAgent(true);
    setTimeoutSeconds(300);
    setOrder(1);

    toast.success('Auto-filled', {
      description: `Owlette Agent v${latestInstallerVersion} preset ready to save.`,
    });
  };

  const handleSave = async () => {
    // Validation
    if (!name.trim()) {
      toast.error('Name required', { description: 'Please enter a preset name.' });
      return;
    }
    if (!softwareName.trim()) {
      toast.error('Software name required', { description: 'Please enter a software name.' });
      return;
    }
    if (!category.trim()) {
      toast.error('Category required', { description: 'Please select a category.' });
      return;
    }
    if (!installerName.trim()) {
      toast.error('Installer name required', { description: 'Please enter an installer filename.' });
      return;
    }
    if (!silentFlags.trim()) {
      toast.error('Silent flags required', { description: 'Please enter installation flags.' });
      return;
    }
    if (!installerUrl.trim()) {
      toast.error('Installer URL required', {
        description: 'Please enter a download URL or use the auto-fill button for Owlette Agent.',
      });
      return;
    }

    setSaving(true);

    try {
      // Build base preset data
      const baseData: any = {
        name,
        software_name: softwareName,
        category,
        installer_name: installerName,
        installer_url: installerUrl,
        silent_flags: silentFlags,
        is_owlette_agent: isOwletteAgent,
        timeout_seconds: timeoutSeconds,
        order,
      };

      // Add optional fields only if they have values (Firestore doesn't accept undefined)
      if (description?.trim()) baseData.description = description.trim();
      if (icon?.trim()) baseData.icon = icon.trim();
      if (verifyPath?.trim()) baseData.verify_path = verifyPath.trim();

      if (isEditMode && preset) {
        // Update existing preset
        await updatePreset(preset.id, baseData);

        toast.success('Preset Updated', {
          description: `"${name}" has been updated successfully.`,
        });
      } else {
        // Create new preset
        await createPreset({
          ...baseData,
          createdAt: serverTimestamp() as any,
          createdBy: user?.uid || 'unknown',
        });

        toast.success('Preset Created', {
          description: `"${name}" has been created successfully.`,
        });
      }

      onOpenChange(false);
    } catch (err: any) {
      toast.error(isEditMode ? 'Update Failed' : 'Create Failed', {
        description: err.message || 'An error occurred while saving the preset.',
      });
    } finally {
      setSaving(false);
    }
  };

  const predefinedCategories = [
    'System',
    'Creative Software',
    'Media Server',
    'Utilities',
    'Development Tools',
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-secondary text-white max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEditMode ? 'Edit Template' : 'Create Template'}</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {isEditMode
              ? 'Update the template configuration.'
              : 'Create a new software template for the deployment catalog.'}
          </DialogDescription>
        </DialogHeader>

        {/* Quick Fill Button - Only show when creating new preset */}
        {!isEditMode && (
          <div className="pb-4 border-b border-border">
            <Button
              type="button"
              variant="outline"
              onClick={handleAutoFillOwlette}
              disabled={installerLoading || !latestInstallerUrl}
              className="w-full border-accent-cyan/50 bg-accent-cyan/10 text-accent-cyan hover:bg-accent-cyan/20 hover:text-accent-cyan cursor-pointer"
            >
              <Sparkles className="mr-2 h-4 w-4" />
              {installerLoading
                ? 'Loading...'
                : latestInstallerUrl
                ? `Auto-fill Owlette Agent v${latestInstallerVersion || '...'}`
                : 'No Owlette Installer Available'}
            </Button>
            <p className="text-xs text-muted-foreground text-center mt-2">
              Automatically populate all fields for Owlette Agent deployment
            </p>
          </div>
        )}

        <div className="space-y-4 py-4">
          {/* Name */}
          <div className="space-y-2">
            <Label htmlFor="name" className="text-white">
              Name *
            </Label>
            <Input
              id="name"
              placeholder="e.g., TouchDesigner 2025.31550"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="border-border bg-background text-white"
            />
            <p className="text-xs text-muted-foreground">Display name shown in UI</p>
          </div>

          {/* Software Name */}
          <div className="space-y-2">
            <Label htmlFor="softwareName" className="text-white">
              Software Name *
            </Label>
            <Input
              id="softwareName"
              placeholder="e.g., TouchDesigner"
              value={softwareName}
              onChange={(e) => setSoftwareName(e.target.value)}
              className="border-border bg-background text-white"
            />
            <p className="text-xs text-muted-foreground">Short identifier for grouping</p>
          </div>

          {/* Category */}
          <div className="space-y-2">
            <Label htmlFor="category" className="text-white">
              Category *
            </Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger className="border-border bg-background text-white">
                <SelectValue placeholder="Select a category..." />
              </SelectTrigger>
              <SelectContent className="border-border bg-secondary">
                {predefinedCategories.map((cat) => (
                  <SelectItem
                    key={cat}
                    value={cat}
                    className="text-white focus:bg-accent focus:text-white"
                  >
                    {cat}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">Used for filtering and organization</p>
          </div>

          {/* Icon (optional) */}
          <div className="space-y-2">
            <Label htmlFor="icon" className="text-white">
              Icon (Emoji)
            </Label>
            <Input
              id="icon"
              placeholder="e.g., 🎨"
              value={icon}
              onChange={(e) => setIcon(e.target.value)}
              maxLength={2}
              className="border-border bg-background text-white"
            />
            <p className="text-xs text-muted-foreground">Optional emoji icon (one character)</p>
          </div>

          {/* Description (optional) */}
          <div className="space-y-2">
            <Label htmlFor="description" className="text-white">
              Description
            </Label>
            <Textarea
              id="description"
              placeholder="Optional description of this preset..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="border-border bg-background text-white resize-none"
            />
          </div>

          {/* Installer Name */}
          <div className="space-y-2">
            <Label htmlFor="installerName" className="text-white">
              Installer Filename *
            </Label>
            <Input
              id="installerName"
              placeholder="e.g., TouchDesigner.2025.31550.exe"
              value={installerName}
              onChange={(e) => setInstallerName(e.target.value)}
              className="border-border bg-background text-white font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">Name of the installer file</p>
          </div>

          {/* Installer URL */}
          <div className="space-y-2">
            <Label htmlFor="installerUrl" className="text-white">
              Installer URL *
            </Label>
            <Input
              id="installerUrl"
              placeholder="https://example.com/installer.exe"
              value={installerUrl}
              onChange={(e) => setInstallerUrl(e.target.value)}
              className="border-border bg-background text-white font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Direct download link for the installer
            </p>
          </div>

          {/* Silent Flags */}
          <div className="space-y-2">
            <Label htmlFor="silentFlags" className="text-white">
              Silent Install Flags *
            </Label>
            <Input
              id="silentFlags"
              placeholder="/VERYSILENT /NORESTART /SUPPRESSMSGBOXES"
              value={silentFlags}
              onChange={(e) => setSilentFlags(e.target.value)}
              className="border-border bg-background text-white font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Command-line flags for silent installation. Include custom directory here (e.g., /DIR=&quot;C:\Custom\Path&quot;)
            </p>
          </div>

          {/* Verify Path (optional) */}
          <div className="space-y-2">
            <Label htmlFor="verifyPath" className="text-white">
              Verification Path
            </Label>
            <Input
              id="verifyPath"
              placeholder='C:\\Program Files\\Software\\app.exe'
              value={verifyPath}
              onChange={(e) => setVerifyPath(e.target.value)}
              className="border-border bg-background text-white font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">Optional: File path to verify installation success</p>
          </div>

          {/* Advanced Options */}
          <div className="grid grid-cols-2 gap-4">
            {/* Timeout */}
            <div className="space-y-2">
              <Label htmlFor="timeout" className="text-white">
                Timeout (seconds)
              </Label>
              <Input
                id="timeout"
                type="number"
                min="60"
                max="3600"
                value={timeoutSeconds}
                onChange={(e) => setTimeoutSeconds(parseInt(e.target.value) || 600)}
                className="border-border bg-background text-white"
              />
              <p className="text-xs text-muted-foreground">Max install time (default: 600)</p>
            </div>

            {/* Order */}
            <div className="space-y-2">
              <Label htmlFor="order" className="text-white">
                Display Order
              </Label>
              <Input
                id="order"
                type="number"
                min="1"
                value={order}
                onChange={(e) => setOrder(parseInt(e.target.value) || 100)}
                className="border-border bg-background text-white"
              />
              <p className="text-xs text-muted-foreground">Sort priority (lower = first)</p>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
            className="border-border bg-background text-white hover:bg-muted cursor-pointer"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={saving}
            className="bg-accent-cyan hover:bg-accent-cyan-hover text-gray-900 cursor-pointer"
          >
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                {isEditMode ? 'Updating...' : 'Creating...'}
              </>
            ) : (
              isEditMode ? 'Update Template' : 'Create Template'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
