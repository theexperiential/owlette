'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Camera, Loader2, RefreshCw, AlertTriangle, Download, ClipboardCopy, Check, Maximize2, X as XIcon, PanelLeftClose, PanelLeftOpen, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { formatRelativeTime } from '@/lib/timeUtils';
import { useAuth } from '@/contexts/AuthContext';
import { useScreenshotHistory, ScreenshotRecord } from '@/hooks/useScreenshotHistory';
import { toast } from 'sonner';

interface ScreenshotDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  machineId: string;
  machineName: string;
  siteId: string;
  isOnline: boolean;
  onCaptureScreenshot: () => Promise<void>;
  lastScreenshot?: {
    url: string;
    timestamp: any;   // Firestore Timestamp (new) or number (legacy)
    sizeKB: number;
  };
  hasActiveDeployment?: boolean;
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
  hasActiveDeployment,
}: ScreenshotDialogProps) {
  const { userPreferences } = useAuth();
  const [isCapturing, setIsCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [screenshot, setScreenshot] = useState(initialScreenshot);
  const [copied, setCopied] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [showHistory, setShowHistory] = useState(true);
  const [selectedHistorical, setSelectedHistorical] = useState<ScreenshotRecord | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [clearingAll, setClearingAll] = useState(false);
  const [confirmClearAll, setConfirmClearAll] = useState(false);
  const captureTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { screenshots: historyScreenshots, loading: historyLoading } = useScreenshotHistory(
    siteId, machineId, open
  );

  const displayedScreenshot = selectedHistorical || screenshot;

  // Listen for screenshot updates in real-time
  useEffect(() => {
    if (!open || !db || !siteId || !machineId) return;

    const machineRef = doc(db, 'sites', siteId, 'machines', machineId);
    const unsubscribe = onSnapshot(machineRef, (snapshot) => {
      const data = snapshot.data();
      if (data?.lastScreenshot?.url) {
        setScreenshot((prev) => {
          if (!prev || data.lastScreenshot.timestamp !== prev.timestamp) {
            if (captureTimeoutRef.current) {
              clearTimeout(captureTimeoutRef.current);
              captureTimeoutRef.current = null;
            }
            setIsCapturing(false);
            setError(null);
            // New capture arrived — deselect historical so latest is shown + highlighted
            setSelectedHistorical(null);
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

  useEffect(() => {
    if (open && initialScreenshot) {
      setScreenshot(initialScreenshot);
    }
    if (open) {
      setSelectedHistorical(null);
    }
  }, [open, initialScreenshot]);

  const handleCapture = useCallback(async () => {
    setIsCapturing(true);
    setError(null);
    setSelectedHistorical(null);

    try {
      await onCaptureScreenshot();

      if (captureTimeoutRef.current) clearTimeout(captureTimeoutRef.current);
      captureTimeoutRef.current = setTimeout(() => {
        captureTimeoutRef.current = null;
        setIsCapturing(false);
        setError(
          hasActiveDeployment
            ? 'Screenshot timed out — a software deployment is in progress on this machine. The agent cannot process other commands until the installation completes.'
            : 'Screenshot timed out — the machine may be offline or running headless with no active user session.'
        );
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

  const handleDeleteScreenshot = useCallback(async (screenshotId: string) => {
    setDeletingId(screenshotId);
    try {
      const res = await fetch(
        `/api/admin/screenshots?siteId=${siteId}&machineId=${machineId}&screenshotId=${screenshotId}`,
        { method: 'DELETE' }
      );
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to delete');
      }
      // If we were viewing the deleted screenshot, go back to latest
      if (selectedHistorical?.id === screenshotId) {
        setSelectedHistorical(null);
      }
      toast.success('Screenshot deleted');
    } catch (err: any) {
      toast.error('Failed to delete screenshot', { description: err.message });
    } finally {
      setDeletingId(null);
    }
  }, [siteId, machineId, selectedHistorical]);

  const handleClearAll = useCallback(async () => {
    setClearingAll(true);
    try {
      const res = await fetch(
        `/api/admin/screenshots?siteId=${siteId}&machineId=${machineId}`,
        { method: 'DELETE' }
      );
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to clear');
      }
      const data = await res.json();
      setSelectedHistorical(null);
      setScreenshot(undefined);
      toast.success(`Cleared ${data.deleted} screenshot${data.deleted === 1 ? '' : 's'}`);
    } catch (err: any) {
      toast.error('Failed to clear history', { description: err.message });
    } finally {
      setClearingAll(false);
    }
  }, [siteId, machineId]);

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

  const formatTimestamp = (ts: any) => {
    const d = ts?.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: (userPreferences.timeFormat || '12h') === '12h',
    });
  };

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
      <DialogContent showCloseButton={false} className="bg-card border-border w-[calc(100vw-2rem)] sm:max-w-none max-w-none p-0 gap-0 h-[calc(100vh-4rem)]">
        <div className="flex h-full overflow-hidden">

          {/* Collapsible left sidebar — history */}
          {showHistory && (
            <div className="w-52 flex-shrink-0 border-r border-border flex flex-col">
              <div className="px-3 py-3 border-b border-border flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">history</span>
                <div className="flex items-center gap-1">
                  {historyScreenshots.length > 0 && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-muted-foreground hover:text-red-400"
                      onClick={() => setConfirmClearAll(true)}
                      disabled={clearingAll}
                      title="Clear all history"
                    >
                      {clearingAll ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-muted-foreground"
                    onClick={() => setShowHistory(false)}
                    title="Hide history"
                  >
                    <PanelLeftClose className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto">
                {historyLoading ? (
                  <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    loading...
                  </div>
                ) : historyScreenshots.length === 0 ? (
                  <p className="text-xs text-muted-foreground p-3">no history yet</p>
                ) : (
                  <div className="py-1">
                    {historyScreenshots.map((hs, index) => {
                      const isSelected = selectedHistorical?.id === hs.id;
                      const isLatest = !selectedHistorical && index === 0;
                      const isDeleting = deletingId === hs.id;
                      return (
                        <div
                          key={hs.id}
                          className={`group flex items-center transition-colors ${
                            isSelected || isLatest
                              ? 'bg-primary/10 border-l-2 border-primary'
                              : 'border-l-2 border-transparent hover:bg-muted/50'
                          }`}
                        >
                          <button
                            className={`flex-1 text-left px-3 py-2 text-xs min-w-0 ${
                              isSelected || isLatest ? 'text-primary' : 'text-muted-foreground'
                            }`}
                            onClick={() => setSelectedHistorical(isLatest ? null : hs)}
                          >
                            <div className="font-medium truncate">{formatTimestamp(hs.timestamp)}</div>
                            <div className="text-[10px] mt-0.5 opacity-70">
                              {formatRelativeTime(hs.timestamp?.seconds ?? Math.floor((typeof hs.timestamp === 'number' ? hs.timestamp : 0) / 1000))} · {hs.sizeKB}KB
                            </div>
                          </button>
                          <button
                            className="opacity-0 group-hover:opacity-100 p-1.5 mr-1 text-muted-foreground hover:text-red-400 transition-opacity"
                            onClick={(e) => { e.stopPropagation(); handleDeleteScreenshot(hs.id); }}
                            disabled={isDeleting}
                            title="Delete screenshot"
                          >
                            {isDeleting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
              {/* Capture button at bottom of sidebar */}
              <div className="p-2 border-t border-border">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCapture}
                  disabled={isCapturing || !isOnline}
                  className="w-full bg-secondary border-border hover:bg-accent"
                >
                  {isCapturing ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Camera className="h-4 w-4 mr-2" />
                  )}
                  {isCapturing ? 'capturing...' : 'capture'}
                </Button>
              </div>
            </div>
          )}

          {/* Main content — screenshot display */}
          <div className="flex-1 flex flex-col min-w-0">
            {/* Header */}
            <DialogHeader className="px-4 py-2 border-b border-border flex-shrink-0">
              <DialogTitle className="flex items-center gap-2">
                {!showHistory && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground"
                    onClick={() => setShowHistory(true)}
                    title="Show history"
                  >
                    <PanelLeftOpen className="h-4 w-4" />
                  </Button>
                )}
                <Camera className="h-5 w-5" />
                screenshot — {machineName}
                {selectedHistorical && (
                  <span className="text-xs font-normal text-muted-foreground ml-2">
                    (viewing {formatTimestamp(selectedHistorical.timestamp)})
                  </span>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground ml-auto"
                  onClick={() => onOpenChange(false)}
                >
                  <XIcon className="h-4 w-4" />
                </Button>
              </DialogTitle>
            </DialogHeader>

            {/* Screenshot display */}
            <div className="flex-1 relative bg-black/30 flex items-center justify-center overflow-hidden min-h-0">
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

              {!isCapturing && !error && !displayedScreenshot && (
                <div className="flex flex-col items-center gap-3 py-12 text-muted-foreground">
                  <Camera className="h-8 w-8" />
                  <p>no screenshot available</p>
                </div>
              )}

              {displayedScreenshot && !isCapturing && (
                <img
                  src={displayedScreenshot.url}
                  alt={`Screenshot of ${machineName}`}
                  className="absolute inset-0 w-full h-full object-contain cursor-pointer"
                  onClick={() => setFullscreen(true)}
                />
              )}
            </div>

            {/* Footer — info + action buttons */}
            <div className="flex items-center justify-between px-4 py-2 border-t border-border flex-shrink-0">
              <div className="text-xs text-muted-foreground">
                {displayedScreenshot && (
                  <>
                    captured {formatTimestamp(displayedScreenshot.timestamp)} ({displayedScreenshot.sizeKB}KB)
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
                  </>
                )}
                {!showHistory && !isCapturing && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleCapture}
                    disabled={isCapturing || !isOnline}
                    className="bg-secondary border-border hover:bg-accent ml-1"
                  >
                    <Camera className="h-4 w-4 mr-2" />
                    capture
                  </Button>
                )}
              </div>
            </div>
          </div>

        </div>
      </DialogContent>
    </Dialog>

    {/* Clear all confirmation dialog */}
    <Dialog open={confirmClearAll} onOpenChange={setConfirmClearAll}>
      <DialogContent className="bg-card border-border max-w-sm">
        <DialogHeader>
          <DialogTitle>clear screenshot history?</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            this will permanently delete {historyScreenshots.length} screenshot{historyScreenshots.length === 1 ? '' : 's'} from storage.
            this action cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setConfirmClearAll(false)}
            className="bg-secondary border-border hover:bg-accent"
          >
            cancel
          </Button>
          <Button
            onClick={async () => {
              setConfirmClearAll(false);
              await handleClearAll();
            }}
            disabled={clearingAll}
            className="bg-red-600 hover:bg-red-700"
          >
            {clearingAll ? 'clearing...' : 'clear all'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}
