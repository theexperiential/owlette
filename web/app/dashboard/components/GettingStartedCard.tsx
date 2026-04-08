/**
 * GettingStartedCard Component
 *
 * Empty state card shown when no machines are configured.
 * Provides step-by-step setup instructions with conditional logic:
 * - Shows "Create Site" prompt if no sites exist
 * - Shows agent download/installation steps if sites exist
 *
 * Used by: Dashboard page when machines.length === 0
 */

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Plus, Download, Copy } from 'lucide-react';
import { toast } from 'sonner';
import type { Site } from '@/hooks/useFirestore';

interface GettingStartedCardProps {
  sites: Site[];
  currentSiteId: string;
  version: string | undefined;
  downloadUrl: string | undefined;
  onCreateSite: () => void;
}

export function GettingStartedCard({
  sites,
  currentSiteId,
  version,
  downloadUrl,
  onCreateSite,
}: GettingStartedCardProps) {
  const handleDownload = () => {
    if (!downloadUrl) {
      toast.error('Download Unavailable', {
        description: 'Installer download URL is not available.',
      });
      return;
    }
    try {
      window.open(downloadUrl, '_blank');
      toast.success('Download Started', {
        description: `Downloading owlette v${version}`,
      });
    } catch (err) {
      toast.error('Download Failed', {
        description: 'Failed to start download. Please try again.',
      });
    }
  };

  const handleCopyLink = () => {
    if (!downloadUrl) {
      toast.error('Copy Failed', {
        description: 'Download URL is not available.',
      });
      return;
    }
    try {
      navigator.clipboard.writeText(downloadUrl);
      toast.success('Link Copied', {
        description: 'Download link copied to clipboard',
      });
    } catch (err) {
      toast.error('Copy Failed', {
        description: 'Failed to copy link. Please try again.',
      });
    }
  };

  return (
    <Card className="border-border bg-background animate-in fade-in duration-500">
      <CardHeader>
        <CardTitle className="text-white">Getting Started</CardTitle>
        <CardDescription className="text-muted-foreground">
          Connect your first machine to start managing processes
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Step 1: Create Your First Site (only shown when no sites exist) */}
        {sites.length === 0 && (
          <div className="rounded-lg border-2 border-accent-cyan/50 bg-accent-cyan/10 p-6">
            <h3 className="text-lg font-bold text-white mb-2">Step 1: Create Your First Site</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Sites organize your machines by location or purpose (e.g., &quot;NYC Office&quot;, &quot;Home Studio&quot;, &quot;Production Floor&quot;).
              Create your first site to get started!
            </p>
            <Button
              onClick={onCreateSite}
              className="bg-accent-cyan hover:bg-accent-cyan-hover text-gray-900 font-semibold px-6 py-3 cursor-pointer"
            >
              <Plus className="h-4 w-4 mr-2" />
              Create Your First Site
            </Button>
          </div>
        )}

        {/* Steps: Only shown after site is created */}
        {sites.length > 0 && (
          <>
            <div className="rounded-lg border border-border bg-background p-4">
              <h3 className="font-semibold text-white mb-3">Step 1: Download owlette Agent</h3>
              <p className="text-sm text-muted-foreground mb-4">
                Download and run the installer <strong className="text-white">on the machine you want to add</strong> (not necessarily this one).
                Use the copy link option if connecting via remote desktop tools like Parsec, TeamViewer, or RDP.
              </p>
              <div className="flex gap-2">
                <Button
                  onClick={handleDownload}
                  disabled={!downloadUrl}
                  className="flex-1 bg-accent-cyan hover:bg-accent-cyan-hover text-gray-900 cursor-pointer"
                >
                  <Download className="h-4 w-4 mr-2" />
                  <span>Download {version && `v${version}`}</span>
                </Button>
                <Button
                  onClick={handleCopyLink}
                  disabled={!downloadUrl}
                  className="flex-1 bg-accent-cyan hover:bg-accent-cyan-hover text-gray-900 cursor-pointer"
                >
                  <Copy className="h-4 w-4 mr-2" />
                  <span>Copy Link</span>
                </Button>
              </div>
            </div>
            <div className="rounded-lg border border-border bg-background p-4">
              <h3 className="font-semibold text-white">Step 2: Run the Installer</h3>
              <p className="text-sm text-muted-foreground">
                A pairing phrase will appear and a browser window will open. Select your site and authorize, or enter the phrase on this dashboard using the <strong className="text-white">+ add machine</strong> button.
              </p>
            </div>
            <div className="rounded-lg border border-border bg-background p-4">
              <h3 className="font-semibold text-white">Step 3: Authorize</h3>
              <p className="text-sm text-muted-foreground">
                Select site <span className="font-mono text-accent-cyan">{currentSiteId}</span> and tap authorize. The machine will appear on your dashboard within seconds.
              </p>
            </div>
            <div className="rounded-lg border border-border bg-background p-4">
              <h3 className="font-semibold text-white">Bulk Deploy?</h3>
              <p className="text-sm text-muted-foreground">
                Use the <strong className="text-white">+ add machine</strong> button → &quot;generate code&quot; tab to get a pre-authorized phrase. Then run:
                <code className="block mt-2 px-3 py-2 bg-muted rounded text-xs font-mono text-foreground">
                  owlette-Installer.exe /ADD=your-phrase-here /SILENT
                </code>
              </p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
