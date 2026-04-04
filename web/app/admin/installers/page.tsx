'use client';

import { useState } from 'react';
import { useInstallerManagement } from '@/hooks/useInstallerManagement';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Package, Plus, Loader2, Download, Trash2, CheckCircle, Copy, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import UploadInstallerDialog from '@/components/admin/UploadInstallerDialog';
import { formatFileSize } from '@/lib/storageUtils';

/**
 * Installers Admin Page
 *
 * Admin-only page for managing owlette Agent installer versions.
 * Allows admins to:
 * - View all versions
 * - Upload new versions
 * - Set version as latest
 * - Delete old versions
 */
export default function InstallerVersionsPage() {
  const {
    versions,
    latestVersion,
    loading,
    error,
    uploadVersion,
    setAsLatest,
    deleteVersion,
    getCleanupCandidates,
    cleanupVersions,
  } = useInstallerManagement();
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [deletingVersion, setDeletingVersion] = useState<string | null>(null);
  const [settingLatest, setSettingLatest] = useState<string | null>(null);
  const [setLatestDialogOpen, setSetLatestDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [versionToSetLatest, setVersionToSetLatest] = useState<string>('');
  const [versionToDelete, setVersionToDelete] = useState<string>('');
  const [cleanupDialogOpen, setCleanupDialogOpen] = useState(false);
  const [cleaningUp, setCleaningUp] = useState(false);
  const [cleanupRetentionDays, setCleanupRetentionDays] = useState(30);

  const handleSetAsLatest = (version: string) => {
    if (latestVersion?.version === version) {
      toast.info('Already Latest', {
        description: 'This version is already set as latest.',
      });
      return;
    }

    setVersionToSetLatest(version);
    setSetLatestDialogOpen(true);
  };

  const confirmSetAsLatest = async () => {
    setSettingLatest(versionToSetLatest);
    setSetLatestDialogOpen(false);

    try {
      await setAsLatest(versionToSetLatest);
      toast.success('Latest Version Updated', {
        description: `Version ${versionToSetLatest} is now the latest.`,
      });
    } catch (err: any) {
      toast.error('Update Failed', {
        description: err.message || 'Failed to update latest version.',
      });
    } finally {
      setSettingLatest(null);
      setVersionToSetLatest('');
    }
  };

  const handleDelete = (version: string) => {
    if (latestVersion?.version === version) {
      toast.error('Cannot Delete', {
        description: 'Cannot delete the current latest version. Set a different version as latest first.',
      });
      return;
    }

    setVersionToDelete(version);
    setDeleteDialogOpen(true);
  };

  const confirmDelete = async () => {
    setDeletingVersion(versionToDelete);
    setDeleteDialogOpen(false);

    try {
      await deleteVersion(versionToDelete);
      toast.success('Version Deleted', {
        description: `Version ${versionToDelete} has been deleted.`,
      });
    } catch (err: any) {
      toast.error('Delete Failed', {
        description: err.message || 'Failed to delete version.',
      });
    } finally {
      setDeletingVersion(null);
      setVersionToDelete('');
    }
  };

  const formatDate = (timestamp: any) => {
    if (!timestamp) return 'N/A';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const cleanupCandidates = cleanupDialogOpen ? getCleanupCandidates(cleanupRetentionDays) : [];

  const handleCleanup = async () => {
    setCleaningUp(true);
    try {
      const count = await cleanupVersions(cleanupCandidates);
      toast.success('Cleanup Complete', {
        description: `Deleted ${count} old installer${count !== 1 ? 's' : ''}.`,
      });
      setCleanupDialogOpen(false);
    } catch (err: any) {
      toast.error('Cleanup Failed', {
        description: err.message || 'Failed to clean up versions.',
      });
    } finally {
      setCleaningUp(false);
    }
  };

  const totalCleanupSize = cleanupCandidates.reduce((sum, v) => sum + (v.file_size || 0), 0);

  const copyDownloadLink = async (downloadUrl: string, version: string) => {
    try {
      await navigator.clipboard.writeText(downloadUrl);
      toast.success('Link Copied', {
        description: `Download link for version ${version} copied to clipboard.`,
      });
    } catch (err) {
      toast.error('Copy Failed', {
        description: 'Failed to copy link to clipboard.',
      });
    }
  };

  return (
    <div className="p-8">
      <div className="max-w-screen-2xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold text-foreground mb-2">Installers</h1>
          <p className="text-muted-foreground">Manage owlette Agent installer versions and downloads</p>
        </div>
        <div className="flex items-center gap-3">
          <Button
            onClick={() => setCleanupDialogOpen(true)}
            variant="outline"
            className="border-border bg-background text-foreground hover:bg-muted hover:text-foreground cursor-pointer"
            disabled={versions.length < 2}
          >
            <Sparkles className="h-4 w-4 mr-2" />
            Clean Up
          </Button>
          <Button
            onClick={() => setUploadDialogOpen(true)}
            className="bg-accent-cyan hover:bg-accent-cyan-hover text-gray-900 cursor-pointer"
          >
            <Plus className="h-4 w-4 mr-2" />
            Upload New Version
          </Button>
        </div>
      </div>

      {/* Stats Card */}
      {latestVersion && (
        <div className="bg-card border border-border rounded-lg p-6 mb-8">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-green-600 rounded-lg">
              <Package className="h-6 w-6 text-white" />
            </div>
            <div className="flex-1">
              <p className="text-sm text-muted-foreground">Current Latest Version</p>
              <div className="flex items-center gap-2 mt-1">
                <p className="text-2xl font-bold text-foreground">{latestVersion.version}</p>
                <Badge className="bg-green-600">Latest</Badge>
              </div>
            </div>
            <div className="text-right">
              <p className="text-sm text-muted-foreground">Uploaded</p>
              <p className="text-lg text-foreground font-medium">
                {formatDate(latestVersion.release_date)}
              </p>
            </div>
            <div className="text-right">
              <p className="text-sm text-muted-foreground">File Size</p>
              <p className="text-lg text-foreground font-medium">
                {formatFileSize(latestVersion.file_size)}
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                onClick={() => window.open(latestVersion.download_url, '_blank')}
                variant="outline"
                size="icon"
                className="border-border bg-background text-foreground hover:bg-muted hover:text-foreground cursor-pointer"
                title={`Download owlette Agent v${latestVersion.version}`}
              >
                <Download className="h-4 w-4" />
              </Button>
              <Button
                onClick={() => copyDownloadLink(latestVersion.download_url, latestVersion.version)}
                variant="outline"
                size="icon"
                className="border-border bg-background text-foreground hover:bg-muted hover:text-foreground cursor-pointer"
                title={`Copy download link for owlette Agent v${latestVersion.version}`}
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Error State */}
      {error && (
        <div className="bg-red-900/30 border border-red-700 rounded-lg p-4 mb-6">
          <p className="text-red-300">{error}</p>
        </div>
      )}

      {/* Loading State */}
      {loading && (
        <div className="flex justify-center items-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-accent-cyan" />
          <span className="ml-3 text-muted-foreground">Loading versions...</span>
        </div>
      )}

      {/* Versions Table */}
      {!loading && !error && (
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border bg-background/50">
                <th className="text-left p-4 text-sm font-medium text-foreground">Version</th>
                <th className="text-left p-4 text-sm font-medium text-foreground">File Size</th>
                <th className="text-left p-4 text-sm font-medium text-foreground">Uploaded</th>
                <th className="text-left p-4 text-sm font-medium text-foreground">Uploaded By</th>
                <th className="text-left p-4 text-sm font-medium text-foreground">Release Notes</th>
                <th className="text-right p-4 text-sm font-medium text-foreground">Actions</th>
              </tr>
            </thead>
            <tbody>
              {versions.length === 0 ? (
                <tr>
                  <td colSpan={6} className="p-8 text-center text-muted-foreground">
                    No versions uploaded yet. Click "Upload New Version" to get started.
                  </td>
                </tr>
              ) : (
                versions.map((version) => {
                  const isLatest = latestVersion?.version === version.version;
                  const isDeleting = deletingVersion === version.version;
                  const isSetting = settingLatest === version.version;

                  return (
                    <tr
                      key={version.id}
                      className="border-b border-border hover:bg-muted/50 transition-colors"
                    >
                      {/* Version */}
                      <td className="p-4">
                        <div className="flex items-center gap-2">
                          <span className="text-foreground font-medium">{version.version}</span>
                          {isLatest && (
                            <Badge className="bg-green-600 flex items-center gap-1">
                              <CheckCircle className="h-3 w-3" />
                              Latest
                            </Badge>
                          )}
                        </div>
                      </td>

                      {/* File Size */}
                      <td className="p-4 text-muted-foreground">
                        {formatFileSize(version.file_size)}
                      </td>

                      {/* Upload Date */}
                      <td className="p-4 text-muted-foreground text-sm">
                        {formatDate(version.release_date)}
                      </td>

                      {/* Uploaded By */}
                      <td className="p-4 text-muted-foreground text-sm">
                        {version.uploaded_by}
                      </td>

                      {/* Release Notes */}
                      <td className="p-4">
                        {version.release_notes ? (
                          <p className="text-sm text-muted-foreground line-clamp-2">
                            {version.release_notes}
                          </p>
                        ) : (
                          <span className="text-xs text-muted-foreground/60">No notes</span>
                        )}
                      </td>

                      {/* Actions */}
                      <td className="p-4">
                        <div className="flex items-center justify-between gap-2">
                          {/* Left side: Set as Latest button (or empty space) */}
                          <div className="min-w-[100px]">
                            {!isLatest && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handleSetAsLatest(version.version)}
                                disabled={isSetting || isDeleting}
                                className="border-border bg-background text-foreground hover:bg-muted hover:text-foreground cursor-pointer text-xs"
                              >
                                {isSetting ? (
                                  <>
                                    <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                                    Setting...
                                  </>
                                ) : (
                                  'Set as Latest'
                                )}
                              </Button>
                            )}
                          </div>

                          {/* Right side: Icon buttons (always aligned) */}
                          <div className="flex items-center gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => window.open(version.download_url, '_blank')}
                              className="border-border bg-background text-foreground hover:bg-muted hover:text-foreground cursor-pointer"
                              title={`Download owlette Agent v${version.version}`}
                            >
                              <Download className="h-3 w-3" />
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => copyDownloadLink(version.download_url, version.version)}
                              className="border-border bg-background text-foreground hover:bg-muted hover:text-foreground cursor-pointer"
                              title={`Copy download link for owlette Agent v${version.version}`}
                            >
                              <Copy className="h-3 w-3" />
                            </Button>
                            {!isLatest ? (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handleDelete(version.version)}
                                disabled={isDeleting || isSetting}
                                className="border-border bg-background text-red-400 hover:bg-red-900 hover:border-red-800 hover:text-red-200 cursor-pointer"
                              >
                                {isDeleting ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  <Trash2 className="h-3 w-3" />
                                )}
                              </Button>
                            ) : (
                              <div className="w-[36px]" />
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Info Box */}
      {!loading && !error && versions.length > 0 && (
        <div className="mt-6 bg-accent-cyan/10 border border-accent-cyan/30 rounded-lg p-4">
          <p className="text-accent-cyan text-sm">
            <strong>Note:</strong> The "Latest" version is what users will download from the public
            download link. You can upload multiple versions and switch between them at any time.
            Old versions cannot be deleted if they are currently set as latest.
          </p>
        </div>
      )}

      {/* Upload Dialog */}
      <UploadInstallerDialog
        open={uploadDialogOpen}
        onOpenChange={setUploadDialogOpen}
        onUpload={uploadVersion}
      />

      {/* Set as Latest Confirmation Dialog */}
      <Dialog open={setLatestDialogOpen} onOpenChange={setSetLatestDialogOpen}>
        <DialogContent className="border-border bg-card text-foreground">
          <DialogHeader>
            <DialogTitle className="text-foreground">Set as Latest Version</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Set version {versionToSetLatest} as the latest version?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setSetLatestDialogOpen(false)}
              className="border-border bg-card text-foreground hover:bg-accent hover:text-foreground cursor-pointer"
            >
              Cancel
            </Button>
            <Button
              onClick={confirmSetAsLatest}
              className="bg-accent-cyan hover:bg-accent-cyan-hover text-gray-900 cursor-pointer"
            >
              OK
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent className="border-border bg-card text-foreground">
          <DialogHeader>
            <DialogTitle className="text-foreground">Delete Version</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Are you sure you want to delete version {versionToDelete}? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteDialogOpen(false)}
              className="border-border bg-card text-foreground hover:bg-accent hover:text-foreground cursor-pointer"
            >
              Cancel
            </Button>
            <Button
              onClick={confirmDelete}
              className="bg-red-600 hover:bg-red-700 text-foreground cursor-pointer"
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cleanup Dialog */}
      <Dialog open={cleanupDialogOpen} onOpenChange={(open) => { if (!cleaningUp) setCleanupDialogOpen(open); }}>
        <DialogContent className="border-border bg-card text-foreground sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-foreground">Clean Up Old Installers</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Remove superseded patch versions while keeping the latest patch per minor release,
              the current latest version, and anything uploaded within the retention window.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="flex items-center gap-3">
              <Label htmlFor="retention-days" className="text-foreground whitespace-nowrap">
                Keep uploads from last
              </Label>
              <Input
                id="retention-days"
                type="number"
                min={0}
                max={365}
                value={cleanupRetentionDays}
                onChange={(e) => setCleanupRetentionDays(Math.max(0, parseInt(e.target.value) || 0))}
                className="w-20 border-border bg-background text-foreground"
              />
              <span className="text-muted-foreground text-sm">days</span>
            </div>

            {cleanupCandidates.length === 0 ? (
              <div className="bg-green-900/20 border border-green-700/30 rounded-lg p-4">
                <p className="text-green-400 text-sm">Nothing to clean up — all versions are either the latest patch in their series or within the retention window.</p>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="bg-red-900/20 border border-red-700/30 rounded-lg p-4">
                  <p className="text-red-400 text-sm font-medium mb-2">
                    {cleanupCandidates.length} version{cleanupCandidates.length !== 1 ? 's' : ''} will
                    be permanently deleted ({formatFileSize(totalCleanupSize)}):
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {cleanupCandidates.map((v) => (
                      <Badge
                        key={v.version}
                        variant="outline"
                        className="border-red-700/50 text-red-400 text-xs"
                      >
                        v{v.version}
                      </Badge>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCleanupDialogOpen(false)}
              disabled={cleaningUp}
              className="border-border bg-card text-foreground hover:bg-accent hover:text-foreground cursor-pointer"
            >
              Cancel
            </Button>
            <Button
              onClick={handleCleanup}
              disabled={cleanupCandidates.length === 0 || cleaningUp}
              className="bg-red-600 hover:bg-red-700 text-foreground cursor-pointer"
            >
              {cleaningUp ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Deleting...
                </>
              ) : (
                `Delete ${cleanupCandidates.length} Version${cleanupCandidates.length !== 1 ? 's' : ''}`
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      </div>
    </div>
  );
}
