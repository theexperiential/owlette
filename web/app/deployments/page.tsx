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
import { Plus, CheckCircle2, XCircle, Clock, Loader2, Trash2, X, MoreVertical, RefreshCw, Package, PlayCircle, Archive } from 'lucide-react';
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
  const { user, loading: authLoading, signOut, userSites, isAdmin, lastSiteId, updateLastSite } = useAuth();
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
      throw new Error(error.message || 'failed to create uninstall task');
    }
  };

  const handleDeleteDeployment = async () => {
    if (!deploymentToDelete) return;

    try {
      await deleteDeployment(deploymentToDelete);
      toast.success('deployment record deleted successfully');
    } catch (error: any) {
      console.error('Failed to delete deployment:', error);
      toast.error(error.message || 'failed to delete deployment record');
    } finally {
      setDeploymentToDelete(null);
    }
  };

  const handleRetryDeployment = async (deployment: any) => {
    try {
      // Find all failed targets
      const failedTargets = deployment.targets.filter((t: any) => t.status === 'failed');

      if (failedTargets.length === 0) {
        toast.error('no failed targets to retry');
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

      toast.success(`retrying deployment for ${failedTargets.length} failed machine(s)`);
    } catch (error: any) {
      console.error('Failed to retry deployment:', error);
      toast.error(error.message || 'failed to retry deployment');
    }
  };

  // Load saved site from Firestore (cross-browser) or localStorage (same-browser fallback)
  useEffect(() => {
    if (!sitesLoading && sites.length > 0 && !currentSiteId) {
      const savedSite = lastSiteId || localStorage.getItem('owlette_current_site');
      if (savedSite && sites.find(s => s.id === savedSite)) {
        setCurrentSiteId(savedSite);
      } else {
        setCurrentSiteId(sites[0].id);
      }
    }
  }, [sites, sitesLoading, currentSiteId, lastSiteId]);

  const handleSiteChange = (siteId: string) => {
    setCurrentSiteId(siteId);
    updateLastSite(siteId);
  };

  useEffect(() => {
    if (!authLoading && !user) {
      router.push('/login');
    }
  }, [user, authLoading, router]);

  if (authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground">loading...</p>
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
        currentPage="deploy software"
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

      {/* Subtle top glow for readability */}
      <div className="pointer-events-none fixed inset-x-0 top-14 h-48 z-0" style={{ background: 'linear-gradient(to bottom, oklch(0.20 0.03 250 / 0.7), transparent)' }} />

      {/* Main content */}
      <main className="relative z-10 mx-auto max-w-screen-2xl p-3 md:p-4">
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
          title="delete deployment record"
          description={`are you sure you want to delete this deployment record?\n\nthis will permanently remove the deployment from the list. this action cannot be undone.\n\nnote: this only deletes the record - it does not uninstall software from machines.`}
          confirmText="delete"
          cancelText="cancel"
          onConfirm={handleDeleteDeployment}
          variant="destructive"
        />

        {/* Section header with inline stats */}
        <div className="mt-3 md:mt-2 mb-6 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div className="flex items-center gap-6 md:gap-8">
            <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground">deployments</h2>

            <div className="flex items-center gap-6 md:gap-8">
              <div className="flex items-center gap-2.5">
                <div className={`rounded-md p-1.5 ${deployments.length > 0 ? 'bg-accent-cyan/10 text-accent-cyan' : 'bg-muted text-muted-foreground'}`}>
                  <Package className="h-4 w-4" />
                </div>
                <div>
                  <div className="flex items-baseline gap-0.5">
                    <span className="text-xl font-bold text-foreground">{deployments.length}</span>
                  </div>
                  <p className="text-[11px] text-muted-foreground leading-tight">total</p>
                </div>
              </div>

              <div className="h-8 w-px bg-border" />

              <div className="flex items-center gap-2.5">
                <div className={`rounded-md p-1.5 ${deployments.filter(d => d.status === 'in_progress').length > 0 ? 'bg-accent-cyan/10 text-accent-cyan' : 'bg-muted text-muted-foreground'}`}>
                  <PlayCircle className="h-4 w-4" />
                </div>
                <div>
                  <div className="flex items-baseline gap-0.5">
                    <span className={`text-xl font-bold ${deployments.filter(d => d.status === 'in_progress').length > 0 ? 'text-accent-cyan' : 'text-foreground'}`}>{deployments.filter(d => d.status === 'in_progress').length}</span>
                  </div>
                  <p className="text-[11px] text-muted-foreground leading-tight">in progress</p>
                </div>
              </div>

              <div className="h-8 w-px bg-border" />

              <div className="flex items-center gap-2.5">
                <div className="rounded-md p-1.5 bg-muted text-muted-foreground">
                  <Archive className="h-4 w-4" />
                </div>
                <div>
                  <div className="flex items-baseline gap-0.5">
                    <span className="text-xl font-bold text-foreground">{templates.length}</span>
                  </div>
                  <p className="text-[11px] text-muted-foreground leading-tight">templates</p>
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-shrink-0">
            <UpdateOwletteButton siteId={currentSiteId} machines={machines} />
            <Button
              onClick={() => setDeployDialogOpen(true)}
              className="bg-accent-cyan hover:bg-accent-cyan-hover text-gray-900 cursor-pointer"
            >
              <Plus className="h-4 w-4 mr-2" />
              new deployment
            </Button>
          </div>
        </div>

        {/* Deployments List */}
        <div className="rounded-lg border border-border bg-card overflow-hidden animate-in fade-in duration-300">
          {deploymentsLoading ? (
            <div className="p-8 text-center">
              <Loader2 className="h-8 w-8 animate-spin mx-auto text-muted-foreground" />
              <p className="mt-2 text-muted-foreground">loading deployments...</p>
            </div>
          ) : deployments.length === 0 ? (
            <div className="p-8 text-center">
              <p className="text-foreground font-medium mb-1">no deployments yet</p>
              <p className="text-sm text-muted-foreground mb-4">create your first deployment to install software across your machines</p>
              <Button
                onClick={() => setDeployDialogOpen(true)}
                className="bg-accent-cyan hover:bg-accent-cyan-hover text-gray-900 cursor-pointer"
                size="sm"
              >
                <Plus className="h-4 w-4 mr-1" />
                new deployment
              </Button>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {deployments.map((deployment) => (
                <div key={deployment.id}>
                  <div
                    className="flex items-center justify-between px-4 py-3 hover:bg-muted/50 transition-colors cursor-pointer"
                    onClick={() => {
                      const selection = window.getSelection();
                      if (selection && selection.toString().length > 0) return;
                      setSelectedDeploymentId(deployment.id === selectedDeploymentId ? null : deployment.id);
                    }}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      {getStatusIcon(deployment.status)}
                      <div className="min-w-0">
                        <span className="text-foreground font-medium select-text">{deployment.name}</span>
                        <p className="text-xs text-muted-foreground select-text truncate">{deployment.installer_name}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 flex-shrink-0">
                      <div className="w-[90px] flex justify-end">
                        {(() => {
                          const failedTargets = deployment.targets.filter((t: any) => t.status === 'failed' && t.error);
                          const errorMessages = failedTargets.map((t: any) => `${t.machineId}: ${t.error}`).join('\n');
                          return getStatusBadge(deployment.status, errorMessages || undefined);
                        })()}
                      </div>
                      <span className="text-xs text-muted-foreground hidden sm:block w-[150px] text-right">
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
                        <DropdownMenuContent align="end" className="border-border bg-secondary">
                          {deployment.targets.some((t: any) => t.status === 'failed') && (
                            <DropdownMenuItem
                              onClick={(e) => {
                                e.stopPropagation();
                                handleRetryDeployment(deployment);
                              }}
                              className="text-foreground focus:bg-accent focus:text-foreground cursor-pointer"
                            >
                              <RefreshCw className="h-4 w-4 mr-2" />
                              retry failed
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
                              className="text-foreground focus:bg-accent focus:text-foreground cursor-pointer"
                            >
                              <Trash2 className="h-4 w-4 mr-2" />
                              uninstall software
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
                            delete record
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>

                  {selectedDeploymentId === deployment.id && (
                    <div className="border-t border-border">
                      <div className="mx-4 my-3 rounded-lg border border-border bg-background p-4 space-y-4">
                        <div className="grid gap-2 text-sm">
                          <div className="flex gap-2">
                            <span className="text-muted-foreground flex-shrink-0 w-24">installer url</span>
                            <span className="text-foreground select-text break-all">{deployment.installer_url}</span>
                          </div>
                          {deployment.silent_flags && (
                            <div className="flex gap-2">
                              <span className="text-muted-foreground flex-shrink-0 w-24">silent flags</span>
                              <span className="text-foreground select-text break-all font-mono text-xs leading-relaxed">{deployment.silent_flags}</span>
                            </div>
                          )}
                          {deployment.verify_path && (
                            <div className="flex gap-2">
                              <span className="text-muted-foreground flex-shrink-0 w-24">verify path</span>
                              <span className="text-foreground select-text break-all">{deployment.verify_path}</span>
                            </div>
                          )}
                        </div>

                        <div>
                          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">targets ({deployment.targets.length})</h4>
                          <div className="space-y-1.5">
                            {deployment.targets.map((target) => (
                              <div key={target.machineId} className="flex items-center justify-between py-1.5 px-3 rounded border border-border/40 bg-background/50">
                                <span className="text-foreground text-sm select-text">{target.machineId}</span>
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
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
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
