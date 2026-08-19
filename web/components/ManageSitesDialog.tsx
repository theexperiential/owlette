'use client';

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Pencil, Trash2, Check, X, Plus, User, Search, ChevronDown } from 'lucide-react';
import { toast } from '@/lib/toast';
import { TimezoneSelect } from '@/components/TimezoneSelect';
import { SiteMachinesList } from '@/components/SiteMachinesList';
import { useUserManagement } from '@/hooks/useUserManagement';

interface Site {
  id: string;
  name: string;
  timezone?: string;
  owner?: string;
}

// Wrap each occurrence of `query` (case-insensitive) in `text` with a cyan
// highlight so filtered results visibly show WHY they matched.
function highlightMatch(text: string, query: string): React.ReactNode {
  const q = query.trim();
  if (!q) return text;
  const lower = text.toLowerCase();
  const lowerQ = q.toLowerCase();
  const parts: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < text.length) {
    const idx = lower.indexOf(lowerQ, i);
    if (idx === -1) {
      parts.push(text.slice(i));
      break;
    }
    if (idx > i) parts.push(text.slice(i, idx));
    parts.push(
      <mark key={key++} className="rounded-[2px] bg-accent-cyan/25 font-semibold text-accent-cyan">
        {text.slice(idx, idx + q.length)}
      </mark>,
    );
    i = idx + q.length;
  }
  return parts;
}

interface ManageSitesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sites: Site[];
  currentSiteId: string;
  /** Machine count for the current site only (the one the page has loaded).
   * When provided, a "machines" column is shown; other sites' cells are blank
   * since their counts aren't loaded here. Omit it to hide the column. */
  machineCount?: number;
  currentUserId?: string;
  isSuperadmin?: boolean;
  onUpdateSite: (siteId: string, updates: { name?: string; timezone?: string }) => Promise<void>;
  onDeleteSite: (siteId: string) => Promise<void>;
  onCreateSite: () => void;
}

export function ManageSitesDialog({
  open,
  onOpenChange,
  sites,
  currentSiteId,
  machineCount,
  currentUserId,
  isSuperadmin = false,
  onUpdateSite,
  onDeleteSite,
  onCreateSite,
}: ManageSitesDialogProps) {
  // When superadmin, fetch all users so we can display the owner of foreign sites.
  // Lazily resolve owner UIDs to emails for sites not owned by the current admin.
  const { users: allUsers } = useUserManagement(Boolean(isSuperadmin));
  const ownerEmailByUid = useMemo(() => {
    if (!isSuperadmin) return new Map<string, string>();
    const map = new Map<string, string>();
    for (const u of allUsers) {
      if (u.uid && u.email) map.set(u.uid, u.email);
    }
    return map;
  }, [allUsers, isSuperadmin]);
  const [editingSiteId, setEditingSiteId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [editingTimezone, setEditingTimezone] = useState('UTC');
  const [deletingDialogOpen, setDeletingDialogOpen] = useState(false);
  const [siteToDelete, setSiteToDelete] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [filter, setFilter] = useState('');
  const filterInputRef = useRef<HTMLInputElement>(null);
  // One expanded machines panel at a time, accordion-style like editing.
  const [expandedSiteId, setExpandedSiteId] = useState<string | null>(null);
  // Counts reported back by expanded panels, so non-current sites show a
  // machine count once their list has been fetched.
  const [machineCounts, setMachineCounts] = useState<Record<string, number>>({});
  const handleMachineCountLoaded = useCallback((siteId: string, count: number) => {
    setMachineCounts((prev) => (prev[siteId] === count ? prev : { ...prev, [siteId]: count }));
  }, []);

  // Reset editing + filter state when dialog closes
  useEffect(() => {
    if (!open) {
      setEditingSiteId(null);
      setEditingName('');
      setEditingTimezone('UTC');
      setFilter('');
      setExpandedSiteId(null);
      setMachineCounts({});
    }
  }, [open]);

  // Filter sites by name, id, timezone, or owner email (case-insensitive) so
  // operators with dozens/hundreds of sites can jump to one by any keyword.
  const filteredSites = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const matched = !q
      ? sites
      : sites.filter((s) => {
          const ownerEmail = s.owner ? ownerEmailByUid.get(s.owner) ?? s.owner : '';
          return (
            s.name.toLowerCase().includes(q) ||
            s.id.toLowerCase().includes(q) ||
            (s.timezone || 'UTC').toLowerCase().includes(q) ||
            ownerEmail.toLowerCase().includes(q)
          );
        });
    // Pin the current site to the top, then sort the rest alphabetically so a
    // long list stays predictable to scan.
    return [...matched].sort((a, b) => {
      if (a.id === currentSiteId) return -1;
      if (b.id === currentSiteId) return 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
  }, [sites, filter, ownerEmailByUid, currentSiteId]);

  const startEditingSite = (site: Site) => {
    setEditingSiteId(site.id);
    setEditingName(site.name);
    setEditingTimezone(site.timezone || 'UTC');
  };

  const cancelEditingSite = () => {
    setEditingSiteId(null);
    setEditingName('');
    setEditingTimezone('UTC');
  };

  const handleSaveSite = async (siteId: string) => {
    if (!editingName.trim()) {
      toast.error('Site name cannot be empty');
      return;
    }

    const site = sites.find(s => s.id === siteId);
    if (!site) return;

    // Check if anything changed
    const nameChanged = editingName.trim() !== site.name;
    const timezoneChanged = editingTimezone !== (site.timezone || 'UTC');

    if (!nameChanged && !timezoneChanged) {
      cancelEditingSite();
      return;
    }

    setIsSaving(true);
    try {
      const updates: { name?: string; timezone?: string } = {};
      if (nameChanged) updates.name = editingName.trim();
      if (timezoneChanged) updates.timezone = editingTimezone;

      await onUpdateSite(siteId, updates);
      toast.success('Site updated successfully!');
      cancelEditingSite();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(message || 'Failed to update site');
    } finally {
      setIsSaving(false);
    }
  };

  const confirmDeleteSite = (siteId: string) => {
    setSiteToDelete(siteId);
    setDeletingDialogOpen(true);
  };

  const handleDeleteSite = async () => {
    if (!siteToDelete) return;

    if (sites.length === 1) {
      toast.error('Cannot delete the last site');
      setDeletingDialogOpen(false);
      setSiteToDelete(null);
      return;
    }

    try {
      await onDeleteSite(siteToDelete);
      toast.success('Site deleted successfully!');
      setDeletingDialogOpen(false);
      setSiteToDelete(null);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(message || 'Failed to delete site');
    }
  };

  // Shared column template so the header and every row align into the same
  // columns. Superadmins get an extra "owner" column. Actions is a fixed 96px
  // (machines chevron + edit + delete) so the fr columns resolve identically
  // across the header and the rows.
  // Build the column template dynamically: the "machines" column only appears
  // when the caller supplies a count (the dashboard), and the "owner" column
  // only for superadmins. Order: name | id | timezone | machines | owner | actions.
  const showMachines = machineCount !== undefined;
  const columns = ['minmax(0,2.2fr)', 'minmax(0,1.6fr)', 'minmax(0,1.2fr)']; // name, id, timezone
  if (showMachines) columns.push('minmax(0,0.9fr)'); // machines
  if (isSuperadmin) columns.push('minmax(0,1.6fr)'); // owner
  columns.push('96px'); // actions
  const gridTemplate = columns.join(' ');

  // Machine count label per row: the current site's count comes from the
  // dashboard prop; other sites' counts appear once their row has been
  // expanded (SiteMachinesList reports what it fetched).
  const machineCountLabel = (siteId: string): string => {
    const count = siteId === currentSiteId ? machineCount ?? 0 : machineCounts[siteId];
    if (count === undefined) return '';
    return `${count} machine${count === 1 ? '' : 's'}`;
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          showCloseButton={false}
          className="border-border bg-secondary text-white sm:max-w-5xl"
          onOpenAutoFocus={(e) => {
            // Search-first: focus the filter on open instead of the first button.
            if (filterInputRef.current) {
              e.preventDefault();
              filterInputRef.current.focus();
            }
          }}
          onEscapeKeyDown={(e) => {
            // Esc steps back: cancel an in-progress edit, else clear the filter,
            // else fall through and let the dialog close.
            if (editingSiteId) {
              e.preventDefault();
              cancelEditingSite();
            } else if (filter.trim()) {
              e.preventDefault();
              setFilter('');
            }
          }}
        >
          <DialogHeader>
            {/* Wraps below sm: the search cluster takes its own line instead of
                inflating the dialog's min-content — which used to push every
                row's actions column off-screen on phones. */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <DialogTitle className="text-white">manage sites</DialogTitle>
              {/* Search, "new site", and close share one centered flex row with
                  the title so all four header controls sit on one axis. gap-6
                  keeps the close ✕ equidistant from its neighbor and the
                  panel edge (the p-6 gutter is also 24px). */}
              <div className="flex min-w-0 grow items-center justify-end gap-6">
                {sites.length > 1 && (
                  <div className="relative min-w-0 w-full max-w-64">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      ref={filterInputRef}
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                      placeholder="filter sites…"
                      aria-label="filter sites"
                      autoComplete="off"
                      className="border-border bg-accent pl-9 pr-8 text-white"
                    />
                    {filter && (
                      <button
                        type="button"
                        onClick={() => {
                          setFilter('');
                          filterInputRef.current?.focus();
                        }}
                        aria-label="clear filter"
                        className="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground hover:text-white cursor-pointer"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                )}
                <Button
                  size="sm"
                  onClick={() => {
                    onOpenChange(false);
                    onCreateSite();
                  }}
                  className="shrink-0 cursor-pointer text-gray-900"
                >
                  <Plus className="h-4 w-4 mr-1" />
                  new site
                </Button>
                <button
                  type="button"
                  onClick={() => onOpenChange(false)}
                  aria-label="close"
                  className="shrink-0 cursor-pointer rounded-sm p-1 text-muted-foreground opacity-70 transition-opacity hover:text-white hover:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-secondary"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            <div className="flex items-center justify-between gap-3">
              <DialogDescription className="text-muted-foreground">
                edit site names, timezones, or delete sites
              </DialogDescription>
              {filter.trim() && (
                <span className="shrink-0 text-xs text-muted-foreground">
                  showing {filteredSites.length} of {sites.length} sites
                </span>
              )}
            </div>
          </DialogHeader>

          <div className="mt-3 max-h-[60vh] space-y-1.5 overflow-y-auto">
            {filteredSites.length === 0 ? (
              <p className="rounded-lg border border-border bg-card px-3 py-10 text-center text-sm text-muted-foreground">
                no sites match “{filter.trim()}”
              </p>
            ) : (
              <>
                {/* Column header — sticky so it stays put while the list scrolls;
                    same grid template as the rows so the columns line up. */}
                <div
                  className="sticky top-0 z-10 grid items-center gap-3 border-b border-border/60 bg-secondary px-3 pb-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70"
                  style={{ gridTemplateColumns: gridTemplate }}
                >
                  <span className="min-w-0 truncate">site</span>
                  <span className="min-w-0 truncate">id</span>
                  <span className="min-w-0 truncate">timezone</span>
                  {showMachines && <span className="min-w-0 truncate">machines</span>}
                  {isSuperadmin && <span className="min-w-0 truncate">owner</span>}
                  <span aria-hidden="true" />
                </div>

                {filteredSites.map((site) => (
                  <div
                    key={site.id}
                    className={`site-row-cv overflow-hidden rounded-lg border transition-colors ${
                      site.id === currentSiteId
                        ? 'border-accent-cyan/60 bg-accent-cyan/10'
                        : 'border-border bg-card hover:bg-muted'
                    }`}
                  >
                    {/* View row — aligned column grid. Stays visible while
                        editing so the panel below is unambiguously attached
                        to the site being edited. */}
                      <div className="grid items-center gap-3 px-3 py-2" style={{ gridTemplateColumns: gridTemplate }}>
                        {/* name */}
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-sm font-medium text-white">{highlightMatch(site.name, filter)}</span>
                          {site.id === currentSiteId && (
                            <span className="shrink-0 rounded bg-accent-cyan/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent-cyan">
                              current
                            </span>
                          )}
                        </div>

                        {/* id — click to copy */}
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              onClick={async (e) => {
                                e.stopPropagation();
                                try {
                                  await navigator.clipboard.writeText(site.id);
                                  toast.success('Site ID copied!');
                                } catch {
                                  toast.error('Failed to copy Site ID');
                                }
                              }}
                              className="min-w-0 cursor-pointer truncate text-left font-mono text-[11px] text-muted-foreground hover:text-accent-cyan"
                            >
                              {highlightMatch(site.id, filter)}
                            </button>
                          </TooltipTrigger>
                          <TooltipContent>
                            <p>copy site id</p>
                          </TooltipContent>
                        </Tooltip>

                        {/* timezone */}
                        <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                          {highlightMatch(site.timezone || 'UTC', filter)}
                        </span>

                        {/* machines — count only for the current site (the only
                            one whose machines are loaded); blank for the rest */}
                        {showMachines && (
                          <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                            {machineCountLabel(site.id)}
                          </span>
                        )}

                        {/* owner — superadmin only */}
                        {isSuperadmin && (
                          site.owner && currentUserId && site.owner !== currentUserId ? (
                            <span
                              className="flex min-w-0 items-center gap-1 text-[11px] text-amber-400/80"
                              title={ownerEmailByUid.get(site.owner) || site.owner}
                            >
                              <User className="h-3 w-3 shrink-0" />
                              <span className="truncate">{highlightMatch(ownerEmailByUid.get(site.owner) || site.owner, filter)}</span>
                            </span>
                          ) : site.owner && currentUserId && site.owner === currentUserId ? (
                            <span className="text-[11px] text-muted-foreground">you</span>
                          ) : (
                            <span className="text-[11px] text-muted-foreground/40" title="no owner recorded">
                              —
                            </span>
                          )
                        )}

                        {/* actions */}
                        <div className="flex items-center justify-end gap-0.5">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setExpandedSiteId(expandedSiteId === site.id ? null : site.id)}
                                aria-label={`machines on ${site.name}`}
                                aria-expanded={expandedSiteId === site.id}
                                className={`h-7 w-7 p-0 hover:bg-muted hover:text-accent-cyan cursor-pointer ${
                                  expandedSiteId === site.id ? 'text-accent-cyan' : 'text-muted-foreground'
                                }`}
                              >
                                <ChevronDown
                                  className={`h-4 w-4 transition-transform duration-150 ease-out motion-reduce:transition-none ${
                                    expandedSiteId === site.id ? '-rotate-180' : 'rotate-0'
                                  }`}
                                />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>{expandedSiteId === site.id ? 'hide machines' : 'view machines'}</p>
                            </TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() =>
                                  editingSiteId === site.id ? cancelEditingSite() : startEditingSite(site)
                                }
                                aria-label={`edit ${site.name}`}
                                aria-expanded={editingSiteId === site.id}
                                className={`h-7 w-7 p-0 hover:bg-muted hover:text-accent-cyan cursor-pointer ${
                                  editingSiteId === site.id ? 'text-accent-cyan' : 'text-muted-foreground'
                                }`}
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>{editingSiteId === site.id ? 'close editor' : 'edit site'}</p>
                            </TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => confirmDeleteSite(site.id)}
                                aria-label={`delete ${site.name}`}
                                className="h-7 w-7 p-0 text-muted-foreground hover:bg-muted hover:text-red-400 cursor-pointer"
                                disabled={sites.length === 1}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>{sites.length === 1 ? 'cannot delete the last site' : 'delete site'}</p>
                            </TooltipContent>
                          </Tooltip>
                        </div>
                      </div>

                    {/* Edit panel — attached beneath the row inside the same
                        card so the site being edited stays visible above its
                        own form. Name + timezone share one line (wrapping on
                        narrow screens) to keep the panel short. */}
                    {editingSiteId === site.id && (
                      <div className="animate-in slide-in-from-top-2 fade-in duration-200 border-t border-border/60 p-3">
                        <div className="flex flex-wrap items-end gap-3">
                          <div className="min-w-40 grow space-y-1.5">
                            <Label htmlFor={`name-${site.id}`} className="text-muted-foreground text-sm">
                              site name
                            </Label>
                            <Input
                              id={`name-${site.id}`}
                              value={editingName}
                              onChange={(e) => setEditingName(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') handleSaveSite(site.id);
                              }}
                              className="border-border bg-accent text-white"
                              autoFocus
                            />
                          </div>
                          <div className="min-w-40 grow space-y-1.5">
                            <Label htmlFor={`timezone-${site.id}`} className="text-muted-foreground text-sm">
                              timezone
                            </Label>
                            <TimezoneSelect
                              id={`timezone-${site.id}`}
                              value={editingTimezone}
                              onValueChange={setEditingTimezone}
                              className="border-border bg-accent text-white"
                            />
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={cancelEditingSite}
                              disabled={isSaving}
                              className="bg-secondary border border-border cursor-pointer"
                            >
                              <X className="h-4 w-4 mr-1" />
                              cancel
                            </Button>
                            <Button
                              size="sm"
                              onClick={() => handleSaveSite(site.id)}
                              disabled={isSaving}
                              className="text-gray-900 cursor-pointer"
                            >
                              <Check className="h-4 w-4 mr-1" />
                              {isSaving ? 'saving...' : 'save'}
                            </Button>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Machines panel — expanded via the row chevron; lists
                        this site's machines with support actions so an admin
                        can act when things go wrong for a customer. */}
                    {expandedSiteId === site.id && (
                      <div className="animate-in slide-in-from-top-2 fade-in duration-200 border-t border-border/60">
                        <SiteMachinesList siteId={site.id} onCountLoaded={handleMachineCountLoaded} />
                      </div>
                    )}
                  </div>
                ))}
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deletingDialogOpen} onOpenChange={setDeletingDialogOpen}>
        <DialogContent className="border-border bg-secondary text-white">
          <DialogHeader>
            <DialogTitle className="text-white">delete site</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              are you sure you want to delete this site? this action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {siteToDelete && (
            <div className="py-4">
              <p className="text-white">
                site: <span className="font-semibold">{sites.find(s => s.id === siteToDelete)?.name}</span>
              </p>
              <p className="text-sm text-muted-foreground mt-2">
                note: the site document will be deleted, but machine data may remain in Firestore.
              </p>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setDeletingDialogOpen(false);
                setSiteToDelete(null);
              }}
              className="bg-secondary border border-border cursor-pointer"
            >
              cancel
            </Button>
            <Button
              onClick={handleDeleteSite}
              className="bg-red-600 hover:bg-red-700 text-white cursor-pointer"
            >
              delete site
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
