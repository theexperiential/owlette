'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useSites } from '@/hooks/useFirestore';
import { useProjectDistributionManager } from '@/hooks/useProjectDistributions';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Plus, CheckCircle2, XCircle, Clock, Loader2, Trash2, X, FolderSync, PlayCircle, Archive } from 'lucide-react';
import ProjectDistributionDialog from '@/components/ProjectDistributionDialog';
import { ManageSitesDialog } from '@/components/ManageSitesDialog';
import { CreateSiteDialog } from '@/components/CreateSiteDialog';
import { PageHeader } from '@/components/PageHeader';
import { AccountSettingsDialog } from '@/components/AccountSettingsDialog';
import DownloadButton from '@/components/DownloadButton';
import { toast } from 'sonner';

export default function ProjectsPage() {
  const { user, loading: authLoading, signOut, userSites, isAdmin, lastSiteId, updateLastSite } = useAuth();
  const { sites, loading: sitesLoading, createSite, updateSite, deleteSite } = useSites(user?.uid, userSites, isAdmin);
  const [currentSiteId, setCurrentSiteId] = useState<string>('');
  const [distributionDialogOpen, setDistributionDialogOpen] = useState(false);
  const [selectedDistributionId, setSelectedDistributionId] = useState<string | null>(null);
  const [manageDialogOpen, setManageDialogOpen] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [accountSettingsOpen, setAccountSettingsOpen] = useState(false);
  const router = useRouter();

  const {
    distributions,
    distributionsLoading,
    templates,
    templatesLoading,
    createDistribution,
    createTemplate,
    updateTemplate,
    deleteTemplate,
    cancelDistribution,
    deleteDistribution,
  } = useProjectDistributionManager(currentSiteId);

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
      case 'failed':
        return <XCircle className="h-5 w-5 text-red-500" />;
      case 'in_progress':
        return <Loader2 className="h-5 w-5 text-accent-cyan animate-spin" />;
      case 'partial':
        return <Clock className="h-5 w-5 text-yellow-500" />;
      default:
        return <Clock className="h-5 w-5 text-muted-foreground" />;
    }
  };

  const getStatusBadge = (status: string) => {
    const colors: Record<string, string> = {
      completed: 'bg-green-600 hover:bg-green-700',
      failed: 'bg-red-600 hover:bg-red-700',
      in_progress: 'bg-accent-cyan hover:bg-accent-cyan-hover',
      partial: 'bg-yellow-600 hover:bg-yellow-700',
      pending: 'bg-muted hover:bg-muted',
      downloading: 'bg-cyan-600 hover:bg-cyan-700',
      extracting: 'bg-purple-600 hover:bg-purple-700',
    };

    return (
      <Badge className={`select-none ${colors[status] || colors.pending}`}>
        {status.replace('_', ' ')}
      </Badge>
    );
  };

  const selectedDistribution = distributions.find(d => d.id === selectedDistributionId);

  return (
    <div className="relative min-h-screen pb-8">
      {/* Header */}
      <PageHeader
        currentPage="distribute projects"
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
      <main className="relative z-10 mx-auto max-w-screen-2xl p-3 md:p-4">
        {/* Distribution Dialog */}
        <ProjectDistributionDialog
          open={distributionDialogOpen}
          onOpenChange={setDistributionDialogOpen}
          siteId={currentSiteId}
          templates={templates}
          onCreateDistribution={createDistribution}
          onCreateTemplate={createTemplate}
          onUpdateTemplate={updateTemplate}
          onDeleteTemplate={deleteTemplate}
        />

        {/* Section header with inline stats */}
        <div className="mt-3 md:mt-2 mb-6 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div className="flex items-center gap-6 md:gap-8">
            <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground">distributions</h2>

            <div className="flex items-center gap-6 md:gap-8">
              <div className="flex items-center gap-2.5">
                <div className={`rounded-md p-1.5 ${distributions.length > 0 ? 'bg-accent-cyan/10 text-accent-cyan' : 'bg-muted text-muted-foreground'}`}>
                  <FolderSync className="h-4 w-4" />
                </div>
                <div>
                  <div className="flex items-baseline gap-0.5">
                    <span className="text-xl font-bold text-foreground">{distributions.length}</span>
                  </div>
                  <p className="text-[11px] text-muted-foreground leading-tight">total</p>
                </div>
              </div>

              <div className="h-8 w-px bg-border" />

              <div className="flex items-center gap-2.5">
                <div className={`rounded-md p-1.5 ${distributions.filter(d => d.status === 'in_progress').length > 0 ? 'bg-accent-cyan/10 text-accent-cyan' : 'bg-muted text-muted-foreground'}`}>
                  <PlayCircle className="h-4 w-4" />
                </div>
                <div>
                  <div className="flex items-baseline gap-0.5">
                    <span className={`text-xl font-bold ${distributions.filter(d => d.status === 'in_progress').length > 0 ? 'text-accent-cyan' : 'text-foreground'}`}>{distributions.filter(d => d.status === 'in_progress').length}</span>
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

          <Button
            onClick={() => setDistributionDialogOpen(true)}
            className="bg-accent-cyan hover:bg-accent-cyan-hover text-gray-900 cursor-pointer flex-shrink-0"
          >
            <Plus className="h-4 w-4 mr-2" />
            new distribution
          </Button>
        </div>

        {/* Distributions List */}
        <div className="rounded-lg border border-border bg-card overflow-hidden animate-in fade-in duration-300">
          {distributionsLoading ? (
            <div className="p-8 text-center">
              <Loader2 className="h-8 w-8 animate-spin mx-auto text-muted-foreground" />
              <p className="mt-2 text-muted-foreground">loading distributions...</p>
            </div>
          ) : distributions.length === 0 ? (
            <div className="p-8 text-center">
              <p className="text-foreground font-medium mb-1">no distributions yet</p>
              <p className="text-sm text-muted-foreground mb-4">create your first distribution to sync project files across your machines</p>
              <Button
                onClick={() => setDistributionDialogOpen(true)}
                className="bg-accent-cyan hover:bg-accent-cyan-hover text-gray-900 cursor-pointer"
                size="sm"
              >
                <Plus className="h-4 w-4 mr-1" />
                new distribution
              </Button>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {distributions.map((distribution) => (
                <div key={distribution.id}>
                  <div
                    className="flex items-center justify-between px-4 py-3 hover:bg-muted/50 transition-colors cursor-pointer"
                    onClick={() => setSelectedDistributionId(distribution.id === selectedDistributionId ? null : distribution.id)}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      {getStatusIcon(distribution.status)}
                      <div className="min-w-0">
                        <span className="text-foreground font-medium select-text">{distribution.name}</span>
                        <p className="text-xs text-muted-foreground select-text truncate">
                          {(() => {
                            try {
                              const url = new URL(distribution.project_url);
                              const filename = url.pathname.substring(url.pathname.lastIndexOf('/') + 1);
                              return filename || 'project.zip';
                            } catch {
                              return 'Invalid URL';
                            }
                          })()}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 flex-shrink-0">
                      <div className="w-[90px] flex justify-end">
                        {getStatusBadge(distribution.status)}
                      </div>
                      <span className="text-xs text-muted-foreground hidden sm:block w-[150px] text-right">
                        {new Date(distribution.createdAt).toLocaleString()}
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={async (e) => {
                          e.stopPropagation();
                          try {
                            await deleteDistribution(distribution.id);
                          } catch (error: any) {
                            console.error('Failed to delete distribution:', error);
                          }
                        }}
                        className="h-7 w-7 p-0 text-muted-foreground hover:text-red-400 hover:bg-red-950/30 cursor-pointer"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>

                  {selectedDistributionId === distribution.id && (
                    <div className="border-t border-border">
                      <div className="mx-4 my-3 rounded-lg border border-border bg-background p-4 space-y-4">
                        <div className="grid gap-2 text-sm">
                          <div className="flex gap-2">
                            <span className="text-muted-foreground flex-shrink-0 w-24">project url</span>
                            <span className="text-foreground select-text break-all">{distribution.project_url}</span>
                          </div>
                          <div className="flex gap-2">
                            <span className="text-muted-foreground flex-shrink-0 w-24">extract path</span>
                            <span className="text-foreground select-text break-all">
                              {distribution.extract_path || <span className="text-muted-foreground italic">~/Documents/OwletteProjects (default)</span>}
                            </span>
                          </div>
                          {distribution.verify_files && distribution.verify_files.length > 0 && (
                            <div className="flex gap-2">
                              <span className="text-muted-foreground flex-shrink-0 w-24">verify files</span>
                              <span className="text-foreground select-text break-all">{distribution.verify_files.join(', ')}</span>
                            </div>
                          )}
                        </div>

                        <div>
                          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">targets ({distribution.targets.length})</h4>
                          <div className="space-y-1.5">
                            {distribution.targets.map((target) => (
                              <div key={target.machineId} className="flex items-center justify-between py-1.5 px-3 rounded border border-border/40 bg-background/50">
                                <span className="text-foreground text-sm select-text">{target.machineId}</span>
                                <div className="flex items-center gap-2">
                                  {target.progress !== undefined && (target.status === 'downloading' || target.status === 'extracting') && (
                                    <span className="text-xs text-muted-foreground">{target.progress}%</span>
                                  )}
                                  {getStatusBadge(target.status)}
                                  {(target.status === 'pending' || target.status === 'downloading' || target.status === 'extracting') && (
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      onClick={async () => {
                                        try {
                                          await cancelDistribution(distribution.id, target.machineId, distribution.project_name);
                                        } catch (error: any) {
                                          console.error('Failed to cancel distribution:', error);
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
  );
}
