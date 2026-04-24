'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useSites, useMachines } from '@/hooks/useFirestore';
import { useProjectDistributionManager } from '@/hooks/useProjectDistributions';
import { useRoosts } from '@/hooks/useRoosts';
import { RoostTargetsList, RoostStatusPill } from '@/components/RoostTargetRow';
import { RoostContentsRow } from '@/components/RoostContentsRow';
import { EmptyStateUpload } from '@/components/EmptyStateUpload';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Plus, Loader2, FolderSync, Archive, ChevronDown, ChevronRight, ChevronsUpDown, ChevronsDownUp, MoreVertical, Trash2, RotateCcw, RefreshCw } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from 'sonner';
import ProjectDistributionDialog from '@/components/ProjectDistributionDialog';
import ConfirmDialog from '@/components/ConfirmDialog';
import { MinimizedUploadCard } from '@/components/MinimizedUploadCard';
import { useRoostUpload } from '@/hooks/useRoostUpload';
import { ManageSitesDialog } from '@/components/ManageSitesDialog';
import { CreateSiteDialog } from '@/components/CreateSiteDialog';
import { PageHeader } from '@/components/PageHeader';
import { AccountSettingsDialog } from '@/components/AccountSettingsDialog';
import DownloadButton from '@/components/DownloadButton';
import { LoadingWord } from '@/components/LoadingWord';
import { formatSiteScopedTimestamp } from '@/lib/timeUtils';
import { formatBytes as formatContentSize } from '@/lib/preUploadCheck';

export default function ProjectsPage() {
  const { user, loading: authLoading, userSites, isSuperadmin, lastSiteId, updateLastSite, userPreferences } = useAuth();
  const { sites, loading: sitesLoading, createSite, updateSite, deleteSite } = useSites(user?.uid, userSites, isSuperadmin);
  // User's explicit pick via handleSiteChange / onSiteCreated. Empty string means
  // "no explicit pick yet — fall back to lastSiteId / localStorage / sites[0]".
  const [userPickedSiteId, setUserPickedSiteId] = useState<string>('');
  // Derived during render (not via useEffect + setState) so we don't trigger
  // cascading renders on site-list changes — matches `react-hooks/set-state-in-effect`.
  const currentSiteId = useMemo(() => {
    if (userPickedSiteId && sites.some((s) => s.id === userPickedSiteId)) {
      return userPickedSiteId;
    }
    if (sitesLoading || sites.length === 0) return '';
    const savedSite =
      lastSiteId ||
      (typeof window !== 'undefined'
        ? localStorage.getItem('owlette_current_site')
        : null);
    if (savedSite && sites.some((s) => s.id === savedSite)) return savedSite;
    return sites[0].id;
  }, [userPickedSiteId, sites, sitesLoading, lastSiteId]);
  // Resolve site timezone for display-mode-aware timestamp rendering on this site-scoped surface.
  const currentSite = sites.find(s => s.id === currentSiteId);
  const siteTimezone = currentSite?.timezone;
  const [distributionDialogOpen, setDistributionDialogOpen] = useState(false);
  // Multi-expand — mirrors dashboard + logs. Ephemeral (no Firestore persistence):
  // roost expansion is transient inspection, not a user preference.
  const [expandedRoostIds, setExpandedRoostIds] = useState<Set<string>>(new Set());
  const [manageDialogOpen, setManageDialogOpen] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [accountSettingsOpen, setAccountSettingsOpen] = useState(false);
  // Pending row-level actions. `null` = no prompt open. Each object carries
  // the roost + whatever the action handler needs to fire off after confirm.
  const [pendingDelete, setPendingDelete] = useState<{ roostId: string; name: string } | null>(null);
  const [pendingRollback, setPendingRollback] = useState<{ roostId: string; targetManifestId: string } | null>(null);
  const [pendingResync, setPendingResync] = useState<{ roostId: string; name: string; targetCount: number } | null>(null);
  const router = useRouter();

  const {
    presets,
    createDistribution,
  } = useProjectDistributionManager(currentSiteId);

  // Main page IS the history. Source of truth is roosts (v2).
  const { roosts, loading: roostsLoading, error: roostsError } = useRoosts(currentSiteId);

  const toggleRoostExpanded = useCallback((roostId: string) => {
    setExpandedRoostIds((prev) => {
      const next = new Set(prev);
      if (next.has(roostId)) {
        next.delete(roostId);
      } else {
        next.add(roostId);
      }
      return next;
    });
  }, []);

  const allExpanded = roosts.length > 0 && expandedRoostIds.size === roosts.length;

  const toggleAllExpanded = useCallback(() => {
    setExpandedRoostIds((prev) => (prev.size === roosts.length ? new Set() : new Set(roosts.map((r) => r.id))));
  }, [roosts]);

  // wave 3.9: used by EmptyStateUpload to branch between "install agent first"
  // onboarding and "create your first roost" CTA.
  const { machines } = useMachines(currentSiteId);

  // Upload execution lives at the page level so a multi-GB run survives
  // dismissal of ProjectDistributionDialog. When the dialog is closed
  // while `upload.state.status === 'uploading'`, the MinimizedUploadCard
  // below takes over as the visible progress indicator.
  const upload = useRoostUpload();
  const showMinimizedCard =
    upload.state.status !== 'idle' && !distributionDialogOpen;

  const handleSiteChange = (siteId: string) => {
    setUserPickedSiteId(siteId);
    updateLastSite(siteId);
  };

  const performDeleteRoost = async (roostId: string, name: string) => {
    try {
      const res = await fetch(
        `/api/roosts/${encodeURIComponent(roostId)}?siteId=${encodeURIComponent(currentSiteId)}`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail ?? body.title ?? `HTTP ${res.status}`);
      }
      toast.success(`deleted ${name}`);
    } catch (err) {
      toast.error('delete failed', { description: (err as Error).message });
    }
  };

  const performResync = async (roostId: string, name: string) => {
    try {
      const res = await fetch(`/api/roosts/${encodeURIComponent(roostId)}/resync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteId: currentSiteId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail ?? body.title ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as { resynced: number };
      toast.success(`re-syncing ${name}`, {
        description: `${body.resynced} target${body.resynced === 1 ? '' : 's'} queued`,
      });
    } catch (err) {
      toast.error('re-sync failed', { description: (err as Error).message });
    }
  };

  const performRollback = async (roostId: string, targetManifestId: string) => {
    try {
      const res = await fetch(`/api/roosts/${encodeURIComponent(roostId)}/rollback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteId: currentSiteId, targetManifestId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail ?? body.title ?? `HTTP ${res.status}`);
      }
      toast.success('rolled back — fanout redispatching to targets');
    } catch (err) {
      toast.error('rollback failed', { description: (err as Error).message });
    }
  };

  useEffect(() => {
    if (!authLoading && !user) {
      router.push('/');
    }
  }, [user, authLoading, router]);

  if (authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground"><LoadingWord /></p>
      </div>
    );
  }

  if (!user) {
    return null;
  }

  return (
    <div className="relative min-h-screen pb-8">
      {/* Header */}
      <PageHeader
        currentPage="roost"
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
        onSiteCreated={(siteId) => setUserPickedSiteId(siteId)}
      />

      {/* Main content */}
      <main className="relative z-10 mx-auto max-w-screen-2xl p-3 md:p-4">
        {/* Distribution Dialog */}
        <ProjectDistributionDialog
          open={distributionDialogOpen}
          onOpenChange={setDistributionDialogOpen}
          siteId={currentSiteId}
          onCreateDistribution={createDistribution}
          upload={upload}
        />

        {/* Section header with inline stats */}
        <div className="mt-3 md:mt-2 mb-6 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div className="flex items-center gap-6 md:gap-8">
            <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground">roost</h2>

            <div className="flex items-center gap-6 md:gap-8">
              <div className="flex items-center gap-2.5">
                <div className={`rounded-md p-1.5 ${roosts.length > 0 ? 'bg-accent-cyan/10 text-accent-cyan' : 'bg-muted text-muted-foreground'}`}>
                  <FolderSync className="h-4 w-4" />
                </div>
                <div>
                  <div className="flex items-baseline gap-0.5">
                    <span className="text-xl font-bold text-foreground">{roosts.length}</span>
                  </div>
                  <p className="text-[11px] text-muted-foreground leading-tight">total</p>
                </div>
              </div>

              <div className="h-8 w-px bg-border" />

              <div className="flex items-center gap-2.5">
                <div className="rounded-md p-1.5 bg-muted text-muted-foreground">
                  <Archive className="h-4 w-4" />
                </div>
                <div>
                  <div className="flex items-baseline gap-0.5">
                    <span className="text-xl font-bold text-foreground">{presets.length}</span>
                  </div>
                  <p className="text-[11px] text-muted-foreground leading-tight">presets</p>
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-shrink-0">
            {roosts.length > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    onClick={toggleAllExpanded}
                    className="hover:bg-muted hover:text-foreground transition-colors cursor-pointer"
                    size="icon"
                  >
                    {allExpanded ? <ChevronsDownUp className="w-4 h-4" /> : <ChevronsUpDown className="w-4 h-4" />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{allExpanded ? 'collapse all' : 'expand all'}</p>
                </TooltipContent>
              </Tooltip>
            )}
            <Button
              onClick={() => setDistributionDialogOpen(true)}
              className="bg-accent-cyan hover:bg-accent-cyan-hover text-gray-900 cursor-pointer"
            >
              <Plus className="h-4 w-4 mr-2" />
              new roost
            </Button>
          </div>
        </div>

        {/* Roosts list — main page IS the history. Each row is a roost
            whose currentManifestId points at the live deploy. Expand for per-target
            deploy state + manifest history. */}
        <div className="rounded-lg border border-border bg-card overflow-hidden animate-in fade-in duration-300">
          {/*
            Render a spinner whenever ANY upstream source isn't yet resolved:
              - sites still loading (user's site list)
              - currentSiteId not yet derived (empty while sites arrive)
              - roosts onSnapshot hasn't fired its first batch yet
            Skipping any of these flashes the welcome/empty-state for a tick
            on real users who already have roosts.
          */}
          {sitesLoading || !currentSiteId || roostsLoading ? (
            <div className="p-8 text-center">
              <Loader2 className="h-8 w-8 animate-spin mx-auto text-muted-foreground" />
              <p className="mt-2 text-muted-foreground">loading...</p>
            </div>
          ) : roostsError ? (
            <div className="p-8 text-center text-sm">
              <p className="text-muted-foreground">failed to load roosts — try refreshing the page.</p>
            </div>
          ) : roosts.length === 0 ? (
            <EmptyStateUpload
              machineCount={machines.length}
              onNewRoost={() => setDistributionDialogOpen(true)}
              onAddMachine={() => router.push('/dashboard')}
            />
          ) : (
            <div className="divide-y divide-border">
              {roosts.map((roost) => {
                const isExpanded = expandedRoostIds.has(roost.id);
                const manifestShort = roost.currentManifestId
                  ? `${roost.currentManifestId.slice(0, 12)}…`
                  : 'no manifest';
                return (
                  <Collapsible
                    key={roost.id}
                    open={isExpanded}
                    onOpenChange={() => toggleRoostExpanded(roost.id)}
                  >
                    <CollapsibleTrigger asChild>
                      <div
                        className="relative flex items-center justify-between px-4 py-3 hover:bg-muted/50 transition-colors cursor-pointer"
                      >
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          {isExpanded ? (
                            <ChevronDown className="h-4 w-4 text-muted-foreground flex-shrink-0" aria-hidden="true" />
                          ) : (
                            <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" aria-hidden="true" />
                          )}
                          <FolderSync className="h-4 w-4 text-accent-cyan flex-shrink-0" aria-hidden="true" />
                          <div className="min-w-0 flex-1">
                            <span className="text-foreground font-medium select-text">{roost.name}</span>
                            <p className="text-xs text-muted-foreground select-text truncate font-mono">
                              manifest {manifestShort}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-3 flex-shrink-0">
                          <RoostStatusPill
                            siteId={currentSiteId}
                            roostId={roost.id}
                            currentManifestId={roost.currentManifestId}
                            targets={roost.targets}
                          />
                          <span
                            className="hidden md:inline-flex items-center gap-1 text-xs text-muted-foreground tabular-nums select-none"
                            aria-label={`${roost.targets.length} target machine${roost.targets.length === 1 ? '' : 's'}`}
                          >
                            <span className="text-foreground">{roost.targets.length}</span>
                            <span>target{roost.targets.length === 1 ? '' : 's'}</span>
                          </span>
                          <span className="text-xs text-muted-foreground hidden sm:block w-[150px] text-right">
                            {formatSiteScopedTimestamp(
                              roost.updatedAt ?? roost.createdAt,
                              userPreferences.timeDisplayMode || 'machine',
                              userPreferences.timezone,
                              siteTimezone,
                              userPreferences.timeFormat || '12h',
                            )}
                          </span>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={(e) => e.stopPropagation()}
                                aria-label="row actions"
                                className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground cursor-pointer"
                              >
                                <MoreVertical className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                              <DropdownMenuItem
                                disabled={!roost.currentManifestId || roost.targets.length === 0}
                                onClick={() => {
                                  if (roost.currentManifestId && roost.targets.length > 0) {
                                    setPendingResync({
                                      roostId: roost.id,
                                      name: roost.name,
                                      targetCount: roost.targets.length,
                                    });
                                  }
                                }}
                                className="cursor-pointer"
                              >
                                <RefreshCw className="h-3.5 w-3.5 mr-2" />
                                re-sync targets
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                disabled={!roost.previousManifestId}
                                onClick={() => {
                                  if (roost.previousManifestId) {
                                    setPendingRollback({
                                      roostId: roost.id,
                                      targetManifestId: roost.previousManifestId,
                                    });
                                  }
                                }}
                                className="cursor-pointer"
                              >
                                <RotateCcw className="h-3.5 w-3.5 mr-2" />
                                roll back to previous
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onClick={() => setPendingDelete({ roostId: roost.id, name: roost.name })}
                                className="cursor-pointer text-red-400 focus:text-red-300 focus:bg-red-950/30"
                              >
                                <Trash2 className="h-3.5 w-3.5 mr-2" />
                                delete roost
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </div>
                    </CollapsibleTrigger>

                    <CollapsibleContent className="overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up">
                      <div className="border-t border-border">
                        <div className="mx-4 my-3 rounded-lg border border-border bg-background p-4 space-y-4">
                          <div className="grid gap-2 text-sm">
                            <div className="flex gap-2">
                              <span className="text-muted-foreground flex-shrink-0 w-28">roost id</span>
                              <span className="text-foreground select-text break-all font-mono text-xs">{roost.id}</span>
                            </div>
                            <div className="flex gap-2">
                              <span className="text-muted-foreground flex-shrink-0 w-28">current manifest</span>
                              <span className="text-foreground select-text break-all font-mono text-xs">
                                {roost.currentManifestId || <span className="text-muted-foreground italic">none</span>}
                              </span>
                            </div>
                            {roost.previousManifestId && (
                              <div className="flex gap-2">
                                <span className="text-muted-foreground flex-shrink-0 w-28">previous</span>
                                <span className="text-foreground select-text break-all font-mono text-xs">
                                  {roost.previousManifestId}
                                </span>
                              </div>
                            )}
                            <div className="flex gap-2">
                              <span className="text-muted-foreground flex-shrink-0 w-28">extract path</span>
                              <span className="text-foreground select-text break-all">
                                {roost.extractPath || <span className="text-muted-foreground italic">~/Documents/Owlette/ (default)</span>}
                              </span>
                            </div>
                            <RoostContentsRow
                              siteId={currentSiteId}
                              roostId={roost.id}
                              manifestId={roost.currentManifestId}
                              totalFiles={roost.totalFiles}
                              totalSize={roost.totalSize}
                            />
                          </div>

                          <div>
                            <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                              targets ({roost.targets.length})
                            </h4>
                            <RoostTargetsList
                              siteId={currentSiteId}
                              roostId={roost.id}
                              currentManifestId={roost.currentManifestId}
                              targets={roost.targets}
                            />
                          </div>
                        </div>
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                );
              })}
            </div>
          )}
        </div>
      </main>

      {/* Floating minimized-upload card. Only rendered when an upload is
          running (or recently terminated) and the dialog isn't open —
          otherwise the dialog IS the progress surface and duplicating it
          on-screen would be noise. Clicking the card reopens the dialog,
          which re-reads `upload.state` and resumes rendering progress. */}
      {showMinimizedCard && (
        <MinimizedUploadCard
          upload={upload}
          onRestore={() => setDistributionDialogOpen(true)}
        />
      )}

      {/* Account Settings Dialog */}
      <AccountSettingsDialog
        open={accountSettingsOpen}
        onOpenChange={setAccountSettingsOpen}
      />

      {/* Row-action confirmations. ConfirmDialog is the app's standard
          pattern (see UninstallDialog, DeleteSite, etc.) — no native
          window.confirm() prompts. */}
      <ConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title="delete roost"
        description={
          pendingDelete
            ? `delete "${pendingDelete.name}"? this removes the manifest history + pointer. chunk gc will reclaim storage on its next run.`
            : ''
        }
        confirmText="delete"
        cancelText="cancel"
        variant="destructive"
        onConfirm={() => {
          if (pendingDelete) {
            performDeleteRoost(pendingDelete.roostId, pendingDelete.name);
          }
        }}
      />

      <ConfirmDialog
        open={!!pendingResync}
        onOpenChange={(open) => !open && setPendingResync(null)}
        title="re-sync roost"
        description={
          pendingResync
            ? `re-pull the current manifest on all ${pendingResync.targetCount} target${pendingResync.targetCount === 1 ? '' : 's'} for "${pendingResync.name}"? use this after a failed sync or to force targets back to the recorded state.`
            : ''
        }
        confirmText="re-sync"
        cancelText="cancel"
        onConfirm={() => {
          if (pendingResync) {
            performResync(pendingResync.roostId, pendingResync.name);
          }
        }}
      />

      <ConfirmDialog
        open={!!pendingRollback}
        onOpenChange={(open) => !open && setPendingRollback(null)}
        title="roll back roost"
        description={
          pendingRollback
            ? `roll back to manifest ${pendingRollback.targetManifestId.slice(0, 12)}…? the fanout trigger will redispatch the change to all targets.`
            : ''
        }
        confirmText="roll back"
        cancelText="cancel"
        onConfirm={() => {
          if (pendingRollback) {
            performRollback(pendingRollback.roostId, pendingRollback.targetManifestId);
          }
        }}
      />
    </div>
  );
}
