'use client';

import React, { useState, useCallback } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Upload, FileUp, X, Loader2, CheckCircle, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import { isValidVersion, formatFileSize } from '@/lib/storageUtils';
import { AdminButton } from './AdminButton';

// Extract version from filename (e.g., "owlette-Installer-v2.0.10.exe" -> "2.0.10")
const extractVersionFromFilename = (filename: string): string | null => {
  const match = filename.match(/v?(\d+\.\d+\.\d+)/i);
  return match ? match[1] : null;
};

interface UploadInstallerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpload: (
    file: File,
    version: string,
    releaseNotes: string | undefined,
    setAsLatest: boolean,
    onProgress: (progress: number) => void
  ) => Promise<void>;
}

export default function UploadInstallerDialog({
  open,
  onOpenChange,
  onUpload,
}: UploadInstallerDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [version, setVersion] = useState('');
  const [releaseNotes, setReleaseNotes] = useState('');
  const [setAsLatest, setSetAsLatest] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isDragging, setIsDragging] = useState(false);

  const resetForm = () => {
    setFile(null);
    setVersion('');
    setReleaseNotes('');
    setSetAsLatest(true);
    setUploadProgress(0);
  };

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const droppedFile = e.dataTransfer.files[0];
    if (droppedFile && droppedFile.name.endsWith('.exe')) {
      setFile(droppedFile);

      // Auto-detect version from filename
      const detectedVersion = extractVersionFromFilename(droppedFile.name);
      if (detectedVersion) {
        setVersion(detectedVersion);
      }
    } else {
      toast.error('Invalid File', {
        description: 'Please select a .exe file',
      });
    }
  }, []);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile && selectedFile.name.endsWith('.exe')) {
      setFile(selectedFile);

      // Auto-detect version from filename
      const detectedVersion = extractVersionFromFilename(selectedFile.name);
      if (detectedVersion) {
        setVersion(detectedVersion);
      }
    } else {
      toast.error('Invalid File', {
        description: 'Please select a .exe file',
      });
    }
  };

  const handleUpload = async () => {
    // Validation
    if (!file) {
      toast.error('No File Selected', {
        description: 'Please select an installer file',
      });
      return;
    }

    if (!version.trim()) {
      toast.error('Version Required', {
        description: 'Please enter a version number',
      });
      return;
    }

    if (!isValidVersion(version)) {
      toast.error('Invalid Version Format', {
        description: 'Version must be in format X.Y.Z (e.g., 2.0.0)',
      });
      return;
    }

    setUploading(true);
    setUploadProgress(0);

    try {
      await onUpload(
        file,
        version,
        releaseNotes.trim() || undefined,
        setAsLatest,
        setUploadProgress
      );

      toast.success('Upload Successful!', {
        description: `Version ${version} has been uploaded${setAsLatest ? ' and set as latest' : ''}.`,
      });

      resetForm();
      onOpenChange(false);
    } catch (error: any) {
      toast.error('Upload Failed', {
        description: error.message || 'Failed to upload installer',
      });
    } finally {
      setUploading(false);
      setUploadProgress(0);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-secondary text-white max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-white">Upload New Installer Version</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Upload a new owlette Agent installer version to Firebase Storage
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* File Upload Area */}
          <div className="space-y-2">
            <Label className="text-white">Installer File</Label>
            <div
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              className={`
                border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors
                ${isDragging ? 'border-accent-cyan bg-accent-cyan/10' : 'border-border hover:border-muted-foreground'}
              `}
            >
              {!file ? (
                <div>
                  <FileUp className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
                  <p className="text-white mb-2">Drag & drop installer file here</p>
                  <p className="text-sm text-muted-foreground mb-4">or</p>
                  <label htmlFor="file-upload">
                    <AdminButton
                      adminVariant="outline"
                      type="button"
                      className="cursor-pointer"
                      onClick={() => document.getElementById('file-upload')?.click()}
                    >
                      <Upload className="h-4 w-4 mr-2" />
                      Choose File
                    </AdminButton>
                  </label>
                  <input
                    id="file-upload"
                    type="file"
                    accept=".exe"
                    className="hidden"
                    onChange={handleFileSelect}
                  />
                  <p className="text-xs text-muted-foreground mt-4">Only .exe files accepted</p>
                </div>
              ) : (
                <div className="flex items-center justify-between bg-background rounded p-4">
                  <div className="flex items-center gap-3">
                    <CheckCircle className="h-5 w-5 text-green-500" />
                    <div className="text-left">
                      <p className="text-white font-medium">{file.name}</p>
                      <p className="text-sm text-muted-foreground">{formatFileSize(file.size)}</p>
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setFile(null)}
                    disabled={uploading}
                    className="hover:bg-secondary! cursor-pointer"
                  >
                    <X className="h-4 w-4 text-muted-foreground" />
                  </Button>
                </div>
              )}
            </div>
          </div>

          {/* Version Input */}
          <div className="space-y-2">
            <Label htmlFor="version" className="text-white">Version Number</Label>
            <Input
              id="version"
              placeholder="2.0.0"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              disabled={uploading}
              className="border-border bg-background text-white"
            />
            <p className="text-xs text-muted-foreground">Format: X.Y.Z (e.g., 2.0.0, 2.1.5)</p>
          </div>

          {/* Release Notes */}
          <div className="space-y-2">
            <Label htmlFor="release-notes" className="text-white">Release Notes (Optional)</Label>
            <Textarea
              id="release-notes"
              placeholder="What's new in this version?"
              value={releaseNotes}
              onChange={(e) => setReleaseNotes(e.target.value)}
              disabled={uploading}
              rows={4}
              className="border-border bg-background text-white resize-none"
            />
          </div>

          {/* Set as Latest Checkbox */}
          <div className="flex items-center gap-2">
            <Checkbox
              id="set-latest"
              checked={setAsLatest}
              onCheckedChange={(checked) => setSetAsLatest(checked as boolean)}
              disabled={uploading}
              className="cursor-pointer"
            />
            <Label htmlFor="set-latest" className="text-white cursor-pointer">
              Set as latest version (recommended)
            </Label>
          </div>

          {/* Upload Progress */}
          {uploading && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Uploading...</span>
                <span className="text-white font-medium">{uploadProgress}%</span>
              </div>
              <div className="w-full bg-background rounded-full h-2">
                <div
                  className="bg-accent-cyan h-2 rounded-full transition-all duration-300"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <AdminButton
            adminVariant="card"
            onClick={() => onOpenChange(false)}
            disabled={uploading}
            className="cursor-pointer"
          >
            Cancel
          </AdminButton>
          <Button
            onClick={handleUpload}
            disabled={uploading || !file || !version}
            className="bg-accent-cyan hover:bg-accent-cyan-hover text-gray-900 cursor-pointer"
          >
            {uploading ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Uploading...
              </>
            ) : (
              <>
                <Upload className="h-4 w-4 mr-2" />
                Upload Installer
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
