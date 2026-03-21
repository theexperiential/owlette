'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useSites } from '@/hooks/useFirestore';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Webhook } from 'lucide-react';
import WebhookSettingsDialog from '@/components/WebhookSettingsDialog';

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
    <div className="p-6 lg:p-8 max-w-6xl mx-auto">
      <div className="mb-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-2">
          <h1 className="text-2xl font-bold text-foreground">Webhook Notifications</h1>
          <div className="flex items-center gap-2">
            <Select value={selectedSiteId} onValueChange={handleSiteChange}>
              <SelectTrigger className="w-[180px] bg-card border-border text-foreground">
                <SelectValue placeholder="Select site" />
              </SelectTrigger>
              <SelectContent className="bg-card border-border">
                {sites.map((site) => (
                  <SelectItem key={site.id} value={site.id} className="text-foreground hover:bg-muted">
                    {site.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <p className="text-muted-foreground text-sm">
          Configure webhook URLs to receive JSON payloads when events occur (machine offline, process crash, etc.).
          Works with Slack, Discord, Teams, PagerDuty, Zapier, and any HTTPS endpoint.
        </p>
      </div>

      {selectedSiteId && (
        <div className="flex flex-col items-center justify-center py-12">
          <Webhook className="h-16 w-16 text-muted-foreground/50 mb-4" />
          <p className="text-muted-foreground mb-4">Manage webhook integrations for this site</p>
          <Button onClick={() => setDialogOpen(true)}>
            <Webhook className="h-4 w-4 mr-2" />
            Manage Webhooks
          </Button>
        </div>
      )}

      {selectedSiteId && (
        <WebhookSettingsDialog
          siteId={selectedSiteId}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
        />
      )}
    </div>
  );
}
