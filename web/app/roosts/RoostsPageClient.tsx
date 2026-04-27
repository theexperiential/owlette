'use client';

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useSites, useMachines } from '@/hooks/useFirestore';
import { useProjectDistributionManager } from '@/hooks/useProjectDistributions';
import { useRoosts } from '@/hooks/useRoosts';
import { useSelectedRoost } from '@/hooks/useSelectedRoost';
import { RoostStatusPill } from '@/components/RoostTargetRow';
import { EmptyStateUpload } from '@/components/EmptyStateUpload';
import { Button } from '@/components/ui/button';
import { Plus, Loader2, FolderSync, Archive, MoreVertical, Trash2, RefreshCw, Copy } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from 'sonner';
import ProjectDistributionDialog, {
  type NewVersionContext,
} from '@/components/ProjectDistributionDialog';
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
import { RoostDetailPanel } from '@/components/roost/RoostDetailPanel';
import { RoostMobileSheet } from '@/components/roost/RoostMobileSheet';

const DESCRIPTION_PREVIEW_CAP = 40;

function formatDescriptionPreview(description: string | null): string | null {
  if (!description) return null;
  if (description.length <= DESCRIPTION_PREVIEW_CAP) return description;
  return `${description.slice(0, DESCRIPTION_PREVIEW_CAP)}\u2026`;
}

export default function RoostsPageClient() {
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
  // When set, the dialog opens in "+ new version" mode for an existing roost.
  // null = normal "new roost" mode.
  const [newVersionContext, setNewVersionContext] = useState<NewVersionContext | null>(null);
  const [manageDialogOpen, setManageDialogOpen] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [accountSettingsOpen, setAccountSettingsOpen] = useState(false);
  // Pending row-level actions. `null` = no prompt open. Each object carries
  // the roost + whatever the action handler needs to fire off after confirm.
  const [pendingDelete, setPendingDelete] = useState<{ roostId: string; name: string } | null>(null);
  const [pendingResync, setPendingResync] = useState<{ roostId: string; name: string; targetCount: number } | null>(null);
  // Bumped after a successful upload terminal — propagates to VersionHistory
  // so the expanded panel re-fetches and shows the freshly-published row.
  const [versionRefreshKey, setVersionRefreshKey] = useState(0);
  const router = useRouter();

  const {
    presets,
    createDistribution,
  } = useProjectDistributionManager(currentSiteId);

  // Main page IS the history. Source of truth is roosts (v2).
  const { roosts, loading: roostsLoading, error: roostsError } = useRoosts(currentSiteId);

  // URL-backed selection (?roost=<id>). Surviving across reload + browser
  // back/forward so the panel state is shareable and bookmarkable.
  const { selectedRoostId, setSelectedRoostId } = useSelectedRoost();

  // Viewport-aware branching between the desktop aside and the mobile sheet.
  // `lg:hidden` on the sheet wrapper is NOT sufficient — Radix Portal renders
  // the overlay + content in document.body, escaping the wrapper. Only JS
  // gating keeps the mobile overlay off the desktop viewport.
  const [isDesktop, setIsDesktop] = useState(true);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const sync = () => setIsDesktop(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);
  const selectedRoost = useMemo(
    () => roosts.find((r) => r.id === selectedRoostId) ?? null,
    [roosts, selectedRoostId]
  );

  // Held copy of the selected roost so the aside can play its
  // `slide-out-to-right` animation before unmounting. When `selectedRoost`
  // goes from null → roost we update immediately (so the enter animation
  // runs); when it goes roost → null we delay clearing for the duration of
  // the exit animation (200ms — matches `tw-animate-css` defaults).
  const [displayRoost, setDisplayRoost] = useState(selectedRoost);
  useEffect(() => {
    if (selectedRoost) {
      setDisplayRoost(selectedRoost);
      return;
    }
    const t = setTimeout(() => setDisplayRoost(null), 200);
    return () => clearTimeout(t);
  }, [selectedRoost]);
  // Tracked across renders so the mobile sheet (and aside) close path can
  // restore focus to the originating row button.
  const prevSelectedIdRef = useRef<string | null>(null);

  // Disappearance: if the selected roost is no longer in the list (deleted
  // by another tab, site changed, direct nav with bogus id), clear the URL.
  // Gating on `!roostsLoading` is non-negotiable — clearing while loading
  // would race with hydration on direct nav and lose a valid selection.
  useEffect(() => {
    if (!roostsLoading && selectedRoostId && !roosts.some((r) => r.id === selectedRoostId)) {
      setSelectedRoostId(null);
    }
  }, [roostsLoading, roosts, selectedRoostId, setSelectedRoostId]);

  // Focus restoration: when the panel transitions to "no selection", move
  // focus back to the originating row button. Critical on mobile (Radix
  // Portal pulls focus when the sheet opens) and good practice on desktop.
  useEffect(() => {
    const prev = prevSelectedIdRef.current;
    if (prev && !selectedRoostId) {
      requestAnimationFrame(() => {
        const el = document.querySelector<HTMLButtonElement>(
          `[data-roost-row="${prev}"]`,
        );
        el?.focus();
      });
    }
    prevSelectedIdRef.current = selectedRoostId;
  }, [selectedRoostId]);

  // Keyboard: Esc closes, ↓/↑ move selection within the current list with
  // edge-wrap. Skipped while focus is in an input/textarea/contenteditable
  // so the dialog and inline edits keep their native behaviour.
  useEffect(() => {
    if (!selectedRoostId) return;
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const editable =
        target?.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA';
      if (editable) return;
      if (e.key === 'Escape') {
        setSelectedRoostId(null);
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (roosts.length === 0) return;
        const idx = roosts.findIndex((r) => r.id === selectedRoostId);
        if (idx === -1) return;
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        const next = roosts[(idx + delta + roosts.length) % roosts.length];
        setSelectedRoostId(next.id);
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedRoostId, roosts, setSelectedRoostId]);

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

  // When an upload terminates successfully, refresh the version-history
  // panel for whichever roost the user expanded. Cheap to invalidate
  // unconditionally; collapsed panels don't fetch on key bumps.
  useEffect(() => {
    if (upload.state.status === 'success') {
      setVersionRefreshKey((k) => k + 1);
    }
  }, [upload.state.status]);

  const handleSiteChange = (siteId: string) => {
    setUserPickedSiteId(siteId);
    updateLastSite(siteId);
  };

  // Discreet copy-to-clipboard helper used by the "copy roost id" /
  // "copy version id" dropdown items. Most operators never touch these
  // — they exist for the rare debugging / support-ticket moment. Falls
  // back to a "couldn't copy" toast when the Clipboard API isn't
  // available (older browser, insecure context), which also reveals the
  // id so the user can copy it manually.
  const copyToClipboard = async (text: string, label: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        toast.success(`${label} copied`);
      } else {
        toast.error(`couldn't copy — ${label}: ${text}`);
      }
    } catch {
      toast.error(`couldn't copy — ${label}: ${text}`);
    }
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

  const openNewVersionDialog = useCallback((ctx: NewVersionContext) => {
    setNewVersionContext(ctx);
    setDistributionDialogOpen(true);
  }, []);

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
          onOpenChange={(open) => {
            setDistributionDialogOpen(open);
            // Drop the new-version pre-fill once the dialog actually closes;
            // otherwise the next "new roost" click would reopen in version mode.
            if (!open) setNewVersionContext(null);
          }}
          siteId={currentSiteId}
          onCreateDistribution={createDistribution}
          upload={upload}
          newVersion={newVersionContext ?? undefined}
          existingRoostIds={roosts.map((r) => r.id)}
        />

        {/* Section header with inline stats */}
        <div className="mt-3 md:mt-2 mb-6 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div className="flex items-center gap-6 md:gap-8">
            <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground">roosts</h2>

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
            <Button
              onClick={() => {
                setNewVersionContext(null);
                setDistributionDialogOpen(true);
              }}
              className="bg-accent-cyan hover:bg-accent-cyan-hover text-gray-900 cursor-pointer"
            >
              <Plus className="h-4 w-4 mr-2" />
              new roost
            </Button>
          </div>
        </div>

        {/* Roosts list + detail panel. Above lg, the panel renders as a
            sticky aside next to the list; below lg, the same panel renders
            inside a right-slide sheet. Both branches are always mounted so
            CSS controls visibility — no flicker on resize. */}
        <div
          className={`flex items-start transition-[gap] duration-200 ease-out ${
            selectedRoost ? 'gap-4' : 'gap-0'
          }`}
        >
          <div className="flex-1 min-w-0 rounded-lg border border-border bg-card overflow-hidden animate-in fade-in duration-300">
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
                onNewRoost={() => {
                  setNewVersionContext(null);
                  setDistributionDialogOpen(true);
                }}
                onAddMachine={() => router.push('/dashboard')}
              />
            ) : (
              <div className="divide-y divide-border">
                {roosts.map((roost) => {
                  const isSelected = selectedRoostId === roost.id;
                  const versionLabel =
                    roost.currentVersionNumber !== null
                      ? `v${roost.currentVersionNumber}`
                      : null;
                  const descriptionPreview = formatDescriptionPreview(
                    roost.currentVersionDescription,
                  );
                  return (
                    <div
                      key={roost.id}
                      className={`relative flex items-center justify-between transition-colors ${
                        isSelected
                          ? 'bg-accent-cyan/10 hover:bg-accent-cyan/15'
                          : 'hover:bg-muted/50'
                      }`}
                    >
                      <button
                        type="button"
                        aria-expanded={isSelected}
                        aria-controls="roost-detail-panel"
                        data-roost-row={roost.id}
                        onClick={() => setSelectedRoostId(isSelected ? null : roost.id)}
                        className="flex items-center justify-between flex-1 min-w-0 px-4 py-3 text-left cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/40"
                      >
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          <FolderSync className="h-4 w-4 text-accent-cyan flex-shrink-0" aria-hidden="true" />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="text-foreground font-medium select-text truncate">
                                {roost.name}
                              </span>
                              {versionLabel && (
                                <span
                                  className="flex-shrink-0 rounded-full border border-border bg-muted/50 px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground tabular-nums"
                                  aria-label={`current version ${versionLabel}`}
                                >
                                  {versionLabel}
                                </span>
                              )}
                            </div>
                            {descriptionPreview && (
                              <p className="mt-1 text-xs text-muted-foreground truncate select-text">
                                {descriptionPreview}
                              </p>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-4 flex-shrink-0">
                          <RoostStatusPill
                            siteId={currentSiteId}
                            roostId={roost.id}
                            currentVersionId={roost.currentVersionId}
                            targets={roost.targets}
                          />
                          <span
                            className="hidden md:inline-flex items-center gap-1 text-sm text-muted-foreground tabular-nums select-none"
                            aria-label={`${roost.targets.length} target machine${roost.targets.length === 1 ? '' : 's'}`}
                          >
                            <span className="text-foreground">{roost.targets.length}</span>
                            <span>target{roost.targets.length === 1 ? '' : 's'}</span>
                          </span>
                          <span className="text-sm text-muted-foreground hidden sm:block w-[200px] text-right whitespace-nowrap">
                            {formatSiteScopedTimestamp(
                              roost.updatedAt ?? roost.createdAt,
                              userPreferences.timeDisplayMode || 'machine',
                              userPreferences.timezone,
                              siteTimezone,
                              userPreferences.timeFormat || '12h',
                            )}
                          </span>
                        </div>
                      </button>
                      <div className="pr-4">
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
                              disabled={!roost.currentVersionId || roost.targets.length === 0}
                              onClick={() => {
                                if (roost.currentVersionId && roost.targets.length > 0) {
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
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={() => copyToClipboard(roost.id, 'roost id')}
                              className="cursor-pointer"
                            >
                              <Copy className="h-3.5 w-3.5 mr-2" />
                              copy roost id
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={!roost.currentVersionId}
                              onClick={() => {
                                if (roost.currentVersionId) {
                                  copyToClipboard(roost.currentVersionId, 'version id');
                                }
                              }}
                              className="cursor-pointer"
                            >
                              <Copy className="h-3.5 w-3.5 mr-2" />
                              copy version id
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
                  );
                })}
              </div>
            )}
          </div>

          {/* Desktop detail panel — slot transitions width so the list
              (flex-1) responsively grows/shrinks to fill the freed space,
              and the panel inside (right-anchored, w-[480px], parent has
              overflow-hidden) appears to slide in/out from the right edge
              as the slot resizes. The slot is always rendered on desktop
              so width transitions both directions; the panel itself uses
              `displayRoost` (held copy that lingers ~200ms after close)
              so its content stays visible during the slide-out. The
              `key={displayRoost.id}` is non-negotiable: RoostContentsRow
              and VersionHistory carry internal state, and remounting on
              selection swap is the only way to guarantee no stale data
              flashes between roosts. */}
          {isDesktop && (
            <div
              className={`flex justify-end flex-shrink-0 overflow-hidden transition-[width] duration-200 ease-out ${
                selectedRoost ? 'w-[480px]' : 'w-0'
              }`}
              aria-hidden={!selectedRoost}
            >
              {displayRoost && (
                <aside
                  aria-labelledby="roost-detail-heading"
                  className="w-[480px] flex-shrink-0 overflow-hidden rounded-lg border border-border bg-card"
                >
                  <RoostDetailPanel
                    key={displayRoost.id}
                    roost={displayRoost}
                    siteId={currentSiteId}
                    siteTimezone={siteTimezone}
                    timeDisplayMode={userPreferences.timeDisplayMode || 'machine'}
                    timezone={userPreferences.timezone}
                    timeFormat={userPreferences.timeFormat || '12h'}
                    refreshKey={versionRefreshKey}
                    machines={machines}
                    headingId="roost-detail-heading"
                    onClose={() => setSelectedRoostId(null)}
                    onNewVersion={openNewVersionDialog}
                    onResync={() => {
                      if (
                        displayRoost.currentVersionId &&
                        displayRoost.targets.length > 0
                      ) {
                        setPendingResync({
                          roostId: displayRoost.id,
                          name: displayRoost.name,
                          targetCount: displayRoost.targets.length,
                        });
                      }
                    }}
                    onDelete={() =>
                      setPendingDelete({
                        roostId: displayRoost.id,
                        name: displayRoost.name,
                      })
                    }
                    onCopyRoostId={() => copyToClipboard(displayRoost.id, 'roost id')}
                    onCopyVersionId={() => {
                      if (displayRoost.currentVersionId) {
                        copyToClipboard(displayRoost.currentVersionId, 'version id');
                      }
                    }}
                  />
                </aside>
              )}
            </div>
          )}
        </div>

        {/* Mobile detail sheet — same panel, different shell. Rendered only
            when the viewport is below the lg breakpoint. CSS gating is not
            sufficient because Radix Portal relocates the overlay + content
            into document.body, which escapes any className on the wrapper. */}
        {!isDesktop && (
          <RoostMobileSheet
            open={selectedRoost !== null}
            onOpenChange={(o) => {
              if (!o) setSelectedRoostId(null);
            }}
            title={selectedRoost?.name ?? 'roost detail'}
          >
            {selectedRoost && (
              <RoostDetailPanel
                key={selectedRoost.id}
                roost={selectedRoost}
                siteId={currentSiteId}
                siteTimezone={siteTimezone}
                timeDisplayMode={userPreferences.timeDisplayMode || 'machine'}
                timezone={userPreferences.timezone}
                timeFormat={userPreferences.timeFormat || '12h'}
                refreshKey={versionRefreshKey}
                machines={machines}
                headingId="roost-detail-heading"
                onClose={() => setSelectedRoostId(null)}
                onNewVersion={openNewVersionDialog}
                onResync={() => {
                  if (
                    selectedRoost.currentVersionId &&
                    selectedRoost.targets.length > 0
                  ) {
                    setPendingResync({
                      roostId: selectedRoost.id,
                      name: selectedRoost.name,
                      targetCount: selectedRoost.targets.length,
                    });
                  }
                }}
                onDelete={() =>
                  setPendingDelete({
                    roostId: selectedRoost.id,
                    name: selectedRoost.name,
                  })
                }
                onCopyRoostId={() => copyToClipboard(selectedRoost.id, 'roost id')}
                onCopyVersionId={() => {
                  if (selectedRoost.currentVersionId) {
                    copyToClipboard(selectedRoost.currentVersionId, 'version id');
                  }
                }}
              />
            )}
          </RoostMobileSheet>
        )}
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
            ? `delete "${pendingDelete.name}"? this removes the version history + pointer. chunk gc will reclaim storage on its next run.`
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
            ? `re-pull the current version on all ${pendingResync.targetCount} target${pendingResync.targetCount === 1 ? '' : 's'} for "${pendingResync.name}"? use this after a failed sync or to force targets back to the recorded state.`
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
    </div>
  );
}
