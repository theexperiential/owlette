'use client';

import React, { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Plus, X, Loader2, Search } from 'lucide-react';
import { toast } from 'sonner';
import { useSites } from '@/hooks/useFirestore';
import { useAuth } from '@/contexts/AuthContext';

interface ManageUserSitesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
  userEmail: string;
  userRole: 'user' | 'admin';
  userSites: string[];
  onAssignSite: (userId: string, siteId: string) => Promise<void>;
  onRemoveSite: (userId: string, siteId: string) => Promise<void>;
}

export function ManageUserSitesDialog({
  open,
  onOpenChange,
  userId,
  userEmail,
  userRole,
  userSites,
  onAssignSite,
  onRemoveSite,
}: ManageUserSitesDialogProps) {
  const { user, isAdmin, userSites: adminSites } = useAuth();
  const { sites, loading: sitesLoading } = useSites(user?.uid, adminSites, isAdmin);
  const [assigningTo, setAssigningTo] = useState<string | null>(null);
  const [removingFrom, setRemovingFrom] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // Local state for optimistic UI updates
  const [localUserSites, setLocalUserSites] = useState<string[]>(userSites);

  // Sync local state with prop changes (when dialog reopens with fresh data)
  useEffect(() => {
    setLocalUserSites(userSites);
  }, [userSites]);

  // Reset search when dialog closes
  useEffect(() => {
    if (!open) {
      setSearchQuery('');
    }
  }, [open]);

  const handleAssignSite = async (siteId: string) => {
    setAssigningTo(siteId);

    // Optimistically update UI immediately
    setLocalUserSites(prev => [...prev, siteId]);

    try {
      await onAssignSite(userId, siteId);
      toast.success('Site Assigned', {
        description: `${userEmail} now has access to this site.`,
      });
    } catch (err: any) {
      // Revert optimistic update on error
      setLocalUserSites(prev => prev.filter(id => id !== siteId));
      toast.error('Assignment Failed', {
        description: err.message || 'Failed to assign site to user.',
      });
    } finally {
      setAssigningTo(null);
    }
  };

  const handleRemoveSite = async (siteId: string) => {
    setRemovingFrom(siteId);

    // Optimistically update UI immediately
    setLocalUserSites(prev => prev.filter(id => id !== siteId));

    try {
      await onRemoveSite(userId, siteId);
      toast.success('Site Removed', {
        description: `${userEmail} no longer has access to this site.`,
      });
    } catch (err: any) {
      // Revert optimistic update on error
      setLocalUserSites(prev => [...prev, siteId]);
      toast.error('Removal Failed', {
        description: err.message || 'Failed to remove site from user.',
      });
    } finally {
      setRemovingFrom(null);
    }
  };

  // Filter sites based on search query
  const filterSites = (siteList: typeof sites) => {
    if (!searchQuery.trim()) return siteList;
    const query = searchQuery.toLowerCase();
    return siteList.filter(site =>
      site.name.toLowerCase().includes(query) ||
      site.id.toLowerCase().includes(query)
    );
  };

  const assignedSites = filterSites(sites.filter((site) => localUserSites.includes(site.id)));
  const availableSites = filterSites(sites.filter((site) => !localUserSites.includes(site.id)));

  // Find orphaned site IDs (in user's array but don't exist in sites collection)
  const validSiteIds = sites.map(s => s.id);
  const orphanedSiteIds = localUserSites.filter((siteId) => !validSiteIds.includes(siteId));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-card text-foreground max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-foreground">manage site access</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            control which sites {userEmail} can access
          </DialogDescription>
        </DialogHeader>

        {/* Admin Notice */}
        {userRole === 'admin' && (
          <div className="bg-accent-cyan/10 border border-accent-cyan/30 rounded-lg p-3 mt-4">
            <p className="text-accent-cyan text-sm">
              <strong className="font-semibold">Admin Access:</strong> This user has admin privileges and can access <strong>all sites</strong> in the system regardless of the assignments below. The &quot;Assigned Sites&quot; list only controls which sites appear in this user&apos;s site dropdown for convenience.
            </p>
          </div>
        )}

        {/* Search Filter */}
        {!sitesLoading && sites.length > 0 && (
          <div className="relative mt-4">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="search sites by name or ID..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 border-border bg-background text-foreground placeholder:text-muted-foreground"
            />
          </div>
        )}

        {sitesLoading ? (
          <div className="flex justify-center items-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-accent-cyan" />
            <span className="ml-2 text-muted-foreground">loading sites...</span>
          </div>
        ) : (
          <div className="space-y-6 py-4 max-h-[60vh] overflow-y-auto pr-2">
            {/* Assigned Sites */}
            <div>
              <h3 className="text-sm font-semibold text-foreground mb-3">
                assigned sites ({assignedSites.length})
              </h3>
              {assignedSites.length === 0 ? (
                <div className="text-center py-6 text-muted-foreground bg-background rounded-lg border border-border">
                  {searchQuery ? 'no assigned sites match your search' : 'no sites assigned yet'}
                </div>
              ) : (
                <div className="space-y-2">
                  {assignedSites.map((site) => (
                    <div
                      key={site.id}
                      className="flex items-center justify-between p-3 bg-background rounded-lg border border-border"
                    >
                      <div className="flex-1">
                        <p className="text-foreground font-medium">{site.name}</p>
                        <p className="text-xs text-muted-foreground font-mono">{site.id}</p>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => handleRemoveSite(site.id)}
                        disabled={removingFrom === site.id}
                        className="text-red-400 hover:text-red-300 hover:bg-red-950/30 cursor-pointer"
                      >
                        {removingFrom === site.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <X className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Orphaned/Invalid Site References */}
            {orphanedSiteIds.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-red-400 mb-3">
                  invalid site references ({orphanedSiteIds.length})
                </h3>
                <div className="space-y-2">
                  <div className="text-xs text-muted-foreground mb-2 p-2 bg-red-950/20 border border-red-900 rounded">
                    these site IDs are in the user&apos;s access list but the sites no longer exist or are inaccessible. remove them to fix the site count.
                  </div>
                  {orphanedSiteIds.map((siteId) => (
                    <div
                      key={siteId}
                      className="flex items-center justify-between p-3 bg-red-950/30 rounded-lg border border-red-900"
                    >
                      <div className="flex-1">
                        <p className="text-red-300 font-medium">invalid/orphaned site</p>
                        <p className="text-xs text-red-400 font-mono">{siteId}</p>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => handleRemoveSite(siteId)}
                        disabled={removingFrom === siteId}
                        className="text-red-400 hover:text-red-300 hover:bg-red-950/30 cursor-pointer"
                      >
                        {removingFrom === siteId ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <X className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Available Sites */}
            <div>
              <h3 className="text-sm font-semibold text-foreground mb-3">
                available sites ({availableSites.length})
              </h3>
              {availableSites.length === 0 && searchQuery ? (
                <div className="text-center py-6 text-muted-foreground bg-background rounded-lg border border-border">
                  no available sites match your search
                </div>
              ) : availableSites.length > 0 ? (
                <div className="space-y-2">
                  {availableSites.map((site) => (
                    <div
                      key={site.id}
                      className="flex items-center justify-between p-3 bg-background rounded-lg border border-border hover:border-accent-cyan/30 transition-colors"
                    >
                      <div className="flex-1">
                        <p className="text-foreground font-medium">{site.name}</p>
                        <p className="text-xs text-muted-foreground font-mono">{site.id}</p>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleAssignSite(site.id)}
                        disabled={assigningTo === site.id}
                        className="border-accent-cyan/50 text-accent-cyan hover:bg-accent-cyan/10 hover:text-accent-cyan cursor-pointer"
                      >
                        {assigningTo === site.id ? (
                          <>
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            assigning...
                          </>
                        ) : (
                          <>
                            <Plus className="h-4 w-4 mr-2" />
                            assign
                          </>
                        )}
                      </Button>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        )}

        {!sitesLoading && sites.length === 0 && (
          <div className="text-center py-8 text-muted-foreground">
            <p>no sites available yet.</p>
            <p className="text-sm mt-2">create a site first from the dashboard.</p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
