'use client';

import { Download, Loader2, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useInstallerVersion } from '@/hooks/useInstallerVersion';
import { toast } from 'sonner';

/**
 * DownloadButton Component
 *
 * Public download button for the Owlette Agent installer.
 * Displays in the dashboard header for all authenticated users.
 *
 * Features:
 * - Shows latest version in tooltip
 * - Downloads installer when clicked
 * - Loading state while fetching
 * - Error handling with user feedback
 */
export default function DownloadButton() {
  const { version, downloadUrl, isLoading, error } = useInstallerVersion();

  const handleDownload = () => {
    if (!downloadUrl) {
      toast.error('download unavailable', {
        description: 'installer download URL is not available.',
      });
      return;
    }

    try {
      // Open download URL in new tab
      window.open(downloadUrl, '_blank');
      toast.success('download started', {
        description: `downloading Owlette v${version}`,
      });
    } catch (err) {
      toast.error('download failed', {
        description: 'failed to start download. please try again.',
      });
    }
  };

  const handleCopyLink = async () => {
    if (!downloadUrl) {
      toast.error('copy failed', {
        description: 'download URL is not available.',
      });
      return;
    }

    try {
      await navigator.clipboard.writeText(downloadUrl);
      toast.success('link copied', {
        description: `download link for v${version} copied to clipboard.`,
      });
    } catch (err) {
      toast.error('copy failed', {
        description: 'failed to copy link to clipboard.',
      });
    }
  };

  // Don't show button if there's an error or no version available
  if (error || (!isLoading && !version)) {
    return null;
  }

  return (
    <div className="flex items-center gap-0.5 sm:gap-1">
      {/* Download Button */}
      <TooltipProvider disableHoverableContent>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleDownload}
              disabled={isLoading || !downloadUrl}
              className="flex items-center hover:bg-secondary hover:text-white cursor-pointer text-white p-1 sm:p-1.5 md:p-2"
            >
              {isLoading ? (
                <Loader2 className="h-3 w-3 sm:h-3.5 sm:w-3.5 md:h-4 md:w-4 animate-spin" />
              ) : (
                <Download className="h-3 w-3 sm:h-3.5 sm:w-3.5 md:h-4 md:w-4" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent
            side="bottom"
            className="bg-secondary border-border text-white"
          >
            {isLoading ? (
              <p>loading version info...</p>
            ) : (
              <p>download Owlette agent v{version}</p>
            )}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      {/* Copy Link Button */}
      <TooltipProvider disableHoverableContent>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCopyLink}
              disabled={isLoading || !downloadUrl}
              className="flex items-center hover:bg-secondary hover:text-white cursor-pointer text-white p-1 sm:p-1.5 md:p-2"
            >
              <Copy className="h-3 w-3 sm:h-3.5 sm:w-3.5 md:h-4 md:w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent
            side="bottom"
            className="bg-secondary border-border text-white"
          >
            {isLoading ? (
              <p>loading version info...</p>
            ) : (
              <p>copy download link for Owlette agent v{version}</p>
            )}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}
