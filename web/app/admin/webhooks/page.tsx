'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useSites } from '@/hooks/useFirestore';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Plus } from 'lucide-react';
import AddWebhookDialog, { WebhookList } from '@/components/WebhookSettingsDialog';

export default function WebhooksPage() {
  const { user, isAdmin, userSites, lastSiteId, updateLastSite } = useAuth();
  const { sites } = useSites(user?.uid, userSites, isAdmin);
  const [selectedSiteId, setSelectedSiteId] = useState<string>('');
  const [dialogOpen, setDialogOpen] = useState(false);

  // Load saved site
  useEffect(() => {
    if (sites.length > 0 && !selectedSiteId) {
      const savedSite = lastSiteId || localStorage.getItem('owlette_current_site');
      if (savedSite && sites.find((s) => s.id === savedSite)) {
        setSelectedSiteId(savedSite);
      } else {
        setSelectedSiteId(sites[0].id);
      }
    }
  }, [sites, selectedSiteId, lastSiteId]);

  const handleSiteChange = (siteId: string) => {
    setSelectedSiteId(siteId);
    updateLastSite(siteId);
  };

  return (
    <div className="p-8">
      <div className="max-w-screen-2xl mx-auto">
        <div className="mb-8">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="text-3xl font-bold text-foreground mb-2">webhooks</h1>
              <p className="text-muted-foreground">
                configure webhook URLs to receive JSON payloads when events occur
              </p>
            </div>
            <div className="flex items-center gap-3">
              {sites.length > 1 && (
                <Select value={selectedSiteId} onValueChange={handleSiteChange}>
                  <SelectTrigger className="w-[180px] bg-card border-border text-foreground">
                    <SelectValue placeholder="select site" />
                  </SelectTrigger>
                  <SelectContent className="bg-card border-border">
                    {sites.map((site) => (
                      <SelectItem key={site.id} value={site.id} className="text-foreground hover:bg-muted">
                        {site.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <Button
                onClick={() => setDialogOpen(true)}
                disabled={!selectedSiteId}
                className="bg-accent-cyan hover:bg-accent-cyan-hover text-gray-900 cursor-pointer"
              >
                <Plus className="h-4 w-4 mr-2" />
                add webhook
              </Button>
            </div>
          </div>
        </div>

        {selectedSiteId && <WebhookList siteId={selectedSiteId} />}

        {selectedSiteId && (
          <AddWebhookDialog
            siteId={selectedSiteId}
            open={dialogOpen}
            onOpenChange={setDialogOpen}
          />
        )}
      </div>
    </div>
  );
}
