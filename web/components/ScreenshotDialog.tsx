'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Camera, Loader2, RefreshCw, AlertTriangle, Download, ClipboardCopy, Check, Maximize2, X as XIcon, History } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { formatRelativeTime } from '@/lib/timeUtils';
import { useScreenshotHistory, ScreenshotRecord } from '@/hooks/useScreenshotHistory';

interface ScreenshotDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  machineId: string;
  machineName: string;
  siteId: string;
  isOnline: boolean;
  onCaptureScreenshot: () => Promise<void>;
  /** Pre-loaded screenshot from machine document */
  lastScreenshot?: {
    url: string;
    timestamp: number;
    sizeKB: number;
  };
}

export function ScreenshotDialog({
  open,
  onOpenChange,
  machineId,
  machineName,
  siteId,
  isOnline,
  onCaptureScreenshot,
  lastScreenshot: initialScreenshot,
}: ScreenshotDialogProps) {
  const [isCapturing, setIsCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [screenshot, setScreenshot] = useState(initialScreenshot);
  const [copied, setCopied] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [selectedHistorical, setSelectedHistorical] = useState<ScreenshotRecord | null>(null);
  const captureTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { screenshots: historyScreenshots, loading: historyLoading } = useScreenshotHistory(
    siteId, machineId, open && showHistory
  );

  // The currently displayed screenshot (historical selection or latest)
  const displayedScreenshot = selectedHistorical || screenshot;

  // Listen for screenshot updates in real-time
  useEffect(() => {
    if (!open || !db || !siteId || !machineId) return;

    const machineRef = doc(db, 'sites', siteId, 'machines', machineId);
    const unsubscribe = onSnapshot(machineRef, (snapshot) => {
      const data = snapshot.data();
      if (data?.lastScreenshot?.url) {
        setScreenshot((prev) => {
          // Only clear capturing state if this is a NEW screenshot
          if (!prev || data.lastScreenshot.timestamp !== prev.timestamp) {
            if (captureTimeoutRef.current) {
              clearTimeout(captureTimeoutRef.current);
              captureTimeoutRef.current = null;
            }
            setIsCapturing(false);
            setError(null);
          }
          return data.lastScreenshot;
        });
      }
    });

    return () => {
      unsubscribe();
      if (captureTimeoutRef.current) {
        clearTimeout(captureTimeoutRef.current);
        captureTimeoutRef.current = null;
      }
    };
  }, [open, siteId, machineId]);

  // Update from prop when dialog opens
  useEffect(() => {
    if (open && initialScreenshot) {
      setScreenshot(initialScreenshot);
    }
  }, [open, initialScreenshot]);

  const handleCapture = useCallback(async () => {
    setIsCapturing(true);
    setError(null);

    try {
      await onCaptureScreenshot();

      // Set a timeout — if no screenshot arrives in 20s, show error
      if (captureTimeoutRef.current) clearTimeout(captureTimeoutRef.current);
      captureTimeoutRef.current = setTimeout(() => {
        captureTimeoutRef.current = null;
        setIsCapturing(false);
        setError('Screenshot timed out — the machine may be running headless or the GUI is not running.');
      }, 20000);
    } catch (err: any) {
      setIsCapturing(false);
      setError(err.message || 'Failed to send screenshot command');
    }
  }, [onCaptureScreenshot]);

  const handleDownload = useCallback(async () => {
    if (!displayedScreenshot?.url) return;
    try {
      const response = await fetch(displayedScreenshot.url);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${machineName}-screenshot-${new Date(displayedScreenshot.timestamp).toISOString().replace(/[:.]/g, '-')}.jpg`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // Fallback: open in new tab
      window.open(displayedScreenshot.url, '_blank');
    }
  }, [displayedScreenshot, machineName]);

  const handleCopy = useCallback(async () => {
    if (!displayedScreenshot?.url) return;
    try {
      const response = await fetch(displayedScreenshot.url);
      const blob = await response.blob();
      const img = new Image();
      img.crossOrigin = 'anonymous';
      const loaded = new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('Failed to load image'));
      });
      img.src = URL.createObjectURL(blob);
      await loaded;
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      canvas.getContext('2d')!.drawImage(img, 0, 0);
      URL.revokeObjectURL(img.src);
      const pngBlob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Canvas export failed'))), 'image/png')
      );
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API not supported or failed
    }
  }, [displayedScreenshot]);

  // Close fullscreen on Escape key
  useEffect(() => {
    if (!fullscreen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullscreen(false);
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [fullscreen]);

  // Auto-capture on first open if no existing screenshot
  useEffect(() => {
    if (open && !screenshot && isOnline && !isCapturing) {
      handleCapture();
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
    {/* Fullscreen overlay */}
    {fullscreen && displayedScreenshot && (
      <div
        className="fixed inset-0 z-[100] bg-black/90 flex items-center justify-center cursor-pointer"
        onClick={() => setFullscreen(false)}
      >
        <Button
          variant="ghost"
          size="icon"
          className="absolute top-4 right-4 text-white hover:bg-white/20 z-10"
          onClick={(e) => { e.stopPropagation(); setFullscreen(false); }}
        >
          <XIcon className="h-6 w-6" />
        </Button>
        <img
          src={displayedScreenshot.url}
          alt={`Screenshot of ${machineName}`}
          className="max-w-[95vw] max-h-[95vh] object-contain"
          onClick={(e) => e.stopPropagation()}
        />
      </div>
    )}
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-card border-border max-w-4xl w-[90vw]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Camera className="h-5 w-5" />
            screenshot — {machineName}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          {/* Screenshot display */}
          <div className="relative bg-black/50 rounded-lg overflow-hidden min-h-[200px] flex items-center justify-center">
            {isCapturing && (
              <div className="flex flex-col items-center gap-3 py-12 text-muted-foreground">
                <Loader2 className="h-8 w-8 animate-spin" />
                <p>capturing screenshot...</p>
              </div>
            )}

            {!isCapturing && error && (
              <div className="flex flex-col items-center gap-3 py-12 text-muted-foreground">
                <AlertTriangle className="h-8 w-8 text-amber-400" />
                <p className="text-sm text-center max-w-md">{error}</p>
              </div>
            )}

            {!isCapturing && !error && !screenshot && (
              <div className="flex flex-col items-center gap-3 py-12 text-muted-foreground">
                <Camera className="h-8 w-8" />
                <p>no screenshot available</p>
              </div>
            )}

            {displayedScreenshot && !isCapturing && (
              <>
                {selectedHistorical && (
                  <div className="absolute top-2 left-2 z-10 bg-black/70 text-white text-xs px-2 py-1 rounded">
                    viewing history — {new Date(selectedHistorical.timestamp).toLocaleString()}
                  </div>
                )}
                <img
                  src={displayedScreenshot.url}
                  alt={`Screenshot of ${machineName}`}
                  className="w-full h-auto max-h-[70vh] object-contain cursor-pointer"
                  onClick={() => setFullscreen(true)}
                />
              </>
            )}
          </div>

          {/* History gallery strip */}
          {showHistory && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground font-medium">history</span>
                {selectedHistorical && (
                  <button
                    className="text-xs text-primary hover:underline"
                    onClick={() => setSelectedHistorical(null)}
                  >
                    back to latest
                  </button>
                )}
              </div>
              {historyLoading ? (
                <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  loading history...
                </div>
              ) : historyScreenshots.length === 0 ? (
                <p className="text-xs text-muted-foreground py-2">no history yet</p>
              ) : (
                <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-thin">
                  {historyScreenshots.map((hs) => (
                    <button
                      key={hs.id}
                      className={`flex-shrink-0 rounded overflow-hidden border-2 transition-colors ${
                        selectedHistorical?.id === hs.id
                          ? 'border-primary'
                          : 'border-transparent hover:border-muted-foreground/40'
                      }`}
                      onClick={() => setSelectedHistorical(hs)}
                    >
                      <img
                        src={hs.url}
                        alt={`Screenshot ${new Date(hs.timestamp).toLocaleString()}`}
                        className="h-16 w-auto object-cover"
                        loading="lazy"
                      />
                      <div className="text-[10px] text-muted-foreground px-1 py-0.5 text-center truncate max-w-[120px]">
                        {formatRelativeTime(hs.timestamp / 1000)}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Footer info + action buttons */}
          <div className="flex items-center justify-between">
            <div className="text-xs text-muted-foreground">
              {displayedScreenshot && (
                <>
                  captured {formatRelativeTime(displayedScreenshot.timestamp / 1000)} ({displayedScreenshot.sizeKB}KB)
                </>
              )}
              <span className="ml-2 text-muted-foreground/60">
                screenshots may contain sensitive content
              </span>
            </div>
            <div className="flex items-center gap-1">
              {displayedScreenshot && (
                <>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={handleDownload}
                    title="Download screenshot"
                  >
                    <Download className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={handleCopy}
                    title="Copy to clipboard"
                  >
                    {copied ? <Check className="h-4 w-4 text-green-500" /> : <ClipboardCopy className="h-4 w-4" />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => setFullscreen(true)}
                    title="Fullscreen"
                  >
                    <Maximize2 className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={`h-8 w-8 ${showHistory ? 'text-primary' : ''}`}
                    onClick={() => { setShowHistory(!showHistory); if (showHistory) setSelectedHistorical(null); }}
                    title="Screenshot history"
                  >
                    <History className="h-4 w-4" />
                  </Button>
                </>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={handleCapture}
                disabled={isCapturing || !isOnline}
                className="bg-secondary border-border hover:bg-accent ml-1"
              >
                {isCapturing ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4 mr-2" />
                )}
                {isCapturing ? 'capturing...' : 'refresh'}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
    </>
  );
}
