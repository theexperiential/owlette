'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useSites, useMachines } from '@/hooks/useFirestore';
import { useDeploymentManager } from '@/hooks/useDeployments';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Plus, CheckCircle2, XCircle, Clock, Loader2, Trash2, X, MoreVertical, RefreshCw } from 'lucide-react';
import DeploymentDialog from '@/components/DeploymentDialog';
import UninstallDialog from '@/components/UninstallDialog';
import { ManageSitesDialog } from '@/components/ManageSitesDialog';
import { CreateSiteDialog } from '@/components/CreateSiteDialog';
import { PageHeader } from '@/components/PageHeader';
import { AccountSettingsDialog } from '@/components/AccountSettingsDialog';
import DownloadButton from '@/components/DownloadButton';
import ConfirmDialog from '@/components/ConfirmDialog';
import { UpdateOwletteButton } from '@/components/UpdateOwletteButton';
import { useUninstall } from '@/hooks/useUninstall';
import { toast } from 'sonner';

export default function DeploymentsPage() {
  const { user, loading: authLoading, signOut, userSites, isAdmin } = useAuth();
  const { sites, loading: sitesLoading, createSite, updateSite, deleteSite } = useSites(user?.uid, userSites, isAdmin);
  const [currentSiteId, setCurrentSiteId] = useState<string>('');
  const [deployDialogOpen, setDeployDialogOpen] = useState(false);
  const [uninstallDialogOpen, setUninstallDialogOpen] = useState(false);
  const [initialSoftwareName, setInitialSoftwareName] = useState<string | undefined>(undefined);
  const [uninstallDeploymentId, setUninstallDeploymentId] = useState<string | undefined>(undefined);
  const [selectedDeploymentId, setSelectedDeploymentId] = useState<string | null>(null);
  const [manageDialogOpen, setManageDialogOpen] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [accountSettingsOpen, setAccountSettingsOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deploymentToDelete, setDeploymentToDelete] = useState<string | null>(null);
  const router = useRouter();

  const {
    deployments,
    deploymentsLoading,
    templates,
    templatesLoading,
    createDeployment,
    createTemplate,
    updateTemplate,
    deleteTemplate,
    cancelDeployment,
    deleteDeployment,
  } = useDeploymentManager(currentSiteId);

  const { machines, loading: machinesLoading } = useMachines(currentSiteId);
  const { createUninstall } = useUninstall();

  const handleCreateUninstall = async (softwareName: string, machineIds: string[], deploymentId?: string) => {
    try {
      await createUninstall(currentSiteId, softwareName, machineIds, deploymentId);
    } catch (error: any) {
      throw new Error(error.message || 'Failed to create uninstall task');
    }
  };

  const handleDeleteDeployment = async () => {
    if (!deploymentToDelete) return;

    try {
      await deleteDeployment(deploymentToDelete);
      toast.success('Deployment record deleted successfully');
    } catch (error: any) {
      console.error('Failed to delete deployment:', error);
      toast.error(error.message || 'Failed to delete deployment record');
    } finally {
      setDeploymentToDelete(null);
    }
  };

  const handleRetryDeployment = async (deployment: any) => {
    try {
      // Find all failed targets
      const failedTargets = deployment.targets.filter((t: any) => t.status === 'failed');

      if (failedTargets.length === 0) {
        toast.error('No failed targets to retry');
        return;
      }

      // Create a new deployment with the same parameters but only for failed machines
      const machineIds = failedTargets.map((t: any) => t.machineId);

      await createDeployment({
        name: `${deployment.name} (Retry)`,
        installer_name: deployment.installer_name,
        installer_url: deployment.installer_url,
        silent_flags: deployment.silent_flags,
        verify_path: deployment.verify_path,
        targets: [], // Will be initialized by createDeployment
      }, machineIds);

      toast.success(`Retrying deployment for ${failedTargets.length} failed machine(s)`);
    } catch (error: any) {
      console.error('Failed to retry deployment:', error);
      toast.error(error.message || 'Failed to retry deployment');
    }
  };

  // Load saved site from localStorage or use first available
  useEffect(() => {
    if (!sitesLoading && sites.length > 0 && !currentSiteId) {
      const savedSite = localStorage.getItem('owlette_current_site');
      if (savedSite && sites.find(s => s.id === savedSite)) {
        setCurrentSiteId(savedSite);
      } else {
        setCurrentSiteId(sites[0].id);
      }
    }
  }, [sites, sitesLoading, currentSiteId]);

  // Save site selection to localStorage
  const handleSiteChange = (siteId: string) => {
    setCurrentSiteId(siteId);
    localStorage.setItem('owlette_current_site', siteId);
  };

  useEffect(() => {
    if (!authLoading && !user) {
      router.push('/login');
    }
  }, [user, authLoading, router]);

  if (authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (!user) {
    return null;
  }

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'completed':
        return <CheckCircle2 className="h-5 w-5 text-green-500" />;
      case 'uninstalled':
        return <Trash2 className="h-5 w-5 text-purple-500" />;
      case 'failed':
        return <XCircle className="h-5 w-5 text-red-500" />;
      case 'cancelled':
        return <XCircle className="h-5 w-5 text-orange-500" />;
      case 'in_progress':
        return <Loader2 className="h-5 w-5 text-accent-cyan animate-spin" />;
      case 'partial':
        return <Clock className="h-5 w-5 text-yellow-500" />;
      default:
        return <Clock className="h-5 w-5 text-muted-foreground" />;
    }
  };

  const getStatusBadge = (status: string, error?: string) => {
    const colors: Record<string, string> = {
      completed: 'bg-green-600 hover:bg-green-700',
      uninstalled: 'bg-purple-600 hover:bg-purple-700',
      failed: 'bg-red-600 hover:bg-red-700',
      cancelled: 'bg-orange-600 hover:bg-orange-700',
      in_progress: 'bg-accent-cyan hover:bg-accent-cyan-hover',
      partial: 'bg-yellow-600 hover:bg-yellow-700',
      pending: 'bg-muted hover:bg-muted',
      downloading: 'bg-cyan-600 hover:bg-cyan-700',
      installing: 'bg-purple-600 hover:bg-purple-700',
    };

    const badge = (
      <Badge className={`select-none ${colors[status] || colors.pending}`}>
        {status.replace('_', ' ')}
      </Badge>
    );

    // Wrap in tooltip if there's an error message
    if (error && (status === 'failed' || status === 'partial')) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            {badge}
          </TooltipTrigger>
          <TooltipContent className="max-w-md whitespace-pre-wrap">
            <p className="text-sm">{error}</p>
          </TooltipContent>
        </Tooltip>
      );
    }

    return badge;
  };

  const selectedDeployment = deployments.find(d => d.id === selectedDeploymentId);

  return (
    <TooltipProvider delayDuration={200}>
    <div className="min-h-screen pb-8">
      {/* Header */}
      <PageHeader
        currentPage="Deploy Software"
        sites={sites}
        currentSiteId={currentSiteId}
        onSiteChange={handleSiteChange}
        onManageSites={() => setManageDialogOpen(true)}
        onAccountSettings={() => setAccountSettingsOpen(true)}
        actionButton={<DownloadButton />}
      />

      {/* Site Management Dialogs */}
      <ManageSitesDialog
        open={manageDialogOpen}
        onOpenChange={setManageDialogOpen}
        sites={sites}
        currentSiteId={currentSiteId}
        onUpdateSite={updateSite}
        onDeleteSite={async (siteId) => {
          await deleteSite(siteId);
          if (siteId === currentSiteId) {
            const remainingSites = sites.filter(s => s.id !== siteId);
            if (remainingSites.length > 0) {
              handleSiteChange(remainingSites[0].id);
            }
          }
        }}
        onCreateSite={() => setCreateDialogOpen(true)}
      />

      <CreateSiteDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onCreateSite={createSite}
        onSiteCreated={(siteId) => setCurrentSiteId(siteId)}
      />

      {/* Main content */}
      <main className="mx-auto max-w-screen-2xl p-3 md:p-4">
        <div className="mt-3 md:mt-2 mb-6 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div className="flex-1">
            <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground mb-1">Software Deployments</h2>
            <p className="text-sm md:text-base text-muted-foreground">
              Deploy software installers across your machines
            </p>
          </div>

          <div className="flex-shrink-0 flex gap-2">
            <UpdateOwletteButton siteId={currentSiteId} machines={machines} />
            <Button
              onClick={() => setDeployDialogOpen(true)}
              className="bg-accent-cyan hover:bg-accent-cyan-hover text-gray-900 cursor-pointer"
            >
              <Plus className="h-4 w-4 mr-2" />
              New Deployment
            </Button>
          </div>
        </div>

        {/* Dialogs */}
        <DeploymentDialog
          open={deployDialogOpen}
          onOpenChange={setDeployDialogOpen}
          siteId={currentSiteId}
          templates={templates}
          onCreateDeployment={createDeployment}
          onCreateTemplate={createTemplate}
          onUpdateTemplate={updateTemplate}
          onDeleteTemplate={deleteTemplate}
        />

        <UninstallDialog
          open={uninstallDialogOpen}
          onOpenChange={setUninstallDialogOpen}
          siteId={currentSiteId}
          onCreateUninstall={handleCreateUninstall}
          initialSoftwareName={initialSoftwareName}
          deploymentId={uninstallDeploymentId}
        />

        <ConfirmDialog
          open={deleteDialogOpen}
          onOpenChange={setDeleteDialogOpen}
          title="Delete Deployment Record"
          description={`Are you sure you want to delete this deployment record?\n\nThis will permanently remove the deployment from the list. This action cannot be undone.\n\nNote: This only deletes the record - it does not uninstall software from machines.`}
          confirmText="Delete"
          cancelText="Cancel"
          onConfirm={handleDeleteDeployment}
          variant="destructive"
        />

        {/* Quick Stats */}
        <div className="mb-6 grid gap-2 md:gap-4 grid-cols-2 md:grid-cols-4 animate-in fade-in duration-300">
          <Card className="border-border bg-card">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-foreground">Total Deployments</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-foreground">{deployments.length}</div>
            </CardContent>
          </Card>

          <Card className="border-border bg-card">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-foreground">In Progress</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-foreground">
                {deployments.filter(d => d.status === 'in_progress').length}
              </div>
            </CardContent>
          </Card>

          <Card className="border-border bg-card">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-foreground">Completed</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-foreground">
                {deployments.filter(d => d.status === 'completed').length}
              </div>
            </CardContent>
          </Card>

          <Card className="border-border bg-card">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-foreground">Templates</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-foreground">{templates.length}</div>
            </CardContent>
          </Card>
        </div>

        {/* Deployments List */}
        <div className="space-y-4 animate-in fade-in duration-300">
          {deploymentsLoading ? (
            <Card className="border-border bg-card">
              <CardContent className="p-8 text-center">
                <Loader2 className="h-8 w-8 animate-spin mx-auto text-muted-foreground" />
                <p className="mt-2 text-muted-foreground">Loading deployments...</p>
              </CardContent>
            </Card>
          ) : deployments.length === 0 ? (
            <Card className="border-border bg-card">
              <CardHeader>
                <CardTitle className="text-foreground">No Deployments Yet</CardTitle>
                <CardDescription className="text-muted-foreground">
                  Create your first deployment to install software across your machines
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button
                  onClick={() => setDeployDialogOpen(true)}
                  className="bg-accent-cyan hover:bg-accent-cyan-hover text-gray-900 cursor-pointer"
                >
                  <Plus className="h-4 w-4 mr-2" />
                  New Deployment
                </Button>
              </CardContent>
            </Card>
          ) : (
            deployments.map((deployment) => (
              <Card
                key={deployment.id}
                className="border-border bg-card cursor-pointer hover:border-border transition-colors"
                onClick={() => {
                  // Don't collapse/expand if user is selecting text
                  const selection = window.getSelection();
                  if (selection && selection.toString().length > 0) {
                    return;
                  }
                  setSelectedDeploymentId(deployment.id === selectedDeploymentId ? null : deployment.id);
                }}
              >
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      {getStatusIcon(deployment.status)}
                      <div className="space-y-2">
                        <CardTitle className="text-foreground select-text">{deployment.name}</CardTitle>
                        <CardDescription className="text-muted-foreground select-text">
                          {deployment.installer_name}
                        </CardDescription>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {(() => {
                        // Collect error messages from all failed targets
                        const failedTargets = deployment.targets.filter((t: any) => t.status === 'failed' && t.error);
                        const errorMessages = failedTargets.map((t: any) => `${t.machineId}: ${t.error}`).join('\n');
                        return getStatusBadge(deployment.status, errorMessages || undefined);
                      })()}
                      <span className="text-xs text-muted-foreground">
                        {new Date(deployment.createdAt).toLocaleString()}
                      </span>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={(e) => e.stopPropagation()}
                            className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground hover:bg-muted cursor-pointer"
                          >
                            <MoreVertical className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="border-border bg-muted">
                          {deployment.targets.some((t: any) => t.status === 'failed') && (
                            <DropdownMenuItem
                              onClick={(e) => {
                                e.stopPropagation();
                                handleRetryDeployment(deployment);
                              }}
                              className="text-foreground focus:bg-muted focus:text-foreground cursor-pointer"
                            >
                              <RefreshCw className="h-4 w-4 mr-2" />
                              Retry Failed
                            </DropdownMenuItem>
                          )}
                          {deployment.status !== 'uninstalled' && (
                            <DropdownMenuItem
                              onClick={(e) => {
                                e.stopPropagation();
                                setInitialSoftwareName(deployment.installer_name);
                                setUninstallDeploymentId(deployment.id);
                                setUninstallDialogOpen(true);
                              }}
                              className="text-foreground focus:bg-muted focus:text-foreground cursor-pointer"
                            >
                              <Trash2 className="h-4 w-4 mr-2" />
                              Uninstall Software
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem
                            onClick={(e) => {
                              e.stopPropagation();
                              setDeploymentToDelete(deployment.id);
                              setDeleteDialogOpen(true);
                            }}
                            className="text-red-400 focus:bg-red-950/30 focus:text-red-400 cursor-pointer"
                          >
                            <X className="h-4 w-4 mr-2" />
                            Delete Record
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                </CardHeader>

                {selectedDeploymentId === deployment.id && (
                  <CardContent className="space-y-4 border-t border-border pt-4">
                    <div className="grid gap-3 text-sm">
                      <div>
                        <div className="text-muted-foreground mb-1">Installer URL:</div>
                        <div className="text-foreground select-text break-all">{deployment.installer_url}</div>
                      </div>
                      <div>
                        <div className="text-muted-foreground mb-1">Silent Flags:</div>
                        <div className="text-foreground select-text break-all">{deployment.silent_flags || 'None'}</div>
                      </div>
                      {deployment.verify_path && (
                        <div>
                          <div className="text-muted-foreground mb-1">Verify Path:</div>
                          <div className="text-foreground select-text break-all">{deployment.verify_path}</div>
                        </div>
                      )}
                    </div>

                    <div>
                      <h4 className="text-sm font-medium text-foreground mb-2">Target Machines ({deployment.targets.length})</h4>
                      <div className="space-y-2">
                        {deployment.targets.map((target) => (
                          <div key={target.machineId} className="flex items-center justify-between p-2 rounded bg-muted">
                            <span className="text-foreground select-text">{target.machineId}</span>
                            <div className="flex items-center gap-2">
                              {target.progress !== undefined && (target.status === 'downloading' || target.status === 'installing') && (
                                <span className="text-xs text-muted-foreground">{target.progress}%</span>
                              )}
                              {getStatusBadge(target.status, target.error)}
                              {(target.status === 'pending' || target.status === 'downloading' || target.status === 'installing') && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={async () => {
                                    try {
                                      await cancelDeployment(deployment.id, target.machineId, deployment.installer_name);
                                      // Status will update automatically via Firestore listener
                                    } catch (error: any) {
                                      console.error('Failed to cancel deployment:', error);
                                    }
                                  }}
                                  className="h-7 px-2 text-red-400 hover:text-red-300 hover:bg-red-950/30 cursor-pointer"
                                >
                                  <X className="h-4 w-4" />
                                </Button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </CardContent>
                )}
              </Card>
            ))
          )}
        </div>
      </main>

      {/* Account Settings Dialog */}
      <AccountSettingsDialog
        open={accountSettingsOpen}
        onOpenChange={setAccountSettingsOpen}
      />
    </div>
    </TooltipProvider>
  );
}
