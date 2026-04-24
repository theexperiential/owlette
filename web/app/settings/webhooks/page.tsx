'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Copy, Loader2, Plus, Webhook, X } from 'lucide-react';
import { toast } from 'sonner';
import { CreateWebhookDialog } from './CreateWebhookDialog';
import { WebhookCard, type WebhookListItem } from './WebhookCard';

interface WebhooksResponse {
  webhooks: WebhookListItem[];
  nextPageToken: string;
}

export default function WebhooksSettingsPage() {
  const router = useRouter();
  const { user, loading: authLoading, userSites, lastSiteId } = useAuth();
  // User's explicit selection wins once made; otherwise fall back to
  // `lastSiteId` (if still accessible) or the first available site. Computed
  // inline rather than synced via a useEffect to avoid the cascading-render
  // lint and extra re-renders when auth data arrives.
  const [userPickedSite, setUserPickedSite] = useState<string>('');
  const selectedSite = userPickedSite
    ? userPickedSite
    : lastSiteId && userSites.includes(lastSiteId)
      ? lastSiteId
      : (userSites[0] ?? '');
  const [webhooks, setWebhooks] = useState<WebhookListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);

  const refresh = useCallback(
    async (siteId: string) => {
      setLoading(true);
      try {
        const res = await fetch(
          `/api/webhooks?siteId=${encodeURIComponent(siteId)}&limit=50`,
        );
        const data = (await res.json()) as
          | WebhooksResponse
          | { detail?: string; title?: string };
        if (res.ok && 'webhooks' in data) {
          setWebhooks(data.webhooks);
        } else {
          const msg =
            ('detail' in data && data.detail) ||
            ('title' in data && data.title) ||
            'failed to load webhooks';
          toast.error(msg);
          setWebhooks([]);
        }
      } catch {
        toast.error('failed to load webhooks');
        setWebhooks([]);
      }
      setLoading(false);
    },
    [],
  );

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      router.push('/login');
      return;
    }
    if (!selectedSite) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch + site-change fetch; state is managed in refresh().
    refresh(selectedSite).catch(() => {});
  }, [user, authLoading, router, refresh, selectedSite]);

  function copyToClipboard(value: string) {
    navigator.clipboard.writeText(value);
    toast.success('copied to clipboard');
  }

  if (authLoading || (!user && loading)) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <PageHeader currentPage="webhooks" />
      <main className="max-w-4xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6 flex-wrap gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-white flex items-center gap-2">
              <Webhook className="h-5 w-5" />
              webhooks
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              subscribe to roost events — manifest publishes, deploy rollouts, quota warnings — with
              hmac-signed http callbacks.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {userSites.length > 1 && (
              <Select value={selectedSite} onValueChange={setUserPickedSite}>
                <SelectTrigger className="w-48 bg-card border-border text-white">
                  <SelectValue placeholder="pick a site" />
                </SelectTrigger>
                <SelectContent>
                  {userSites.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Button
              type="button"
              onClick={() => setCreateOpen(true)}
              disabled={!selectedSite}
              className="bg-accent-cyan hover:bg-accent-cyan-hover text-gray-900 cursor-pointer"
            >
              <Plus className="h-4 w-4 mr-1" /> create webhook
            </Button>
          </div>
        </div>

        {revealedSecret && (
          <Card className="border-accent-cyan/50 bg-accent-cyan/5 p-4 mb-6 relative">
            <button
              type="button"
              onClick={() => setRevealedSecret(null)}
              className="absolute top-3 right-3 text-muted-foreground hover:text-white cursor-pointer"
              aria-label="dismiss"
            >
              <X className="h-4 w-4" />
            </button>
            <p className="text-sm text-accent-cyan font-medium pr-6 mb-2">
              signing secret issued — copy it now. it will not be shown again.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs bg-background border border-border rounded px-3 py-2 text-white font-mono break-all select-all">
                {revealedSecret}
              </code>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => copyToClipboard(revealedSecret)}
                    className="h-9 border-border text-accent-cyan hover:bg-muted cursor-pointer"
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>copy</p>
                </TooltipContent>
              </Tooltip>
            </div>
          </Card>
        )}

        {!selectedSite ? (
          <Card className="border-border bg-card/50 p-8 text-center">
            <p className="text-sm text-white">no sites available</p>
            <p className="text-xs text-muted-foreground mt-1">
              you need site access to manage webhooks. ask a site admin to add you.
            </p>
          </Card>
        ) : loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : webhooks.length === 0 ? (
          <Card className="border-border bg-card/50 p-8 text-center space-y-3">
            <Webhook className="h-8 w-8 text-muted-foreground mx-auto" />
            <div>
              <p className="text-sm text-white">no webhooks yet</p>
              <p className="text-xs text-muted-foreground mt-1">
                subscribe to events so your ci/cd, slack bot, or monitoring can react to roost
                activity.
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              onClick={() => setCreateOpen(true)}
              className="bg-accent-cyan hover:bg-accent-cyan-hover text-gray-900 cursor-pointer"
            >
              <Plus className="h-3.5 w-3.5 mr-1" /> create your first webhook
            </Button>
          </Card>
        ) : (
          <div className="space-y-3">
            {webhooks.map((w) => (
              <WebhookCard
                key={w.id}
                webhook={w}
                siteId={selectedSite}
                onChanged={() => void refresh(selectedSite)}
                onSecretRotated={setRevealedSecret}
              />
            ))}
          </div>
        )}
      </main>

      {selectedSite && (
        <CreateWebhookDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          siteId={selectedSite}
          onCreated={(secret) => {
            setRevealedSecret(secret);
            void refresh(selectedSite);
          }}
        />
      )}
    </div>
  );
}
